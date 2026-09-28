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
const net = await import('net');
const { DATA_DIR, writeJSON } = await import('./db.js');
const repo = await import('./repositories/index.js');
const alerting = await import('./alerting.js');
const logWriter = await import('./logWriter.js');
const { writeSettings } = await import('./settingsStore.js');
const { getDefaultSettings } = await import('./defaultSettings.js');

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

/* --------------------------------------------------------------------------
   7. Log writer health — a full/unwritable log destination must reach the
   one alert choke point, not just a console nobody is watching. Counters are
   cumulative for the process, so the check must alert on the delta since the
   last tick and never re-alert on a failure already counted.
   -------------------------------------------------------------------------- */

await check('checkLogWriterHealth is clean with no write/rotation/drop activity', () => {
    assert.deepStrictEqual(alerting.checkLogWriterHealth(), []);
});

await check('checkLogWriterHealth flags a new write failure exactly once', async () => {
    const unwritableDir = path.join(TEMP_ROOT, 'no-such-dir');
    const unwritable = path.join(unwritableDir, 'telemetry.log');
    logWriter.enqueueLog(unwritable, 'line\n');
    await logWriter.drainLogWriter();
    assert.ok(logWriter.getLogWriterStats().writeFailures > 0, 'appendFile into a missing directory must count as a write failure');
    assert.deepStrictEqual(alerting.checkLogWriterHealth(), ['LOG_WRITE_FAILING']);
    assert.deepStrictEqual(alerting.checkLogWriterHealth(), [], 'the same already-counted failure must not re-alert on the next tick');

    // The failed line stays queued for a background retry (see logWriter.js's
    // scheduleFlush(retryDelayMs)). Let it succeed and drain fully now, so a
    // later automatic retry can't asynchronously bump writeFailures again
    // during an unrelated check further down this suite.
    fs.mkdirSync(unwritableDir, { recursive: true });
    await logWriter.drainLogWriter();
    assert.equal(logWriter.getLogWriterStats().queuedEntries, 0);
});

await check('checkLogWriterHealth flags dropped entries when the bounded queue overflows', async () => {
    const target = path.join(TEMP_ROOT, 'overflow.log');
    // Default MAX_QUEUE_ENTRIES is 2048; enqueue past it synchronously (no
    // await yields to the 50ms flush timer) so some entries deterministically
    // drop rather than get written.
    for (let i = 0; i < 2100; i++) logWriter.enqueueLog(target, `${i}\n`);
    assert.ok(logWriter.getLogWriterStats().droppedEntries > 0);
    assert.deepStrictEqual(alerting.checkLogWriterHealth(), ['LOG_QUEUE_OVERFLOW']);
    await logWriter.drainLogWriter();
});

/* --------------------------------------------------------------------------
   8. Alert delivery — a real SMTP send, not just the cooldown/flag logic.
   Every check above proves raiseAlert() decides correctly; none of them
   proves an email actually leaves the process, because no prior suite ever
   configures alertEmail/smtp far enough for sendMailIfConfigured() to be
   reached (docs/RUNBOOKS.md §15 "Alert drill" — this is its automated half).
   A minimal in-process SMTP server captures what nodemailer actually sends,
   the same "throwaway local SMTP server" pattern used for the Phase 20.1
   password-reset email — no new dependency, no real network egress.
   -------------------------------------------------------------------------- */

function startFakeSmtpServer() {
    const messages = [];
    const server = net.createServer(socket => {
        let buffer = '';
        let dataMode = false;
        let dataBuffer = '';
        socket.write('220 localhost ESMTP drill\r\n');
        socket.on('data', chunk => {
            if (dataMode) {
                dataBuffer += chunk.toString('utf8');
                const terminator = dataBuffer.indexOf('\r\n.\r\n');
                if (terminator !== -1) {
                    messages.push(dataBuffer.slice(0, terminator));
                    dataMode = false;
                    dataBuffer = '';
                    socket.write('250 OK: queued\r\n');
                }
                return;
            }
            buffer += chunk.toString('utf8');
            let idx;
            while ((idx = buffer.indexOf('\r\n')) !== -1) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const cmd = line.split(' ')[0].toUpperCase();
                if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 localhost\r\n');
                else if (cmd === 'MAIL') socket.write('250 OK\r\n');
                else if (cmd === 'RCPT') socket.write('250 OK\r\n');
                else if (cmd === 'DATA') { dataMode = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
                else if (cmd === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); }
                else socket.write('250 OK\r\n');
            }
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, messages }));
    });
}

const { server: smtpServer, port: smtpPort, messages: capturedMessages } = await startFakeSmtpServer();

writeSettings({
    ...getDefaultSettings(),
    alertEmail: 'oncall@drill.test',
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'drill', pass: 'drill-pass', fromName: 'Alert Drill' }
});

await check('raiseAlert actually delivers a real email through the configured SMTP transport', async () => {
    const result = await alerting.raiseAlert({
        code: 'DRILL_SMTP_LIVE', severity: 'critical', message: 'Alert drill: this is a real send, not a stub.',
        details: { drill: true }
    });
    assert.strictEqual(result.sent, true, result.reason);
    assert.strictEqual(capturedMessages.length, 1);
    // Body is quoted-printable (Content-Transfer-Encoding), which soft-wraps
    // long lines with a literal "=\r\n" — strip that before substring checks
    // so a wrap point landing mid-phrase doesn't produce a false negative.
    const raw = capturedMessages[0].replace(/=\r\n/g, '');
    assert.match(raw, /Subject: =\?UTF-8\?Q\?=5BCRITICAL=5D_DRILL=5FSMTP=5FLIVE/, 'the subject line must reach the wire');
    assert.match(raw, /oncall@drill\.test/i, 'the configured recipient must be the actual envelope/header recipient');
    assert.match(raw, /Alert drill: this is a real send/, 'the message body must contain the real alert text');
});

await check('the per-code cooldown blocks a second real send, not just the return flag', async () => {
    const before = capturedMessages.length;
    const result = await alerting.raiseAlert({ code: 'DRILL_SMTP_LIVE', message: 'second, immediately after' });
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'cooldown');
    assert.strictEqual(capturedMessages.length, before, 'a cooled-down alert must never open a second SMTP connection');
});

await check('an unreachable SMTP host fails soft — raiseAlert reports it, never throws', async () => {
    writeSettings({
        ...getDefaultSettings(),
        alertEmail: 'oncall@drill.test',
        smtp: { host: '127.0.0.1', port: 1, secure: false, user: 'drill', pass: 'drill-pass', fromName: 'Alert Drill' }
    });
    const result = await alerting.raiseAlert({ code: 'DRILL_SMTP_UNREACHABLE', message: 'must not throw' });
    assert.strictEqual(result.sent, false);
    assert.ok(result.reason, 'a failed send must still explain why');
});

await new Promise(resolve => smtpServer.close(resolve));

/* Same QA-001 bug class as backend/test_security.js's teardown (fixed this
 * same session): this suite's own checks above queue diagnostic writes
 * through logWriter.js's async batching, so closing the db and removing the
 * temp directory before that queue drains raced a scheduled flush against a
 * directory that no longer existed. Drain first, in the same order
 * server.js's real shutdown() uses. */
await logWriter.drainLogWriter();
repo.closeDb();
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });

console.log('======================================================================');
console.log(`✅ OPERATIONAL ALERTING SUITE PASSED (${passed} checks)`);
console.log('======================================================================');
