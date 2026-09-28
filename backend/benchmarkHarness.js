/**
 * Shared ephemeral-server harness for the performance tools (benchmark.js,
 * perfTrace.js). Both need the exact same thing — boot the real server as a
 * child process against its own throwaway tenant, wait for it to become
 * healthy, and tear it down cleanly — so it lives once here rather than as
 * two copies that would drift (CLAUDE.md §1: never a parallel third way).
 *
 * Never imports db.js in this process and therefore cannot touch merchant
 * data. No runtime dependency is required.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* The one source of truth for the benchmark tenant's PIN, tax and rate
   configuration — seedBenchmarkTenant() writes it to disk and any caller
   pricing a request against it reads the same constants, so the two can
   never drift the way two copies of the same numbers eventually do. */
export const BENCHMARK_SETTINGS = {
    companyName: 'Benchmark Tenant',
    adminPin: '2468',
    goldTaxSlab: 3,
    taxMode: 'Exclusive',
    invoicePrefix: 'PERF',
    invoiceSeqStart: 1
};
export const BENCHMARK_RATES = { price24K: 7500, price22K: 6875, price18K: 5600 };

export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function getFreePort() {
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
export function seedBenchmarkTenant(dataDir) {
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

/**
 * Boots backend/server.js as a child process against a fresh temp tenant
 * under `tempRoot`, waits until GET /api/health answers, and returns the
 * child handle plus its base URL. `extraEnv` lets a caller add its own
 * environment overrides (e.g. a slower rate limiter) without this module
 * needing to know about every caller's needs.
 */
export async function startServer(tempRoot, extraEnv = {}) {
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
            // runaway automation against a real store, not to cap how fast a
            // performance tool may measure the server's own throughput. Raised
            // only for this ephemeral process; the tuning is a router concern
            // and already covered by its own rate-limit tests.
            API_RATE_MAX: String(process.env.API_RATE_MAX || 50_000),
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => output.push(chunk.toString()));
    child.stderr.on('data', chunk => output.push(chunk.toString()));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited early:\n${output.join('')}`);
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
    throw new Error(`Server did not become healthy within 30 seconds:\n${output.join('')}`);
}

export async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), wait(10_000).then(() => false)]);
    if (graceful) return;
    child.kill('SIGKILL');
    await once(child, 'exit');
}

/** The value at `ratio` through an already-ascending-sorted array (e.g. 0.95 for p95). */
export function percentile(sorted, ratio) {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function rounded(value) {
    return Math.round(value * 100) / 100;
}
