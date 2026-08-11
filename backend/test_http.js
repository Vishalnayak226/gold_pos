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
fs.writeFileSync(path.join(dataDir, 'advances.json'), JSON.stringify([{
    id: 'ADV-HTTP-1',
    customerPhone: phone,
    customerName: 'HTTP Customer',
    type: 'deposit',
    status: 'approved',
    amount: 100,
    timestamp: Date.now()
}], null, 2));

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
    return JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8'));
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

    const login = await request('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: initialSettings.adminPin })
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).token;
    const adminHeaders = { Authorization: `Bearer ${token}` };

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
        assert.equal(stored.adminPin, '2468');
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
        assert.equal(afterOmitted.adminPin, '2468');
        assert.equal(afterOmitted.razorpayKeySecret, 'razorpay-secret-value');
        assert.equal(afterOmitted.smtp.pass, 'smtp-secret-value');
    });

    await check('non-null secret updates rotate credentials without echoing them', async () => {
        const response = await request('/api/settings', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                adminPin: '8642',
                razorpayKeySecret: 'rotated-razorpay-secret',
                smtp: { pass: 'rotated-smtp-secret' }
            })
        });
        assert.equal(response.status, 200);
        assert.doesNotMatch(JSON.stringify(await response.json()), /8642|rotated-razorpay-secret|rotated-smtp-secret/);
        const stored = readData('settings.json');
        assert.equal(stored.adminPin, '8642');
        assert.equal(stored.razorpayKeySecret, 'rotated-razorpay-secret');
        assert.equal(stored.smtp.pass, 'rotated-smtp-secret');
    });

    await check('over-redemption is rejected without consuming an invoice or changing a ledger', async () => {
        const settingsBefore = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
        const advancesBefore = fs.readFileSync(path.join(dataDir, 'advances.json'), 'utf8');
        const response = await request('/api/sales', {
            method: 'POST',
            headers: { ...adminHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(salePayload(101))
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /exceeds.*available balance/i);
        assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), settingsBefore);
        assert.equal(fs.readFileSync(path.join(dataDir, 'advances.json'), 'utf8'), advancesBefore);
        assert.equal(fs.existsSync(path.join(dataDir, `sales_${new Date().getFullYear()}.json`)), false);
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
        assert.equal(readData('settings.json').invoiceSeqStart, 11);
        assert.equal(readData(`sales_${new Date().getFullYear()}.json`).length, 1);
        const advances = readData('advances.json');
        assert.equal(advances.length, 2);
        assert.equal(advances[1].type, 'redeem');
        assert.equal(advances[1].amount, 100);
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
        assert.equal(fs.existsSync(path.join(dataDir, returnsFileName)), false,
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
        assert.equal(fs.existsSync(path.join(dataDir, returnsFileName)), false);
    });

    await check('a partial cash return refunds ₹4,532 for 4 g and touches no advance', async () => {
        // 4 g @ 1,000 = 4,000 metal; making 1,000 × 0.4 = 400; gross 4,400;
        // 3% = 132. Refund 4,532.
        const advancesBefore = readData('advances.json').length;
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

        const rows = readData(returnsFileName);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].originalInvoiceId, returnableInvoiceId);
        assert.equal(rows[0].taxAmount, 132);
        assert.equal(rows[0].note, 'size exchange');
        // A cash refund is handed over the counter — it must not quietly
        // become store credit as well.
        assert.equal(readData('advances.json').length, advancesBefore,
            'a cash refund must not write to the advances ledger');
    });

    await check('the sale stays exactly as filed — returns never rewrite an invoice', async () => {
        const sale = readData(`sales_${new Date().getFullYear()}.json`)
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
        assert.match(record.id, /^RET-[0-9A-F]{12}$/);
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

        const credit = readData('advances.json').find(a => a.id === body.return.advanceCreditId);
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
        const rows = readData(returnsFileName).filter(r => r.originalInvoiceId === returnableInvoiceId);
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
        assert.equal(readData(returnsFileName).length, 3, 'no fourth row may be written');
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
        // A crash between the two writes would otherwise leave either a refund
        // nobody was credited for, or credit against a return that never
        // happened — the reason both share one transaction.
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

        const filenames = [returnsFileName, 'advances.json'];
        const before = Object.fromEntries(filenames.map(name =>
            [name, fs.readFileSync(path.join(dataDir, name), 'utf8')]));

        const originalRename = fs.renameSync;
        const originalConsoleError = console.error;
        const expectedErrors = [];
        let renameCount = 0;
        fs.renameSync = (...args) => {
            renameCount++;
            if (renameCount === 3) {
                const error = new Error('injected return transaction failure');
                error.code = 'EIO';
                throw error;
            }
            return originalRename(...args);
        };
        console.error = message => expectedErrors.push(String(message));

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
            fs.renameSync = originalRename;
            console.error = originalConsoleError;
        }

        assert.equal(response.status, 500);
        assert.equal(expectedErrors.some(m => m.includes('injected return transaction failure')), true);
        for (const name of filenames) {
            assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), before[name],
                `${name} changed after rollback`);
        }
        assert.equal(fs.existsSync(path.join(dataDir, '.json-transaction.json')), false);
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
            const res = await request('/api/customer/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, password })
            });
            assert.equal(res.status, 200);
            return (await res.json()).token;
        };

        // A freshly issued login must set its own password before the portal
        // opens, so the test walks the same path a real customer does.
        const tempToken = await signIn(tempPassword);
        const changed = await request('/api/customer/password/change', {
            method: 'POST',
            headers: { Authorization: `Bearer ${tempToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword: tempPassword, newPassword: 'PortalPass!2026' })
        });
        assert.equal(changed.status, 200);

        const token = await signIn('PortalPass!2026');
        const response = await request('/api/customer/returns', {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(response.status, 200);
        const rows = (await response.json()).returns;

        assert.equal(rows.length, 3, 'the three returns filed against this phone');
        assert.equal(rows.every(r => r.refundAmount > 0), true);
        assert.equal(rows.some(r => r.refundMode === 'gold'), true);
        assert.equal(rows.some(r => r.refundMode === 'cash'), true);
        // Internal cashier remarks are not the customer's correspondence.
        assert.equal(rows.every(r => r.note === undefined), true);
        assert.equal(rows.every(r => r.customerPhone === undefined), true);

        // And the gold refund is visible as spendable credit on the same screen.
        const ledger = await request('/api/customer/advances', {
            headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(ledger.status, 200);
        const advances = await ledger.json();
        const creditRow = advances.history.find(a => a.source === 'return');
        assert.ok(creditRow, 'the gold refund must appear in the customer’s own ledger');
        assert.equal(creditRow.amount, 5665);
    });

    /* ======================================================================
       Razorpay webhook ingestion (roadmap Phase 0)
       ====================================================================== */

    const webhookOrder = 'order_webhook_test_1';
    fs.writeFileSync(path.join(dataDir, 'payment_orders.json'), JSON.stringify([{
        orderId: webhookOrder,
        customerPhone: phone,
        amountPaise: 250000,
        amount: 2500,
        currency: 'INR',
        status: 'created',
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000
    }], null, 2));

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
        const advancesBefore = fs.readFileSync(path.join(dataDir, 'advances.json'), 'utf8');
        const response = await postWebhook(capturedEvent('pay_unsigned', webhookOrder, 250000), { signature: '' });
        assert.equal(response.status, 400);
        assert.equal(fs.readFileSync(path.join(dataDir, 'advances.json'), 'utf8'), advancesBefore);
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

        const deposit = readData('advances.json').find(a => a.referenceId === 'pay_captured_ok');
        assert.ok(deposit, 'the captured payment should have produced a deposit row');
        assert.equal(deposit.amount, 2500);
        assert.equal(deposit.status, 'approved');
        assert.equal(deposit.customerPhone, phone, 'credit goes to the order’s customer, not the webhook body’s');
        assert.match(deposit.id, /^ADV-[0-9A-F]{12}$/, 'ledger ids must be cryptographically strong');

        const order = readData('payment_orders.json').find(o => o.orderId === webhookOrder);
        assert.equal(order.status, 'paid');
        assert.equal(order.depositId, deposit.id);
    });

    await check('a redelivered webhook is acknowledged without crediting twice', async () => {
        const depositsBefore = readData('advances.json').filter(a => a.referenceId === 'pay_captured_ok').length;
        const response = await postWebhook(
            capturedEvent('pay_captured_ok', webhookOrder, 250000),
            { eventId: 'evt_capture_1' }
        );
        assert.equal(response.status, 200);
        assert.equal((await response.json()).duplicate, true);
        assert.equal(readData('advances.json').filter(a => a.referenceId === 'pay_captured_ok').length, depositsBefore);
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
        assert.equal(readData('advances.json').filter(a => a.referenceId === 'pay_captured_ok').length, 1);
    });

    await check('a capture for the wrong amount is refused, not credited', async () => {
        const mismatchOrder = 'order_webhook_mismatch';
        const orders = readData('payment_orders.json');
        orders.push({
            orderId: mismatchOrder, customerPhone: phone, amountPaise: 100000, amount: 1000,
            currency: 'INR', status: 'created', createdAt: Date.now(), expiresAt: Date.now() + 86400000
        });
        fs.writeFileSync(path.join(dataDir, 'payment_orders.json'), JSON.stringify(orders, null, 2));

        const response = await postWebhook(
            capturedEvent('pay_mismatch', mismatchOrder, 5000), // ₹50 against a ₹1000 order
            { eventId: 'evt_mismatch_1' }
        );
        assert.equal(response.status, 200); // acknowledged, so it stops being retried
        assert.equal((await response.json()).ignored, 'amount-mismatch');
        assert.equal(readData('advances.json').some(a => a.referenceId === 'pay_mismatch'), false);
        assert.equal(readData('payment_orders.json').find(o => o.orderId === mismatchOrder).status, 'mismatched');
    });

    await check('an EXPIRED order whose payment the gateway captured is still credited', async () => {
        // Expiry bounds how long an unpaid intent is kept; it must never refuse
        // money that actually moved. Refusing here would strand a customer who
        // paid on a slow connection, and no amount of retrying would fix it.
        const staleOrder = 'order_webhook_expired';
        const longAgo = Date.now() - (48 * 60 * 60 * 1000);
        const orders = readData('payment_orders.json');
        orders.push({
            orderId: staleOrder, customerPhone: phone, amountPaise: 77700, amount: 777,
            currency: 'INR', status: 'created', createdAt: longAgo, expiresAt: longAgo + 86400000
        });
        fs.writeFileSync(path.join(dataDir, 'payment_orders.json'), JSON.stringify(orders, null, 2));

        const response = await postWebhook(
            capturedEvent('pay_expired_but_real', staleOrder, 77700),
            { eventId: 'evt_expired_1' }
        );
        assert.equal(response.status, 200);
        const deposit = readData('advances.json').find(a => a.referenceId === 'pay_expired_but_real');
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
        assert.equal(readData('advances.json').some(a => a.referenceId === 'pay_orphan'), false);
    });

    await check('payment.failed marks the order failed without touching the ledger', async () => {
        const failOrder = 'order_webhook_failed';
        const orders = readData('payment_orders.json');
        orders.push({
            orderId: failOrder, customerPhone: phone, amountPaise: 100000, amount: 1000,
            currency: 'INR', status: 'created', createdAt: Date.now(), expiresAt: Date.now() + 86400000
        });
        fs.writeFileSync(path.join(dataDir, 'payment_orders.json'), JSON.stringify(orders, null, 2));

        const raw = JSON.stringify({
            event: 'payment.failed',
            payload: { payment: { entity: { id: 'pay_failed_1', order_id: failOrder, amount: 100000, status: 'failed', error_description: 'card declined' } } }
        });
        const response = await postWebhook(raw, { eventId: 'evt_failed_1' });
        assert.equal(response.status, 200);
        assert.equal(readData('advances.json').some(a => a.referenceId === 'pay_failed_1'), false);
        assert.equal(readData('payment_orders.json').find(o => o.orderId === failOrder).status, 'failed');
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
            assert.equal(readData('advances.json').some(a => a.referenceId === 'pay_nosecret'), false);
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

    await check('a mid-commit filesystem failure rolls the entire HTTP sale back', async () => {
        const filenames = ['settings.json', 'advances.json', `sales_${new Date().getFullYear()}.json`];
        const before = Object.fromEntries(filenames.map(name => [name, fs.readFileSync(path.join(dataDir, name), 'utf8')]));
        const originalRename = fs.renameSync;
        const originalConsoleError = console.error;
        let renameCount = 0;
        const expectedErrors = [];
        fs.renameSync = (...args) => {
            renameCount++;
            // Journal rename, settings replacement, then fail the sale file.
            if (renameCount === 3) {
                const error = new Error('injected HTTP transaction failure');
                error.code = 'EIO';
                throw error;
            }
            return originalRename(...args);
        };
        console.error = message => expectedErrors.push(String(message));

        let response;
        try {
            response = await request('/api/sales', {
                method: 'POST',
                headers: { ...adminHeaders, 'Content-Type': 'application/json' },
                body: JSON.stringify(salePayload(0))
            });
        } finally {
            fs.renameSync = originalRename;
            console.error = originalConsoleError;
        }

        assert.equal(response.status, 500);
        assert.equal(expectedErrors.some(message => message.includes('injected HTTP transaction failure')), true);
        for (const name of filenames) {
            assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), before[name], `${name} changed after rollback`);
        }
        assert.equal(fs.existsSync(path.join(dataDir, '.json-transaction.json')), false);
    });

    console.log('======================================================================');
    console.log(`🎉 ALL ${passed} HTTP ROUTE CHECKS PASSED.`);
    console.log('======================================================================');
} finally {
    if (server) await new Promise(resolve => server.close(resolve));
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(resolvedSystemTemp + path.sep) && path.basename(resolvedTemp).startsWith('gold-pos-http-')) {
        fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
}
