/**
 * Repeatable clean-instance performance baseline.
 *
 * This is deliberately a CLI rather than a unit test. Performance is an
 * environmental property, so a laptop must not fail a release merely because
 * it is under load; instead this tool produces comparable evidence for a
 * supported counter/VPS and can be given an explicit budget by CI later.
 *
 * It boots the real server as a child process with its own temporary tenant,
 * reads complete responses through real HTTP, and removes that tenant on exit.
 * It never imports db.js in this process and therefore cannot touch merchant
 * data. No runtime dependency is required.
 *
 * Usage:
 *   npm run benchmark
 *   npm run benchmark:quick
 *   node benchmark.js --output C:\\evidence\\gold-pos-baseline.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { computeMetalValue, computeInvoiceTotals } from '../frontend/js/lib/billingMath.js';
import {
    BENCHMARK_SETTINGS, BENCHMARK_RATES, wait, startServer, stopServer, percentile, rounded
} from './benchmarkHarness.js';

const QUICK = process.argv.includes('--quick');
const OUTPUT_INDEX = process.argv.indexOf('--output');
const outputFile = OUTPUT_INDEX === -1 ? null : process.argv[OUTPUT_INDEX + 1];

if (OUTPUT_INDEX !== -1 && (!outputFile || outputFile.startsWith('--'))) {
    throw new Error('--output requires a destination filename.');
}

/**
 * Measure complete HTTP round trips. Each worker claims a next index instead
 * of building an enormous promise array, which keeps the benchmark itself
 * light and prevents it from becoming the bottleneck at large sample counts.
 *
 * `scenario.method`/`headers` extend a request past a bare GET — an
 * authenticated checkout is a POST carrying a session cookie and CSRF header,
 * same as a real cashier's browser sends. `scenario.body` may be a fixed
 * string or a `(index) => string` so every sample can be a genuinely new,
 * valid invoice rather than one replayed body. `scenario.path` may likewise
 * be a `(index) => string` — a void or a return targets a different,
 * specific invoice on every sample, not a fixed endpoint.
 */
async function measure(baseUrl, scenario) {
    const latencies = [];
    const statusCounts = {};
    let byteCount = 0;
    let next = 0;
    let firstError = null;
    const startedAt = performance.now();
    const method = scenario.method || 'GET';

    async function worker() {
        while (true) {
            const index = next++;
            if (index >= scenario.samples || firstError) return;
            const started = performance.now();
            const path = typeof scenario.path === 'function' ? scenario.path(index) : scenario.path;
            try {
                const response = await fetch(baseUrl + path, {
                    method,
                    headers: {
                        'Cache-Control': 'no-cache',
                        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
                        ...(scenario.headers || {})
                    },
                    body: method === 'GET'
                        ? undefined
                        : (typeof scenario.body === 'function' ? scenario.body(index) : scenario.body)
                });
                const bytes = (await response.arrayBuffer()).byteLength;
                const elapsed = performance.now() - started;
                statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
                if (!response.ok) {
                    firstError = new Error(`${scenario.name} returned HTTP ${response.status}`);
                    return;
                }
                byteCount += bytes;
                latencies.push(elapsed);
            } catch (error) {
                firstError = error;
                return;
            }
        }
    }

    await Promise.all(Array.from({ length: scenario.concurrency }, worker));
    if (firstError) throw firstError;
    if (latencies.length !== scenario.samples) {
        throw new Error(`${scenario.name} completed ${latencies.length}/${scenario.samples} samples.`);
    }

    const elapsedMs = performance.now() - startedAt;
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
        name: scenario.name,
        path: typeof scenario.path === 'function' ? scenario.path(0) : scenario.path,
        samples: scenario.samples,
        concurrency: scenario.concurrency,
        statusCounts,
        responseBytes: Math.round(byteCount / scenario.samples),
        elapsedMs: rounded(elapsedMs),
        throughputPerSecond: rounded(scenario.samples / (elapsedMs / 1000)),
        latencyMs: {
            min: rounded(sorted[0]),
            p50: rounded(percentile(sorted, 0.50)),
            p95: rounded(percentile(sorted, 0.95)),
            p99: rounded(percentile(sorted, 0.99)),
            max: rounded(sorted[sorted.length - 1])
        }
    };
}

/** A deterministic, always-10-digit phone for seeded customer `index`. */
function benchmarkPhone(index) {
    return String(9700000000 + index);
}

