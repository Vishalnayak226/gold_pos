/**
 * Browser-side counter performance trace.
 *
 * benchmark.js measures the server's own HTTP throughput; this is its
 * counterpart for what a cashier actually waits on inside the browser tab —
 * keyboard/scanner input reaching the on-screen total, tab transitions
 * between screens, and the invoice preview rendering — over a real Chromium
 * page driven by Playwright, which this project already depends on for its
 * E2E suite (CLAUDE.md §0's one exempt devDependency). No new dependency.
 *
 * This is a baseline tool, not proof of a specific low-end counter, real
 * scanner/printer hardware, or a full 8-hour shift — see the `scope` field
 * in its own JSON output for exactly what it does and does not claim.
 * `--minutes` controls how long the cycle repeats; the default is a short
 * smoke run. A real soak is `--minutes 480`, started deliberately (it holds
 * a Chromium process and a server process open for the full duration) and
 * is not something this tool runs unattended by default.
 *
 * It boots the real server as a child process with its own temporary
 * tenant, drives it through a real browser tab, and removes the tenant on
 * exit. It never imports db.js in this process and therefore cannot touch
 * merchant data.
 *
 * Usage:
 *   npm run perf-trace
 *   npm run perf-trace -- --minutes 480 --output C:\\evidence\\perf-trace.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';
import {
    BENCHMARK_SETTINGS, startServer, stopServer, percentile, rounded
} from './benchmarkHarness.js';

const MINUTES_INDEX = process.argv.indexOf('--minutes');
const requestedMinutes = MINUTES_INDEX === -1 ? 2 : Number(process.argv[MINUTES_INDEX + 1]);
if (!Number.isFinite(requestedMinutes) || requestedMinutes < 0) {
    throw new Error('--minutes requires a non-negative number.');
}
const OUTPUT_INDEX = process.argv.indexOf('--output');
const outputFile = OUTPUT_INDEX === -1 ? null : process.argv[OUTPUT_INDEX + 1];
if (OUTPUT_INDEX !== -1 && (!outputFile || outputFile.startsWith('--'))) {
    throw new Error('--output requires a destination filename.');
}

/** Every timed sample is pushed here, keyed by what it measured. */
function bucketRecorder() {
    const buckets = {};
    return {
        record(label, ms) {
            (buckets[label] || (buckets[label] = [])).push(ms);
        },
        finalize() {
            const out = {};
            for (const [label, list] of Object.entries(buckets)) {
                const sorted = [...list].sort((a, b) => a - b);
                out[label] = {
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
            return out;
        }
    };
}

async function waitForTextChange(page, selector, previousText, timeoutMs) {
    await page.waitForFunction(
        ({ selector, previousText }) => {
            const el = document.querySelector(selector);
            return !!el && el.textContent !== previousText;
        },
        { selector, previousText },
        { timeout: timeoutMs }
    );
}

async function loginAndOpenBillingDesk(page, baseUrl) {
    await page.goto(baseUrl);
    await page.fill('#admin-pin-input', BENCHMARK_SETTINGS.adminPin);
    await page.click('#admin-login-btn');
    await page.locator('#app-viewport').waitFor({ state: 'visible' });
    await page.click('button[data-target="sales-tab"]');
    await page.locator('#sales-tab').waitFor({ state: 'attached' });
    await page.waitForFunction(
        () => document.querySelector('#sales-tab')?.getAttribute('data-desk-ready') === 'true'
    );
}

/**
 * One shift-like cycle: switch through several other screens and back to
 * Billing (screen-transition cost), scan a barcode (server round trip),
 * then correct the weight by hand (pure client-side recalculation and
 * invoice-preview render). Every step times itself independently so a
 * regression in one specific path is visible rather than averaged away.
 */
async function runCycle(page, recorder, cycleIndex) {
    const tabTargets = ['dashboard-tab', 'advances-tab', 'settings-tab', 'sales-tab'];
    for (const target of tabTargets) {
        const startedAt = performance.now();
        await page.click(`button[data-target="${target}"]`);
        await page.locator(`#${target}`).waitFor({ state: 'visible' });
        recorder.record(`tab transition: -> ${target}`, performance.now() - startedAt);
    }

    // SCANNER INPUT: a barcode does not need to match a real item — this
    // measures the round trip from a scanned code hitting the server's
    // lookup endpoint to the status line settling, not a successful match.
    // Every not-found lookup ends on the same generic message, so a
    // "wait for the text to differ from before" check would hang from the
    // second cycle on; lookupSku() sets a distinct 'Looking up…' placeholder
    // synchronously before its request goes out, so waiting for the status
    // to move PAST that placeholder is what actually times the request,
    // regardless of what either lookup's final text says.
    const skuInput = page.locator('#billing-sku');
    await skuInput.fill('');
    await skuInput.pressSequentially(`BENCH-SCAN-${cycleIndex}`, { delay: 15 });
    const scanTypedAt = performance.now();
    await skuInput.press('Enter');
    await page.waitForFunction(
        () => document.querySelector('#billing-sku-status')?.textContent !== 'Looking up catalogue item…',
        { timeout: 5000 }
    );
    recorder.record('scanner: barcode lookup round trip', performance.now() - scanTypedAt);

    // KEYBOARD INPUT -> TOTAL RECALCULATION: a purely client-side path
    // (BillingDesk.js recomputes on every 'input' event), and separately,
    // the invoice preview sheet a cashier is about to print re-rendering.
    // The weight must be unique for every cycle in the whole run, not just
    // per short cycle, or a later cycle can land on an earlier cycle's exact
    // total/preview text and the "wait for it to change" check never fires.
    const totalBefore = await page.locator('#sum-grand-total').textContent();
    const previewBefore = await page.locator('#preview-line-rows').textContent();
    const weightInput = page.locator('#gold-weight');
    await weightInput.fill('');
    const weightValue = (2 + cycleIndex * 0.003).toFixed(3);
    await weightInput.pressSequentially(weightValue, { delay: 20 });
    const weightTypedAt = performance.now();
    await waitForTextChange(page, '#sum-grand-total', totalBefore, 5000);
    recorder.record('keyboard: weight -> total recalculation', performance.now() - weightTypedAt);
    await waitForTextChange(page, '#preview-line-rows', previewBefore, 5000);
    recorder.record('print preparation: invoice preview re-render', performance.now() - weightTypedAt);
}

async function main() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-perf-trace-'));
    let child = null;
    let browser = null;
    try {
        const started = await startServer(tempRoot);
        child = started.child;

        browser = await chromium.launch();
        const page = await browser.newPage();
        page.on('pageerror', err => { throw new Error(`Uncaught page error: ${err.message}`); });
        await loginAndOpenBillingDesk(page, started.baseUrl);

        const recorder = bucketRecorder();
        const heapSamplesBytes = [];
        const deadline = Date.now() + requestedMinutes * 60_000;
        const runStartedAt = performance.now();
        let cyclesCompleted = 0;

        // At least one cycle always runs, even at --minutes 0, so the tool
        // is still useful as a quick correctness smoke check on its own.
        do {
            await runCycle(page, recorder, cyclesCompleted);
            cyclesCompleted++;
            const heapBytes = await page.evaluate(() => (
                // Chromium-only (non-standard) API — this tool only ever
                // launches chromium, so it is always present here.
                performance.memory ? performance.memory.usedJSHeapSize : null
            ));
            if (heapBytes !== null) heapSamplesBytes.push(heapBytes);
        } while (Date.now() < deadline);

        const actualElapsedMs = rounded(performance.now() - runStartedAt);
        const browserVersion = browser.version();

        const report = {
            formatVersion: 1,
            generatedAt: new Date().toISOString(),
            mode: requestedMinutes === 0 ? 'smoke' : 'timed',
            requestedMinutes,
            actualElapsedMs,
            cyclesCompleted,
            runtime: {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                chromiumVersion: browserVersion
            },
            heapTrace: heapSamplesBytes.length === 0 ? null : {
                samples: heapSamplesBytes.length,
                firstBytes: heapSamplesBytes[0],
                lastBytes: heapSamplesBytes[heapSamplesBytes.length - 1],
                maxBytes: Math.max(...heapSamplesBytes),
                growthBytes: heapSamplesBytes[heapSamplesBytes.length - 1] - heapSamplesBytes[0]
            },
            scope: 'One headless Chromium tab on this dev machine against a warm loopback server, '
                + `${cyclesCompleted} cycle(s) over ${actualElapsedMs}ms. Each cycle switches through `
                + 'four admin screens, scans a barcode (a real round trip to the lookup endpoint, not '
                + 'necessarily a matching item), then hand-corrects a weight and times the client-side '
                + 'recalculation and invoice-preview re-render. heapTrace is a same-tab JS heap growth '
                + 'proxy for a leak, sampled once per cycle — not a full memory/open-handle profiler '
                + 'trace. No claim about a real low-end counter, real scanner/scale/printer hardware, '
                + 'network latency, or a genuine 8-hour shift: that needs `--minutes 480` run '
                + 'deliberately, on the actual target hardware, not this default short smoke window.',
            breakdown: recorder.finalize()
        };

        const json = JSON.stringify(report, null, 2);
        if (outputFile) {
            const resolved = path.resolve(outputFile);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, json + '\n', 'utf8');
            console.log(`Perf trace evidence written to ${resolved}`);
        }
        console.log(json);
    } finally {
        if (browser) await browser.close();
        await stopServer(child);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(`Perf trace failed: ${error.stack || error.message}`);
    process.exitCode = 1;
});
