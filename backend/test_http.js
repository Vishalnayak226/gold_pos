/**
 * Real HTTP boundary tests.
 *
 * Boots the production Express app on an ephemeral TCP port with a temporary
 * database, then drives it through fetch. No route handler is called directly.
 */
import assert from 'node:assert/strict';
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
const initialSettings = {
    companyName: 'HTTP Test Store',
    goldTaxSlab: 3,
    taxMode: 'Exclusive',
    invoicePrefix: 'HTTP',
    invoiceSeqStart: 10,
    adminPin: '2468',
    razorpayKeyId: 'rzp_live_public_key',
    razorpayKeySecret: 'razorpay-secret-value',
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
