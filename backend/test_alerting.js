/**
 * ==========================================================================
 * Operational alerting suite (docs/PRODUCTION_READINESS_ROADMAP.md Phase 3,
 * "Alert on payment/webhook failures, ledger imbalance, backup failure,
 * stale rates, error/latency, capacity, TLS expiry and control-plane
 * failure").
 *
 * alerting.js is the one choke point (raiseAlert) every one of those signals
 * goes through. This suite exercises the periodic checks directly rather
 * than driving them through a live HTTP request or a real cron tick — the
 * webhook/payment-failure alert calls themselves are exercised in place by
 * test_http.js (they fire alongside the existing failure-path assertions
 * there; this suite is not a duplicate of that coverage).
 *
 * GOLD_POS_DATA_DIR/LOGS_DIR/BACKUPS_DIR are set on the FIRST line for the
 * reason CLAUDE.md §8 spells out: db.js resolves DATA_DIR once at import and
 * ESM caches it, so setting it later would point this suite at the tenant's
 * real ledger. checkBackupFreshness() reads the real `backups/` directory by
 * default (same as backupEngine.js), so GOLD_POS_BACKUPS_DIR is set too —
 * without it this suite would report on the tenant's actual backup history.
 *
 * Native assert only. Zero extra dependencies.
 * ==========================================================================
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-alerting-'));
process.env.GOLD_POS_DATA_DIR = path.join(TEMP_ROOT, 'data');
process.env.GOLD_POS_LOGS_DIR = path.join(TEMP_ROOT, 'logs');
process.env.GOLD_POS_BACKUPS_DIR = path.join(TEMP_ROOT, 'backups');

const assert = (await import('assert')).default;
const { DATA_DIR, writeJSON } = await import('./db.js');
const repo = await import('./repositories/index.js');
const alerting = await import('./alerting.js');

let passed = 0;
function check(label, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed++;
            console.log(`  ✅ ${label}`);
        });
}

console.log('======================================================================');
console.log('OPERATIONAL ALERTING SUITE');
console.log('======================================================================');

/* --------------------------------------------------------------------------
   1. raiseAlert: the choke point every check funnels through
   -------------------------------------------------------------------------- */

await check('raiseAlert cools down per code, not globally', async () => {
    const first = await alerting.raiseAlert({ code: 'TEST_CODE_A', message: 'first' });
    assert.notStrictEqual(first.reason, 'cooldown', 'the first alert for a fresh code must not be suppressed');

    const second = await alerting.raiseAlert({ code: 'TEST_CODE_A', message: 'second, immediately after' });
    assert.strictEqual(second.sent, false);
    assert.strictEqual(second.reason, 'cooldown');

    // A different code is unaffected by TEST_CODE_A's cooldown.
    const other = await alerting.raiseAlert({ code: 'TEST_CODE_B', message: 'unrelated code' });
    assert.notStrictEqual(other.reason, 'cooldown');
});

/* --------------------------------------------------------------------------
   2. Stale gold rates
   -------------------------------------------------------------------------- */

const RATES_FILE = path.join(DATA_DIR, 'rates.json');

await check('checkStaleRates does nothing when no rates file exists yet', () => {
    assert.deepStrictEqual(alerting.checkStaleRates(), []);
});

await check('checkStaleRates leaves a fresh sync alone', () => {
    writeJSON(RATES_FILE, { lastUpdated: new Date().toISOString(), price24K: 7500 });
    assert.deepStrictEqual(alerting.checkStaleRates(), []);
});

await check('checkStaleRates flags a sync older than the threshold', () => {
    const fortyHoursAgo = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
    writeJSON(RATES_FILE, { lastUpdated: fortyHoursAgo, price24K: 7500 });
    assert.deepStrictEqual(alerting.checkStaleRates(), ['GOLD_RATE_STALE']);
});

/* --------------------------------------------------------------------------
   3. Ledger integrity — audit chain + per-invoice line drift
   -------------------------------------------------------------------------- */

const { tenantId, branchId } = repo.dataStoreContext();
const db = repo.unsafeDatabaseHandle();
const NOW = Date.now();

await check('checkLedgerIntegrity is clean on a freshly bootstrapped, invoice-free ledger', () => {
    assert.deepStrictEqual(alerting.checkLedgerIntegrity(), []);
});