/**
 * The same body a real Billing Desk would submit: a priced single-line cash
 * sale, `totalAmount` computed against this tenant's own tax/rate config so
 * the checkout benchmark measures a well-formed request rather than
 * repeatedly exercising the server's stale-client-total correction path.
 */
function buildSalePayload(weightGrams, customerIndex) {
    const metalValue = computeMetalValue(weightGrams, BENCHMARK_RATES.price22K);
    const totals = computeInvoiceTotals({
        metalValue, makingChargeAmount: 0, discountPercent: 0,
        taxSlab: BENCHMARK_SETTINGS.goldTaxSlab, taxMode: BENCHMARK_SETTINGS.taxMode
    });
    return JSON.stringify({
        purity: '22K', weightGrams, makingChargeAmount: 0, discountPercent: 0,
        totalAmount: totals.totalAmount,
        customerName: `Benchmark Customer ${customerIndex}`,
        customerPhone: benchmarkPhone(customerIndex)
    });
}

/** Cookie/CSRF pair a mutating admin request needs — same shape test_http.js's session helpers use. */
function sessionHeadersFrom(response) {
    const jar = {};
    (response.headers.getSetCookie ? response.headers.getSetCookie() : []).forEach(line => {
        const pair = line.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        jar[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    const csrfToken = jar.gp_admin_csrf || '';
    return { Cookie: `gp_admin_sess=${jar.gp_admin_sess || ''}; gp_admin_csrf=${csrfToken}`, 'X-CSRF-Token': csrfToken };
}

/** Signs in as the seeded tenant's owner and returns headers for every later authenticated request. */
async function authenticate(baseUrl) {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: BENCHMARK_SETTINGS.adminPin })
    });
    if (!response.ok) {
        throw new Error(`Benchmark admin login failed: HTTP ${response.status} — ${await response.text()}`);
    }
    await response.arrayBuffer();
    return sessionHeadersFrom(response);
}

/**
 * Populates the tenant with a small merchant-shaped ledger — several
 * customers, each with a few invoices — through the exact same authenticated
 * HTTP path a cashier uses. Unmeasured setup, not a scenario: it exists so
 * the checkout/lookup/paged-ledger scenarios that follow run against real row
 * counts instead of an empty tenant.
 */
async function seedMerchantDataset(baseUrl, authHeaders, { customerCount, invoicesPerCustomer }) {
    const startedAt = performance.now();
    const jobs = [];
    for (let customerIndex = 0; customerIndex < customerCount; customerIndex++) {
        for (let n = 0; n < invoicesPerCustomer; n++) {
            jobs.push({ customerIndex, weightGrams: 1 + ((customerIndex + n) % 5) });
        }
    }

    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= jobs.length) return;
            const job = jobs[index];
            const response = await fetch(`${baseUrl}/api/sales`, {
                method: 'POST',
                headers: { ...authHeaders, 'Content-Type': 'application/json' },
                body: buildSalePayload(job.weightGrams, job.customerIndex)
            });
            if (!response.ok) {
                throw new Error(`Seeding invoice ${index + 1}/${jobs.length} failed: HTTP ${response.status} — ${await response.text()}`);
            }
            await response.arrayBuffer();
        }
    }

    // A few tills at once, same as the concurrent checkout scenario below —
    // BEGIN IMMEDIATE serialises the writes regardless, so this shortens wall
    // time without changing what gets written.
    const concurrency = Math.max(1, Math.min(10, jobs.length));
    await Promise.all(Array.from({ length: concurrency }, worker));

    return { customerCount, invoiceCount: jobs.length, elapsedMs: rounded(performance.now() - startedAt) };
}

/** One authenticated POST /api/sales, returning the invoiceId the server assigned. */
async function createInvoice(baseUrl, authHeaders, weightGrams, customerIndex) {
    const response = await fetch(`${baseUrl}/api/sales`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: buildSalePayload(weightGrams, customerIndex)
    });
    if (!response.ok) {
        throw new Error(`Benchmark setup: creating a disposable invoice failed: HTTP ${response.status} — ${await response.text()}`);
    }
    return (await response.json()).invoiceId;
}

/**
 * A return and a void each consume the one invoice they act on — unlike
 * checkout/lookup, the same invoice cannot be resampled. Unmeasured setup,
 * same reasoning as seedMerchantDataset: files `count` fresh, disposable
 * invoices sequentially (this pool is tiny compared to the merchant seed)
 * and returns their invoice numbers for the return/void scenarios to consume
 * one-for-one, by sample index.
 */
