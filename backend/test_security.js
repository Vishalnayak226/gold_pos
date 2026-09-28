/**
 * Security regression suite (TESTING_CHECKLIST.md §23d, "a security-focused
 * automated suite for regression-prone boundaries").
 *
 * Deliberately NOT re-covered here — already asserted elsewhere, see the
 * cited suite:
 *   - hostile / log-forging request ids ......... test_http.js
 *   - session revocation (PIN change, deactivation, manual sign-out) test_http.js
 *   - replay / duplicate money events (webhook race, duplicate refs) test_concurrency.js, test_http.js
 *   - settings/browser secret redaction (redactSettings) ... test_routes.js, test_http.js
 *   - IDOR: customer identity is bound to the session, never to a
 *     client-supplied phone/id (server.js's /api/customer/* routes) — no
 *     route was found that trusts a request-supplied identity instead
 *   - path traversal via a server-built filesystem path — no route in this
 *     tree builds a path from req.params/req.query; every path.join() call
 *     uses a fixed internal filename. Static-file traversal is exercised
 *     below anyway, as a regression guard on the express.static wiring.
 *
 * What IS new here: an authorization matrix across roles, CSRF rejection
 * for both session types, an oversized-body refusal, and a check that the
 * credentials this suite plants never reach a log file in the clear.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
/* NOTHING that reaches db.js may be imported here — see CLAUDE.md §8 and
 * test_http.js's identical warning. Auth helpers are pulled in with a
 * dynamic import() further down, after GOLD_POS_DATA_DIR is set. */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-security-'));