function insertRow(table, row) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(',');
    return db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`)
        .run(...columns.map(column => row[column]));
}

await check('checkLedgerIntegrity is still clean once a well-formed invoice exists', () => {
    insertRow('invoices', {
        id: 'ALERT-INV-1', tenant_id: tenantId, branch_id: branchId, invoice_number: 'ALERT-000001-26',
        financial_year: '2026-27', sequence_value: 901, customer_name: 'Test Customer',
        metal_value_paise: 5000000, taxable_amount_paise: 5000000, tax_amount_paise: 150000,
        total_amount_paise: 5150000, issued_at: NOW, business_date: '2026-08-19'
    });
    insertRow('invoice_lines', {
        id: 'ALERT-IL-1', invoice_id: 'ALERT-INV-1', line_number: 1, purity: '22K',
        weight_mg: 8500, rate_paise_per_g: 687500, metal_value_paise: 5000000,
        taxable_amount_paise: 5000000, tax_amount_paise: 150000, line_total_paise: 5150000
    });
    assert.deepStrictEqual(alerting.checkLedgerIntegrity(), []);
});

await check('checkLedgerIntegrity catches an invoice whose lines no longer sum to its header', () => {
    // Simulates the exact tamper/corruption scenario the invariant guards
    // against (CLAUDE.md §0) — bypassing the app layer on purpose, the same
    // way test_schema.js and verifyBackup.js do to prove the check works.
    db.prepare('UPDATE invoice_lines SET taxable_amount_paise = ? WHERE id = ?')
        .run(4000000, 'ALERT-IL-1');
    assert.deepStrictEqual(alerting.checkLedgerIntegrity(), ['LEDGER_LINE_DRIFT']);
    // Restore, so this check does not leak state into the ones after it.
    db.prepare('UPDATE invoice_lines SET taxable_amount_paise = ? WHERE id = ?')
        .run(5000000, 'ALERT-IL-1');
});

/* --------------------------------------------------------------------------
   4. HTTP error-rate / p95 latency window
   -------------------------------------------------------------------------- */

await check('checkErrorRateAndLatency ignores a window too small to judge', () => {
    alerting.recordRequestOutcome(500, 10);
    alerting.recordRequestOutcome(500, 10);
    assert.deepStrictEqual(alerting.checkErrorRateAndLatency(), []);
});

await check('checkErrorRateAndLatency flags an elevated 5xx rate over a large enough window', () => {
    for (let i = 0; i < 15; i++) alerting.recordRequestOutcome(200, 10);
    for (let i = 0; i < 10; i++) alerting.recordRequestOutcome(500, 10);
    assert.deepStrictEqual(alerting.checkErrorRateAndLatency(), ['HTTP_ERROR_RATE']);
});

await check('checkErrorRateAndLatency flags elevated p95 latency independently of error rate', () => {
    for (let i = 0; i < 19; i++) alerting.recordRequestOutcome(200, 50);
    alerting.recordRequestOutcome(200, 5000); // the one slow outlier that should land in p95
    assert.deepStrictEqual(alerting.checkErrorRateAndLatency(), ['HTTP_LATENCY_P95']);
});

await check('checkErrorRateAndLatency resets the window on every call', () => {
    alerting.recordRequestOutcome(200, 10);
    assert.deepStrictEqual(alerting.checkErrorRateAndLatency(), []); // 1 request, below MIN_SAMPLE
});

/* --------------------------------------------------------------------------
   5. Backup freshness
   -------------------------------------------------------------------------- */

await check('checkBackupFreshness flags a missing backups directory', () => {
    assert.deepStrictEqual(alerting.checkBackupFreshness(), ['BACKUP_MISSING']);
});

await check('checkBackupFreshness accepts a snapshot created moments ago', () => {
    const backupsDir = process.env.GOLD_POS_BACKUPS_DIR;
    fs.mkdirSync(path.join(backupsDir, 'backup_2026-08-19'), { recursive: true });
    assert.deepStrictEqual(alerting.checkBackupFreshness(), []);
});

await check('checkBackupFreshness flags a snapshot older than the staleness threshold', () => {
    const backupsDir = process.env.GOLD_POS_BACKUPS_DIR;
    const staleDir = path.join(backupsDir, 'backup_2026-08-01');
    fs.mkdirSync(staleDir, { recursive: true });
    const fortyHoursAgo = new Date(Date.now() - 40 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, fortyHoursAgo, fortyHoursAgo);
    // Also age the fresh one from the previous check so it doesn't mask this.
    fs.utimesSync(path.join(backupsDir, 'backup_2026-08-19'), fortyHoursAgo, fortyHoursAgo);
    assert.deepStrictEqual(alerting.checkBackupFreshness(), ['BACKUP_STALE']);
});

/* --------------------------------------------------------------------------
   6. Disk capacity and TLS expiry — sanity only. Forcing an actual low-disk
   condition or a real expiring certificate isn't practical in a unit suite;
   these confirm the checks run against the live environment without
   throwing, which is what wires them safely into the scheduler.
   -------------------------------------------------------------------------- */

await check('checkDiskCapacity runs against the real data volume without throwing', () => {
    const result = alerting.checkDiskCapacity();
    assert.ok(Array.isArray(result));
});

await check('checkTlsExpiry no-ops when no publicUrl is configured', () => {
    // Fresh install: settings.json has no publicUrl yet. Must not throw or
    // attempt a network connection.
    alerting.checkTlsExpiry();
});

repo.closeDb();
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });

console.log('======================================================================');
console.log(`✅ OPERATIONAL ALERTING SUITE PASSED (${passed} checks)`);
console.log('======================================================================');
