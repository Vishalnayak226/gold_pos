/**
 * Real HTTP boundary tests.
 *
 * Boots the production Express app on an ephemeral TCP port with a temporary
 * database, then drives it through fetch. No route handler is called directly.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
/* NOTHING that reaches db.js may be imported here.
 *
 * db.js resolves DATA_DIR once, at import, and ESM hoists every static import
 * above the process.env assignments below — so a static `import ... from
 * './adminAuth.js'` at the top of this file silently pins the whole suite to the
 * real backend/data directory instead of its temp one. That is not a theoretical
 * hazard: it happened, and the suite migrated the live tenant's settings.json
 * before anyone noticed the 401 it caused. See CLAUDE.md §8.
 *
 * Auth helpers are pulled in with a dynamic import() further down, after
 * GOLD_POS_DATA_DIR is set. */

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-http-'));
const dataDir = path.join(tempRoot, 'data');
const logsDir = path.join(tempRoot, 'logs');
fs.mkdirSync(dataDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.GOLD_POS_DISABLE_BOOTSTRAP = '1';
process.env.GOLD_POS_DATA_DIR = dataDir;
process.env.GOLD_POS_LOGS_DIR = logsDir;
process.env.CORS_ORIGINS = 'https://admin.example.test';

const phone = '9000000000';
const WEBHOOK_SECRET = 'http-webhook-secret-value';
// The server prices invoices from its own active rate, so the fixture pins one
// rather than letting the suite inherit whatever rates.json happens to hold.
// 1000/g keeps salePayload()'s arithmetic below readable.
const FIXTURE_RATE = 1000;
const initialSettings = {
    companyName: 'HTTP Test Store',
    goldTaxSlab: 3,
    taxMode: 'Exclusive',
    invoicePrefix: 'HTTP',
    invoiceSeqStart: 10,
    adminPin: '2468',
    razorpayKeyId: 'rzp_live_public_key',
    razorpayKeySecret: 'razorpay-secret-value',
    razorpayWebhookSecret: WEBHOOK_SECRET,
    smtp: {
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        user: 'mailer',
        pass: 'smtp-secret-value',
        fromName: 'HTTP Test'
    }
};

fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(initialSettings, null, 2));
fs.writeFileSync(path.join(dataDir, 'rates.json'), JSON.stringify({
    lastUpdated: new Date().toISOString(),
    status: 'fixture',
    price24K: FIXTURE_RATE * 24 / 22,
    price22K: FIXTURE_RATE,
    price18K: FIXTURE_RATE * 18 / 22
}, null, 2));
fs.writeFileSync(path.join(dataDir, 'license.json'), JSON.stringify({
    licenseKey: 'HTTP-TEST',
    activated: true,
    status: 'active',
    expiryDate: new Date(Date.now() + 86400000).toISOString(),
    lastHandshakeTime: Date.now()
}, null, 2));
let server;
let passed = 0;

function check(label, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            passed++;
            console.log(`  ✅ ${label}`);
        });
}

function readData(filename) {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8'));
    /* settings.json holds its credentials encrypted at rest now. Every caller
       here is asking whether a VALUE survived some round trip, which is a
       question about plaintext — so hand them the opened document. The separate
       claim that the bytes on disk really are ciphertext is asserted directly
       against the file, in "credentials are encrypted at rest". */
    if (filename !== 'settings.json') return parsed;
    resetKeyCache();
    const { key } = resolveKey(dataDir);
    return openSettings(parsed, key);
}

/**
 * Whether the master PIN stored on disk verifies this plaintext.
 *
 * PINs are scrypt hashes, so a save can no longer be checked by string equality
 * — and should not be. What matters is that the credential still works.
 */
function storedPinVerifies(pin) {
    const stored = readData('settings.json');
    return Boolean(stored.adminPinHash) && Boolean(stored.authSalt)
        && verifyPinHash(pin, stored.authSalt, stored.adminPinHash);
}

/** Whether an operator's stored PIN hash verifies this plaintext. */
function operatorPinVerifies(operatorId, pin) {
    const stored = readData('settings.json');
    const op = (stored.operators || []).find(o => o && o.id === operatorId);
    return Boolean(op && op.pinHash) && Boolean(stored.authSalt)
        && verifyPinHash(pin, stored.authSalt, op.pinHash);
}

/**
 * Session auth is a cookie now (Unit 1 of the production-readiness plan), not
 * a bearer token — fetch() has no cookie jar of its own, so every check that
 * needs an authenticated request captures Set-Cookie from a login response
 * and replays it by hand. `getSetCookie()` (not `.get('set-cookie')`, which
 * collapses multiple headers into one unusable comma-joined string) is the
 * WHATWG extension Node's fetch implements for exactly this.
 */
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

/** A ready-to-spread {Cookie, X-CSRF-Token} headers object from a cookie jar. */
function sessionHeaders(jar, sessCookie, csrfCookie) {
    const csrfToken = jar[csrfCookie] || '';
    return { Cookie: `${sessCookie}=${jar[sessCookie] || ''}; ${csrfCookie}=${csrfToken}`, 'X-CSRF-Token': csrfToken };
}

/** Logs in as admin and returns the response plus ready-to-use auth headers. */
async function loginAdmin(request, body) {
    const response = await request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const jar = cookieJarFrom(response);
    return {
        response,
        headers: sessionHeaders(jar, 'gp_admin_sess', 'gp_admin_csrf'),
        token: jar.gp_admin_sess || '',
        csrfToken: jar.gp_admin_csrf || ''
    };
}

