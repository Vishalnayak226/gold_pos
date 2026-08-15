/**
 * ==========================================================================
 * Playwright fixtures — a real server, a seeded database, both disposable.
 *
 * Every spec gets its own server process on its own ephemeral port, backed by
 * a freshly seeded copy of backend/seed.js's dataset in a temp directory.
 * Nothing here reads or writes backend/data/, and nothing binds :5000, so an
 * E2E run cannot corrupt a developer's data or collide with the dev server
 * they left running (CLAUDE.md §8).
 *
 * Because the data is seeded rather than accumulated, assertions can name
 * exact figures — "Aarti's balance is ₹20,000" — instead of the vague
 * "something greater than zero" checks that pass against a broken ledger.
 * ==========================================================================
 */

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '../..');

/** An OS-assigned free port, released immediately before the server claims it. */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function waitForHealth(baseUrl, child, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited early with code ${child.exitCode}.`);
        }
        try {
            const res = await fetch(`${baseUrl}/api/health`);
            if (res.ok) return;
        } catch (_) {
            // Not listening yet.
        }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Server did not become healthy at ${baseUrl} within ${timeoutMs}ms.`);
}

export const test = base.extend({
    /**
     * A booted Gold POS server over a seeded, throwaway database.
     * Worker-scoped would be faster, but these journeys mutate the ledger —
     * a per-test database is what keeps each spec's assertions absolute.
     */
    posServer: async ({}, use, testInfo) => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-e2e-'));
        const dataDir = path.join(tempRoot, 'data');
        const logsDir = path.join(tempRoot, 'logs');

        // Imported, not shelled out to: the seeder is a module precisely so a
        // fixture can build a database in-process against an explicit target.
        const { seed } = await import('../../seed.js');
        const seeded = await seed({ out: dataDir });

        const port = await findFreePort();
        const baseUrl = `http://127.0.0.1:${port}`;

        const child = spawn(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR,
            env: {
                ...process.env,
                PORT: String(port),
                // Explicitly NOT production: the seeded dataset uses demo
                // Razorpay keys and a mock price provider, which is exactly
                // what productionGuard.js exists to refuse to boot.
                NODE_ENV: 'test',
                GOLD_POS_DATA_DIR: dataDir,
                GOLD_POS_LOGS_DIR: logsDir
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let serverLog = '';
        child.stdout.on('data', chunk => { serverLog += chunk; });
        child.stderr.on('data', chunk => { serverLog += chunk; });

        try {
            await waitForHealth(baseUrl, child);
            await use({
                baseUrl,
                dataDir,
                seeded,
                /**
                 * Reads a CONFIGURATION file straight off disk.
                 *
                 * Only `settings.json` and `license.json` still live here —
                 * configuration stayed JSON on purpose (CLAUDE.md §0). The
                 * ledger did not: reaching for `sales_2026.json` through this
                 * helper reads the importer's frozen seed, not the journey's
                 * own work. Use `readLedger()` for anything the store files.
                 */
                readData(filename) {
                    return JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8'));
                },

                /**
                 * Reads a ledger collection out of THIS test's SQLite database,
                 * in the wire shape the routes serve.
                 *
                 * One of: sales, returns, advances, customerAccounts,
                 * paymentOrders (which takes a customer phone). Rows come back
                 * NEWEST FIRST, matching `ORDER BY issued_at DESC` in the
                 * repositories — so the row a journey just filed is [0].
                 *
                 * Runs out of process; see readLedger.mjs for why that is not
                 * an optimisation but a correctness requirement.
                 */
                readLedger(collection, argument = '') {
                    const out = execFileSync(
                        process.execPath,
                        [path.join(BACKEND_DIR, 'tests', 'e2e', 'readLedger.mjs'), dataDir, collection, String(argument)],
                        { env: { ...process.env, GOLD_POS_DATA_DIR: dataDir, GOLD_POS_LOGS_DIR: logsDir }, encoding: 'utf8' }
                    );
                    return JSON.parse(out);
                }
            });
        } finally {
            // A failing spec is far easier to diagnose with the server's own
            // output attached than with a bare timeout.
            if (testInfo.status !== testInfo.expectedStatus && serverLog) {
                await testInfo.attach('server-output', { body: serverLog, contentType: 'text/plain' });
            }
            child.kill();
            await new Promise(resolve => child.once('exit', resolve));
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    },

    /** A page already pointed at this test's server. */
    page: async ({ page, posServer }, use) => {
        // Surfaces a console error as a readable failure rather than as a
        // mystery timeout further down the spec.
        page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });
        await page.goto(posServer.baseUrl);
        await use(page);
    }
});

/**
 * Waits for the app's notification modal, returns its text, and dismisses it.
 *
 * Both index.html and customer.html override `window.alert` with an in-page
 * `#custom-alert-box` overlay, so there is no native dialog for
 * `page.on('dialog')` to catch — and until the overlay is dismissed it covers
 * the viewport and swallows every subsequent click. Reading it through this
 * helper is therefore both how a spec asserts on a message and how it unblocks
 * the page for the next action.
 *
 * The override also early-returns while a box is already open, which means an
 * undismissed alert silently discards the next one. Specs must read each
 * message as it appears rather than batching them up at the end.
 */
export async function readAlert(page) {
    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    const message = (await box.locator('p').innerText()).trim();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toBeHidden();
    return message;
}

/** Signs in to the admin terminal with the seeded PIN. */
export async function loginAsAdmin(page, posServer) {
    await page.goto(posServer.baseUrl);
    await page.fill('#admin-pin-input', posServer.seeded.adminPin);
    await page.click('#admin-login-btn');
    await expect(page.locator('#app-viewport')).toBeVisible();
}

/** Signs in to the customer portal as one of the seeded customers. */
export async function loginAsCustomer(page, posServer, index = 0) {
    const customer = posServer.seeded.customers[index];
    await page.goto(`${posServer.baseUrl}/customer.html`);
    await page.fill('#login-phone', customer.phone);
    await page.fill('#login-password', customer.password);
    await page.click('#login-submit-btn');
    return customer;
}

export { expect };