async function seedDisposableInvoices(baseUrl, authHeaders, count) {
    const invoiceIds = [];
    for (let i = 0; i < count; i++) {
        invoiceIds.push(await createInvoice(baseUrl, authHeaders, 2, 0));
    }
    return invoiceIds;
}

/** One item with one generously-sized lot, so many small +weight adjustments never race a real stock floor. */
async function seedStockLot(baseUrl, authHeaders) {
    const itemRes = await fetch(`${baseUrl}/api/inventory/items`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Benchmark Stock Item', purity: '22K', skuCode: 'BENCH-SKU-1', netWeightGrams: 5 })
    });
    if (!itemRes.ok) throw new Error(`Benchmark setup: creating the stock item failed: HTTP ${itemRes.status} — ${await itemRes.text()}`);
    const item = (await itemRes.json()).item;

    const lotRes = await fetch(`${baseUrl}/api/inventory/lots`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: item.id, weightGrams: 500, unitCostPerGram: 800 })
    });
    if (!lotRes.ok) throw new Error(`Benchmark setup: opening the stock lot failed: HTTP ${lotRes.status} — ${await lotRes.text()}`);
    return (await lotRes.json()).lot.id;
}

/** A dedicated phone for benchmark advance deposits, well outside the seeded customer index range. */
const ADVANCE_BENCHMARK_PHONE = benchmarkPhone(999999);

/**
 * A mixed-till workload: `tills` concurrent workers, each repeatedly running
 * the same short cycle a real counter mixes through a shift — a sale, a
 * second sale, a return against the first, a void of the second, and an
 * advance deposit — rather than every worker hammering one endpoint. This is
 * what the checkout-only concurrent scenario above cannot show: several
 * different write paths (sale/return/void/advance) contending for the same
 * SQLite writer lock at once.
 *
 * Every HTTP call still fails fast (same contract as measure()); latency is
 * bucketed per operation kind so a regression in, say, void specifically is
 * visible rather than averaged away.
 */