/** Logs in as a customer and returns the response plus ready-to-use auth headers. */
async function loginCustomerHttp(request, body) {
    const response = await request('/api/customer/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const jar = cookieJarFrom(response);
    return {
        response,
        headers: sessionHeaders(jar, 'gp_cust_sess', 'gp_cust_csrf'),
        token: jar.gp_cust_sess || '',
        csrfToken: jar.gp_cust_csrf || ''
    };
}

function salePayload(appliedAdvance) {
    return {
        purity: '22K',
        weightGrams: 1,
        goldPricePerGram: 1000,
        metalValue: 1000,
        makingChargeAmount: 0,
        discountPercent: 0,
        totalAmount: 1030 - appliedAdvance,
        customerName: 'HTTP Customer',
        customerPhone: phone,
        appliedAdvance,
        timestamp: Date.now()
    };
}

console.log('======================================================================');
console.log('HTTP ROUTE SECURITY & TRANSACTION VERIFICATION');
console.log('======================================================================');

// Safe now: GOLD_POS_DATA_DIR is set, so db.js resolves to the temp directory.
const { verifyPinHash, currentTotpCode } = await import('./adminAuth.js');
const { resolveKey, openSettings, resetKeyCache } = await import('./secretVault.js');
const repo = await import('./repositories/index.js');
const advanceService = await import('./services/advanceService.js');
const saleServiceModule = await import('./services/saleService.js');
const returnServiceModule = await import('./services/returnService.js');
const paymentServiceModule = await import('./services/paymentService.js');

/* ==========================================================================
   Reading the ledger back

   The ledger is SQL now, so these replace the `ledger.advances()`
   calls the assertions below used to make. They deliberately return the SAME
   legacy wire shapes the JSON files held — `toLegacyAdvances`, `listSales`
   and friends are the projections the routes themselves answer with — so each
   assertion still says what it always said about the row it is checking,
   rather than being rewritten around column names.

   Reading through the repositories rather than by opening the database file
   also keeps the suite honest about the seam: if a projection stops emitting a
   field, these fail in the same way the browser would break.
   ========================================================================== */
const ledger = {
    advances: () => repo.advances.toLegacyAdvances(
        repo.advances.search({ tenantId: repo.dataStoreContext().tenantId, limit: 500 }).rows
    ),
    /* The invoices AS FILED — the stored header and its lines, with no return
       state attached. Deliberately not `listSales()`: that projection merges in
       what has since come back, which is exactly the thing the "a return never
       rewrites an invoice" check needs to be able to distinguish. Return state
       is asserted through /api/sales/lookup, where it belongs. */
    sales: () => repo.invoices
        .search({ tenantId: repo.dataStoreContext().tenantId, limit: 500 }).rows
        .map(row => repo.invoices.toLegacySale(row)),
    returns: () => returnServiceModule.listReturns({ limit: 500 }).results,
    order: (providerOrderId) => paymentServiceModule.findOrder(providerOrderId)
        || paymentServiceModule.findOrder(providerOrderId, 'mock')
};

/** The gold rates and phone validator the advance service needs from a caller. */
const SERVICE_DEPS = {
    getActiveGoldRates: () => ({
        price24K: FIXTURE_RATE * 24 / 22,
        price22K: FIXTURE_RATE,
        price18K: FIXTURE_RATE * 18 / 22,
        sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
    }),
    isValidPhone: (value) => /^\d{10}$/.test(String(value || ''))
};

/**
 * A customer's unverified claim, sitting pending — the fixture the approval
 * checks act on.
 *
 * Seeded through the service rather than by writing a row with a chosen id,
 * because the id is the database's to mint now. Returns it, so the assertions
 * name the row that actually exists instead of one the fixture invented.
 */
function seedPendingDeposit({ amount, referenceId }) {
    const result = advanceService.recordDeposit({
        customerPhone: phone,
        customerName: 'HTTP Customer',
        amount,
        paymentMethod: 'UPI',
        referenceId,
        status: 'pending',
        source: 'portal'
    }, SERVICE_DEPS);
    if (!result.success) throw new Error('Could not seed a pending deposit: ' + result.error);
    return result.deposit.id;
}

/* The opening balance the redemption checks below spend against.
   Seeded through the SERVICE rather than by inserting a row, so the fixture
   goes through the same validation, the same account creation and the same
   locked-rate snapshot a real counter deposit would. */
repo.initialiseDataStore({ name: 'HTTP Test Store' });
{
    const seeded = advanceService.recordDeposit({
        customerPhone: phone,
        customerName: 'HTTP Customer',
        amount: 100,
        paymentMethod: 'UPI',
        referenceId: 'seed-http-opening-balance',
        status: 'approved',
        source: 'counter'
    }, {
        getActiveGoldRates: () => ({
            price24K: FIXTURE_RATE * 24 / 22,
            price22K: FIXTURE_RATE,
            price18K: FIXTURE_RATE * 18 / 22,
            sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
        }),
        isValidPhone: (value) => /^\d{10}$/.test(String(value || ''))
    });
    if (!seeded.success) {
        throw new Error('Could not seed the opening advance balance: ' + seeded.error);
    }
}

/**
 * The code an authenticator app would be showing now.
 *
 * Uses the production generator rather than a copy of it: a test that
 * reimplements what it is testing agrees with its own bugs. The generator itself
 * is pinned against the published RFC 6238 vectors in test_suite.js.
 */
function currentTotp(secret) {
    return currentTotpCode(secret);
}

// Populated by the enrolment check and used by the ones that follow it.
let mfaSecret = '';
let mfaRecoveryCodes = [];
let mfaManagerHeaders = null;

try {
    const { startServer } = await import('./server.js');
    server = startServer(0);
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const request = (pathname, options = {}) => fetch(baseUrl + pathname, options);

    await check('security headers and explicit CORS allowlist are emitted over HTTP', async () => {
        const blocked = await request('/api/health', { headers: { Origin: 'https://evil.example.test' } });
        assert.equal(blocked.status, 200);
        assert.equal(blocked.headers.get('access-control-allow-origin'), null);
        assert.equal(blocked.headers.get('x-gold-pos-api-version'), '1');
        assert.equal((await blocked.json()).apiVersion, '1');
        assert.match(blocked.headers.get('content-security-policy') || '', /default-src 'self'/);
        assert.equal(blocked.headers.get('x-content-type-options'), 'nosniff');

        const allowed = await request('/api/health', { headers: { Origin: 'https://admin.example.test' } });
        assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://admin.example.test');
    });

    await check('admin-only settings route rejects an unauthenticated request', async () => {
        const response = await request('/api/settings');
        assert.equal(response.status, 401);
        assert.equal((await response.json()).error, 'ADMIN_SESSION_REQUIRED');
    });

    const adminSession = await loginAdmin(request, { pin: initialSettings.adminPin });
    assert.equal(adminSession.response.status, 200);
    const adminHeaders = adminSession.headers;

    await check('GET /api/settings redacts every write-only credential', async () => {
        const response = await request('/api/settings', { headers: adminHeaders });
        assert.equal(response.status, 200);
        const settings = await response.json();
        assert.equal(settings.adminPin, null);
        assert.equal(settings.razorpayKeySecret, null);
        assert.equal(settings.smtp.pass, null);
        assert.equal(settings.adminPinConfigured, true);
        assert.equal(settings.razorpayKeySecretConfigured, true);
        assert.equal(settings.smtp.passConfigured, true);
        const serialized = JSON.stringify(settings);
        assert.doesNotMatch(serialized, /2468|razorpay-secret-value|smtp-secret-value/);
    });

    await check('null secret updates preserve stored values and the POST response stays redacted', async () => {
        const response = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                companyName: 'Updated HTTP Store',
                adminPin: null,
                razorpayKeySecret: null,
                smtp: { host: 'smtp2.example.test', pass: null }
            })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.settings.adminPin, null);
        assert.equal(body.settings.razorpayKeySecret, null);
        assert.equal(body.settings.smtp.pass, null);

        const stored = readData('settings.json');
        assert.equal(stored.companyName, 'Updated HTTP Store');
        // The PIN is hashed on disk, so the assertion is that it still VERIFIES
        // and that no plaintext survives — a stronger claim than the string
        // comparison this replaced.
        assert.equal(storedPinVerifies('2468'), true, 'the master PIN was clobbered by the mask');
        assert.equal(stored.adminPin, undefined, 'a plaintext PIN must never be written back');
        assert.equal(stored.razorpayKeySecret, 'razorpay-secret-value');
        assert.equal(stored.smtp.pass, 'smtp-secret-value');
        assert.equal(stored.smtp.host, 'smtp2.example.test');
        assert.equal(stored.smtp.user, 'mailer');

        const omitted = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ upiId: 'http-test@upi' })
        });
        assert.equal(omitted.status, 200);
        const afterOmitted = readData('settings.json');
        assert.equal(storedPinVerifies('2468'), true);
        assert.equal(afterOmitted.razorpayKeySecret, 'razorpay-secret-value');
        assert.equal(afterOmitted.smtp.pass, 'smtp-secret-value');
    });

    await check('non-null secret updates rotate credentials without echoing them', async () => {
        const response = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                adminPin: '864286',
                razorpayKeySecret: 'rotated-razorpay-secret',
                smtp: { pass: 'rotated-smtp-secret' }
            })
        });
        assert.equal(response.status, 200);
        assert.doesNotMatch(JSON.stringify(await response.json()), /864286|rotated-razorpay-secret|rotated-smtp-secret/);
        const stored = readData('settings.json');
        assert.equal(storedPinVerifies('864286'), true, 'the rotated PIN should now be the one that works');
        assert.equal(storedPinVerifies('2468'), false, 'the old PIN must stop working');
        assert.equal(stored.adminPin, undefined);
        assert.equal(stored.razorpayKeySecret, 'rotated-razorpay-secret');
        assert.equal(stored.smtp.pass, 'rotated-smtp-secret');
    });

    await check('over-redemption is rejected without consuming an invoice or changing a ledger', async () => {
        const settingsBefore = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
        const advancesBefore = ledger.advances();
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(101))
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /exceeds.*available balance/i);
        assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), settingsBefore);
        // The refusal happens INSIDE the transaction, so nothing it had already
        // written survives: no redemption row, and no invoice.
        assert.deepEqual(ledger.advances(), advancesBefore);
        assert.equal(ledger.sales().length, 0, 'no invoice may be filed by a refused sale');
    });

    await check('a valid sale commits invoice, sale, and redemption together over HTTP', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(100))
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.invoiceId, `HTTP-000010-${new Date().getFullYear().toString().slice(-2)}`);
        assert.equal(ledger.sales().length, 1);

        /* The invoice number now comes from the `document_sequences` table,
           seeded once from settings.invoiceSeqStart. The JSON counter is no
           longer incremented per sale — it is the SEED, not the sequence — so
           what matters is that the series continued from 10, asserted above,
           rather than that a settings key moved. */
        const advances = ledger.advances();
        assert.equal(advances.length, 2);
        const redemption = advances.find(a => a.type === 'redeem');
        assert.ok(redemption, 'the redemption must be filed alongside the invoice');
        assert.equal(redemption.amount, 100);
        assert.equal(redemption.invoiceId, body.invoiceId,
            'the redemption names the invoice that spent it');
    });

    /* ======================================================================
       Server-authoritative pricing (roadmap Phase 0)
       ====================================================================== */

    await check('the server prices from its own rate and ignores the client’s', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purity: '22K',
                weightGrams: 10,
                // A tampered till: a rate and metal value two orders of
                // magnitude below the truth, with a self-consistent total so
                // nothing downstream looks obviously wrong.
                goldPricePerGram: 10,
                metalValue: 100,
                makingChargeAmount: 0,
                discountPercent: 0,
                totalAmount: 103,
                customerName: 'Rate Tamper',
                appliedAdvance: 0
            })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.rateCorrected, true, 'the desk should be told its rate was stale');

        // 10g × the fixture's 1000/g, +3% GST — the client's 103 is discarded.
        assert.equal(body.sale.goldPricePerGram, FIXTURE_RATE);
        assert.equal(body.sale.metalValue, 10000);
        assert.equal(body.sale.totalAmount, 10300);
        assert.equal(body.sale.goldRateSource, 'auto');
    });

    await check('a manual rate override in Settings is what invoices actually bill at', async () => {
        const settingsFile = path.join(dataDir, 'settings.json');
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        fs.writeFileSync(settingsFile, JSON.stringify({
            ...saved,
            overrideGoldPrice: { active: true, price24K: 0, price22K: 2000, price18K: 0 }
        }, null, 2));

        try {
            const response = await request('/api/sales', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    purity: '22K', weightGrams: 1, goldPricePerGram: 2000,
                    makingChargeAmount: 0, discountPercent: 0, totalAmount: 2060, appliedAdvance: 0
                })
            });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.sale.goldPricePerGram, 2000);
            assert.equal(body.sale.metalValue, 2000);
            // Provenance is recorded, so an audit can tell a counter override
            // from a synced market rate.
            assert.equal(body.sale.goldRateSource, 'manual');
            assert.equal(body.rateCorrected, false);
        } finally {
            fs.writeFileSync(settingsFile, JSON.stringify(saved, null, 2));
        }
    });

    /* ======================================================================
       Settings TYPE validation.

       POST /api/settings spreads the request body over settings.json, and the
       billing pipeline reads those keys with plain JS coercion — so a wrong
       TYPE did not fail loudly, it produced a wrong invoice. Each case below is
       a real defect that reached the permanent ledger.
       ====================================================================== */

    const postSettings = (body) => request('/api/settings', {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const postSale = () => request('/api/sales', {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            purity: '22K', weightGrams: 1, makingChargeAmount: 0,
            discountPercent: 0, totalAmount: 1030
        })
    });

    await check('a stringified invoice sequence is stored as a NUMBER, not concatenated', async () => {
        // "10" + 1 === "101". The sequence used to run 10 → 101 → 1011 → 10111,
        // destroying a strictly-sequential, legally-relevant invoice series.
        const saved = readData('settings.json');
        try {
            assert.equal((await postSettings({ invoiceSeqStart: '4000' })).status, 200);
            assert.equal(typeof readData('settings.json').invoiceSeqStart, 'number',
                'the stored sequence must be a number');

            const first = await (await postSale()).json();
            assert.match(first.invoiceId, /-004000-/, 'first invoice uses the sequence as given');

            /* The counter lives in `document_sequences` now, not in
               settings.json — that key is the SEED a financial year opens at,
               and POST /api/settings pushes an edit through to the sequence.
               So the concatenation bug is asserted where the number actually
               comes from: the next allocation, not a JSON field. */
            const second = await (await postSale()).json();
            assert.match(second.invoiceId, /-004001-/,
                'the sequence increments by one, not by concatenation');

            const third = await (await postSale()).json();
            assert.match(third.invoiceId, /-004002-/, 'and keeps incrementing by one');
        } finally {
            fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(saved, null, 2));
        }
    });

    await check('a non-numeric invoice sequence is refused rather than stamped into an invoice', async () => {
        // parseInt('abc') is NaN, which used to skip the lower-the-sequence
        // guard entirely and file invoice "HTTP-000abc-26".
        const response = await postSettings({ invoiceSeqStart: 'abc' });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /invoiceSeqStart/);
        assert.notEqual(readData('settings.json').invoiceSeqStart, 'abc');
    });

    await check('a non-numeric GST slab is refused rather than silently billing 0%', async () => {
        // Number('abc') || 0 === 0. The store stopped charging GST while every
        // screen still looked normal.
        const response = await postSettings({ goldTaxSlab: 'abc' });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /goldTaxSlab/);
        assert.equal(readData('settings.json').goldTaxSlab, 3, 'the working slab is untouched');
    });

    await check('an out-of-range GST slab is refused', async () => {
        for (const slab of [-50, 101, 1e9]) {
            const response = await postSettings({ goldTaxSlab: slab });
            assert.equal(response.status, 400, `slab ${slab} must be refused`);
        }
        assert.equal(readData('settings.json').goldTaxSlab, 3);
    });

    await check('an out-of-range discount approval threshold is refused', async () => {
        for (const value of [-1, 101, 'abc']) {
            const response = await postSettings({ discountApprovalThreshold: value });
            assert.equal(response.status, 400, `threshold ${JSON.stringify(value)} must be refused`);
        }
        assert.equal(readData('settings.json').discountApprovalThreshold, 0);
    });

    await check('an object invoice prefix cannot reach a permanent invoice number', async () => {
        // {} stamped "[object Object]-000011-26" into the ledger; an object with
        // a non-callable toString threw on EVERY sale until settings were
        // hand-edited.
        for (const prefix of [{ evil: 1 }, { toString: 'not-a-function' }, ['A'], 42]) {
            const response = await postSettings({ invoicePrefix: prefix });
            assert.equal(response.status, 400, `prefix ${JSON.stringify(prefix)} must be refused`);
        }
        const sale = await (await postSale()).json();
        assert.ok(!String(sale.invoiceId).includes('[object'), 'no invoice carries [object Object]');
    });

    await check('a poisoned settings.json is repaired rather than propagated', async () => {
        // A restored backup or hand edit never passes through the route
        // validator, so the invoice-numbering choke point coerces too.
        const saved = readData('settings.json');
        try {
            fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
                ...saved, invoicePrefix: { evil: 1 }, invoiceSeqStart: '77'
            }, null, 2));

            const sale = await (await postSale()).json();
            // A well-formed number under a usable prefix — never
            // "[object Object]-…", and never a concatenated sequence. The
            // number itself continues this financial year's series (the
            // allocator is `document_sequences`, and invoiceSeqStart only seeds
            // a year that has issued nothing), so the assertion is on the SHAPE
            // rather than on a specific value.
            assert.match(sale.invoiceId, /^GOLD-\d{6}-\d{2}$/,
                'falls back to a usable prefix and a well-formed sequence');

            const after = readData('settings.json');
            assert.equal(after.invoicePrefix, 'GOLD', 'the unusable prefix is corrected on disk');
            assert.equal(after.invoiceSeqStart, 77,
                'the stringified sequence is corrected to a number on disk');
        } finally {
            fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(saved, null, 2));
        }
    });

    await check('a valid settings patch is still accepted and canonicalised', async () => {
        const saved = readData('settings.json');
        try {
            assert.equal((await postSettings({ taxMode: '  inclusive  ', goldTaxSlab: '5' })).status, 200);
            const after = readData('settings.json');
            assert.equal(after.taxMode, 'Inclusive', 'casing and padding are canonicalised');
            assert.equal(after.goldTaxSlab, 5, 'a numeric string is stored as a number');
            assert.equal(typeof after.goldTaxSlab, 'number');
        } finally {
            fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(saved, null, 2));
        }
    });

    await check('client-supplied fields cannot smuggle themselves into the ledger', async () => {
        const backdated = Date.UTC(2001, 0, 1);
        const before = Date.now();
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purity: '22K', weightGrams: 1, makingChargeAmount: 0,
                discountPercent: 0, totalAmount: 1030, appliedAdvance: 0,
                // Every one of these used to land in sales_YYYY.json verbatim
                // via `...req.body`.
                timestamp: backdated,
                taxAmount: 0,
                taxPercent: 0,
                discount: 99999,
                id: 'FORGED-INVOICE-1',
                isPaid: true,
                arbitraryJunk: 'x'.repeat(50)
            })
        });
        assert.equal(response.status, 200);
        const sale = (await response.json()).sale;

        assert.ok(sale.timestamp >= before, 'the sale must carry the server clock, not the client’s');
        assert.notEqual(sale.timestamp, backdated);
        assert.match(sale.id, /^HTTP-\d{6}-\d{2}$/, 'the invoice id must be the server’s sequence');
        assert.equal(sale.taxPercent, 3);
        assert.equal(sale.taxAmount, 30);
        assert.equal(sale.discount, 0);
        assert.equal(sale.isPaid, undefined, 'unknown client fields must not be persisted');
        assert.equal(sale.arbitraryJunk, undefined);
    });

    await check('a sale is refused outright when no usable gold rate exists', async () => {
        const ratesFile = path.join(dataDir, 'rates.json');
        const saved = fs.readFileSync(ratesFile, 'utf8');
        fs.writeFileSync(ratesFile, JSON.stringify({ price24K: 0, price22K: 0, price18K: 0 }, null, 2));
        const seqBefore = readData('settings.json').invoiceSeqStart;

        try {
            const response = await request('/api/sales', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    purity: '22K', weightGrams: 1, makingChargeAmount: 0,
                    discountPercent: 0, totalAmount: 1030, appliedAdvance: 0
                })
            });
            // Refusing beats guessing: a zero-rate invoice bills the customer
            // for the making charge alone and gives the gold away.
            assert.equal(response.status, 503);
            assert.match((await response.json()).error, /gold rate/i);
            assert.equal(readData('settings.json').invoiceSeqStart, seqBefore,
                'a refused sale must not consume an invoice number');
        } finally {
            fs.writeFileSync(ratesFile, saved);
        }
    });

    /* ======================================================================
       Returns & refunds

       The invoice under test: 10 g of 22K at the fixture rate of ₹1,000/g =
       ₹10,000 metal, plus ₹1,000 making = ₹11,000, plus 3% exclusive GST of
       ₹330. Filed total ₹11,330, no advance redeemed. Every refund figure
       below is worked out from those numbers by hand.
       ====================================================================== */

    const returnsFileName = `returns_${new Date().getFullYear()}.json`;
    let returnableInvoiceId;

    await check('an invoice is filed to return against', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purity: '22K', weightGrams: 10, makingChargeAmount: 1000,
                makingChargePercent: 10, discountPercent: 0,
                totalAmount: 11330, appliedAdvance: 0,
                customerName: 'HTTP Customer', customerPhone: phone
            })
        });
        assert.equal(response.status, 200);
        const sale = (await response.json()).sale;
        assert.equal(sale.totalAmount, 11330);
        returnableInvoiceId = sale.id;
    });

    await check('filing a return without an admin session is rejected', async () => {
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: returnableInvoiceId, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(response.status, 401);
        assert.equal(ledger.returns().length, 0,
            'a rejected return must not create a returns ledger');
    });

    await check('reading the returns ledger requires an admin session', async () => {
        assert.equal((await request('/api/returns')).status, 401);
    });

    await check('a return against an invoice that does not exist is refused', async () => {
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: 'NO-SUCH-INVOICE', weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(response.status, 404);
    });

    await check('a refund mode other than cash or gold is refused', async () => {
        for (const refundMode of ['store-credit', '', null, 'CASH']) {
            const response = await request('/api/returns', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ invoiceId: returnableInvoiceId, weightGrams: 1, refundMode })
            });
            assert.equal(response.status, 400, `refundMode ${JSON.stringify(refundMode)} must be refused`);
        }
    });

    await check('returning more than the invoice weighs is refused, writing nothing', async () => {
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: returnableInvoiceId, weightGrams: 10.001, refundMode: 'cash' })
        });
        assert.equal(response.status, 400);
        assert.equal(ledger.returns().length, 0);
    });

    await check('a partial cash return refunds ₹4,532 for 4 g and touches no advance', async () => {
        // 4 g @ 1,000 = 4,000 metal; making 1,000 × 0.4 = 400; gross 4,400;
        // 3% = 132. Refund 4,532.
        const advancesBefore = ledger.advances().length;
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invoiceId: returnableInvoiceId, weightGrams: 4,
                refundMode: 'cash', note: 'size exchange'
            })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.return.refundAmount, 4532);
        assert.equal(body.return.refundMode, 'cash');
        assert.equal(body.return.closesInvoice, false);
        assert.equal(body.remainingWeightGrams, 6);
        assert.equal(body.advanceCredit, null);

        const rows = ledger.returns();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].originalInvoiceId, returnableInvoiceId);
        assert.equal(rows[0].taxAmount, 132);
        assert.equal(rows[0].note, 'size exchange');
        // A cash refund is handed over the counter — it must not quietly
        // become store credit as well.
        assert.equal(ledger.advances().length, advancesBefore,
            'a cash refund must not write to the advances ledger');
    });

    await check('the sale stays exactly as filed — returns never rewrite an invoice', async () => {
        const sale = ledger.sales()
            .find(s => s.id === returnableInvoiceId);
        assert.equal(sale.totalAmount, 11330);
        assert.equal(sale.weightGrams, 10);
        assert.equal(sale.returnedWeightGrams, undefined,
            'return state must be derived from the returns ledger, not stamped on the sale');
    });

    await check('invoice lookup reports what has come back and what is still returnable', async () => {
        const response = await request(`/api/sales/lookup?q=${returnableInvoiceId}`, { headers: adminHeaders });
        assert.equal(response.status, 200);
        const hit = (await response.json()).results.find(s => s.id === returnableInvoiceId);
        assert.equal(hit.returnedWeightGrams, 4);
        assert.equal(hit.refundedAmount, 4532);
        assert.equal(hit.returnableWeightGrams, 6);
        assert.equal(hit.returnCount, 1);
        assert.equal(hit.fullyReturned, false);
    });

    await check('a client-supplied refund figure is ignored — the server prices the return', async () => {
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invoiceId: returnableInvoiceId, weightGrams: 1, refundMode: 'cash',
                // Every one of these would land in the ledger if the route
                // spread the body instead of naming its fields.
                refundAmount: 999999, taxAmount: 999999, id: 'FORGED-RETURN',
                timestamp: Date.UTC(2001, 0, 1), customerPhone: '9999999999',
                arbitraryJunk: 'x'.repeat(50)
            })
        });
        assert.equal(response.status, 200);
        const record = (await response.json()).return;
        // 1 g: 1,000 metal + 100 making = 1,100; 3% = 33. Refund 1,133.
        assert.equal(record.refundAmount, 1133);
        assert.equal(record.taxAmount, 33);
        // A return is a NUMBERED CREDIT NOTE now, allocated from the same
        // transactional sequence an invoice is — so the client's proposed
        // 'FORGED-RETURN' is not merely ignored, it is unrepresentable.
        assert.match(record.id, /^CN-\d{6}-\d{2}$/);
        assert.notEqual(record.id, 'FORGED-RETURN');
        assert.equal(record.customerPhone, phone, 'the phone must come off the invoice');
        assert.ok(record.timestamp > Date.UTC(2001, 0, 1));
        assert.equal(record.arbitraryJunk, undefined);
    });

    await check('a gold refund credits the advance ledger in the same commit', async () => {
        // 5 g remain. The closing return trues up to the unrefunded balance:
        // 11,330 − 4,532 − 1,133 = 5,665.
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invoiceId: returnableInvoiceId, weightGrams: 5, refundMode: 'gold'
            })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.return.refundAmount, 5665);
        assert.equal(body.return.closesInvoice, true);
        assert.equal(body.remainingWeightGrams, 0);

        const credit = ledger.advances().find(a => a.id === body.return.advanceCreditId);
        assert.ok(credit, 'the gold refund must have written its credit row');
        assert.equal(credit.type, 'deposit');
        assert.equal(credit.amount, 5665);
        assert.equal(credit.status, 'approved');
        assert.equal(credit.source, 'return');
        assert.equal(credit.invoiceId, returnableInvoiceId);
        assert.equal(credit.returnId, body.returnId);
        // The customer portal's Gold Appreciation panel reads this field off
        // every deposit row; a refund credit missing it would break that panel.
        assert.ok(credit.lockedGoldRate22K > 0);
    });

    await check('the gold credit is spendable balance the moment it is filed', async () => {
        const response = await request(`/api/advances/lookup?phone=${phone}`, { headers: adminHeaders });
        assert.equal(response.status, 200);
        const ledger = await response.json();
        assert.ok(ledger.balance >= 5665, `refund credit must be spendable, balance ${ledger.balance}`);
        assert.equal(ledger.pendingCount, 0, 'a store-issued refund needs no approval step');
    });

    await check('every refund against one invoice sums to exactly what it charged', async () => {
        const rows = ledger.returns().filter(r => r.originalInvoiceId === returnableInvoiceId);
        const total = rows.reduce((sum, r) => sum + r.refundAmount, 0);
        assert.equal(Math.round(total * 100) / 100, 11330);
        assert.equal(rows.reduce((sum, r) => sum + r.weightGrams, 0), 10);
    });

    await check('a fully returned invoice refuses any further return', async () => {
        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: returnableInvoiceId, weightGrams: 0.001, refundMode: 'cash' })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /returned in full/i);
        assert.equal(ledger.returns().length, 3, 'no fourth row may be written');
    });

    await check('lookup marks the invoice closed once everything has come back', async () => {
        const response = await request(`/api/sales/lookup?q=${returnableInvoiceId}`, { headers: adminHeaders });
        const hit = (await response.json()).results.find(s => s.id === returnableInvoiceId);
        assert.equal(hit.fullyReturned, true);
        assert.equal(hit.returnableWeightGrams, 0);
        assert.equal(hit.refundedAmount, 11330);
    });

    await check('a gold refund is refused on an invoice with no customer account', async () => {
        const walkIn = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purity: '22K', weightGrams: 1, makingChargeAmount: 0,
                discountPercent: 0, totalAmount: 1030, appliedAdvance: 0
            })
        });
        const cashSaleId = (await walkIn.json()).sale.id;

        const refused = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: cashSaleId, weightGrams: 1, refundMode: 'gold' })
        });
        assert.equal(refused.status, 400);
        assert.match((await refused.json()).error, /no customer phone/i);

        // The same invoice refunds fine as cash, which is how it was paid.
        const allowed = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: cashSaleId, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(allowed.status, 200);
        assert.equal((await allowed.json()).return.refundAmount, 1030);
    });

    await check('a mid-commit failure rolls a gold return back completely', async () => {
        /* A failure between the credit note and the advance credit would
           otherwise leave either a refund nobody was credited for, or credit
           against a return that never happened — the reason both share one
           transaction.

           The failure is injected where one can genuinely occur over HTTP: the
           approval threshold. `authorizeRefund` runs INSIDE the transaction, on
           the server's own priced refund — by which point the credit-note
           number has been allocated and the note itself inserted. Refusing
           there is a true mid-transaction failure, and everything before it
           must unwind.

           (The JSON version injected an fs.renameSync error to break a
           multi-file write. There is no multi-file write to break any more; the
           equivalent guarantee is the database's, and test_schema.js asserts
           the primitive directly.) */
        const sale = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purity: '22K', weightGrams: 2, makingChargeAmount: 0,
                discountPercent: 0, totalAmount: 2060, appliedAdvance: 0,
                customerName: 'HTTP Customer', customerPhone: phone
            })
        });
        const rollbackInvoiceId = (await sale.json()).sale.id;

        const returnsBefore = ledger.returns();
        const advancesBefore = ledger.advances();

        // The master PIN is an owner — it may approve — but it carries no
        // second factor and cannot enrol one, so this refuses from inside the
        // transaction rather than at the door.
        assert.equal((await postSettings({
            refundApprovalThreshold: 1, requireMfaForApprovers: true
        })).status, 200);

        let response;
        try {
            response = await request('/api/returns', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invoiceId: rollbackInvoiceId, weightGrams: 2, refundMode: 'gold'
                })
            });
        } finally {
            await postSettings({ refundApprovalThreshold: 0, requireMfaForApprovers: false });
        }

        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, 'MFA_REQUIRED');

        // Nothing the transaction had already written survives.
        assert.deepEqual(ledger.returns(), returnsBefore, 'no credit note may survive the rollback');
        assert.deepEqual(ledger.advances(), advancesBefore, 'no advance credit may survive the rollback');

        // And the credit-note number it allocated was rolled back rather than
        // burned: the next successful return takes the number this one would
        // have had, leaving no gap in a legally-sequential series.
        const next = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invoiceId: rollbackInvoiceId, weightGrams: 2, refundMode: 'gold'
            })
        });
        assert.equal(next.status, 200);
        const filed = (await next.json()).return;
        const highestBefore = returnsBefore
            .map(r => Number(String(r.id).split('-')[1]))
            .reduce((a, b) => Math.max(a, b), 0);
        assert.equal(Number(String(filed.id).split('-')[1]), highestBefore + 1,
            'the rolled-back allocation left no gap in the credit-note series');
    });

    /* ----------------------------------------------------------------------
       The customer's own view of a return — "it reflects on mobile".
       ---------------------------------------------------------------------- */

    await check('a customer cannot read returns without a session', async () => {
        const response = await request('/api/customer/returns');
        assert.equal(response.status, 401);
    });

    await check('a signed-in customer sees their own returns, scoped to their session', async () => {
        const issued = await request('/api/customer-accounts/issue-login', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, name: 'HTTP Customer', confirmDestructive: true })
        });
        assert.equal(issued.status, 200);
        const tempPassword = (await issued.json()).tempPassword;

        const signIn = async (password) => {
            const session = await loginCustomerHttp(request, { phone, password });
            assert.equal(session.response.status, 200);
            return session.headers;
        };

        // A freshly issued login must set its own password before the portal
        // opens, so the test walks the same path a real customer does.
        const tempHeaders = await signIn(tempPassword);
        const changed = await request('/api/customer/password/change', {
            method: 'POST',
            headers: { ...tempHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword: tempPassword, newPassword: 'PortalPass!2026' })
        });
        assert.equal(changed.status, 200);

        const customerHeaders = await signIn('PortalPass!2026');
        const response = await request('/api/customer/returns', {
            headers: customerHeaders
        });
        assert.equal(response.status, 200);
        const rows = (await response.json()).returns;

        // Every return filed against this phone so far — counted from the
        // ledger rather than pinned to a literal, so adding a return check
        // above does not fail an assertion that is really about SCOPING.
        assert.equal(rows.length, ledger.returns().filter(r => r.customerPhone === phone).length);
        assert.ok(rows.length >= 3, 'the returns filed against this phone are all visible');
        assert.equal(rows.every(r => r.refundAmount > 0), true);
        assert.equal(rows.some(r => r.refundMode === 'gold'), true);
        assert.equal(rows.some(r => r.refundMode === 'cash'), true);
        // Internal cashier remarks are not the customer's correspondence.
        assert.equal(rows.every(r => r.note === undefined), true);
        assert.equal(rows.every(r => r.customerPhone === undefined), true);

        // And the gold refund is visible as spendable credit on the same screen.
        const advancesResponse = await request('/api/customer/advances', {
            headers: customerHeaders
        });
        assert.equal(advancesResponse.status, 200);
        const advances = await advancesResponse.json();
        const creditRows = advances.history.filter(a => a.source === 'return');
        assert.ok(creditRows.length > 0, 'the gold refund must appear in the customer’s own ledger');
        // The closing return trued up to the unrefunded balance — matched by
        // value rather than by position, since more than one gold refund is
        // credited to this phone over the course of the suite.
        assert.ok(creditRows.some(a => a.amount === 5665),
            'the closing gold refund is credited at its trued-up value');
    });

    /* ======================================================================
       Razorpay webhook ingestion (roadmap Phase 0)
       ====================================================================== */

    const webhookOrder = 'order_webhook_test_1';
    // The order intent the gateway will claim to have captured against.
    // Recorded through the service, so it is the same row a real checkout
    // would have created.
    assert.equal(paymentServiceModule.recordOrder({
        providerOrderId: webhookOrder,
        customerPhone: phone,
        amountPaise: 250000,
        currency: 'INR'
    }), true, 'the webhook fixture order must be recorded');

    const capturedEvent = (paymentId, orderId, amountPaise) => JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, status: 'captured' } } }
    });

    const postWebhook = (rawBody, { signature, eventId } = {}) => request('/api/payment/webhook', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-razorpay-signature': signature !== undefined
                ? signature
                : crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'),
            ...(eventId ? { 'x-razorpay-event-id': eventId } : {})
        },
        body: rawBody
    });

    await check('an unsigned webhook delivery is rejected and credits nothing', async () => {
        const advancesBefore = ledger.advances();
        const response = await postWebhook(capturedEvent('pay_unsigned', webhookOrder, 250000), { signature: '' });
        assert.equal(response.status, 400);
        assert.deepEqual(ledger.advances(), advancesBefore);
    });

    await check('a webhook signed with the wrong secret is rejected', async () => {
        const raw = capturedEvent('pay_wrongsig', webhookOrder, 250000);
        const forged = crypto.createHmac('sha256', 'not-the-webhook-secret').update(raw).digest('hex');
        const response = await postWebhook(raw, { signature: forged });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /signature/i);
    });

    await check('a tampered body fails verification even with a valid signature for the original', async () => {
        const original = capturedEvent('pay_tamper', webhookOrder, 250000);
        const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(original).digest('hex');
        // The amount is raised after signing — the exact attack the raw-body
        // requirement exists to defeat.
        const tampered = capturedEvent('pay_tamper', webhookOrder, 9900000);
        const response = await postWebhook(tampered, { signature });
        assert.equal(response.status, 400);
    });

    await check('a signed payment.captured credits the ledger for the order’s stored amount', async () => {
        const response = await postWebhook(
            capturedEvent('pay_captured_ok', webhookOrder, 250000),
            { eventId: 'evt_capture_1' }
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).success, true);

        const deposit = ledger.advances().find(a => a.referenceId === 'pay_captured_ok');
        assert.ok(deposit, 'the captured payment should have produced a deposit row');
        assert.equal(deposit.amount, 2500);
        assert.equal(deposit.status, 'approved');
        assert.equal(deposit.customerPhone, phone, 'credit goes to the order’s customer, not the webhook body’s');
        assert.match(deposit.id, /^ADV-[0-9A-F]{12}$/, 'ledger ids must be cryptographically strong');

        const order = ledger.order(webhookOrder);
        assert.equal(order.status, 'paid');
        assert.equal(order.depositId, deposit.id);
    });

    await check('a redelivered webhook is acknowledged without crediting twice', async () => {
        const depositsBefore = ledger.advances().filter(a => a.referenceId === 'pay_captured_ok').length;
        const response = await postWebhook(
            capturedEvent('pay_captured_ok', webhookOrder, 250000),
            { eventId: 'evt_capture_1' }
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).duplicate, true);
        assert.equal(ledger.advances().filter(a => a.referenceId === 'pay_captured_ok').length, depositsBefore);
    });

    await check('the same payment under a NEW event id still credits only once', async () => {
        // Razorpay can legitimately emit a fresh event id for the same
        // payment. Event-id deduplication alone would let that through, so the
        // ledger's own payment-id constraint is what has to hold.
        const response = await postWebhook(
            capturedEvent('pay_captured_ok', webhookOrder, 250000),
            { eventId: 'evt_capture_2_different' }
        );
        assert.equal(response.status, 200);
        assert.equal(ledger.advances().filter(a => a.referenceId === 'pay_captured_ok').length, 1);
    });

    await check('a capture for the wrong amount is refused, not credited', async () => {
        const mismatchOrder = 'order_webhook_mismatch';
        paymentServiceModule.recordOrder({
            providerOrderId: mismatchOrder, customerPhone: phone, amountPaise: 100000, currency: 'INR'
        });

        const response = await postWebhook(
            capturedEvent('pay_mismatch', mismatchOrder, 5000), // ₹50 against a ₹1000 order
            { eventId: 'evt_mismatch_1' }
        );
        assert.equal(response.status, 200); // acknowledged, so it stops being retried
        assert.equal((await response.json()).ignored, 'amount-mismatch');
        assert.equal(ledger.advances().some(a => a.referenceId === 'pay_mismatch'), false);
        assert.equal(ledger.order(mismatchOrder).status, 'mismatched');
    });

    await check('an EXPIRED order whose payment the gateway captured is still credited', async () => {
        // Expiry bounds how long an unpaid intent is kept; it must never refuse
        // money that actually moved. Refusing here would strand a customer who
        // paid on a slow connection, and no amount of retrying would fix it.
        const staleOrder = 'order_webhook_expired';
        paymentServiceModule.recordOrder({
            providerOrderId: staleOrder, customerPhone: phone, amountPaise: 77700, currency: 'INR'
        });
        // Aged past any expiry window. An order intent is no longer pruned, but
        // the property under test is unchanged: expiry bounds how long an
        // UNPAID intent is kept and must never refuse money that actually moved.
        repo.unsafeDatabaseHandle()
            .prepare('UPDATE payment_orders SET created_at = ? WHERE provider_order_id = ?')
            .run(Date.now() - (48 * 60 * 60 * 1000), staleOrder);

        const response = await postWebhook(
            capturedEvent('pay_expired_but_real', staleOrder, 77700),
            { eventId: 'evt_expired_1' }
        );
        assert.equal(response.status, 200);
        const deposit = ledger.advances().find(a => a.referenceId === 'pay_expired_but_real');
        assert.ok(deposit, 'a captured payment against an expired order must still be credited');
        assert.equal(deposit.amount, 777);
    });

    await check('a webhook for an unknown order is acknowledged but credits nothing', async () => {
        const response = await postWebhook(
            capturedEvent('pay_orphan', 'order_never_created_here', 250000),
            { eventId: 'evt_orphan_1' }
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).ignored, 'unknown-order');
        assert.equal(ledger.advances().some(a => a.referenceId === 'pay_orphan'), false);
    });

    await check('payment.failed marks the order failed without touching the ledger', async () => {
        const failOrder = 'order_webhook_failed';
        paymentServiceModule.recordOrder({
            providerOrderId: failOrder, customerPhone: phone, amountPaise: 100000, currency: 'INR'
        });

        const raw = JSON.stringify({
            event: 'payment.failed',
            payload: { payment: { entity: { id: 'pay_failed_1', order_id: failOrder, amount: 100000, status: 'failed', error_description: 'card declined' } } }
        });
        const response = await postWebhook(raw, { eventId: 'evt_failed_1' });
        assert.equal(response.status, 200);
        assert.equal(ledger.advances().some(a => a.referenceId === 'pay_failed_1'), false);
        assert.equal(ledger.order(failOrder).status, 'failed');
    });

    await check('an unrelated signed event is acknowledged and ignored', async () => {
        const raw = JSON.stringify({ event: 'refund.created', payload: {} });
        const response = await postWebhook(raw, { eventId: 'evt_refund_1' });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).ignored, 'refund.created');
    });

    await check('the webhook is refused outright when no webhook secret is configured', async () => {
        const settingsFile = path.join(dataDir, 'settings.json');
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        fs.writeFileSync(settingsFile, JSON.stringify({ ...saved, razorpayWebhookSecret: '' }, null, 2));
        try {
            const raw = capturedEvent('pay_nosecret', webhookOrder, 250000);
            const response = await postWebhook(raw, { eventId: 'evt_nosecret_1' });
            assert.equal(response.status, 503);
            assert.equal(ledger.advances().some(a => a.referenceId === 'pay_nosecret'), false);
        } finally {
            fs.writeFileSync(settingsFile, JSON.stringify(saved, null, 2));
        }
    });

    await check('GET /api/settings redacts the webhook secret too', async () => {
        const response = await request('/api/settings', { headers: adminHeaders });
        const settings = await response.json();
        assert.equal(settings.razorpayWebhookSecret, null);
        assert.equal(settings.razorpayWebhookSecretConfigured, true);
        assert.doesNotMatch(JSON.stringify(settings), new RegExp(WEBHOOK_SECRET));
    });

    await check('a mid-commit failure rolls the entire HTTP sale back', async () => {
        /* The sale is ONE transaction: the number, the header, its lines, its
           tenders and any advance redemption commit together or not at all.
           The failure is injected where one can genuinely occur over HTTP — a
           tender split that does not add up, which `recordSuppliedTenders`
           refuses AFTER the sequence has been allocated and the invoice, its
           lines and the redemption have all been written.

           (The JSON version injected an fs.renameSync error to break a
           multi-file write. There is no multi-file write to break any more;
           test_schema.js asserts the database primitive directly.) */
        const salesBefore = ledger.sales();
        const advancesBefore = ledger.advances();

        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                // ₹1,030 is payable; ₹500 is tendered. The invoice must not be
                // filed with a payment record that disagrees with its total.
                tenders: [
                    { method: 'cash', amount: 300 },
                    { method: 'card', amount: 200 }
                ]
            })
        });

        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /do not add up|payable/i);

        assert.deepEqual(ledger.sales(), salesBefore, 'no invoice may survive the rollback');
        assert.deepEqual(ledger.advances(), advancesBefore, 'no redemption may survive the rollback');

        // The invoice number it allocated rolled back rather than being burned:
        // the next sale takes the number this one would have had.
        const highestBefore = salesBefore
            .map(s => Number(String(s.id).split('-')[1]))
            .reduce((a, b) => Math.max(a, b), 0);
        const next = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        });
        assert.equal(next.status, 200);
        const filed = (await next.json()).invoiceId;
        assert.equal(Number(String(filed).split('-')[1]), highestBefore + 1,
            'a rolled-back sale leaves no gap in the invoice series');
    });
    /* ==================================================================
       Multi-line invoices over HTTP
       ================================================================== */

    await check('a multi-line sale stores a line per item and a correct rollup', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerName: 'Multi Line Customer',
                customerPhone: phone,
                lines: [
                    { description: 'Bangles', purity: '22K', weightGrams: 2, makingChargeAmount: 100, makingChargePercent: 5 },
                    { description: 'Chain', purity: '18K', weightGrams: 1, makingChargeAmount: 50, makingChargePercent: 6 }
                ],
                totalAmount: 0
            })
        });
        assert.equal(response.status, 200);
        const { sale } = await response.json();

        assert.equal(sale.lines.length, 2);
        assert.equal(sale.lines[0].lineNumber, 1);
        assert.equal(sale.lines[1].purity, '18K');
        /* Each line priced at ITS OWN purity's store rate, never the request's.
           Stored at the schema's scale for a metal rate — integer paise per
           gram — so an 18K rate of ₹818.1818…/g reads back as ₹818.18. The
           money is unaffected: the line's metal value is computed from the
           full-precision rate at pricing time and stored as its own figure,
           rather than being re-derived from the rounded rate on read. */
        assert.equal(sale.lines[0].goldPricePerGram, FIXTURE_RATE);
        assert.equal(sale.lines[1].goldPricePerGram, Math.round(FIXTURE_RATE * 18 / 22 * 100) / 100);

        // The rollup describes the whole document, not line 1.
        assert.equal(sale.purity, 'MIXED');
        assert.equal(sale.weightGrams, 3);
        assert.equal(sale.goldPricePerGram, 0, 'a mixed-rate invoice states no single rate');
        assert.equal(sale.makingChargeAmount, 150);

        // The rows sum to the header, to the paise — the identity the whole
        // per-line allocation exists to guarantee.
        const taxableSum = sale.lines.reduce((t, l) => t + l.taxableAmount, 0);
        const taxSum = sale.lines.reduce((t, l) => t + l.taxAmount, 0);
        assert.equal(Math.round(taxableSum * 100), Math.round(sale.taxableAmount * 100));
        assert.equal(Math.round(taxSum * 100), Math.round(sale.taxAmount * 100));
    });

    await check('a single-line request still stores one line and the same scalars', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        });
        assert.equal(response.status, 200);
        const { sale } = await response.json();
        assert.equal(sale.lines.length, 1);
        assert.equal(sale.purity, '22K', 'a single-purity invoice states its purity, not MIXED');
        assert.equal(sale.weightGrams, 1);
        assert.equal(sale.goldPricePerGram, FIXTURE_RATE);
        assert.equal(sale.totalAmount, 1030);
    });

    await check('wastage is off by default — a sale prices identically to before it existed', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                purity: '22K', weightGrams: 2, makingChargeAmount: 0, discountPercent: 0, totalAmount: 0
            })
        });
        const { sale } = await response.json();
        assert.equal(sale.lines[0].wastageMode, 'none');
        assert.equal(sale.lines[0].wastageAmount, 0);
        assert.equal(sale.totalAmount, 2060, '2g × ₹1,000 + 3% GST, untouched by a disabled feature');
    });

    await check('enabling wastage charges every line uniformly from settings, never from the request', async () => {
        assert.equal((await postSettings({
            wastageEnabled: true, wastageMode: 'weight_uplift', wastagePercent: 5
        })).status, 200);

        let response;
        try {
            response = await request('/api/sales', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    purity: '22K', weightGrams: 2, makingChargeAmount: 0, discountPercent: 0,
                    // A tampered payload proposing its own wastage figures — the
                    // server must ignore both and use the settings-configured
                    // model instead.
                    wastageMode: 'separate_line', wastageAmount: 999999,
                    totalAmount: 0
                })
            });
        } finally {
            await postSettings({ wastageEnabled: false, wastageMode: 'weight_uplift', wastagePercent: 0 });
        }

        assert.equal(response.status, 200);
        const { sale } = await response.json();
        // 5% of 2g = 0.1g extra, priced at the same ₹1,000/g line rate = ₹100 —
        // the request's proposed 'separate_line'/999999 must be ignored entirely.
        assert.equal(sale.lines[0].wastageMode, 'weight_uplift');
        assert.equal(sale.lines[0].wastageWeightGrams, 0.1);
        assert.equal(sale.lines[0].wastageAmount, 100);
        // 2g metal (₹2,000) + ₹100 wastage = ₹2,100 pre-tax, 3% GST = ₹63.
        assert.equal(sale.totalAmount, 2163);
    });

    await check('one bad line refuses the whole invoice and names which line', async () => {
        const before = readData('settings.json').invoiceSeqStart;
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lines: [
                    { purity: '22K', weightGrams: 1 },
                    { purity: '99K', weightGrams: 1 }
                ],
                totalAmount: 0
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /Line 2/);
        // No invoice number burned on a rejected payload.
        assert.equal(readData('settings.json').invoiceSeqStart, before);
    });

    await check('returning one line of a multi-line invoice prices it at that line’s rate', async () => {
        const sale = (await (await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerName: 'Line Return Customer',
                customerPhone: phone,
                lines: [
                    { description: 'Ring', purity: '22K', weightGrams: 4, makingChargeAmount: 0 },
                    { description: 'Pendant', purity: '24K', weightGrams: 2, makingChargeAmount: 0 }
                ],
                totalAmount: 0
            })
        })).json()).sale;

        // Line 2 in full: 2 g @ the 24K rate, plus 3% GST.
        const expected = Math.round(2 * (FIXTURE_RATE * 24 / 22) * 1.03 * 100) / 100;
        const filed = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, lineNumber: 2, weightGrams: 2, refundMode: 'cash' })
        });
        assert.equal(filed.status, 200);
        const body = await filed.json();
        assert.equal(body.return.lineNumber, 2);
        assert.equal(body.return.purity, '24K');
        assert.equal(Math.abs(body.return.refundAmount - expected) < 0.02, true,
            `expected about ${expected}, got ${body.return.refundAmount}`);
        // Line 2 is closed; the invoice is not, because line 1 is untouched.
        assert.equal(body.return.closesLine, true);
        assert.equal(body.return.closesInvoice, false);
        assert.equal(body.invoiceRemainingWeightGrams, 4);

        // A second return against the SAME line is refused even though the
        // invoice still has returnable weight on line 1.
        const again = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, lineNumber: 2, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(again.status, 400);
        assert.match((await again.json()).error, /line 2/i);

        // Line 1 is still returnable, and closing it closes the invoice.
        const closing = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, lineNumber: 1, weightGrams: 4, refundMode: 'cash' })
        });
        assert.equal(closing.status, 200);
        const closed = await closing.json();
        assert.equal(closed.return.closesInvoice, true);
        // The two refunds together equal exactly what the invoice charged.
        const filedGross = Math.round((sale.totalAmount + sale.appliedAdvance) * 100);
        const refunded = Math.round((body.return.refundAmount + closed.return.refundAmount) * 100);
        assert.equal(refunded, filedGross, 'refunds must sum to the filed gross');
    });

    await check('a multi-line invoice refuses a return that does not name a line', async () => {
        const sale = (await (await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerPhone: phone,
                lines: [
                    { purity: '22K', weightGrams: 1, makingChargeAmount: 0 },
                    { purity: '18K', weightGrams: 1, makingChargeAmount: 0 }
                ],
                totalAmount: 0
            })
        })).json()).sale;

        const response = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /several items/i);
    });

    /* ==================================================================
       Tenders — how the invoice was paid
       ================================================================== */

    await check('a tender split that adds up is stored on the invoice', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                tenders: [
                    { method: 'cash', amount: 30 },
                    { method: 'card', amount: 1000, reference: 'SLIP-42' }
                ]
            })
        });
        assert.equal(response.status, 200);
        const { sale } = await response.json();
        assert.equal(sale.totalAmount, 1030);
        assert.equal(sale.tenders.length, 2);
        assert.equal(sale.tenders[1].method, 'card');
        assert.equal(sale.tenders[1].reference, 'SLIP-42');
    });

    await check('a tender split that does not add up refuses the sale', async () => {
        const before = readData('settings.json').invoiceSeqStart;
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                tenders: [{ method: 'cash', amount: 500 }]
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /do not add up/i);
        // Refused BEFORE the invoice number is consumed.
        assert.equal(readData('settings.json').invoiceSeqStart, before);
    });

    await check('an unknown tender method is refused', async () => {
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                tenders: [{ method: 'crypto', amount: 1030 }]
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /unknown method/i);
    });

    await check('a tender must cover the total AFTER an advance is redeemed', async () => {
        // A DEDICATED customer with a balance of exactly ₹100. Redeeming an
        // advance is all-or-nothing (computeInvoiceTotals redeems as much as the
        // balance allows), so the shared fixture customer — whose balance the
        // checks above legitimately spend and refund — cannot give a
        // deterministic total to tender against.
        const tenderPhone = '9000000123';
        const topUp = await request('/api/advances', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerPhone: tenderPhone,
                customerName: 'Tender Advance Customer',
                amount: 100,
                paymentMethod: 'Cash',
                referenceId: 'TENDER-ADVANCE-TOPUP'
            })
        });
        assert.equal(topUp.status, 200);

        // A redeemed advance was tendered when it was deposited. Requiring the
        // tenders to cover the pre-advance gross would double-count it.
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(100),
                customerPhone: tenderPhone,
                tenders: [{ method: 'cash', amount: 930 }]
            })
        });
        assert.equal(response.status, 200);
        const { sale } = await response.json();
        assert.equal(sale.appliedAdvance, 100);
        assert.equal(sale.totalAmount, 930);
        assert.equal(sale.tenders[0].amount, 930);
    });

    await check('a lone tender with no amount records the server’s own total', async () => {
        // The desk sends this for an ordinary unsplit sale. It is what keeps a
        // legitimately repriced invoice (rate synced overnight, slab edited
        // mid-shift) from being refused for disagreeing with the browser's
        // stale figure — the cashier's intent was "the whole bill, in cash".
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                // Deliberately disagrees with the server's 1030.
                totalAmount: 1,
                tenders: [{ method: 'cash' }]
            })
        });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.totalCorrected, true, 'the desk is still told it was repriced');
        assert.equal(body.sale.totalAmount, 1030);
        assert.equal(body.sale.tenders.length, 1);
        assert.equal(body.sale.tenders[0].amount, 1030, 'the tender follows the server total');
    });

    await check('an amountless tender is NOT accepted inside a split', async () => {
        // Two rows mean the cashier deliberately allocated amounts, so every
        // row must carry one — otherwise "the rest" would be guessed.
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                tenders: [{ method: 'cash', amount: 30 }, { method: 'card' }]
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /positive amount/i);
    });

    await check('an invoice fully settled by an advance records no counter tender', async () => {
        const freePhone = '9000000456';
        await request('/api/advances', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerPhone: freePhone,
                customerName: 'Fully Advance Customer',
                amount: 2000,
                paymentMethod: 'Cash',
                referenceId: 'FULLY-ADVANCE-TOPUP'
            })
        });
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...salePayload(0),
                customerPhone: freePhone,
                appliedAdvance: 2000,
                tenders: [{ method: 'cash' }]
            })
        });
        assert.equal(response.status, 200);
        const { sale } = await response.json();
        assert.equal(sale.totalAmount, 0, 'the advance covered the whole bill');
        assert.deepEqual(sale.tenders, [], 'nothing was tendered at the counter');
    });

    await check('an invoice with no tenders recorded is still accepted', async () => {
        // Every invoice filed before tenders existed has none, and the desk may
        // legitimately not record one — absent must never mean "paid nothing".
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json()).sale.tenders, []);
    });

    /* ==================================================================
       Actor identity — who filed the record
       ================================================================== */

    await check('the master PIN signs in as the store owner and is named on the sale', async () => {
        const me = await request('/api/admin/me', { headers: adminHeaders });
        assert.equal(me.status, 200);
        const identity = await me.json();
        assert.equal(identity.actor.id, 'owner');
        assert.equal(identity.actor.role, 'owner');
        assert.equal(identity.canApprove, true);

        const sale = (await (await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        })).json()).sale;
        assert.equal(sale.actor.id, 'owner');
        assert.equal(sale.actor.role, 'owner');
    });

    await check('a named cashier’s PIN identifies them, and their sales carry their name', async () => {
        const saved = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                operators: [
                    { name: 'Cashier One', role: 'cashier', pin: '432143', active: true },
                    { name: 'Manager Two', role: 'manager', pin: '567856', active: true }
                ]
            })
        });
        assert.equal(saved.status, 200);
        // The roster comes back without any PIN in it.
        const body = await saved.json();
        assert.doesNotMatch(JSON.stringify(body.settings.operators), /432143|567856/);
        assert.equal(body.settings.operators[0].pinConfigured, true);

        const cashierSession = await loginAdmin(request, { pin: '432143' });
        assert.equal(cashierSession.response.status, 200);
        const cashier = await cashierSession.response.json();
        assert.equal(cashier.actor.name, 'Cashier One');
        assert.equal(cashier.actor.role, 'cashier');
        assert.equal(cashier.canApprove, false);

        const sale = (await (await request('/api/sales', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        })).json()).sale;
        assert.equal(sale.actor.name, 'Cashier One');
        assert.equal(sale.actor.role, 'cashier');

        // …and their refunds do too.
        const refund = await request('/api/returns', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(refund.status, 200);
        assert.equal((await refund.json()).return.actor.name, 'Cashier One');
    });

    await check('two operators cannot share a PIN', async () => {
        const response = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                operators: [
                    { name: 'A', role: 'cashier', pin: '111111' },
                    { name: 'B', role: 'cashier', pin: '111111' }
                ]
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /same PIN/i);
    });

    await check('an operator with no PIN, a bad PIN or an unknown role is refused', async () => {
        const cases = [
            [{ name: 'No Pin', role: 'cashier' }, /needs a PIN/i],
            [{ name: 'Short', role: 'cashier', pin: '12' }, /6 to 8 digits/i],
            [{ name: 'Bad Role', role: 'wizard', pin: '987698' }, /unknown role/i],
            [{ role: 'cashier', pin: '987698' }, /needs a name/i]
        ];
        for (const [operator, pattern] of cases) {
            const response = await request('/api/settings', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ operators: [operator] })
            });
            assert.equal(response.status, 400, JSON.stringify(operator));
            assert.match((await response.json()).error, pattern);
        }
    });

    await check('a cashier cannot approve a deposit, a manager can', async () => {
        // A customer's unverified claim, sitting pending.
        const pendingId = seedPendingDeposit({ amount: 250, referenceId: 'UTR-ROLE-TEST' });

        const cashierSession = await loginAdmin(request, { pin: '432143' });

        const refused = await request(`/api/advances/${pendingId}/approve`, {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, 'APPROVER_REQUIRED');
        // Still pending — the refusal changed nothing.
        assert.equal(
            ledger.advances().find(a => a.id === pendingId).status,
            'pending'
        );

        const managerSession = await loginAdmin(request, { pin: '567856' });

        const allowed = await request(`/api/advances/${pendingId}/approve`, {
            method: 'POST',
            headers: { ...managerSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'seen on the bank statement' })
        });
        assert.equal(allowed.status, 200);
        const stored = ledger.advances().find(a => a.id === pendingId);
        assert.equal(stored.status, 'approved');
        // The approval names the person who gave it — the whole point of the
        // pending state.
        assert.equal(stored.reviewedBy.name, 'Manager Two');
        assert.equal(stored.reviewedBy.role, 'manager');
    });

    /* ==================================================================
       Security audit C1/C3 — owner/manager-only system routes.

       Before this, POST /api/settings was gated by requireAdminSession
       alone: any signed-in cashier could rewrite the entire settings
       document, including adding themselves as `owner`. These checks pin
       that a non-owner (and, for the owner-only routes, a non-owner
       manager too) is refused with 403 ROLE_REQUIRED before the handler
       runs, and that nothing changes on disk as a result.
       ================================================================== */

    await check('a cashier cannot rewrite settings; only the owner can', async () => {
        const before = readData('settings.json');
        const cashierSession = await loginAdmin(request, { pin: '432143' });

        const refused = await request('/api/settings', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ goldTaxSlab: 0 })
        });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, 'ROLE_REQUIRED');
        assert.equal(readData('settings.json').goldTaxSlab, before.goldTaxSlab,
            'a refused request must not have touched the GST slab');

        // A manager is not enough either — settings is owner-only, unlike
        // the customer-accounts/backup/reports bucket below.
        const managerSession = await loginAdmin(request, { pin: '567856' });
        const managerRefused = await request('/api/settings', {
            method: 'POST',
            headers: { ...managerSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ goldTaxSlab: 0 })
        });
        assert.equal(managerRefused.status, 403);
        assert.equal((await managerRefused.json()).error, 'ROLE_REQUIRED');

        // The owner still can — the gate refuses by role, not blanket.
        const allowed = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyName: before.companyName })
        });
        assert.equal(allowed.status, 200);
    });

    await check('a cashier cannot add themselves as owner even by editing the roster directly', async () => {
        // Defence-in-depth on mergeOperators itself: even if a future route
        // reused it without an owner gate, an incoming owner-role row must
        // still be refused from a non-owner caller. Exercised here through
        // the (owner-gated) route with an owner session forging a payload
        // that mixes in a self-promoted row is not reachable over HTTP once
        // the route itself is owner-only — so this instead confirms the
        // gate gives NO cashier a path to the roster at all.
        const cashierSession = await loginAdmin(request, { pin: '432143' });
        const attempt = await request('/api/settings', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                operators: [{ name: 'Self Promoted', role: 'owner', pin: '999999', active: true }]
            })
        });
        assert.equal(attempt.status, 403);
        assert.equal((await attempt.json()).error, 'ROLE_REQUIRED');
        assert.equal(
            readData('settings.json').operators.some(op => op.name === 'Self Promoted'),
            false,
            'no self-promoted owner row may reach disk'
        );
    });

    await check('customer-accounts, diagnostics, and update routes refuse a cashier', async () => {
        const cashierSession = await loginAdmin(request, { pin: '432143' });

        const list = await request('/api/customer-accounts', { headers: cashierSession.headers });
        assert.equal(list.status, 403);
        assert.equal((await list.json()).error, 'ROLE_REQUIRED');

        const issue = await request('/api/customer-accounts/issue-login', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '9333444555', name: 'Should Not Get A Login' })
        });
        assert.equal(issue.status, 403);
        assert.equal((await issue.json()).error, 'ROLE_REQUIRED');

        const telemetry = await request('/api/diagnostics/telemetry', { headers: cashierSession.headers });
        assert.equal(telemetry.status, 403);

        const exportReq = await request('/api/diagnostics/export', { headers: cashierSession.headers });
        assert.equal(exportReq.status, 403);

        const updateCheck = await request('/api/admin/update/check', {
            method: 'POST', headers: cashierSession.headers
        });
        assert.equal(updateCheck.status, 403);

        // Diagnostics and updates are owner-only — a manager is refused too.
        const managerSession = await loginAdmin(request, { pin: '567856' });
        const managerTelemetry = await request('/api/diagnostics/telemetry', { headers: managerSession.headers });
        assert.equal(managerTelemetry.status, 403);

        // Customer-accounts is manager-or-owner, so a manager DOES get in.
        const managerList = await request('/api/customer-accounts', { headers: managerSession.headers });
        assert.equal(managerList.status, 200);
    });

    await check('GET /api/qrcode is rate-limited and caps the data length', async () => {
        const tooLong = await request('/api/qrcode?data=' + 'x'.repeat(201));
        assert.equal(tooLong.status, 400);

        const ok = await request('/api/qrcode?data=' + encodeURIComponent('upi://pay?pa=store@upi&am=1&cu=INR'));
        assert.equal(ok.status, 200);
        assert.ok((await ok.json()).dataUrl.startsWith('data:image/'));
    });

    await check('registration answers the same way for an existing account and for unclaimed store history', async () => {
        // A fresh phone with store history (a filed sale) but no portal
        // login — the CLAIM_REQUIRES_STORE case.
        const unclaimedPhone = '9777888999';
        const historySale = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...salePayload(0), customerName: 'Unclaimed History', customerPhone: unclaimedPhone })
        });
        assert.equal(historySale.status, 200);

        // Already fully registered (this suite's own customer, `phone`).
        const existing = await request('/api/customer/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, name: 'Someone Else', email: 'probe@example.test', password: 'ProbePass!2026' })
        });
        // Known to the store but not yet claimed online.
        const unclaimed = await request('/api/customer/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: unclaimedPhone, name: 'Someone Else', email: 'probe2@example.test', password: 'ProbePass!2026' })
        });
        assert.equal(existing.status, 409);
        assert.equal(unclaimed.status, 409);
        const existingBody = await existing.json();
        const unclaimedBody = await unclaimed.json();
        // Same error code and message either way — an attacker probing
        // numbers cannot tell "already has a login" from "known to the
        // store but not yet claimed" (security audit H4).
        assert.equal(existingBody.error, 'REGISTRATION_BLOCKED');
        assert.equal(unclaimedBody.error, 'REGISTRATION_BLOCKED');
        assert.equal(existingBody.message, unclaimedBody.message);
    });

    await check('old-gold exchange is off by default — the route answers as though it never existed', async () => {
        const response = await request('/api/old-gold-exchanges', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerPhone: phone, declaredPurity: '22K', testedPurity: '22K', grossWeightGrams: 10
            })
        });
        assert.equal(response.status, 404);
    });

    await check('enabling old-gold exchange requires an owner/manager, then credits a redeemable balance', async () => {
        // Pinned explicitly rather than trusting the ambient rate this deep into
        // a long-running suite — same defensive technique the "manual rate
        // override" check above already uses, and for the same reason.
        assert.equal((await postSettings({
            oldGoldExchangeEnabled: true, oldGoldDeductionPercent: 10,
            overrideGoldPrice: { active: true, price24K: 0, price22K: 1000, price18K: 0 }
        })).status, 200);

        // A dedicated phone, never used elsewhere in this suite — "apply
        // advance" is all-or-nothing (it always redeems the WHOLE available
        // balance, never a chosen sub-amount), so proving "this exchange's
        // credit is spendable" needs a customer whose balance is EXACTLY this
        // credit, not the shared fixture `phone` with its own accumulated
        // history from every other check in this file.
        const oldGoldPhone = '9111222333';

        try {
            const cashierSession = await loginAdmin(request, { pin: '432143' });
            const refused = await request('/api/old-gold-exchanges', {
                method: 'POST',
                headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerPhone: oldGoldPhone, declaredPurity: '22K', testedPurity: '22K', grossWeightGrams: 10
                })
            });
            assert.equal(refused.status, 403);

            const allowed = await request('/api/old-gold-exchanges', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerPhone: oldGoldPhone, customerName: 'Old Gold Customer',
                    declaredPurity: '24K', testedPurity: '22K', grossWeightGrams: 10,
                    description: 'One bangle, tested at 22K'
                })
            });
            assert.equal(allowed.status, 200, JSON.stringify(await allowed.clone().json().catch(() => null)));
            const { exchange } = await allowed.json();
            // 10g − 10% deduction = 9g net, credited at the TESTED purity's rate
            // (FIXTURE_RATE = 1000/g for 22K) — never the declared purity's.
            assert.equal(exchange.netWeightGrams, 9);
            assert.equal(exchange.creditAmount, 9000);

            const posted = ledger.advances().find(e => e.id === exchange.advanceEntryId);
            assert.ok(posted, 'the exchange must name the advance entry it produced');
            assert.equal(posted.amount, 9000);
            assert.equal(posted.status, 'approved');
            assert.equal(posted.customerPhone, oldGoldPhone);

            // The credit is spendable immediately — an ordinary advance
            // redemption against a real sale, zero new logic.
            const sale = await request('/api/sales', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    purity: '22K', weightGrams: 20, makingChargeAmount: 0, discountPercent: 0,
                    customerPhone: oldGoldPhone, appliedAdvance: 9000, totalAmount: 0
                })
            });
            assert.equal(sale.status, 200);
            assert.equal((await sale.json()).sale.appliedAdvance, 9000);
        } finally {
            await postSettings({
                oldGoldExchangeEnabled: false, oldGoldDeductionPercent: 5,
                overrideGoldPrice: { active: false, price24K: 0, price22K: 0, price18K: 0 }
            });
        }
    });

    await check('gold savings schemes are off by default — the routes answer as though they never existed', async () => {
        const response = await request('/api/gold-schemes/enrollments', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ customerPhone: '9222333444' })
        });
        assert.equal(response.status, 404);
    });

    await check('enabling gold schemes: enroll, pay installments, mature into a redeemable credit', async () => {
        const schemePhone = '9222333444';
        assert.equal((await postSettings({
            goldSchemeEnabled: true, goldSchemeInstallmentCount: 3, goldSchemeBonusInstallments: 1,
            goldSchemeDefaultGraceDays: 30, goldSchemeEarlyClosurePenaltyPercent: 10,
            overrideGoldPrice: { active: true, price24K: 0, price22K: 1000, price18K: 0 }
        })).status, 200);

        try {
            const cashierSession = await loginAdmin(request, { pin: '432143' });
            const refusedEnroll = await request('/api/gold-schemes/enrollments', {
                method: 'POST',
                headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerPhone: schemePhone, customerName: 'Scheme Customer' })
            });
            assert.equal(refusedEnroll.status, 403);

            const enrolled = await request('/api/gold-schemes/enrollments', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerPhone: schemePhone, customerName: 'Scheme Customer' })
            });
            assert.equal(enrolled.status, 200);
            const { enrollment } = await enrolled.json();
            assert.equal(enrollment.status, 'active');
            assert.equal(enrollment.installmentCount, 3);
            assert.equal(enrollment.bonusInstallments, 1);

            const payInstallment = () => request(`/api/gold-schemes/enrollments/${enrollment.id}/installments`, {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 1000, paymentMethod: 'cash' })
            });

            const first = await payInstallment();
            assert.equal(first.status, 200);
            const firstBody = await first.json();
            assert.equal(firstBody.installment.installmentNumber, 1);
            assert.equal(firstBody.installment.gramsLocked, 1, '₹1,000 at ₹1,000/g locks exactly 1g');

            await payInstallment();

            const tooEarly = await request(`/api/gold-schemes/enrollments/${enrollment.id}/mature`, {
                method: 'POST', headers: adminHeaders
            });
            assert.equal(tooEarly.status, 409, 'only 2 of 3 installments paid — maturity must be refused');

            const third = await payInstallment();
            assert.equal((await third.json()).installment.installmentNumber, 3);

            const installmentsList = await request(`/api/gold-schemes/enrollments/${enrollment.id}/installments`, {
                headers: adminHeaders
            });
            assert.equal((await installmentsList.json()).results.length, 3);

            const matured = await request(`/api/gold-schemes/enrollments/${enrollment.id}/mature`, {
                method: 'POST', headers: adminHeaders
            });
            assert.equal(matured.status, 200, JSON.stringify(await matured.clone().json().catch(() => null)));
            const maturedBody = await matured.json();
            // 3 installments × 1g = 3g, average 1g/installment, 1 bonus
            // installment = +1g, 4g total, credited at the pinned ₹1,000/g.
            assert.equal(maturedBody.payout.bonusGrams, 1);
            assert.equal(maturedBody.payout.payoutGrams, 4);
            assert.equal(maturedBody.payout.payoutAmount, 4000);
            assert.equal(maturedBody.enrollment.status, 'matured');

            const posted = ledger.advances().find(e => e.id === maturedBody.payout.advanceEntryId);
            assert.ok(posted, 'maturity must name the advance entry it produced');
            assert.equal(posted.amount, 4000);
            assert.equal(posted.status, 'approved');

            // Already matured — a second maturity attempt must be refused, not
            // double-credit.
            const again = await request(`/api/gold-schemes/enrollments/${enrollment.id}/mature`, {
                method: 'POST', headers: adminHeaders
            });
            assert.equal(again.status, 409);

            // A separate enrollment, closed early: 1 installment (1g), 10%
            // penalty, no bonus — 0.9g credited at ₹1,000/g = ₹900.
            const earlyPhone = '9222333455';
            const enrolled2 = await request('/api/gold-schemes/enrollments', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerPhone: earlyPhone, customerName: 'Early Closer' })
            });
            const enrollment2 = (await enrolled2.json()).enrollment;
            await request(`/api/gold-schemes/enrollments/${enrollment2.id}/installments`, {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 1000, paymentMethod: 'cash' })
            });
            const closedEarly = await request(`/api/gold-schemes/enrollments/${enrollment2.id}/close-early`, {
                method: 'POST', headers: adminHeaders
            });
            assert.equal(closedEarly.status, 200);
            const closedBody = await closedEarly.json();
            assert.equal(closedBody.payout.bonusGrams, 0, 'an early closure earns no bonus');
            assert.equal(closedBody.payout.payoutGrams, 0.9);
            assert.equal(closedBody.payout.payoutAmount, 900);
            assert.equal(closedBody.enrollment.status, 'closed_early');

            // A third enrollment, never paid: too soon to default.
            const enrolled3 = await request('/api/gold-schemes/enrollments', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerPhone: '9222333466', customerName: 'Fresh Enrollment' })
            });
            const enrollment3 = (await enrolled3.json()).enrollment;
            const tooSoonDefault = await request(`/api/gold-schemes/enrollments/${enrollment3.id}/default`, {
                method: 'POST', headers: adminHeaders
            });
            assert.equal(tooSoonDefault.status, 409, 'a fresh enrollment is not yet overdue for its grace period');
        } finally {
            await postSettings({
                goldSchemeEnabled: false, goldSchemeInstallmentCount: 11, goldSchemeBonusInstallments: 1,
                goldSchemeDefaultGraceDays: 30, goldSchemeEarlyClosurePenaltyPercent: 0,
                overrideGoldPrice: { active: false, price24K: 0, price22K: 0, price18K: 0 }
            });
        }
    });

    await check('management reports are off by default — the routes answer as though they never existed', async () => {
        for (const kind of ['settlement', 'reconciliation', 'profitability', 'ageing']) {
            const response = await request(`/api/reports/${kind}`, { headers: adminHeaders });
            assert.equal(response.status, 404, `${kind} report should 404 while disabled`);
        }
        // The pre-existing Phase 5.5 accounting-export CSV is unrelated to this
        // sign-off gate and must not be swept in by it.
        const csv = await request('/api/reports/sales-register.csv', { headers: adminHeaders });
        assert.notEqual(csv.status, 404, 'the accounting-export CSV must not be gated by managementReportsEnabled');
    });

    await check('enabling management reports makes them reachable', async () => {
        try {
            assert.equal((await postSettings({ managementReportsEnabled: true })).status, 200);
            for (const kind of ['settlement', 'reconciliation', 'profitability', 'ageing']) {
                const response = await request(`/api/reports/${kind}`, { headers: adminHeaders });
                assert.equal(response.status, 200, `${kind} report should be reachable once enabled`);
            }
        } finally {
            await postSettings({ managementReportsEnabled: false });
        }
    });

    await check('a rejected PIN is still rejected once operators exist', async () => {
        const response = await request('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '0000' })
        });
        assert.equal(response.status, 401);
    });

    /* ==================================================================
       PIN hashing, session revocation, MFA, refund threshold
       ================================================================== */

    await check('operator PINs are stored hashed, never in the clear', async () => {
        const raw = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
        // '432143' and '567856' were configured as operator PINs above.
        assert.doesNotMatch(raw, /"pin"\s*:\s*"432143"/);
        assert.doesNotMatch(raw, /"pin"\s*:\s*"567856"/);
        const stored = readData('settings.json');
        const cashier = stored.operators.find(op => op.name === 'Cashier One');
        assert.equal(cashier.pin, undefined, 'no plaintext pin key should survive');
        assert.match(cashier.pinHash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+$/);
        assert.equal(operatorPinVerifies(cashier.id, '432143'), true, 'the hash must verify the real PIN');
        assert.equal(operatorPinVerifies(cashier.id, '0000'), false, 'and reject another');
    });

    await check('the tenant salt and every PIN hash are kept out of the browser', async () => {
        const response = await request('/api/settings', { headers: adminHeaders });
        const body = await response.text();
        assert.doesNotMatch(body, /authSalt"\s*:\s*"[0-9a-f]{8}/, 'the salt must not be sent');
        assert.doesNotMatch(body, /scrypt\$/, 'no PIN hash may be sent to a browser');
        const settings = JSON.parse(body);
        assert.equal(settings.adminPinHash, null);
        assert.equal(settings.authSalt, null);
        assert.equal(settings.operators[0].pinHash, undefined);
        assert.equal(settings.operators[0].pinConfigured, true);
    });

    await check('changing an operator’s PIN ends their live sessions', async () => {
        const before = await loginAdmin(request, { pin: '432143' });
        // The session works…
        assert.equal((await request('/api/admin/me', {
            headers: before.headers
        })).status, 200);

        const roster = readData('settings.json').operators.map(op => ({
            id: op.id, name: op.name, role: op.role, active: op.active,
            ...(op.name === 'Cashier One' ? { pin: '432199' } : {})
        }));
        const saved = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operators: roster })
        });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).sessionsRevoked >= 1, true, 'the save should report the revocation');

        // …and no longer does. The credential changed, so the access ends with it.
        assert.equal((await request('/api/admin/me', {
            headers: before.headers
        })).status, 401);
        // The new PIN works; the old one does not.
        assert.equal((await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '432199' })
        })).status, 200);
        assert.equal((await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '432143' })
        })).status, 401);
    });

    await check('deactivating an operator ends their sessions and their login', async () => {
        const cashierSession = await loginAdmin(request, { pin: '432199' });

        const roster = readData('settings.json').operators.map(op => ({
            id: op.id, name: op.name, role: op.role,
            active: op.name === 'Cashier One' ? false : op.active
        }));
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operators: roster })
        });

        assert.equal((await request('/api/admin/me', { headers: cashierSession.headers })).status, 401);
        assert.equal((await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '432199' })
        })).status, 401, 'an inactive operator cannot sign in');

        // Reactivate for the checks that follow.
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                operators: readData('settings.json').operators.map(op => ({
                    id: op.id, name: op.name, role: op.role, active: true
                }))
            })
        });
    });

    await check('a live session can be listed and signed out by an approver', async () => {
        const cashierSession = await loginAdmin(request, { pin: '432199' });

        // A cashier may not enumerate who is signed in.
        assert.equal((await request('/api/admin/sessions', {
            headers: cashierSession.headers
        })).status, 403);

        const list = await request('/api/admin/sessions', { headers: adminHeaders });
        assert.equal(list.status, 200);
        const page = await list.json();
        const theirs = page.results.find(r => r.actor.name === 'Cashier One');
        assert.equal(Boolean(theirs), true, 'the cashier session should be listed');
        // No token may appear in the listing — that would be handing out a
        // credential from a read-only screen.
        assert.doesNotMatch(JSON.stringify(page), new RegExp(cashierSession.token));

        const revoked = await request('/api/admin/sessions/revoke', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: theirs.handle })
        });
        assert.equal(revoked.status, 200);
        assert.equal((await request('/api/admin/me', {
            headers: cashierSession.headers
        })).status, 401);

        // And an approver cannot revoke their own session from that screen.
        const self = await request('/api/admin/sessions', { headers: adminHeaders });
        const selfHandle = (await self.json()).currentHandle;
        const refused = await request('/api/admin/sessions/revoke', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ handle: selfHandle })
        });
        assert.equal(refused.status, 400);
        assert.equal((await refused.json()).error, 'CANNOT_REVOKE_OWN_SESSION');
    });

    await check('TOTP enrolment requires a live code, then issues recovery codes', async () => {
        const manager = readData('settings.json').operators.find(op => op.name === 'Manager Two');

        const begin = await request('/api/admin/mfa/begin', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operatorId: manager.id })
        });
        assert.equal(begin.status, 200);
        const setup = await begin.json();
        assert.match(setup.uri, /^otpauth:\/\/totp\//);
        assert.match(setup.qrDataUri, /^data:image\/png;base64,/);
        // Nothing is stored until the code is proven: no secret, not enabled.
        const beforeEnrol = readData('settings.json').operators.find(op => op.id === manager.id);
        assert.equal(Boolean(beforeEnrol.mfaEnabled), false);
        assert.equal(beforeEnrol.totpSecret, undefined, 'the secret must not be stored before it is proven');

        // A wrong code is refused.
        const bad = await request('/api/admin/mfa/enrol', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operatorId: manager.id, secret: setup.secret, code: '000000' })
        });
        assert.equal(bad.status, 400);

        // The real code enrols and returns the codes exactly once.
        const good = await request('/api/admin/mfa/enrol', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ operatorId: manager.id, secret: setup.secret, code: currentTotp(setup.secret) })
        });
        assert.equal(good.status, 200);
        const enrolled = await good.json();
        assert.equal(enrolled.recoveryCodes.length, 10);

        const stored = readData('settings.json').operators.find(op => op.id === manager.id);
        assert.equal(stored.mfaEnabled, true);
        assert.equal(stored.recoveryCodes.length, 10);
        // Stored as hashes, never as the codes themselves.
        assert.doesNotMatch(JSON.stringify(stored.recoveryCodes), new RegExp(enrolled.recoveryCodes[0]));
        mfaSecret = setup.secret;
        mfaRecoveryCodes = enrolled.recoveryCodes;
    });

    await check('an enrolled operator must supply a code to sign in', async () => {
        const noCode = await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '567856' })
        });
        assert.equal(noCode.status, 401);
        assert.equal((await noCode.json()).error, 'MFA_CODE_REQUIRED');

        const wrongCode = await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '567856', totpCode: '000000' })
        });
        assert.equal(wrongCode.status, 401);
        assert.equal((await wrongCode.json()).error, 'MFA_CODE_INVALID');

        const okSession = await loginAdmin(request, { pin: '567856', totpCode: currentTotp(mfaSecret) });
        assert.equal(okSession.response.status, 200);
        const session = await okSession.response.json();
        assert.equal(session.mfaUsed, true);
        mfaManagerHeaders = okSession.headers;
    });

    await check('a recovery code works once and only once', async () => {
        const code = mfaRecoveryCodes[0];
        const first = await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '567856', recoveryCode: code })
        });
        assert.equal(first.status, 200);
        assert.equal((await first.json()).mfaUsed, true);
        assert.equal(
            readData('settings.json').operators.find(op => op.name === 'Manager Two').recoveryCodes.length,
            9, 'the used code must be consumed'
        );

        const replay = await request('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: '567856', recoveryCode: code })
        });
        assert.equal(replay.status, 401, 'a recovery code must not work twice');
    });

    await check('requireMfaForApprovers blocks an approval from a session without a factor', async () => {
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requireMfaForApprovers: true })
        });

        const mfaGateId = seedPendingDeposit({ amount: 300, referenceId: 'UTR-MFA-GATE' });

        // The master PIN is an owner, but it carries no second factor — and
        // cannot, since there is no person to enrol. That refusal is the point.
        const refused = await request(`/api/advances/${mfaGateId}/approve`, {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, 'MFA_REQUIRED');
        assert.equal(ledger.advances().find(a => a.id === mfaGateId).status, 'pending');

        // The manager who signed in WITH a code may approve.
        const allowed = await request(`/api/advances/${mfaGateId}/approve`, {
            method: 'POST',
            headers: { ...mfaManagerHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'verified' })
        });
        assert.equal(allowed.status, 200);
        assert.equal(ledger.advances().find(a => a.id === mfaGateId).reviewedBy.name, 'Manager Two');

        // Put it back so the remaining checks are not all MFA-gated.
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requireMfaForApprovers: false })
        });
    });

    await check('a refund at or above the threshold needs an approver', async () => {
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refundApprovalThreshold: 500 })
        });

        // A sale worth refunding ~1030, comfortably over the 500 limit.
        const sale = (await (await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        })).json()).sale;

        const cashierSession = await loginAdmin(request, { pin: '432199' });

        const refused = await request('/api/returns', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(refused.status, 403);
        const body = await refused.json();
        assert.equal(body.error, 'APPROVER_REQUIRED');
        assert.equal(body.code, 'APPROVER_REQUIRED', 'domain refusals expose a stable machine code');
        assert.match(body.message, /500/, 'the message should name the store limit');
        // Nothing was filed.
        assert.equal(
            ledger.returns().filter(r => r.originalInvoiceId === sale.id).length,
            0, 'a refused refund must not be written'
        );

        // The owner may.
        const allowed = await request('/api/returns', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(allowed.status, 200);
    });

    await check('a refund below the threshold is still a cashier’s to make', async () => {
        // Threshold well above the refund this produces.
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refundApprovalThreshold: 100000 })
        });
        const sale = (await (await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(0))
        })).json()).sale;

        const cashierSession = await loginAdmin(request, { pin: '432199' });

        const filed = await request('/api/returns', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.id, weightGrams: 1, refundMode: 'cash' })
        });
        assert.equal(filed.status, 200);
        assert.equal((await filed.json()).return.actor.name, 'Cashier One');

        // Back to unlimited so later checks behave as before.
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refundApprovalThreshold: 0 })
        });
    });

    await check('the refund threshold itself is validated', async () => {
        for (const bad of [-1, 'abc', 10 ** 12]) {
            const response = await request('/api/settings', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify({ refundApprovalThreshold: bad })
            });
            assert.equal(response.status, 400, `threshold ${bad} should be refused`);
        }
    });

    /* M1 — extreme-discount guard. refundApprovalThreshold above guards money
       leaving the till; nothing guarded a give-away SALE, so a cashier could
       apply a 100% discount with nothing flagging it. Same threshold shape,
       mirrored onto saleService.js's own priced discount. */
    await check('a sale discount at or above the threshold needs an approver', async () => {
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ discountApprovalThreshold: 50 })
        });

        const cashierSession = await loginAdmin(request, { pin: '432199' });

        const refused = await request('/api/sales', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...salePayload(0), discountPercent: 60 })
        });
        assert.equal(refused.status, 403);
        const body = await refused.json();
        assert.match(body.error, /60%/, 'the message should name the attempted discount');
        assert.match(body.error, /50%/, 'the message should name the store limit');

        // The owner may.
        const allowed = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...salePayload(0), discountPercent: 60 })
        });
        assert.equal(allowed.status, 200);
    });

    await check('a sale discount below the threshold is still a cashier’s to make', async () => {
        // Threshold set, but the discount below stays under it.
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ discountApprovalThreshold: 50 })
        });
        const cashierSession = await loginAdmin(request, { pin: '432199' });

        const filed = await request('/api/sales', {
            method: 'POST',
            headers: { ...cashierSession.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...salePayload(0), discountPercent: 10 })
        });
        assert.equal(filed.status, 200);

        // Back to disabled so later checks behave as before.
        await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ discountApprovalThreshold: 0 })
        });
    });

    /* ==================================================================
       Paged ledger reads
       ================================================================== */

    await check('GET /api/sales returns a clamped page with period totals', async () => {
        const response = await request('/api/sales?limit=2', { headers: adminHeaders });
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(Array.isArray(page.results), true);
        assert.equal(page.results.length <= 2, true);
        assert.equal(page.limit, 2);
        assert.equal(page.truncated, page.total > 2);
        // `totals` covers every matched row, not the page — the Dashboard's
        // revenue tiles read it and must stay correct beyond one page.
        assert.equal(page.totals.count, page.total);
        assert.equal(typeof page.totals.totalAmount, 'number');
        assert.equal(page.total > 2, true, 'fixture should have filed more than two sales by now');
    });

    await check('GET /api/returns and /api/advances use the same envelope', async () => {
        for (const route of ['/api/returns', '/api/advances']) {
            const page = await (await request(`${route}?limit=1`, { headers: adminHeaders })).json();
            assert.equal(Array.isArray(page.results), true, route);
            assert.equal(page.limit, 1, route);
            assert.equal(typeof page.total, 'number', route);
            assert.equal(typeof page.truncated, 'boolean', route);
        }
    });

    await check('the advance liability summary ignores the date filter', async () => {
        // A balance is a lifetime running figure; a month's slice of it is not a
        // balance. Only `totals` describes the filtered period.
        const page = await (await request('/api/advances?from=1990-01-01&to=1990-01-02', { headers: adminHeaders })).json();
        assert.equal(page.totals.count, 0, 'no rows in 1990');
        assert.equal(page.summary.outstandingTotal > 0, true, 'the liability is still reported');
    });

    await check('a malformed date is refused rather than silently ignored', async () => {
        const response = await request('/api/sales?from=not-a-date', { headers: adminHeaders });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /YYYY-MM-DD/);
    });

    await check('GET /api/advances/customers rolls balances up per customer', async () => {
        const page = await (await request('/api/advances/customers', { headers: adminHeaders })).json();
        assert.equal(Array.isArray(page.results), true);
        const row = page.results.find(c => c.phone === phone);
        assert.equal(Boolean(row), true, 'the fixture customer should be listed');
        assert.equal(typeof row.balance, 'number');
        assert.equal(row.entryCount > 0, true);
        // Searching matches the CUSTOMER, after the rollup.
        const searched = await (await request(
            `/api/advances/customers?q=${phone}`, { headers: adminHeaders }
        )).json();
        assert.equal(searched.results.length, 1);
        assert.equal(searched.results[0].phone, phone);
    });

    /* ==================================================================
       Catalogue → billing → return/void stock, plus management reports.
       These use the live HTTP boundary: auth, body parsing, routes, services,
       transaction and repository all participate.
       ================================================================== */

    let billingInventory = null;

    await check('SKU lookup feeds an exact lot into an atomic stock-linked sale and return exchange', async () => {
        const itemRes = await request('/api/inventory/items', {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'HTTP Stock Chain', purity: '22K', skuCode: 'HTTP-SKU-1', netWeightGrams: 5 })
        });
        assert.equal(itemRes.status, 200);
        const item = (await itemRes.json()).item;

        const lotRes = await request('/api/inventory/lots', {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ itemId: item.id, weightGrams: 5, unitCostPerGram: 800 })
        });
        assert.equal(lotRes.status, 200);
        const lot = (await lotRes.json()).lot;

        const lookup = await request('/api/inventory/items/by-sku/HTTP-SKU-1', { headers: adminHeaders });
        assert.equal(lookup.status, 200);
        const found = await lookup.json();
        assert.equal(found.item.id, item.id);
        assert.equal(found.lots[0].id, lot.id);

        const saleRes = await request('/api/sales', {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerName: 'HTTP Inventory Customer', customerPhone: phone,
                lines: [{ purity: '22K', weightGrams: 2, inventoryItemId: item.id, inventoryLotId: lot.id }],
                totalAmount: 0, appliedAdvance: 0, discountPercent: 0
            })
        });
        assert.equal(saleRes.status, 200);
        const sale = await saleRes.json();

        const stockAfterSale = await (await request('/api/inventory/stock', { headers: adminHeaders })).json();
        assert.equal(stockAfterSale.find(row => row.itemId === item.id).weightGrams, 3);

        const returnRes = await request('/api/returns', {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'exchange' })
        });
        assert.equal(returnRes.status, 200);
        const returned = await returnRes.json();
        assert.equal(returned.return.refundMode, 'exchange');
        assert.equal(returned.return.isExchange, true);

        const stockAfterReturn = await (await request('/api/inventory/stock', { headers: adminHeaders })).json();
        assert.equal(stockAfterReturn.find(row => row.itemId === item.id).weightGrams, 4);
        billingInventory = { item, lot, exchangeCreditNoteId: returned.returnId };
    });

    await check('same-day void restores linked stock and all four management reports answer over HTTP', async () => {
        const { item, lot } = billingInventory;
        const saleRes = await request('/api/sales', {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lines: [{ purity: '22K', weightGrams: 1, inventoryItemId: item.id, inventoryLotId: lot.id }],
                customerName: 'Void Customer', totalAmount: 0, appliedAdvance: 0, discountPercent: 0
            })
        });
        assert.equal(saleRes.status, 200);
        const invoiceId = (await saleRes.json()).invoiceId;

        const voidRes = await request(`/api/sales/${encodeURIComponent(invoiceId)}/void`, {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'HTTP test cashier correction' })
        });
        assert.equal(voidRes.status, 200);
        assert.equal((await voidRes.json()).sale.state, 'cancelled');

        const repeatedVoid = await request(`/api/sales/${encodeURIComponent(invoiceId)}/void`, {
            method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'HTTP test cashier correction' })
        });
        assert.equal(repeatedVoid.status, 409);
        assert.equal((await repeatedVoid.json()).code, 'VOID_NOT_ALLOWED');

        const stock = await (await request('/api/inventory/stock', { headers: adminHeaders })).json();
        assert.equal(stock.find(row => row.itemId === item.id).weightGrams, 4);

        // managementReportsEnabled defaults off and the earlier "enabling
        // management reports" check already restores it to off in its own
        // finally — this test needs it on for its own duration only.
        try {
            assert.equal((await postSettings({ managementReportsEnabled: true })).status, 200);
            for (const name of ['settlement', 'reconciliation', 'profitability', 'ageing']) {
                const response = await request(`/api/reports/${name}`, { headers: adminHeaders });
                assert.equal(response.status, 200, name);
                const body = await response.json();
                assert.equal(typeof body.definition, 'string', name);
            }
            const profit = await (await request('/api/reports/profitability', { headers: adminHeaders })).json();
            assert.ok(profit.rows.some(row => row.invoiceNumber && row.costPaise !== null));
        } finally {
            await postSettings({ managementReportsEnabled: false });
        }
    });

    /* ==================================================================
       THE AUDIT TRAIL'S READ PATH.

       The table has been append-only since Phase 24 and written on every
       money path since Phase 29, but nothing exposed it until Phase 31 —
       an append-only table nobody can read is evidence in principle and
       not in practice. These assert the reading, not the writing:
       test_schema.js already proves the triggers refuse an UPDATE.
       ================================================================== */

    await check('the audit trail records the sales this suite filed, newest first', async () => {
        const res = await request('/api/audit?entityType=invoice&limit=200', { headers: adminHeaders });
        assert.equal(res.status, 200);
        const body = await res.json();

        const issued = body.results.filter(e => e.action === 'SALE_ISSUED');
        assert.ok(issued.length > 0, 'every sale this suite filed should have left a trail row');
        assert.ok(issued.every(e => e.entityType === 'invoice'), 'the entityType filter must be applied server-side');

        // Newest first, like every other ledger route.
        const times = body.results.map(e => e.occurredAt);
        assert.deepEqual(times, [...times].sort((a, b) => b - a), 'the trail must come back newest first');

        // The detail column is parsed for the browser, not shipped as a string.
        const withDetail = issued.find(e => e.detail);
        assert.ok(withDetail, 'a SALE_ISSUED row should carry its detail');
        assert.equal(typeof withDetail.detail, 'object');
        assert.ok(withDetail.summary.length > 0, 'a trail row must say what happened in words');
    });

    await check('a cashier cannot read the audit trail', async () => {
        /* '432199', not the '432143' Cashier One starts with: the session-
           revocation check earlier in this suite rotates their PIN to prove
           that changing it ends their sessions, and this runs after it. */
        const asCashier = await loginAdmin(request, { pin: '432199' });
        assert.equal(asCashier.response.status, 200, 'the cashier must be able to sign in for this to test anything');

        /* The trail names who released money, which makes it the record a
           cashier under suspicion most wants to read and has least business
           reading. Same gate as approving a deposit, deliberately. */
        const refused = await request('/api/audit', {
            headers: asCashier.headers
        });
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, 'APPROVER_REQUIRED');
    });

    await check('the audit trail is not readable without a session at all', async () => {
        const anonymous = await request('/api/audit');
        assert.equal(anonymous.status, 401);
        assert.equal((await anonymous.json()).error, 'ADMIN_SESSION_REQUIRED');
    });

    await check('a malformed audit date is refused rather than silently ignored', async () => {
        const bad = await request('/api/audit?from=not-a-date', { headers: adminHeaders });
        assert.equal(bad.status, 400);
        assert.match((await bad.json()).error, /YYYY-MM-DD/);

        const backwards = await request('/api/audit?from=2026-08-10&to=2026-08-01', { headers: adminHeaders });
        assert.equal(backwards.status, 400);
    });

    await check('the audit chain verifies, and says what it does not cover', async () => {
        const res = await request('/api/audit/verify', { headers: adminHeaders });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.verified, true, 'a freshly written trail must verify');
        assert.ok(body.eventsInChain > 0, 'this suite has written money events, so the chain is not empty');
        assert.match(body.headHash, /^[0-9a-f]{64}$/, 'a verified chain publishes a head hash');
        // Coverage is reported rather than implied: rows written before the
        // chain existed are counted, never silently folded in.
        assert.equal(typeof body.eventsPredatingChain, 'number');
        assert.equal(body.brokenAt, null);
    });

    await check('the audit export carries a manifest that pins the whole chain', async () => {
        const res = await request('/api/audit/export', { headers: adminHeaders });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-disposition') || '', /attachment; filename="audit-trail-/);

        const dump = await res.json();
        assert.ok(Array.isArray(dump.events) && dump.events.length > 0);
        assert.match(dump.manifest.chain.headHash, /^[0-9a-f]{64}$/);
        assert.equal(dump.manifest.rowsExported, dump.events.length);
        assert.ok(dump.manifest.howToVerify.includes('verifyAuditChain'));
        // detail is delivered parsed, not as a JSON string the browser must re-parse.
        assert.ok(!('detail_json' in dump.events[0]) || dump.events[0].detail_json === undefined);

        /* A narrowed range changes the rows but not what the manifest DESCRIBES:
           the chain figures always cover the whole trail, because a head hash
           over a chosen slice would pin nothing — the filter could be picked to
           exclude the edited row.

           The head itself is not compared across the two calls on purpose:
           exporting is an audited act, so the first export appended a row and
           legitimately moved the head. That the head moves per export is the
           behaviour the next check asserts directly. */
        const narrow = await request('/api/audit/export?from=2999-01-01&to=2999-12-31', { headers: adminHeaders });
        assert.equal(narrow.status, 200);
        const narrowDump = await narrow.json();
        assert.equal(narrowDump.events.length, 0, 'the range should have excluded every row');
        assert.match(narrowDump.manifest.chain.headHash, /^[0-9a-f]{64}$/,
            'an empty slice still publishes the whole chain’s head');
        assert.ok(narrowDump.manifest.chain.eventsInChain > 0,
            'the manifest must describe the whole chain, not the empty slice');
        assert.equal(narrowDump.manifest.rowsExported, 0);
    });

    await check('exporting the trail is itself an audited act', async () => {
        const trail = await request('/api/audit?action=AUDIT_EXPORTED&limit=50', { headers: adminHeaders });
        assert.equal(trail.status, 200);
        const body = await trail.json();
        // The previous check exported twice; taking a copy of the evidence is an
        // event the evidence should contain.
        assert.ok(body.results.length >= 2, 'each export must leave its own audit row');
        assert.equal(body.results[0].entityType, 'audit');
    });

    await check('verify and export are approver-only, like the trail itself', async () => {
        const asCashier = await loginAdmin(request, { pin: '432199' });
        assert.equal(asCashier.response.status, 200);

        const verify = await request('/api/audit/verify', { headers: asCashier.headers });
        assert.equal(verify.status, 403);
        assert.equal((await verify.json()).error, 'APPROVER_REQUIRED');

        const exported = await request('/api/audit/export', { headers: asCashier.headers });
        assert.equal(exported.status, 403);

        // ...and neither is reachable with no session at all.
        assert.equal((await request('/api/audit/verify')).status, 401);
        assert.equal((await request('/api/audit/export')).status, 401);
    });

    /* ------------------------------------------------------------------
       §"Body schemas" — shape checked before the handler, so a handler can
       trust `typeof`. Meaning is still checked where it always was.
       ------------------------------------------------------------------ */

    await check('a login PIN sent as a number is refused as a malformed body, not as a wrong PIN', async () => {
        /* The PIN must stay a string all the way to scrypt: as a number,
           "0421" is 421 and a leading-zero PIN stops matching its own hash. */
        const response = await request('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: 2468 })
        });
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.error, 'INVALID_BODY');
        assert.equal(body.field, 'pin', 'the refusal must name the field so the UI can point at it');
        assert.match(body.requestId, /^REQ-/);

        /* AND A MALFORMED BODY MUST NOT SPEND THE LOCKOUT BUDGET. The schema
           runs after `loginRateLimiter` but before the handler, so no failed
           attempt is ever recorded — send more than the five-attempt threshold
           and every one must still be a 400, never a 429. Otherwise anyone
           could lock a store's own counter out with junk JSON. */
        for (let attempt = 0; attempt < 8; attempt++) {
            const junk = await request('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin: { nested: true } })
            });
            assert.equal(junk.status, 400, 'a malformed login body must never escalate into a lockout');
        }
    });

    await check('a login body shaped exactly as the browser sends it is accepted', async () => {
        /* THE REGRESSION THIS EXISTS FOR. `frontend/js/app.js` posts every field
           the form owns, so an operator with no second factor still sends
           `totpCode: ""` and `recoveryCode: ""`. The first version of the schema
           gave those a pattern requiring at least one character, which refused
           the empty string and 400'd EVERY ordinary sign-in. The other checks
           here post only `{pin}` and sailed straight past it — Playwright, which
           drives the real form, is what caught it. Post the real shape. */
        const response = await request('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            /* '864286', not initialSettings.adminPin: the secret-rotation check
               far above this one replaces the master PIN, and '2468' has been
               dead since. */
            body: JSON.stringify({ pin: '864286', totpCode: '', recoveryCode: '' })
        });
        assert.equal(response.status, 200, 'the browser\'s own login shape must not be refused');
        assert.ok(cookieJarFrom(response).gp_admin_sess, 'a successful login must set the session cookie');
    });

    await check('a structurally wrong registration is refused before any account logic runs', async () => {
        for (const [label, payload] of [
            ['an object where a phone belongs', { phone: { toString: 'nope' }, password: 'Str0ngPass!' }],
            ['an array where a phone belongs', { phone: ['9000000001'], password: 'Str0ngPass!' }],
            ['a missing password', { phone: '9000000002' }],
            ['a null phone', { phone: null, password: 'Str0ngPass!' }]
        ]) {
            const response = await request('/api/customer/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            assert.equal(response.status, 400, `${label} should be refused`);
            assert.equal((await response.json()).error, 'INVALID_BODY', `${label} should be refused as a bad body`);
        }
    });

    /* ------------------------------------------------------------------
       §"Abuse limits" — the limits that cover what a credential lockout
       cannot: endpoints where every request succeeds and the abuse is the
       volume.
       ------------------------------------------------------------------ */

    await check('a rate-limited response advertises the quota so a client can back off', async () => {
        const response = await request('/api/health', { headers: adminHeaders });
        /* /api/health is exempt, so it must carry NO limit headers at all —
           monitoring polls it by design, and throttling a probe makes a healthy
           process look down and can trigger a false failover. */
        assert.equal(response.headers.get('ratelimit-limit'), null);

        const limited = await request('/api/settings', { headers: adminHeaders });
        assert.equal(limited.status, 200);
        assert.ok(Number(limited.headers.get('ratelimit-limit')) > 0);
        assert.ok(Number(limited.headers.get('ratelimit-remaining')) >= 0);
    });

    await check('the password-reset endpoint refuses a flood and says when to return', async () => {
        /* Five per fifteen minutes. The cost of this endpoint is an email sent
           to an address we do not control, which is why it is one of the
           tightest. The route answers the same way for a known and an unknown
           phone (anti-enumeration), so the 429 is the only observable change. */
        let refused = null;
        for (let attempt = 0; attempt < 6 && !refused; attempt++) {
            const response = await request('/api/customer/password/forgot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: '9000000123' })
            });
            if (response.status === 429) refused = response;
        }
        assert.ok(refused, 'six reset requests in a row were never refused');
        const body = await refused.json();
        assert.equal(body.error, 'RATE_LIMITED');
        assert.ok(body.retryAfterSeconds > 0);
        assert.match(body.requestId, /^REQ-/);
        assert.ok(Number(refused.headers.get('retry-after')) > 0);
    });

    /* ------------------------------------------------------------------
       §"The operational boundary" — request identity, readiness vs
       liveness, safe errors, and draining. Everything here is what an
       operator sees, so it is asserted the way an operator would see it.
       ------------------------------------------------------------------ */

    await check('every response carries a request id, and a well-formed inbound one is reused', async () => {
        const generated = await request('/api/health');
        assert.match(generated.headers.get('x-request-id') || '', /^REQ-[0-9A-F]{12}$/);

        // Reuse is what lets one id span the proxy hop and this process.
        const reused = await request('/api/health', { headers: { 'X-Request-Id': 'edge-7f3a_9.1' } });
        assert.equal(reused.headers.get('x-request-id'), 'edge-7f3a_9.1');
    });

    await check('a request id that could forge a log entry is replaced, not sanitised', async () => {
        /* This value reaches error.log and telemetry.log. Spaces and quotes are
           the cheap end of the same problem newlines are, and a partially
           scrubbed id correlates to nothing anyway — so it is discarded. */
        const hostile = await request('/api/health', { headers: { 'X-Request-Id': 'abc" , "action":"forged' } });
        assert.match(hostile.headers.get('x-request-id') || '', /^REQ-[0-9A-F]{12}$/);

        const overlong = await request('/api/health', { headers: { 'X-Request-Id': 'a'.repeat(65) } });
        assert.match(overlong.headers.get('x-request-id') || '', /^REQ-[0-9A-F]{12}$/);
    });

    await check('GET /api/ready reports the ledger open and fully migrated', async () => {
        const response = await request('/api/ready');
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'ready');
        assert.equal(body.draining, false);
        assert.equal(body.checks.database, 'ok');
        assert.equal(body.checks.migrations, 'current');
        assert.match(body.requestId, /^REQ-/);
    });

    await check('GET /api/health stays liveness-only and never probes the ledger', async () => {
        /* If these two ever merge, a database blip starts killing processes
           that a restart cannot fix. The absence of `checks` is the assertion. */
        const body = await (await request('/api/health')).json();
        assert.equal(body.status, 'ok');
        assert.equal(body.checks, undefined);
        assert.ok(body.version);
    });

    await check('an unknown /api route answers JSON rather than an HTML 404', async () => {
        const response = await request('/api/does-not-exist');
        assert.equal(response.status, 404);
        assert.match(response.headers.get('content-type') || '', /application\/json/);
        const body = await response.json();
        assert.equal(body.error, 'NOT_FOUND');
        assert.match(body.requestId, /^REQ-/);
        /* The FULL path, not the mount-stripped one. Mounting this handler at
           '/api' rewrote req.url and never restored it, so both this body and
           every 404 telemetry line named a path that does not exist. */
        assert.equal(body.path, '/api/does-not-exist');
    });

    await check('a body the parser rejects returns a safe JSON error with no stack trace', async () => {
        /* Reaches the terminal error handler, which is the only thing standing
           between a thrown error and Express's default handler rendering the
           stack trace into the response body. */
        const response = await request('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"pin": '
        });
        assert.equal(response.status, 400);
        const raw = await response.text();
        assert.doesNotMatch(raw, /at .+\(.*server\.js/);
        assert.doesNotMatch(raw, /<!DOCTYPE|<html/i);
        const body = JSON.parse(raw);
        assert.equal(body.error, 'BAD_REQUEST');
        assert.match(body.requestId, /^REQ-/);
    });

    /* LAST. Draining is process-wide, so once this runs every readiness answer
       below it would be 503 and the ledger handle is closed. */
    await check('a draining process reports 503 before it stops listening, then drains', async () => {
        const { startServer: start, shutdown } = await import('./server.js');
        const second = start(0);
        if (!second.listening) await once(second, 'listening');

        /* Drain the second listener and ask the FIRST one — still open — what
           readiness now says. That is the ordering the whole design rests on:
           the proxy must see 503 while requests in flight can still finish. */
        const drained = shutdown(second, 'suite');

        const response = await request('/api/ready');
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.status, 'not_ready');
        assert.equal(body.draining, true);
        assert.equal(body.detail, 'shutting down');

        await drained;
        assert.equal(second.listening, false);
        // Idempotent: a second signal joins the drain already running.
        assert.equal(shutdown(second, 'suite-again'), drained);
    });

    console.log('======================================================================');
    console.log(`🎉 ALL ${passed} HTTP ROUTE CHECKS PASSED.`);
    console.log('======================================================================');
} finally {
    if (server) await new Promise(resolve => server.close(resolve));

    /* CLOSE THE DATABASE BEFORE REMOVING ITS DIRECTORY. Windows refuses to
       unlink a file that still has an open handle, so an unclosed connection
       turns teardown into an EPERM — which is thrown from this `finally` and
       MASKS whatever real failure sent us here, reporting a permissions
       problem in place of the assertion that actually broke. */
    try {
        const repo = await import('./repositories/index.js');
        repo.closeDb();
    } catch (_) {
        // The suite may have failed before the store was ever opened.
    }

    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(resolvedSystemTemp + path.sep) && path.basename(resolvedTemp).startsWith('gold-pos-http-')) {
        // Best-effort: a teardown failure must never be the error the operator
        // sees instead of the test result.
        try {
            fs.rmSync(resolvedTemp, { recursive: true, force: true });
        } catch (err) {
            console.warn(`[cleanup] could not remove ${resolvedTemp}: ${err.message}`);
        }
    }
}
