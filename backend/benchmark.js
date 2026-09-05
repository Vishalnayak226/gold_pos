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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUICK = process.argv.includes('--quick');
const OUTPUT_INDEX = process.argv.indexOf('--output');
const outputFile = OUTPUT_INDEX === -1 ? null : process.argv[OUTPUT_INDEX + 1];

if (OUTPUT_INDEX !== -1 && (!outputFile || outputFile.startsWith('--'))) {
    throw new Error('--output requires a destination filename.');
}

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
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
        companyName: 'Benchmark Tenant',
        adminPin: '2468',
        goldTaxSlab: 3,
        taxMode: 'Exclusive',
        invoicePrefix: 'PERF',
        invoiceSeqStart: 1
    }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'rates.json'), JSON.stringify({
        lastUpdated: new Date().toISOString(),
        status: 'fixture', price24K: 7500, price22K: 6875, price18K: 5600
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
 */
async function measure(baseUrl, scenario) {
    const latencies = [];
    const statusCounts = {};
    let byteCount = 0;
    let next = 0;
    let firstError = null;
    const startedAt = performance.now();

    async function worker() {
        while (true) {
            const index = next++;
            if (index >= scenario.samples || firstError) return;
            const started = performance.now();
            try {
                const response = await fetch(baseUrl + scenario.path, {
                    headers: { 'Cache-Control': 'no-cache' }
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
            PORT: String(port)
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
        const count = QUICK ? { health: 50, static: 30, concurrent: 100 } : { health: 250, static: 100, concurrent: 500 };
        const scenarios = [
            { name: 'GET /api/health serial', path: '/api/health', samples: count.health, concurrency: 1 },
            { name: 'GET / static HTML serial', path: '/', samples: count.static, concurrency: 1 },
            { name: 'GET /js/app.js serial', path: '/js/app.js', samples: count.static, concurrency: 1 },
            { name: 'GET /api/health concurrent', path: '/api/health', samples: count.concurrent, concurrency: 25 }
        ];

        // Warm server, JIT, module cache and local TCP path outside the measured samples.
        await measure(started.baseUrl, { name: 'warmup', path: '/api/health', samples: 10, concurrency: 1 });
        const results = [];
        for (const scenario of scenarios) {
            results.push(await measure(started.baseUrl, scenario));
        }

        const report = {
            formatVersion: 1,
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
            scope: 'Warm loopback only; isolated empty tenant; no authenticated checkout, browser rendering, printer, low-end hardware or VPS claim.',
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