const dataDir = path.join(tempRoot, 'data');
const logsDir = path.join(tempRoot, 'logs');
fs.mkdirSync(dataDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.GOLD_POS_DISABLE_BOOTSTRAP = '1';
process.env.GOLD_POS_DATA_DIR = dataDir;
process.env.GOLD_POS_LOGS_DIR = logsDir;
process.env.CORS_ORIGINS = 'https://admin.example.test';

const phone = '9000000001';
// Recognisable, suite-unique literals — grepped for verbatim in the log
// files this suite's own traffic writes, in "secret redaction" below.
const RAZORPAY_SECRET = 'security-suite-razorpay-secret-8f2c1';
const SMTP_SECRET = 'security-suite-smtp-secret-8f2c1';
const initialSettings = {
    companyName: 'Security Test Store',
    adminPin: '135791',
    razorpayKeyId: 'rzp_live_public_key',
    razorpayKeySecret: RAZORPAY_SECRET,
    razorpayWebhookSecret: 'security-suite-webhook-secret-8f2c1',
    smtp: {
        host: 'smtp.example.test', port: 587, secure: false,
        user: 'mailer', pass: SMTP_SECRET, fromName: 'Security Test'
    }
};
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(initialSettings, null, 2));
fs.writeFileSync(path.join(dataDir, 'rates.json'), JSON.stringify({
    lastUpdated: new Date().toISOString(), status: 'fixture',
    price24K: 1000, price22K: 900, price18K: 700
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'license.json'), JSON.stringify({
    licenseKey: 'SECURITY-TEST', activated: true, status: 'active',
    expiryDate: new Date(Date.now() + 86400000).toISOString(), lastHandshakeTime: Date.now()
}, null, 2));

let server;
let passed = 0;
function check(label, fn) {
    return Promise.resolve().then(fn).then(() => {
        passed++;
        console.log(`  ✅ ${label}`);
    });
}

/** Same pattern as test_http.js's cookieJarFrom/sessionHeaders — each HTTP
 * suite keeps its own copy so it can boot and drive a server independently. */
function cookieJarFrom(res) {
    const jar = {};
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach(line => {
        const pair = line.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        jar[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return jar;
}
function sessionHeaders(jar, sessCookie, csrfCookie) {
    const csrfToken = jar[csrfCookie] || '';
    return { Cookie: `${sessCookie}=${jar[sessCookie] || ''}; ${csrfCookie}=${csrfToken}`, 'X-CSRF-Token': csrfToken };
}
async function loginAdmin(request, body) {
    const response = await request('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const jar = cookieJarFrom(response);
    return { response, jar, headers: sessionHeaders(jar, 'gp_admin_sess', 'gp_admin_csrf') };
}
async function loginCustomerHttp(request, body) {
    const response = await request('/api/customer/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const jar = cookieJarFrom(response);
    return { response, jar, headers: sessionHeaders(jar, 'gp_cust_sess', 'gp_cust_csrf') };
}

console.log('======================================================================');
console.log('SECURITY REGRESSION SUITE');
console.log('======================================================================');

try {
    const { startServer } = await import('./server.js');
    server = startServer(0);
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (pathname, options = {}) => fetch(baseUrl + pathname, options);

    const owner = await loginAdmin(request, { pin: initialSettings.adminPin });
    assert.equal(owner.response.status, 200);
    const ownerHeaders = owner.headers;

    /* ============================================================
       1. CSRF — double-submit-cookie, checked independently by
       requireAdminSession (adminAuth.js) and requireCustomerSession
       (customerAuth.js). Neither code path had a rejection test before.
       ============================================================ */

    await check('a state-changing admin request without a CSRF header is refused', async () => {
        const jar = owner.jar;
        const res = await request('/api/settings', {
            method: 'POST',
            headers: {
                Cookie: `gp_admin_sess=${jar.gp_admin_sess}; gp_admin_csrf=${jar.gp_admin_csrf}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error, 'CSRF_TOKEN_INVALID');
    });

    await check('a state-changing admin request with a mismatched CSRF header is refused', async () => {
        const jar = owner.jar;
        const res = await request('/api/settings', {
            method: 'POST',
            headers: {
                Cookie: `gp_admin_sess=${jar.gp_admin_sess}; gp_admin_csrf=${jar.gp_admin_csrf}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': 'not-the-right-token'
            },
            body: JSON.stringify({})
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error, 'CSRF_TOKEN_INVALID');
    });

    await check('the matching CSRF header is accepted — baseline proving the two refusals above are real', async () => {
        const res = await request('/api/settings', {
            method: 'POST',
            headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(res.status, 200);
    });

    const issued = await request('/api/customer-accounts/issue-login', {
        method: 'POST',
        headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name: 'Security Test Customer', confirmDestructive: true })
    });
    assert.equal(issued.status, 200);
    const tempPassword = (await issued.json()).tempPassword;
    const custSignIn = await loginCustomerHttp(request, { phone, password: tempPassword });
    assert.equal(custSignIn.response.status, 200);

    await check('a state-changing customer request without a CSRF header is refused', async () => {
        const jar = custSignIn.jar;
        const res = await request('/api/customer/password/change', {
            method: 'POST',
            headers: {
                Cookie: `gp_cust_sess=${jar.gp_cust_sess}; gp_cust_csrf=${jar.gp_cust_csrf}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ currentPassword: tempPassword, newPassword: 'Security!2026Pass' })
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error, 'CSRF_TOKEN_INVALID');
    });

    await check('a state-changing customer request with a mismatched CSRF header is refused', async () => {
        const jar = custSignIn.jar;
        const res = await request('/api/customer/password/change', {
            method: 'POST',
            headers: {
                Cookie: `gp_cust_sess=${jar.gp_cust_sess}; gp_cust_csrf=${jar.gp_cust_csrf}`,
                'Content-Type': 'application/json',
                'X-CSRF-Token': 'not-the-right-token'
            },
            body: JSON.stringify({ currentPassword: tempPassword, newPassword: 'Security!2026Pass' })
        });
        assert.equal(res.status, 403);
        assert.equal((await res.json()).error, 'CSRF_TOKEN_INVALID');
    });

    await check('the matching CSRF header lets the customer act — baseline proving the two refusals above are real', async () => {
        const res = await request('/api/customer/password/change', {
            method: 'POST',
            headers: { ...custSignIn.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword: tempPassword, newPassword: 'Security!2026Pass' })
        });
        assert.equal(res.status, 200);
    });

    /* ============================================================
       2. Authorization matrix — a representative sample of routes
       spanning "any admin role", "owner or manager", and "owner only",
       checked against no session and against every role.
       ============================================================ */

    const rosterSave = await request('/api/settings', {
        method: 'POST',
        headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            operators: [
                { name: 'Security Cashier', role: 'cashier', pin: '246813', active: true },
                { name: 'Security Manager', role: 'manager', pin: '975312', active: true }
            ]
        })
    });
    assert.equal(rosterSave.status, 200);
    const cashier = await loginAdmin(request, { pin: '246813' });
    const manager = await loginAdmin(request, { pin: '975312' });
    assert.equal(cashier.response.status, 200);
    assert.equal(manager.response.status, 200);

    const AUTHZ_MATRIX = [
        { label: 'GET /api/sales (any admin role)', method: 'GET', path: '/api/sales', allowedRoles: ['cashier', 'manager', 'owner'] },
        { label: 'GET /api/customer-accounts (owner/manager only)', method: 'GET', path: '/api/customer-accounts', allowedRoles: ['manager', 'owner'] },
        { label: 'GET /api/diagnostics/telemetry (owner only)', method: 'GET', path: '/api/diagnostics/telemetry', allowedRoles: ['owner'] },
        { label: 'POST /api/settings (owner only)', method: 'POST', path: '/api/settings', allowedRoles: ['owner'], body: {} }
    ];

    await check('authorization matrix: every sampled route refuses no session, refuses the wrong role, and allows the right one', async () => {
        const sessions = { cashier: cashier.headers, manager: manager.headers, owner: ownerHeaders };
        for (const row of AUTHZ_MATRIX) {
            const anonHeaders = row.body ? { 'Content-Type': 'application/json' } : {};
            const anon = await request(row.path, {
                method: row.method, headers: anonHeaders,
                body: row.body ? JSON.stringify(row.body) : undefined
            });
            assert.equal(anon.status, 401, row.label);
            assert.equal((await anon.json()).error, 'ADMIN_SESSION_REQUIRED', row.label);

            for (const [role, headers] of Object.entries(sessions)) {
                const merged = { ...headers, ...(row.body ? { 'Content-Type': 'application/json' } : {}) };
                const res = await request(row.path, {
                    method: row.method, headers: merged,
                    body: row.body ? JSON.stringify(row.body) : undefined
                });
                if (row.allowedRoles.includes(role)) {
                    assert.ok(res.status < 400, `${row.label}: ${role} should be allowed, got ${res.status}`);
                } else {
                    assert.equal(res.status, 403, `${row.label}: ${role} should be refused, got ${res.status}`);
                    assert.equal((await res.json()).error, 'ROLE_REQUIRED', row.label);
                }
            }
        }
    });

    /* ============================================================
       3. Path traversal — no route in this tree builds a filesystem
       path from request input (confirmed by inspection), so this is a
       regression guard on express.static's own protection rather than
       a check on custom code.
       ============================================================ */

    await check('a traversal attempt against static assets never escapes the frontend root', async () => {
        const attempts = [
            '/js/../../../../backend/package.json',
            '/js/%2e%2e/%2e%2e/%2e%2e/backend/package.json',
            '/js/..%2f..%2f..%2fbackend%2fpackage.json'
        ];
        for (const attempt of attempts) {
            const res = await request(attempt);
            assert.notEqual(res.status, 200, `${attempt} must not resolve to a real file`);
            const body = await res.text();
            assert.doesNotMatch(body, /"name":\s*"gold-pos-backend"/, `${attempt} must not read backend/package.json`);
        }
    });

    /* ============================================================
       4. Oversized requests — malformed JSON is already covered by
       test_http.js ("a body the parser rejects returns a safe JSON
       error with no stack trace"); this is the size half of the same
       body-parser boundary (server.js's `express.json({ limit: '5mb' })`).
       ============================================================ */

    await check('a request body over the 5mb limit is refused, not parsed', async () => {
        const oversized = 'x'.repeat(6 * 1024 * 1024);
        const res = await request('/api/settings', {
            method: 'POST',
            headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyName: oversized })
        });
        assert.equal(res.status, 413);
        assert.equal((await res.json()).error, 'BAD_REQUEST');
    });

    /* ============================================================
       5. Secret redaction — settings/browser redaction is already
       covered elsewhere (see header comment). This instead asks
       whether the credentials this suite planted ever reached a log
       file in the clear across every request the suite made — the
       gap logError() itself has no redaction pass for (db.js), unlike
       blackBoxLogger.js's separate PII scrub.
       ============================================================ */

    await check('planted credentials never reach a log file in the clear across this suite\'s own traffic', async () => {
        const errorLogPath = path.join(logsDir, 'error.log');
        const telemetryLogPath = path.join(logsDir, 'telemetry.log');
        const errorLog = fs.existsSync(errorLogPath) ? fs.readFileSync(errorLogPath, 'utf8') : '';
        const telemetryLog = fs.existsSync(telemetryLogPath) ? fs.readFileSync(telemetryLogPath, 'utf8') : '';
        for (const secret of [RAZORPAY_SECRET, SMTP_SECRET]) {
            assert.doesNotMatch(errorLog, new RegExp(secret), `${secret} must never reach error.log in the clear`);
            assert.doesNotMatch(telemetryLog, new RegExp(secret), `${secret} must never reach telemetry.log in the clear`);
        }
    });

    console.log('======================================================================');
    console.log(`✅ SECURITY SUITE PASSED (${passed} checks)`);
    console.log('======================================================================');
} finally {
    /* QA-001 fix (docs/WHOLE_APP_QUALITY_AUDIT_2026-09-18.md): teardown must
     * go through the same graceful path production uses — server.js's
     * exported shutdown() drains the async log writer, THEN closes the
     * ledger, in that order (see its own doc comment). A bare server.close()
     * here left queued diagnostic writes racing the rmSync below, so a green
     * run still printed a post-cleanup "[LogWriter] Could not append/rotate
     * ... ENOENT" warning once the directory it was writing into was gone. */
    if (server) {
        const { shutdown } = await import('./server.js');
        await shutdown(server, 'test-security-suite-teardown');
    }
    /* Idempotent fallback — shutdown() above already closes the ledger on
     * every path that reaches it; this only matters if the suite failed
     * before a server (and therefore the store) was ever opened. */
    try {
        const repo = await import('./repositories/index.js');
        repo.closeDb();
    } catch (_) {
        // The suite may have failed before the store was ever opened.
    }

    const { getLogWriterStats } = await import('./logWriter.js');
    const drainedStats = getLogWriterStats();

    /* Regression guard: a re-introduced QA-001 looks exactly like a
     * "[LogWriter] Could not append/rotate" message printed after this
     * point. Catch it and fail loudly instead of letting it merely print. */
    let postCleanupLogWriterMessage = null;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args) => {
        const line = args.join(' ');
        if (line.includes('[LogWriter]')) postCleanupLogWriterMessage = line;
        originalWarn(...args);
    };
    console.error = (...args) => {
        const line = args.join(' ');
        if (line.includes('[LogWriter]')) postCleanupLogWriterMessage = line;
        originalError(...args);
    };

    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(resolvedSystemTemp + path.sep) && path.basename(resolvedTemp).startsWith('gold-pos-security-')) {
        try {
            fs.rmSync(resolvedTemp, { recursive: true, force: true });
        } catch (err) {
            console.warn(`[cleanup] could not remove ${resolvedTemp}: ${err.message}`);
        }
    }

    /* logWriter.js's own flush/retry timers are unref()'d, so they never
     * keep the process alive by themselves — but if a drain were ever
     * skipped or raced, one could still fire in this window. Outwait its
     * default 50ms flush delay before declaring the guard clear. */
    await new Promise(resolve => setTimeout(resolve, 250));

    console.warn = originalWarn;
    console.error = originalError;

    if (postCleanupLogWriterMessage) {
        throw new Error(`QA-001 regression: log writer wrote after cleanup: ${postCleanupLogWriterMessage}`);
    }
    assert.equal(drainedStats.queuedEntries, 0, 'log writer must have nothing queued after a graceful shutdown drain');
    assert.equal(drainedStats.inFlightEntries, 0, 'log writer must have nothing in-flight after a graceful shutdown drain');
}
