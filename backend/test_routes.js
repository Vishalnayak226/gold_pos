/**
 * ==========================================================================
 * Gold POS HTTP Route & Auth Boundary Suite
 *
 * test_suite.js exercises helpers in-process; nothing in it ever made an HTTP
 * request, so a broken route, a missing auth check or a swallowed write
 * failure could not fail a build. This suite boots the REAL server as a child
 * process and drives it over HTTP.
 *
 * It runs against a throwaway data directory (GOLDPOS_DATA_DIR/GOLDPOS_LOGS_DIR,
 * see db.js) and a free ephemeral port, so it never touches backend/data/ and
 * never collides with a dev server on :5000 — fixture debris in a live data
 * directory looks exactly like a real bug (CLAUDE.md §8).
 *
 * Native assert + fetch only. Zero extra dependencies.
 * ==========================================================================
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getDefaultSettings } from './defaultSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ==========================================================================
   Harness
   ========================================================================== */

// Distinctive values: every assertion that a secret did not leak greps the
// raw response body for these exact strings, so a partial leak still fails.
const REAL = {
    razorpaySecret: 'rzp_live_LEAKCANARY_9f3a2b',
    adminPin: '4821',
    smtpPass: 'smtp-LEAKCANARY-pw-77'
};

let serverProcess = null;
let tempRoot = null;
let BASE = '';
let passed = 0;

function getFreePort() {
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

function seedDataDir(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });

    const settings = getDefaultSettings();
    settings.companyName = 'Route Suite Jewellers';
    settings.invoiceSeqStart = 500;
    settings.razorpayKeyId = 'rzp_live_publickeyid';
    settings.razorpayKeySecret = REAL.razorpaySecret;
    settings.adminPin = REAL.adminPin;
    settings.smtp = {
        host: 'smtp.example.com', port: 587, secure: false,
        user: 'store@example.com', pass: REAL.smtpPass, fromName: 'Route Suite'
    };
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));

    // Open the license gate (licenseChecker.js) so gated routes reject on
    // AUTH rather than on licensing — otherwise every 401 assertion below
    // would actually be a 402 and prove nothing about the auth boundary.
    const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dataDir, 'license.json'), JSON.stringify({
        activated: true, status: 'active', expiryDate: expiry, lastHandshakeTime: Date.now()
    }, null, 2));
}

async function startServer() {
    const port = await getFreePort();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-routes-'));
    const dataDir = path.join(tempRoot, 'data');
    const logsDir = path.join(tempRoot, 'logs');
    seedDataDir(dataDir);
    fs.mkdirSync(logsDir, { recursive: true });

    BASE = `http://127.0.0.1:${port}`;

    serverProcess = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        // cwd drives backupEngine.js's `process.cwd()/backups` — keep those
        // snapshots in the temp tree too instead of the repo root.
        cwd: tempRoot,
        env: {
            ...process.env,
            PORT: String(port),
            GOLDPOS_DATA_DIR: dataDir,
            GOLDPOS_LOGS_DIR: logsDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const serverLog = [];
    serverProcess.stdout.on('data', d => serverLog.push(d.toString()));
    serverProcess.stderr.on('data', d => serverLog.push(d.toString()));
    serverProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
            console.error('[harness] server exited early with code', code);
            console.error(serverLog.join(''));
        }
    });

    // Poll until the process answers, rather than sleeping a fixed guess.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/api/health`);
            if (res.ok) return { dataDir, logsDir, port };
        } catch (_) { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Server did not become healthy within 30s:\n' + serverLog.join(''));
}

async function stopServer() {
    if (serverProcess && serverProcess.exitCode === null) {
        const ended = new Promise(r => serverProcess.once('exit', r));
        serverProcess.kill();
        await Promise.race([ended, new Promise(r => setTimeout(r, 5000))]);
    }
    if (tempRoot) {
        // Windows can hold the log file handle a moment past exit.
        for (let attempt = 0; attempt < 5; attempt++) {
            try { fs.rmSync(tempRoot, { recursive: true, force: true }); break; }
            catch (_) { await new Promise(r => setTimeout(r, 200)); }
        }
    }
}

/** GET/POST helper returning status, parsed body, and the raw text. */
async function call(method, route, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON is a valid outcome */ }
    return { status: res.status, json, text };
}

