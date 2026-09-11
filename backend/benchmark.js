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
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { computeMetalValue, computeInvoiceTotals } from '../frontend/js/lib/billingMath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUICK = process.argv.includes('--quick');
const OUTPUT_INDEX = process.argv.indexOf('--output');
const outputFile = OUTPUT_INDEX === -1 ? null : process.argv[OUTPUT_INDEX + 1];

if (OUTPUT_INDEX !== -1 && (!outputFile || outputFile.startsWith('--'))) {
    throw new Error('--output requires a destination filename.');
}

/* The one source of truth for this tenant's PIN, tax and rate configuration —
   seedBenchmarkTenant() writes it to disk and buildSalePayload() prices
   against it, so the two can never drift the way two copies of the same
   numbers eventually do. */
const BENCHMARK_SETTINGS = {
    companyName: 'Benchmark Tenant',
    adminPin: '2468',
    goldTaxSlab: 3,
    taxMode: 'Exclusive',
    invoicePrefix: 'PERF',
    invoiceSeqStart: 1
};
const BENCHMARK_RATES = { price24K: 7500, price22K: 6875, price18K: 5600 };

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(error => error ? reject(error) : resolve(port));
        });
    });
}

/** A valid, deliberately uninteresting tenant that opens the license gate. */
function seedBenchmarkTenant(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(BENCHMARK_SETTINGS, null, 2));
    fs.writeFileSync(path.join(dataDir, 'rates.json'), JSON.stringify({
        lastUpdated: new Date().toISOString(),
        status: 'fixture', ...BENCHMARK_RATES
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'license.json'), JSON.stringify({
        licenseKey: 'PERFORMANCE-BENCHMARK',
        activated: true,
        status: 'active',
        expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        lastHandshakeTime: Date.now()
    }, null, 2));
}

function percentile(sorted, ratio) {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function rounded(value) {
    return Math.round(value * 100) / 100;
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
 * valid invoice rather than one replayed body.
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
            try {
                const response = await fetch(baseUrl + scenario.path, {
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
        path: scenario.path,
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

async function startServer(tempRoot) {
    const port = await getFreePort();
    const dataDir = path.join(tempRoot, 'data');
    const logsDir = path.join(tempRoot, 'logs');
    seedBenchmarkTenant(dataDir);
    fs.mkdirSync(logsDir, { recursive: true });

    const output = [];
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        cwd: tempRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            GOLDPOS_DATA_DIR: dataDir,
            GOLDPOS_LOGS_DIR: logsDir,
            PORT: String(port),
            // The blanket per-minute API_RATE_MAX (600 by default) exists to stop
            // runaway automation against a real store, not to cap how fast this
            // harness may measure the server's own throughput. Raised only for
            // this ephemeral benchmark process; the tuning is a router concern
            // and already covered by its own rate-limit tests.
            API_RATE_MAX: String(process.env.API_RATE_MAX || 50_000)
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => output.push(chunk.toString()));
    child.stderr.on('data', chunk => output.push(chunk.toString()));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Benchmark server exited early:\n${output.join('')}`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/health`);
            if (response.ok) return { child, baseUrl };
        } catch (_) {
            // The process is still opening its SQLite store or TCP listener.
        }
        await wait(100);
    }
    child.kill();
    throw new Error(`Benchmark server did not become healthy within 30 seconds:\n${output.join('')}`);
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), wait(10_000).then(() => false)]);
    if (graceful) return;
    child.kill('SIGKILL');
    await once(child, 'exit');
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
                checkout: 20, checkoutConcurrent: 20, lookup: 20, pagedLedger: 20
            }
            : {
                health: 250, static: 100, concurrent: 500,
                seedCustomers: 40, seedInvoicesPerCustomer: 5,
                checkout: 100, checkoutConcurrent: 100, lookup: 100, pagedLedger: 100
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
                + 'checkout/lookup/paged-ledger results run authenticated, against the seeded merchant '
                + `dataset described in "seed" (${seed.customerCount} customers, ${seed.invoiceCount} invoices). `
                + 'Still no claim about browser rendering, scanner/scale/printer hardware, a low-end '
                + 'counter, real network latency, VPS capacity or return/void/mixed-concurrency workloads.',
            results
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
