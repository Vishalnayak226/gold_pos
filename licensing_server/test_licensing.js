/**
 * Behavioural / API regression suite for the central licensing service
 * (docs/TESTING_CHECKLIST.md §25a — previously syntax-check and npm-audit
 * only; nothing exercised a route, an auth boundary, a signature, or a
 * rate limit).
 *
 * Same conventions as backend/test_security.js: a throwaway temp directory,
 * the real server booted in-process on an ephemeral port, driven over
 * fetch() — no mocks. server.js's DATA_DIR/KEYS_DIR are redirected to that
 * temp directory via GOLD_POS_LICENSING_DATA_DIR/GOLD_POS_LICENSING_KEYS_DIR
 * (added alongside this suite) so nothing here ever touches the real
 * licensing_server/{data,keys}.
 *
 * Covers: admin authentication (including the brute-force lockout),
 * entitlement/verify semantics for active/expired/suspended/unknown
 * licenses, cryptographic signature validity (and that tampering breaks
 * it) for both the license-verify and release-manifest signatures, license
 * issue/suspend/renew/revoke, release publish input validation, rollout
 * percentage and the only "rollback" lever this API offers (republishing a
 * version does not let an older version usurp `latest`; republishing the
 * SAME version at a lower rolloutPercent does take effect), malformed/
 * oversized bodies, the two rate limiters, and basic tenant-isolation
 * (one license's data never leaks into another's response).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-licensing-'));
const dataDir = path.join(tempRoot, 'data');
const keysDir = path.join(tempRoot, 'keys');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(keysDir, { recursive: true });

process.env.NODE_ENV = 'test';
process.env.GOLD_POS_DISABLE_BOOTSTRAP = '1';
process.env.GOLD_POS_LICENSING_DATA_DIR = dataDir;
process.env.GOLD_POS_LICENSING_KEYS_DIR = keysDir;
process.env.ADMIN_SECRET = 'licensing-suite-admin-secret-8f2c1';

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const FAR_FUTURE = '2099-12-31';
const PAST_DATE = '2020-01-01';

const FIXTURES = [
    { licenseKey: 'ACTIVE-KEY-0001', customerName: 'Active Test Tenant', expiryDate: FAR_FUTURE, status: 'active', billingCycle: 'yearly', amount: 5000, nextDueDate: FAR_FUTURE },
    { licenseKey: 'EXPIRED-KEY-0002', customerName: 'Expired Test Tenant', expiryDate: PAST_DATE, status: 'active', billingCycle: 'monthly', amount: 500, nextDueDate: PAST_DATE },
    { licenseKey: 'SUSPENDED-KEY-0003', customerName: 'Suspended Test Tenant', expiryDate: FAR_FUTURE, status: 'suspended', billingCycle: 'monthly', amount: 500, nextDueDate: FAR_FUTURE }
];
fs.writeFileSync(path.join(dataDir, 'licenses.json'), JSON.stringify(FIXTURES, null, 2));

let server;
let passed = 0;
function check(label, fn) {
    return Promise.resolve().then(fn).then(() => {
        passed++;
        console.log(`  ✅ ${label}`);
    });
}

console.log('======================================================================');
console.log('LICENSING SERVICE BEHAVIOURAL SUITE');
console.log('======================================================================');

try {
    const { startServer } = await import('./server.js');
    server = startServer(0);
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (pathname, options = {}) => fetch(baseUrl + pathname, options);
    const adminHeaders = { Authorization: `Bearer ${ADMIN_SECRET}`, 'Content-Type': 'application/json' };

    const licensePublicKey = fs.readFileSync(path.join(keysDir, 'license_public.pem'), 'utf8');
    const releasePublicKey = fs.readFileSync(path.join(keysDir, 'release_public.pem'), 'utf8');
    function verifiesAgainst(publicKey, payloadStr, signature) {
        return crypto.createVerify('sha256').update(payloadStr).verify(publicKey, signature, 'base64');
    }

    /* ============================================================
       1. Entitlement checks — POST /api/license/verify
       ============================================================ */

    await check('GET /api/health is public and reports ok', async () => {
        const res = await request('/api/health');
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'ok');
    });

    await check('verify without a licenseKey is refused with 400', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        assert.equal(res.status, 400);
    });

    await check('verify of an unknown key reports invalid and carries no license data', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: 'NO-SUCH-KEY-EXISTS' })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.equal(body.status, 'invalid');
        assert.equal(body.payload, undefined);
        assert.equal(body.signature, undefined);
    });

    let activePayload, activeSignature;
    await check('verify of an active, unexpired key succeeds with a signed payload matching its own record', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: 'ACTIVE-KEY-0001', systemFingerprint: 'test-fp-1' })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        activePayload = body.payload;
        activeSignature = body.signature;
        const decoded = JSON.parse(activePayload);
        assert.equal(decoded.licenseKey, 'ACTIVE-KEY-0001');
        assert.equal(decoded.customerName, 'Active Test Tenant');
        assert.equal(decoded.status, 'active');
        assert.equal(decoded.systemFingerprint, 'test-fp-1');
    });

    await check('the active-license signature verifies against the licensing public key', async () => {
        assert.ok(verifiesAgainst(licensePublicKey, activePayload, activeSignature));
    });

    await check('tampering the payload after signing invalidates the signature', async () => {
        const tampered = activePayload.replace('"status":"active"', '"status":"ACTIVE"');
        assert.notEqual(tampered, activePayload);
        assert.equal(verifiesAgainst(licensePublicKey, tampered, activeSignature), false);
    });

    await check('verify of an expired key reports expired and refuses success', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: 'EXPIRED-KEY-0002' })
        });
        const body = await res.json();
        assert.equal(body.success, false);
        const decoded = JSON.parse(body.payload);
        assert.equal(decoded.status, 'expired');
    });

    await check('verify of a suspended key reports suspended and refuses success', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: 'SUSPENDED-KEY-0003' })
        });
        const body = await res.json();
        assert.equal(body.success, false);
        const decoded = JSON.parse(body.payload);
        assert.equal(decoded.status, 'suspended');
    });

    await check('tenant isolation: one license\'s verify response never carries another tenant\'s data', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: 'EXPIRED-KEY-0002' })
        });
        const decoded = JSON.parse((await res.json()).payload);
        assert.equal(decoded.customerName, 'Expired Test Tenant');
        assert.notEqual(decoded.customerName, 'Active Test Tenant');
        assert.notEqual(decoded.customerName, 'Suspended Test Tenant');
    });

    /* ============================================================
       2. Admin authentication boundary
       ============================================================ */

    await check('an admin route without an Authorization header is refused with 401', async () => {
        const res = await request('/api/admin/keys');
        assert.equal(res.status, 401);
    });

    await check('an admin route with a malformed Authorization header (no Bearer prefix) is refused', async () => {
        const res = await request('/api/admin/keys', { headers: { Authorization: ADMIN_SECRET } });
        assert.equal(res.status, 401);
    });

    await check('an admin route with the wrong bearer token is refused', async () => {
        const res = await request('/api/admin/keys', { headers: { Authorization: 'Bearer not-the-real-secret' } });
        assert.equal(res.status, 401);
    });

    await check('an admin route with the correct bearer token succeeds and lists every fixture', async () => {
        const res = await request('/api/admin/keys', { headers: adminHeaders });
        assert.equal(res.status, 200);
        const body = await res.json();
        const keys = body.map(l => l.licenseKey);
        for (const fixture of FIXTURES) assert.ok(keys.includes(fixture.licenseKey), fixture.licenseKey);
    });

    /* ============================================================
       3. License issue / suspend / renew / revoke — POST/DELETE
          /api/admin/keys (an upsert keyed by licenseKey; a "suspend"
          and a "renew" are both just a re-POST with a changed field).
       ============================================================ */

    await check('issuing a license with a missing mandatory field is refused with 400', async () => {
        const res = await request('/api/admin/keys', {
            method: 'POST', headers: adminHeaders, body: JSON.stringify({ licenseKey: 'INCOMPLETE-0004' })
        });
        assert.equal(res.status, 400);
    });

    await check('issuing a brand-new license key succeeds and is immediately listed', async () => {
        const res = await request('/api/admin/keys', {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ licenseKey: 'LIFECYCLE-KEY-0005', customerName: 'Lifecycle Tenant', expiryDate: FAR_FUTURE })
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).record.status, 'active');
        const list = await (await request('/api/admin/keys', { headers: adminHeaders })).json();
        assert.ok(list.some(l => l.licenseKey === 'LIFECYCLE-KEY-0005'));
    });

    await check('suspending that license (re-POST with status=suspended) takes effect on the next verify', async () => {
        const upsert = await request('/api/admin/keys', {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ licenseKey: 'LIFECYCLE-KEY-0005', customerName: 'Lifecycle Tenant', expiryDate: FAR_FUTURE, status: 'suspended' })
        });
        assert.equal(upsert.status, 200);
        const verify = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: 'LIFECYCLE-KEY-0005' })
        });
        const decoded = JSON.parse((await verify.json()).payload);
        assert.equal(decoded.status, 'suspended');
    });

    await check('renewing that license (re-POST with status=active and a new expiry) restores success', async () => {
        const upsert = await request('/api/admin/keys', {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ licenseKey: 'LIFECYCLE-KEY-0005', customerName: 'Lifecycle Tenant', expiryDate: '2099-06-30', status: 'active' })
        });
        assert.equal(upsert.status, 200);
        const verify = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: 'LIFECYCLE-KEY-0005' })
        });
        const body = await verify.json();
        assert.equal(body.success, true);
        assert.equal(JSON.parse(body.payload).expiryDate, '2099-06-30');
    });

    await check('revoking (DELETE /api/admin/keys/:key) removes it from the roster and verify reports invalid', async () => {
        const del = await request('/api/admin/keys/LIFECYCLE-KEY-0005', { method: 'DELETE', headers: adminHeaders });
        assert.equal(del.status, 200);
        const list = await (await request('/api/admin/keys', { headers: adminHeaders })).json();
        assert.ok(!list.some(l => l.licenseKey === 'LIFECYCLE-KEY-0005'));
        const verify = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: 'LIFECYCLE-KEY-0005' })
        });
        assert.equal((await verify.json()).status, 'invalid');
    });

    /* ============================================================
       4. Release publishing — input validation, signature,
          rollout percentage and the "no accidental rollback" guarantee.
       ============================================================ */

    const validRelease = {
        version: '1.0.0', channel: 'security', changelog: 'initial',
        downloadUrl: 'https://example.test/release-1.0.0.zip', sha256: 'a'.repeat(64)
    };

    await check('publishing with a missing mandatory field is refused with 400', async () => {
        const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ version: '1.0.0' }) });
        assert.equal(res.status, 400);
    });

    await check('publishing with an invalid channel is refused with 400', async () => {
        const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, channel: 'not-a-channel' }) });
        assert.equal(res.status, 400);
    });

    await check('publishing with a non-semver version is refused with 400', async () => {
        const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, version: 'v1' }) });
        assert.equal(res.status, 400);
    });

    await check('publishing with a non-http downloadUrl is refused with 400', async () => {
        const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, downloadUrl: 'ftp://example.test/x' }) });
        assert.equal(res.status, 400);
    });

    await check('publishing with a malformed sha256 is refused with 400', async () => {
        const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, sha256: 'not-hex' }) });
        assert.equal(res.status, 400);
    });

    await check('publishing with an over-length changelog is refused with 400', async () => {
        const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, changelog: 'x'.repeat(5001) }) });
        assert.equal(res.status, 400);
    });

    await check('publishing with an out-of-range rolloutPercent is refused with 400', async () => {
        for (const bad of [0, 101, 'abc']) {
            const res = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, rolloutPercent: bad }) });
            assert.equal(res.status, 400, `rolloutPercent=${bad}`);
        }
    });

    let releaseSignature, releasePayload;
    await check('a valid publish is accepted, defaults rolloutPercent to 100, and is retrievable signed', async () => {
        const publish = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify(validRelease) });
        assert.equal(publish.status, 200);
        assert.equal((await publish.json()).release.rolloutPercent, 100);

        const latest = await request('/api/releases/latest?channel=security');
        assert.equal(latest.status, 200);
        const body = await latest.json();
        releasePayload = body.payload;
        releaseSignature = body.signature;
        assert.equal(JSON.parse(releasePayload).version, '1.0.0');
    });

    await check('the release manifest signature verifies against the release public key, and tampering breaks it', async () => {
        assert.ok(verifiesAgainst(releasePublicKey, releasePayload, releaseSignature));
        const tampered = releasePayload.replace('"version":"1.0.0"', '"version":"9.9.9"');
        assert.equal(verifiesAgainst(releasePublicKey, tampered, releaseSignature), false);
    });

    await check('a channel with no published release is a 404, not an empty success', async () => {
        const res = await request('/api/releases/latest?channel=feature');
        assert.equal(res.status, 404);
    });

    await check('publishing an OLDER version afterwards never displaces a newer already-latest release (no accidental rollback)', async () => {
        const newer = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, version: '2.0.0', sha256: 'b'.repeat(64) }) });
        assert.equal(newer.status, 200);

        const older = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, version: '1.5.0', sha256: 'c'.repeat(64) }) });
        assert.equal(older.status, 200, 'publishing an old version is itself allowed — it just must not win /latest');

        const latest = await request('/api/releases/latest?channel=security');
        assert.equal(JSON.parse((await latest.json()).payload).version, '2.0.0');
    });

    await check('republishing the SAME version at a lower rolloutPercent is the one supported "shrink the rollout" lever', async () => {
        const wide = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, version: '2.0.0', sha256: 'b'.repeat(64), rolloutPercent: 50 }) });
        assert.equal(wide.status, 200);
        const narrow = await request('/api/admin/releases', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...validRelease, version: '2.0.0', sha256: 'b'.repeat(64), rolloutPercent: 5 }) });
        assert.equal(narrow.status, 200);

        const latest = await request('/api/releases/latest?channel=security');
        const decoded = JSON.parse((await latest.json()).payload);
        assert.equal(decoded.version, '2.0.0');
        assert.equal(decoded.rolloutPercent, 5, 'the most-recently-published entry on a version tie must win');
    });

    await check('GET /api/releases is admin-only and lists every publish newest first', async () => {
        const anon = await request('/api/releases');
        assert.equal(anon.status, 401);
        const res = await request('/api/releases', { headers: adminHeaders });
        assert.equal(res.status, 200);
        const list = await res.json();
        assert.ok(list.length >= 4);
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].publishedAt >= list[i].publishedAt);
    });

    /* ============================================================
       5. Malformed / oversized bodies and the safe-error boundary.
       ============================================================ */

    await check('a malformed JSON body returns a safe JSON error with no stack trace or file path', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"licenseKey": '
        });
        assert.equal(res.status, 400);
        const raw = await res.text();
        assert.doesNotMatch(raw, /at .+\(.*server\.js/);
        assert.doesNotMatch(raw, /node_modules/);
        assert.doesNotMatch(raw, /<!DOCTYPE|<html/i);
        const body = JSON.parse(raw);
        assert.equal(body.error, 'BAD_REQUEST');
    });

    await check('an oversized body is refused, not parsed', async () => {
        const res = await request('/api/license/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey: 'x'.repeat(150000) })
        });
        assert.equal(res.status, 413);
    });

    await check('an unknown /api route answers JSON, not an HTML 404', async () => {
        const res = await request('/api/does-not-exist');
        assert.equal(res.status, 404);
        assert.match(res.headers.get('content-type') || '', /application\/json/);
        assert.equal((await res.json()).error, 'NOT_FOUND');
    });

    /* ============================================================
       6. Admin brute-force lockout — LAST among admin-auth checks:
          it deliberately drives every remaining admin credential (even
          the correct one) into a 429 for this suite's IP, so nothing
          admin-authenticated below this point would still work.
       ============================================================ */

    await check('repeated wrong admin tokens eventually lock the caller out, even with the correct token', async () => {
        let lockedOut = false;
        for (let attempt = 0; attempt < 10 && !lockedOut; attempt++) {
            const res = await request('/api/admin/keys', { headers: { Authorization: 'Bearer still-wrong' } });
            if (res.status === 429) {
                lockedOut = true;
                assert.equal((await res.json()).error, 'TOO_MANY_ATTEMPTS');
            } else {
                assert.equal(res.status, 401);
            }
        }
        assert.ok(lockedOut, 'lockout must engage within 10 wrong attempts');

        const withRealToken = await request('/api/admin/keys', { headers: adminHeaders });
        assert.equal(withRealToken.status, 429, 'a lockout must block the correct token too, not just wrong ones');
    });

    /* ============================================================
       7. General per-IP rate limiter — LAST overall: once tripped,
          every /api/* route except /api/health 429s for the rest of
          this process's window, so nothing can run after this.
       ============================================================ */

    await check('the general per-IP rate limiter eventually 429s a route, while /api/health stays exempt throughout', async () => {
        let limited = false;
        for (let attempt = 0; attempt < 320 && !limited; attempt++) {
            const res = await request('/api/version');
            if (res.status === 429) {
                limited = true;
                assert.match(res.headers.get('retry-after') || '', /^\d+$/);
            }
        }
        assert.ok(limited, 'the general limiter must engage within 320 requests');

        // Stays enforced, not a one-off fluke.
        const again = await request('/api/version');
        assert.equal(again.status, 429);

        const health = await request('/api/health');
        assert.equal(health.status, 200, '/api/health must be exempt even while the general limiter is fully tripped');
    });

    console.log('======================================================================');
    console.log(`✅ LICENSING SERVICE SUITE PASSED (${passed} checks)`);
    console.log('======================================================================');
} finally {
    if (server) await new Promise(resolve => server.close(resolve));
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedSystemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(resolvedSystemTemp + path.sep) && path.basename(resolvedTemp).startsWith('gold-pos-licensing-')) {
        try {
            fs.rmSync(resolvedTemp, { recursive: true, force: true });
        } catch (err) {
            console.warn(`[cleanup] could not remove ${resolvedTemp}: ${err.message}`);
        }
    }
}