function check(label, fn) {
    try {
        const result = fn();
        // An async callback resolves its assertions after check() has already
        // returned, so a failure inside one could never fail the suite. Make
        // that mistake loud instead of silently green.
        assert.ok(!result || typeof result.then !== 'function',
            `check("${label}") was passed an async function — its assertions would be skipped`);
        passed++;
        console.log(`  ✅ ${label}`);
    } catch (err) {
        console.log(`  ❌ ${label}`);
        throw err;
    }
}

/** Fails if any canary secret appears anywhere in a payload bound for a client. */
function assertNoSecretsIn(rawText, where) {
    for (const [name, value] of Object.entries(REAL)) {
        assert.ok(!rawText.includes(value), `${where} leaked ${name} in plaintext`);
    }
}

function readDiskSettings(dataDir) {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
}

/* ==========================================================================
   Suite
   ========================================================================== */

console.log('======================================================================');
console.log('STARTING HTTP ROUTE & AUTH BOUNDARY TESTS');
console.log('======================================================================');

const { dataDir } = await startServer();
console.log(`[harness] server up on ${BASE}, data dir ${dataDir}\n`);

try {
    /* ---------- Group 1: liveness and the unauthenticated surface ---------- */
    console.log('Group 1: Public surface');

    const health = await call('GET', '/api/health');
    check('GET /api/health responds 200 without any credentials', () => {
        assert.strictEqual(health.status, 200);
        assert.ok(health.json, 'health should return JSON');
    });

    const pub = await call('GET', '/api/settings/public');
    check('GET /api/settings/public serves the portal without exposing secrets', () => {
        assert.strictEqual(pub.status, 200);
        assert.strictEqual(pub.json.companyName, 'Route Suite Jewellers');
        assertNoSecretsIn(pub.text, 'GET /api/settings/public');
        assert.ok(!('adminPin' in pub.json), 'public settings must not carry adminPin at all');
        assert.ok(!('razorpayKeySecret' in pub.json), 'public settings must not carry razorpayKeySecret');
    });

    /* ---------- Group 2: the admin auth boundary ---------- */
    console.log('\nGroup 2: Admin auth boundary');

    for (const [label, opts] of [
        ['no Authorization header', {}],
        ['a garbage bearer token', { token: 'not-a-real-token' }],
        ['an empty bearer token', { token: '' }]
    ]) {
        const res = await call('GET', '/api/settings', opts);
        check(`GET /api/settings is rejected with ${label}`, () => {
            assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
            assert.strictEqual(res.json.error, 'ADMIN_SESSION_REQUIRED');
            assertNoSecretsIn(res.text, 'the 401 response');
        });
    }

    const gated = await call('GET', '/api/sales');
    check('GET /api/sales is rejected with no session (license gate open, so this is auth)', () => {
        assert.strictEqual(gated.status, 401, `expected 401 auth rejection, got ${gated.status}`);
        assert.strictEqual(gated.json.error, 'ADMIN_SESSION_REQUIRED');
    });

    const badLogin = await call('POST', '/api/admin/login', { body: { pin: '0000' } });
    check('POST /api/admin/login rejects a wrong PIN', () => {
        assert.strictEqual(badLogin.status, 401);
        assertNoSecretsIn(badLogin.text, 'the failed-login response');
    });

    const login = await call('POST', '/api/admin/login', { body: { pin: REAL.adminPin } });
    check('POST /api/admin/login issues a token for the correct PIN', () => {
        assert.strictEqual(login.status, 200);
        assert.ok(login.json.token && login.json.token.length >= 32, 'expected a session token');
    });
    const token = login.json.token;

    const authed = await call('GET', '/api/settings', { token });
    check('GET /api/settings succeeds with a valid session', () => {
        assert.strictEqual(authed.status, 200);
        assert.strictEqual(authed.json.companyName, 'Route Suite Jewellers');
    });

    /* ---------- Group 3: secrets never reach the browser ---------- */
    console.log('\nGroup 3: Secret redaction');

    check('GET /api/settings redacts every credential with configured metadata', () => {
        assert.strictEqual(authed.json.razorpayKeySecret, null, 'razorpayKeySecret not redacted');
        assert.strictEqual(authed.json.adminPin, null, 'adminPin not redacted');
        assert.strictEqual(authed.json.smtp.pass, null, 'smtp.pass not redacted');
        assert.strictEqual(authed.json.razorpayKeySecretConfigured, true);
        assert.strictEqual(authed.json.adminPinConfigured, true);
        assert.strictEqual(authed.json.smtp.passConfigured, true);
    });

    check('GET /api/settings response contains no plaintext secret anywhere', () => {
        assertNoSecretsIn(authed.text, 'GET /api/settings');
    });

    check('Redaction leaves non-secret configuration fully intact', () => {
        assert.strictEqual(authed.json.razorpayKeyId, 'rzp_live_publickeyid', 'public key id must survive');
        assert.strictEqual(authed.json.smtp.host, 'smtp.example.com');
        assert.strictEqual(authed.json.smtp.user, 'store@example.com');
        assert.strictEqual(authed.json.smtp.port, 587);
        assert.strictEqual(authed.json.goldTaxSlab, 3.0);
        assert.strictEqual(authed.json.invoiceSeqStart, 500);
    });

    /* ---------- Group 4: the read-modify-write round trip ---------- */
    console.log('\nGroup 4: Write-only round-trip must not destroy credentials');

    // Exactly what the Settings screen does: post back the object it was
    // given, with one unrelated field edited.
    const echoed = { ...authed.json, companyName: 'Renamed Jewellers' };
    const save = await call('POST', '/api/settings', { token, body: echoed });
    check('POST /api/settings accepts null write-only fields echoed by the UI', () => {
        assert.strictEqual(save.status, 200);
        assert.strictEqual(save.json.success, true);
    });

    check('POST response is itself redacted (no secret echoed back)', () => {
        assertNoSecretsIn(save.text, 'POST /api/settings response');
        assert.strictEqual(save.json.settings.razorpayKeySecret, null);
        assert.strictEqual(save.json.settings.smtp.pass, null);
    });

    check('The real credentials on disk survived the null round-trip', () => {
        const disk = readDiskSettings(dataDir);
        assert.strictEqual(disk.companyName, 'Renamed Jewellers', 'the edit should have applied');
        assert.strictEqual(disk.razorpayKeySecret, REAL.razorpaySecret, 'razorpayKeySecret was overwritten by the mask!');
        assert.strictEqual(disk.adminPin, REAL.adminPin, 'adminPin was overwritten by the mask!');
        assert.strictEqual(disk.smtp.pass, REAL.smtpPass, 'smtp.pass was overwritten by the mask!');
    });

    const reLogin = await call('POST', '/api/admin/login', { body: { pin: REAL.adminPin } });
    check('POST /api/admin/login still accepts the original PIN post-save', () => {
        assert.strictEqual(reLogin.status, 200, 'the PIN was clobbered by the masked round-trip');
    });

    const rotate = await call('POST', '/api/settings', {
        token,
        body: { razorpayKeySecret: 'rzp_live_ROTATED_secret', smtp: { ...authed.json.smtp, pass: 'rotated-pw' } }
    });
    check('A genuinely retyped secret is saved (null only protects untouched fields)', () => {
        assert.strictEqual(rotate.status, 200);
        const disk = readDiskSettings(dataDir);
        assert.strictEqual(disk.razorpayKeySecret, 'rzp_live_ROTATED_secret');
        assert.strictEqual(disk.smtp.pass, 'rotated-pw');
    });

    const cleared = await call('POST', '/api/settings', { token, body: { razorpayKeySecret: '' } });
    check('An explicitly cleared secret reads back as unconfigured', () => {
        assert.strictEqual(cleared.status, 200);
        assert.strictEqual(cleared.json.settings.razorpayKeySecret, null);
        assert.strictEqual(cleared.json.settings.razorpayKeySecretConfigured, false);
        assert.strictEqual(readDiskSettings(dataDir).razorpayKeySecret, '');
    });

    /* ---------- Group 5: persistence failure is reported, not swallowed ---------- */
    console.log('\nGroup 5: Persistence failure');

    // writeJSON() stages through `<file>.tmp` then renames. A directory
    // sitting on that path makes the staged write fail with EISDIR — a
    // non-retryable error — on both Windows and POSIX.
    const stagingPath = path.join(dataDir, 'settings.json.tmp');
    fs.mkdirSync(stagingPath, { recursive: true });
    let failWrite;
    try {
        failWrite = await call('POST', '/api/settings', { token, body: { companyName: 'Should Not Persist' } });
    } finally {
        fs.rmSync(stagingPath, { recursive: true, force: true });
    }

    check('POST /api/settings returns 500 when the write cannot be persisted', () => {
        assert.strictEqual(failWrite.status, 500, `expected 500, got ${failWrite.status}`);
        assert.ok(failWrite.json && failWrite.json.error, 'a failed write must return a JSON error envelope');
    });

    check('A failed write leaves the previous settings on disk unchanged', () => {
        const disk = readDiskSettings(dataDir);
        assert.notStrictEqual(disk.companyName, 'Should Not Persist',
            'a write reported as failed must not have partially applied');
        assert.strictEqual(disk.adminPin, REAL.adminPin, 'credentials must survive a failed write');
    });

    const stillUp = await call('GET', '/api/health');
    check('The server survives a persistence failure and keeps serving', () => {
        assert.strictEqual(stillUp.status, 200);
    });

    /* ---------- Group 6: destructive-action guard ---------- */
    console.log('\nGroup 6: Invoice sequence guard');

    const lower = await call('POST', '/api/settings', { token, body: { invoiceSeqStart: 2 } });
    check('Lowering the invoice sequence is refused with 409 unless confirmed', () => {
        assert.strictEqual(lower.status, 409, `expected 409, got ${lower.status}`);
        assert.strictEqual(lower.json.error, 'CONFIRMATION_REQUIRED');
        assert.strictEqual(readDiskSettings(dataDir).invoiceSeqStart, 500, 'the sequence must not have moved');
    });

    const lowerOk = await call('POST', '/api/settings', { token, body: { invoiceSeqStart: 2, confirmDestructive: true } });
    check('Lowering succeeds once explicitly confirmed, and the flag is not persisted', () => {
        assert.strictEqual(lowerOk.status, 200);
        const disk = readDiskSettings(dataDir);
        assert.strictEqual(disk.invoiceSeqStart, 2);
        assert.ok(!('confirmDestructive' in disk), 'confirmDestructive must never be written to settings.json');
    });

    /* ---------- Group 7: session invalidation ---------- */
    console.log('\nGroup 7: Session lifecycle');

    const logout = await call('POST', '/api/admin/logout', { token });
    check('POST /api/admin/logout succeeds', () => {
        assert.strictEqual(logout.status, 200);
    });

    const afterLogout = await call('GET', '/api/settings', { token });
    check('The token is dead immediately after logout', () => {
        assert.strictEqual(afterLogout.status, 401, 'a logged-out token must not still work');
        assert.strictEqual(afterLogout.json.error, 'ADMIN_SESSION_REQUIRED');
    });

    /* ---------- Group 8: brute-force lockout (LAST — it locks this IP out) ---------- */
    console.log('\nGroup 8: Login brute-force lockout');

    let lockoutStatus = 0;
    let attempts = 0;
    while (attempts < 10 && lockoutStatus !== 429) {
        const res = await call('POST', '/api/admin/login', { body: { pin: '9999' } });
        lockoutStatus = res.status;
        attempts++;
    }
    check(`Repeated wrong PINs trigger a 429 lockout (after ${attempts} attempts)`, () => {
        assert.strictEqual(lockoutStatus, 429, 'the login endpoint never locked out — brute force is unthrottled');
    });

    const lockedOut = await call('POST', '/api/admin/login', { body: { pin: REAL.adminPin } });
    check('The lockout also blocks the CORRECT PIN while in cooldown', () => {
        assert.strictEqual(lockedOut.status, 429);
        assert.strictEqual(lockedOut.json.error, 'TOO_MANY_ATTEMPTS');
    });

    console.log('\n======================================================================');
    console.log(`🎉 ALL ${passed} HTTP ROUTE & AUTH BOUNDARY CHECKS PASSED.`);
    console.log('======================================================================');
} catch (err) {
    console.error('\n❌ Route test failure:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    await stopServer();
    process.exit(1);
}

await stopServer();