async function measureMixedTill(baseUrl, authHeaders, { tills, iterationsPerTill }) {
    const latenciesByKind = { sale: [], return: [], void: [], 'advance deposit': [] };
    let firstError = null;
    const startedAt = performance.now();

    async function timed(kind, fn) {
        const started = performance.now();
        await fn();
        latenciesByKind[kind].push(performance.now() - started);
    }

    async function till(tillIndex) {
        for (let iteration = 0; iteration < iterationsPerTill && !firstError; iteration++) {
            try {
                const customerIndex = 900000 + tillIndex * 1000 + iteration;
                let invoiceA, invoiceB;
                await timed('sale', async () => { invoiceA = await createInvoice(baseUrl, authHeaders, 2, customerIndex); });
                await timed('sale', async () => { invoiceB = await createInvoice(baseUrl, authHeaders, 2, customerIndex); });
                await timed('return', async () => {
                    const response = await fetch(`${baseUrl}/api/returns`, {
                        method: 'POST',
                        headers: { ...authHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ invoiceId: invoiceA, weightGrams: 2, refundMode: 'cash' })
                    });
                    if (!response.ok) throw new Error(`Mixed-till return failed: HTTP ${response.status} — ${await response.text()}`);
                    await response.arrayBuffer();
                });
                await timed('void', async () => {
                    const response = await fetch(`${baseUrl}/api/sales/${encodeURIComponent(invoiceB)}/void`, {
                        method: 'POST',
                        headers: { ...authHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason: 'Benchmark mixed-till void' })
                    });
                    if (!response.ok) throw new Error(`Mixed-till void failed: HTTP ${response.status} — ${await response.text()}`);
                    await response.arrayBuffer();
                });
                await timed('advance deposit', async () => {
                    const response = await fetch(`${baseUrl}/api/advances`, {
                        method: 'POST',
                        headers: { ...authHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            customerPhone: ADVANCE_BENCHMARK_PHONE, customerName: 'Benchmark Mixed-Till Customer',
                            amount: 50, paymentMethod: 'Cash', referenceId: `BENCH-MIXED-${tillIndex}-${iteration}-${Date.now()}`
                        })
                    });
                    if (!response.ok) throw new Error(`Mixed-till advance deposit failed: HTTP ${response.status} — ${await response.text()}`);
                    await response.arrayBuffer();
                });
            } catch (error) {
                firstError = error;
                return;
            }
        }
    }

    await Promise.all(Array.from({ length: tills }, (_, tillIndex) => till(tillIndex)));
    if (firstError) throw firstError;

    const elapsedMs = performance.now() - startedAt;
    const totalOps = Object.values(latenciesByKind).reduce((sum, list) => sum + list.length, 0);
    const breakdown = {};
    for (const [kind, list] of Object.entries(latenciesByKind)) {
        const sorted = [...list].sort((a, b) => a - b);
        breakdown[kind] = {
            samples: sorted.length,
            latencyMs: {
                min: rounded(sorted[0]),
                p50: rounded(percentile(sorted, 0.50)),
                p95: rounded(percentile(sorted, 0.95)),
                p99: rounded(percentile(sorted, 0.99)),
                max: rounded(sorted[sorted.length - 1])
            }
        };
    }
    return {
        name: 'Mixed-till (sale + sale + return + void + advance deposit per cycle)',
        tills, iterationsPerTill, totalOps,
        elapsedMs: rounded(elapsedMs),
        throughputPerSecond: rounded(totalOps / (elapsedMs / 1000)),
        breakdown
    };
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-benchmark-'));
    let child = null;
    try {
        const started = await startServer(tempRoot);
        child = started.child;
        const count = QUICK
            ? {
                health: 50, static: 30, concurrent: 100,
                seedCustomers: 10, seedInvoicesPerCustomer: 2,
                checkout: 20, checkoutConcurrent: 20, lookup: 20, pagedLedger: 20,
                returnSamples: 10, voidSamples: 10, stockAdjust: 20, paymentDeposit: 20,
                mixedTills: 3, mixedIterationsPerTill: 2
            }
            : {
                health: 250, static: 100, concurrent: 500,
                seedCustomers: 40, seedInvoicesPerCustomer: 5,
                checkout: 100, checkoutConcurrent: 100, lookup: 100, pagedLedger: 100,
                returnSamples: 30, voidSamples: 30, stockAdjust: 100, paymentDeposit: 100,
                mixedTills: 5, mixedIterationsPerTill: 5
            };

        // Warm server, JIT, module cache and local TCP path outside the measured samples.
        await measure(started.baseUrl, { name: 'warmup', path: '/api/health', samples: 10, concurrency: 1 });

        // UNAUTHENTICATED, EMPTY-TENANT BASELINE. Measured before any seeding
        // touches this tenant, so these four numbers stay exactly what they
        // always were: the cost of the server and static assets alone.
        const unauthenticatedScenarios = [
            { name: 'GET /api/health serial', path: '/api/health', samples: count.health, concurrency: 1 },
            { name: 'GET / static HTML serial', path: '/', samples: count.static, concurrency: 1 },
            { name: 'GET /js/app.js serial', path: '/js/app.js', samples: count.static, concurrency: 1 },
            { name: 'GET /api/health concurrent', path: '/api/health', samples: count.concurrent, concurrency: 25 }
        ];
        const results = [];
        for (const scenario of unauthenticatedScenarios) {
            results.push(await measure(started.baseUrl, scenario));
        }

        // AUTHENTICATED WORKLOAD AGAINST A SEEDED MERCHANT DATASET. Everything
        // above this line ran against an empty tenant; everything below runs
        // as the store owner against a tenant that now has a real ledger.
        const authHeaders = await authenticate(started.baseUrl);
        const seed = await seedMerchantDataset(started.baseUrl, authHeaders, {
            customerCount: count.seedCustomers, invoicesPerCustomer: count.seedInvoicesPerCustomer
        });

        const authenticatedScenarios = [
            {
                name: 'POST /api/sales authenticated checkout serial', method: 'POST', path: '/api/sales',
                headers: authHeaders, body: () => buildSalePayload(2, 0), samples: count.checkout, concurrency: 1
            },
            {
                name: 'POST /api/sales authenticated checkout concurrent (5 tills)', method: 'POST', path: '/api/sales',
                headers: authHeaders, body: () => buildSalePayload(2, 0), samples: count.checkoutConcurrent, concurrency: 5
            },
            {
                // 'Benchmark' matches every seeded customer's name, so this
                // returns a real, non-trivial page rather than the near-empty
                // result an exact single-phone match would.
                name: 'GET /api/sales/lookup authenticated (seeded dataset)', path: '/api/sales/lookup?q=Benchmark&limit=50',
                headers: authHeaders, samples: count.lookup, concurrency: 1
            },
            {
                name: 'GET /api/sales authenticated paged ledger (seeded dataset)', path: '/api/sales?limit=50',
                headers: authHeaders, samples: count.pagedLedger, concurrency: 1
            }
        ];
        for (const scenario of authenticatedScenarios) {
            results.push(await measure(started.baseUrl, scenario));
        }

        // RETURN / VOID / STOCK / PAYMENT WORKLOADS. Each return and void
        // consumes the one disposable invoice it acts on, so those pools are
        // seeded one-for-one with the sample count rather than reused.
        const returnInvoiceIds = await seedDisposableInvoices(started.baseUrl, authHeaders, count.returnSamples);
        const voidInvoiceIds = await seedDisposableInvoices(started.baseUrl, authHeaders, count.voidSamples);
        const stockLotId = await seedStockLot(started.baseUrl, authHeaders);

        const singlePathScenarios = [
            {
                name: 'POST /api/returns authenticated (cash refund)', method: 'POST',
                path: '/api/returns', headers: authHeaders,
                body: (index) => JSON.stringify({ invoiceId: returnInvoiceIds[index], weightGrams: 2, refundMode: 'cash' }),
                samples: count.returnSamples, concurrency: 1
            },
            {
                name: 'POST /api/sales/:id/void authenticated (same-day void)', method: 'POST',
                path: (index) => `/api/sales/${encodeURIComponent(voidInvoiceIds[index])}/void`, headers: authHeaders,
                body: JSON.stringify({ reason: 'Benchmark same-day void' }),
                samples: count.voidSamples, concurrency: 1
            },
            {
                // A small positive delta only — this measures write throughput
                // under the same BEGIN IMMEDIATE lock every other mutation uses,
                // not stock-floor business rules, so it can never legitimately fail.
                name: 'POST /api/inventory/lots/:id/adjust authenticated (physical-count top-up)', method: 'POST',
                path: `/api/inventory/lots/${stockLotId}/adjust`, headers: authHeaders,
                body: JSON.stringify({ weightDeltaGrams: 0.1 }),
                samples: count.stockAdjust, concurrency: 1
            },
            {
                name: 'POST /api/advances authenticated (counter deposit)', method: 'POST',
                path: '/api/advances', headers: authHeaders,
                body: (index) => JSON.stringify({
                    customerPhone: ADVANCE_BENCHMARK_PHONE, customerName: 'Benchmark Advance Customer',
                    amount: 50, paymentMethod: 'Cash', referenceId: `BENCH-ADV-${index}-${Date.now()}`
                }),
                samples: count.paymentDeposit, concurrency: 1
            }
        ];
        for (const scenario of singlePathScenarios) {
            results.push(await measure(started.baseUrl, scenario));
        }

        // MIXED-TILL: several concurrent workers each running a different mix
        // of write paths (sale/return/void/advance) against the same ledger,
        // rather than every worker hammering one endpoint — the scenario the
        // single-endpoint measurements above cannot show.
        const mixedTill = await measureMixedTill(started.baseUrl, authHeaders, {
            tills: count.mixedTills, iterationsPerTill: count.mixedIterationsPerTill
        });

        const report = {
            formatVersion: 2,
            generatedAt: new Date().toISOString(),
            mode: QUICK ? 'quick' : 'baseline',
            runtime: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
                logicalCpuCount: os.cpus().length,
                totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024)
            },
            seed,
            scope: 'Warm loopback only. The four "empty tenant" results run before seeding; the '
                + 'checkout/lookup/paged-ledger/return/void/stock-adjust/advance-deposit results run '
                + 'authenticated, against the seeded merchant dataset described in "seed" '
                + `(${seed.customerCount} customers, ${seed.invoiceCount} invoices); "mixedTill" runs `
                + 'several concurrent tills each mixing sale/return/void/advance-deposit writes against '
                + 'the same ledger. Still no claim about browser rendering, scanner/scale/printer '
                + 'hardware, a low-end counter, real network latency, VPS capacity, disk pressure, or a '
                + 'representative production-scale tenant (this seed is tens, not thousands, of invoices).',
            results,
            mixedTill
        };

        const json = JSON.stringify(report, null, 2);
        if (outputFile) {
            const resolved = path.resolve(outputFile);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, json + '\n', 'utf8');
            console.log(`Benchmark evidence written to ${resolved}`);
        }
        console.log(json);
    } finally {
        await stopServer(child);
        // This exact directory was created by mkdtemp above; merchant data is
        // never a child of it. Removing it keeps repeated benchmark runs clean.
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(`Benchmark failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
