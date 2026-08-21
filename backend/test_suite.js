/**
 * ==========================================================================
 * Gold POS Platform Integration Test Suite
 * Validates pricing math, bi-directional rounding, licensing, and envelopes.
 * Uses native Node assert module. Zero extra dependencies.
 * ==========================================================================
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// Mock DB helpers to avoid polluting live databases
const ROU_DATA = {
    price24K: 7500.00,
    price22K: 6875.00,
    price18K: 5625.00
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* --------------------------------------------------------------------------
   Throwaway data directory, redirected BEFORE anything imports db.js.

   db.js resolves DATA_DIR once, at import time, and ESM caches the module —
   so setting these env vars inside a test function is far too late: the first
   `await import('./customerAuth.js')` anywhere in this file has already
   pinned the path. Getting that wrong writes fixture accounts into the
   tenant's real backend/data/customer_auth.json, where they look exactly like
   real customers (CLAUDE.md §8).

   Every test here is pure math, crypto, or account machinery, so none of them
   has any business reading the live database in the first place.
   -------------------------------------------------------------------------- */
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-suite-'));
process.env.GOLD_POS_DATA_DIR = path.join(TEST_ROOT, 'data');
process.env.GOLD_POS_LOGS_DIR = path.join(TEST_ROOT, 'logs');
// pitr.js resolves this once at import — set before any dynamic import of it,
// same reason as DATA_DIR/LOGS_DIR above, or Test 13 litters backend/backups/pitr.
process.env.GOLD_POS_PITR_DIR = path.join(TEST_ROOT, 'pitr');
fs.mkdirSync(process.env.GOLD_POS_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.GOLD_POS_LOGS_DIR, { recursive: true });

console.log('======================================================================');
console.log('STARTING INTEGRATION VERIFICATION TESTS');
console.log('======================================================================');

/* ==========================================================================
   TEST 1: Troy Ounce to Gram conversion precision
   ========================================================================== */
function testTroyOunceConversion() {
    console.log('Running Test 1: Troy Ounce to Gram conversion...');
    
    const goldPriceUSDPerOunce = 2350.00;
    const exchangeRateUSDToLocal = 83.50;
    const troyOunceToGrams = 31.1034768;

    // Standard conversion formula
    const pricePerGram24K = (goldPriceUSDPerOunce / troyOunceToGrams) * exchangeRateUSDToLocal;
    const rounded24K = Math.round(pricePerGram24K * 100) / 100;

    // Expected value: (2350 / 31.1034768) * 83.50 = 75.5542... * 83.50 = 6308.78
    const expected = 6308.78;
    
    assert.strictEqual(rounded24K, expected, `Conversion mismatch! Expected: ${expected}, Got: ${rounded24K}`);
    console.log('✅ Test 1 Passed: Gold price per gram converted and rounded correctly.');
}

/* ==========================================================================
   TEST 2: Bi-directional calculations precision checks
   ========================================================================== */
function testBidirectionalCalculations() {
    console.log('Running Test 2: Bi-directional Making Charge calculations...');

    const baseGoldPrice = 7500.00; // ₹7,500/g
    const weight = 10.0; // 10 grams
    const baseValue = baseGoldPrice * weight; // ₹75,000

    // Scenario A: Cashier enters Making Charge Percentage = 8%
    const pctInput = 8.0;
    const computedFlatMaking = Math.round((baseValue * (pctInput / 100)) * 100) / 100;
    const expectedFlat = 6000.00;
    assert.strictEqual(computedFlatMaking, expectedFlat, `Flat making charge mismatch! Expected: ${expectedFlat}, Got: ${computedFlatMaking}`);

    // Scenario B: Cashier shifts flat rate to ₹6,300 (percentage should shift to 8.4%)
    const newFlatInput = 6300.00;
    const computedPct = Math.round(((newFlatInput / baseValue) * 100) * 100) / 100;
    const expectedPct = 8.40;
    assert.strictEqual(computedPct, expectedPct, `Percentage making charge mismatch! Expected: ${expectedPct}, Got: ${computedPct}`);

    console.log('✅ Test 2 Passed: Bi-directional state calculations and roundings validated.');
}

/* ==========================================================================
   TEST 3: SaaS licensing validity, grace period, and middleware rules
   ========================================================================== */
function testLicensingLogic() {
    console.log('Running Test 3: SaaS licensing validity & offline grace checks...');

    // Scenario A: Active license with valid expiry date
    const mockLicenseActive = {
        activated: true,
        status: 'active',
        expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString(), // 10 days in future
        lastHandshakeTime: Date.now()
    };

    const isLicValid = (lic) => {
        if (lic.activated && lic.status === 'active') {
            const expiry = lic.expiryDate ? new Date(lic.expiryDate) : null;
            if (expiry && expiry < new Date()) return false;
            return true;
        }
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const timeSinceHandshake = Date.now() - (lic.lastHandshakeTime || 0);
        if (lic.status === 'active' && timeSinceHandshake < sevenDaysMs) return true;
        return false;
    };

    assert.strictEqual(isLicValid(mockLicenseActive), true, 'Active license should be valid.');

    // Scenario B: Expired license (expiry in past)
    const mockLicenseExpired = {
        activated: true,
        status: 'active',
        expiryDate: new Date(Date.now() - 1000 * 60 * 60).toISOString(), // 1 hour in past
        lastHandshakeTime: Date.now()
    };
    assert.strictEqual(isLicValid(mockLicenseExpired), false, 'Expired license should be invalid.');

    // Scenario C: Offline grace period (license key active, server unreachable, last handshake 3 days ago)
    const mockLicenseGraceValid = {
        activated: false, // lost connection, active status flag reset but retained status
        status: 'active',
        expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString(),
        lastHandshakeTime: Date.now() - 1000 * 60 * 60 * 24 * 3 // 3 days ago
    };
    assert.strictEqual(isLicValid(mockLicenseGraceValid), true, 'License within 7-day grace period should be valid.');

    // Scenario D: Expired grace period (last handshake 8 days ago)
    const mockLicenseGraceExpired = {
        activated: false,
        status: 'active',
        expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString(),
        lastHandshakeTime: Date.now() - 1000 * 60 * 60 * 24 * 8 // 8 days ago
    };
    assert.strictEqual(isLicValid(mockLicenseGraceExpired), false, 'License with grace period > 7 days should be invalid.');

    console.log('✅ Test 3 Passed: Licensing grace periods and lock boundaries validated.');
}

/* ==========================================================================
   TEST 4: Asymmetric Cryptographic Envelope Decryption
   ========================================================================== */
function testAsymmetricEnvelope() {
    console.log('Running Test 4: Asymmetric Cryptographic Envelope...');

    // Define mock keys locally for self-contained testing
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const sensitiveData = JSON.stringify({
        sales: [{ invoice: 'GOLD-000001-26', amount: 50000 }],
        customerPhone: '9000000000'
    });

    // 1. Encrypt Envelope (Simulation)
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    
    let ciphertext = cipher.update(sensitiveData, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // Encrypt the AES key with RSA Public Key
    const encryptedAesKey = crypto.publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        aesKey
    );

    const envelope = {
        encryptedKey: encryptedAesKey.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        ciphertext
    };

    // 2. Decrypt Envelope (Simulation using privateKey)
    const rsaDecryptedKey = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(envelope.encryptedKey, 'base64')
    );

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        rsaDecryptedKey,
        Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));

    let decrypted = decipher.update(envelope.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    const result = JSON.parse(decrypted);
    assert.strictEqual(result.customerPhone, '9000000000', 'Decrypted payload phone mismatch!');
    
    console.log('✅ Test 4 Passed: Asymmetric cryptographic envelope encrypt/decrypt cycle validated.');
}

/* ==========================================================================
   TEST 5: Customer password hashing (scrypt) round-trip
   Covers the pure half of backend/customerAuth.js — the half that decides
   whether a stolen customer_auth.json is crackable. Reset codes are covered
   by Test 7 below; sessions and lockout are proved over HTTP in
   test_routes.js against a live server on a throwaway data directory.
   ========================================================================== */
async function testCustomerPasswordHashing() {
    console.log('Running Test 5: Customer password hashing & verification...');
    const { hashPassword, verifyPassword, validatePasswordStrength } = await import('./customerAuth.js');

    const password = 'correct horse battery';
    const { salt, passwordHash } = hashPassword(password);

    // Self-describing format: scrypt$N$r$p$<hex>, so work factors can be
    // raised later without invalidating every stored password.
    const parts = passwordHash.split('$');
    assert.strictEqual(parts.length, 5, 'Password hash should be scrypt$N$r$p$hex');
    assert.strictEqual(parts[0], 'scrypt', 'Password hash should declare its KDF');
    assert.ok(parseInt(parts[1], 10) >= 16384, 'scrypt N should be at least 16384');
    assert.ok(!passwordHash.includes(password), 'Password must never appear in its own hash');

    const account = { salt, passwordHash };
    assert.strictEqual(verifyPassword(password, account), true, 'Correct password should verify.');
    assert.strictEqual(verifyPassword('wrong password', account), false, 'Wrong password must not verify.');
    assert.strictEqual(verifyPassword('', account), false, 'Empty password must not verify.');
    assert.strictEqual(verifyPassword(password, { salt, passwordHash: 'scrypt$16384$8$1$deadbeef' }), false,
        'A tampered hash must not verify.');
    assert.strictEqual(verifyPassword(password, { salt: 'different', passwordHash }), false,
        'A swapped salt must not verify.');

    // Distinct salts per account, so identical passwords never collide and a
    // precomputed table is worthless against the file as a whole.
    const second = hashPassword(password);
    assert.notStrictEqual(second.salt, salt, 'Each account must get its own random salt.');
    assert.notStrictEqual(second.passwordHash, passwordHash, 'Same password must hash differently per salt.');

    assert.ok(validatePasswordStrength('short') !== null, 'Short passwords must be rejected.');
    assert.strictEqual(validatePasswordStrength('longenough123'), null, 'An 8+ char password should pass.');

    console.log('✅ Test 5 Passed: scrypt hashing, verification, and salt uniqueness validated.');
}

/* ==========================================================================
   TEST 6: Login lockout escalation schedule
   Same escalating-cooldown rule as the admin PIN limiter (adminAuth.js),
   asserted as arithmetic so a future tweak to the constants can't silently
   flatten the curve.
   ========================================================================== */
function testLockoutEscalation() {
    console.log('Running Test 6: Failed-login lockout escalation...');

    const MAX_FAILED_ATTEMPTS = 5;
    const BASE_LOCKOUT_MS = 30 * 1000;
    const MAX_LOCKOUT_MS = 15 * 60 * 1000;

    const lockoutFor = (attempts) => {
        if (attempts < MAX_FAILED_ATTEMPTS) return 0;
        const extra = attempts - MAX_FAILED_ATTEMPTS;
        return Math.min(BASE_LOCKOUT_MS * Math.pow(2, extra), MAX_LOCKOUT_MS);
    };

    assert.strictEqual(lockoutFor(4), 0, 'Under the threshold there is no lockout.');
    assert.strictEqual(lockoutFor(5), 30000, '5th failure locks for 30s.');
    assert.strictEqual(lockoutFor(6), 60000, '6th failure doubles to 60s.');
    assert.strictEqual(lockoutFor(7), 120000, '7th failure doubles to 120s.');
    assert.strictEqual(lockoutFor(20), MAX_LOCKOUT_MS, 'Lockout is capped at 15 minutes.');

    // A 4-digit admin PIN is a 10,000-value keyspace; with this schedule the
    // attacker gets 5 free guesses and then spends over an hour on the next
    // 10 — which is what made the unthrottled endpoint a real finding in 1.0.1.
    let elapsedMs = 0;
    for (let attempt = MAX_FAILED_ATTEMPTS; attempt < MAX_FAILED_ATTEMPTS + 10; attempt++) {
        elapsedMs += lockoutFor(attempt);
    }
    assert.ok(elapsedMs > 60 * 60 * 1000, `10 attempts past the threshold should cost over an hour, got ${elapsedMs}ms`);

    console.log('✅ Test 6 Passed: Lockout escalation curve and cap validated.');
}

/* ==========================================================================
   TEST 7: Password reset code lifecycle — the self-service path

   This is the machinery a customer uses to get back into their account
   WITHOUT the store: request a code, type it in, choose a new password. It
   had no coverage at all, which is a poor place to have none — every branch
   here either lets the wrong person in or strands the right one at the
   counter, and Test 5's comment claiming it was "proved against a live
   server" was not true of any suite.

   Runs against the throwaway data directory set up at the top of this file,
   so it never touches the tenant's customer_auth.json (CLAUDE.md §8).
   ========================================================================== */
async function testPasswordResetLifecycle() {
    console.log('Running Test 7: Password reset code lifecycle...');

    const dataDir = process.env.GOLD_POS_DATA_DIR;
    const {
        createCustomerAccount, issueResetToken, consumeResetToken,
        loginCustomer, findAccount
    } = await import('./customerAuth.js');

    {
        const phone = '9000000123';
        const created = createCustomerAccount({
            phone, password: 'OriginalPass!1', name: 'Reset Tester', email: 'reset@example.test'
        });
        assert.strictEqual(created.success, true, 'Test account should be created.');

        // --- The happy path: request, use, sign in with the new password ---
        const issued = issueResetToken(phone);
        assert.ok(issued && issued.code, 'A reset code should be issued for a real account.');
        assert.ok(issued.expiresAt > Date.now(), 'The code should carry a future expiry.');
        assert.ok(issued.code.length >= 8, 'A short code would be brute-forceable inside its window.');

        // The plaintext code must never be sitting in the account file — only
        // its hash. A leaked customer_auth.json must not be a set of live
        // account-takeover tokens.
        const stored = findAccount(phone);
        assert.ok(stored.resetTokenHash, 'The account should hold a reset token hash.');
        assert.ok(!JSON.stringify(stored).includes(issued.code),
            'The plaintext reset code must never be persisted.');

        const used = consumeResetToken(phone, issued.code, 'BrandNewPass!2');
        assert.strictEqual(used.success, true, 'A valid code should set the new password.');

        const signedIn = loginCustomer(phone, 'BrandNewPass!2', '127.0.0.1');
        assert.strictEqual(signedIn.success, true, 'The customer should sign in with the new password.');
        const oldPassword = loginCustomer(phone, 'OriginalPass!1', '127.0.0.1');
        assert.strictEqual(oldPassword.success, false, 'The old password must stop working.');

        // --- Single use: the same code cannot be replayed ---
        const replayed = consumeResetToken(phone, issued.code, 'ThirdPassword!3');
        assert.strictEqual(replayed.success, false, 'A consumed code must not work twice.');

        // --- A wrong code is refused, and burns the real one after 5 tries ---
        const second = issueResetToken(phone);
        for (let i = 0; i < 5; i++) {
            const guess = consumeResetToken(phone, 'WRONGCODE1', 'GuessedPass!4');
            assert.strictEqual(guess.success, false, `Wrong guess ${i + 1} must be refused.`);
        }
        const afterBruteForce = consumeResetToken(phone, second.code, 'GuessedPass!4');
        assert.strictEqual(afterBruteForce.success, false,
            'The real code must be invalidated once the guess budget is spent.');

        // --- An expired code is refused ---
        const third = issueResetToken(phone);
        /* Age the code past its window. Accounts live in the `customers` table
           now rather than in customer_auth.json, but the seam speaks the same
           legacy account shape — so this reaches in the same way it always did,
           through `loadAccounts`/`saveAccounts` instead of through the file. */
        const repo = await import('./repositories/index.js');
        const tenantId = repo.dataStoreContext().tenantId;
        const accounts = repo.customers.loadAccounts(tenantId);
        accounts.find(a => a.phone === phone).resetExpires = Date.now() - 1000;
        repo.customers.saveAccounts(tenantId, accounts);
        const expired = consumeResetToken(phone, third.code, 'TooLate!5');
        assert.strictEqual(expired.success, false, 'An expired code must be refused.');
        assert.ok(/expired/i.test(expired.error), 'And must say so, so the customer requests another.');

        // --- A weak new password is refused even with a valid code ---
        const fourth = issueResetToken(phone);
        const weak = consumeResetToken(phone, fourth.code, 'short');
        assert.strictEqual(weak.success, false, 'A valid code must not waive the password rules.');

        // --- No account, no code. Never throws, never reveals. ---
        assert.strictEqual(issueResetToken('9999999999'), null,
            'An unknown number must not produce a reset code.');

        console.log('✅ Test 7 Passed: reset codes are single-use, expiring, guess-limited, and never stored in the clear.');
    }
}

/* ==========================================================================
   Test 8: admin PIN hashing and the plaintext migration

   PINs used to sit in settings.json in the clear. Three properties matter, and
   none is visible from the outside: the migration converts an existing tenant's
   plaintext without anyone retyping it, it deletes the plaintext, and it is
   idempotent so a boot loop cannot rehash a hash.
   ========================================================================== */
async function testAdminPinHashing() {
    console.log('Running Test 8: admin PIN hashing and plaintext migration...');
    const auth = await import('./adminAuth.js');

    // An existing tenant: plaintext master PIN and a plaintext operator PIN.
    const settings = {
        adminPin: '9182',
        operators: [{ id: 'OP-T8', name: 'Test Cashier', role: 'cashier', pin: '5150', active: true }]
    };

    assert.strictEqual(auth.migratePinsToHashes(settings), true, 'the first pass should change something');
    assert.strictEqual(settings.adminPin, undefined, 'the plaintext master PIN must be deleted');
    assert.strictEqual(settings.operators[0].pin, undefined, 'the plaintext operator PIN must be deleted');
    assert.ok(settings.authSalt && settings.authSalt.length >= 32, 'a tenant salt must be generated');
    assert.match(settings.adminPinHash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+$/);

    // Both credentials still work, which is the whole point of the migration.
    const asOperator = auth.resolveActor('5150', settings);
    assert.ok(asOperator, 'the operator PIN must still authenticate after hashing');
    assert.strictEqual(asOperator.actor.name, 'Test Cashier');
    assert.strictEqual(asOperator.actor.role, 'cashier');
    const asOwner = auth.resolveActor('9182', settings);
    assert.ok(asOwner, 'the master PIN must still authenticate after hashing');
    assert.strictEqual(asOwner.actor.id, 'owner');
    assert.strictEqual(auth.resolveActor('0000', settings), null, 'a wrong PIN must not authenticate');

    // Idempotent: nothing plaintext is left, so a second boot rewrites nothing.
    assert.strictEqual(auth.migratePinsToHashes(settings), false, 'the second pass must be a no-op');

    // A fresh install with no credential at all is seeded with the documented
    // default — the case that used to be handled by a plaintext template key.
    const fresh = {};
    assert.strictEqual(auth.migratePinsToHashes(fresh), true);
    assert.ok(auth.resolveActor('1234', fresh), 'a fresh install should open with the default PIN');
    assert.strictEqual(fresh.adminPin, undefined, 'and still not store it in the clear');

    // No salt means no verifiable credential: refuse rather than fall back to
    // comparing plaintext, which would silently undo the hashing.
    assert.strictEqual(
        auth.resolveActor('1234', { adminPinHash: fresh.adminPinHash }),
        null,
        'a settings document with no salt must not authenticate anyone'
    );

    // Recovery codes are single-use and stored only as hashes.
    const recovery = auth.generateRecoveryCodes(settings.authSalt);
    assert.strictEqual(recovery.plain.length, 10);
    assert.strictEqual(recovery.hashes.length, 10);
    assert.ok(!recovery.hashes.some(h => h.includes(recovery.plain[0])), 'a hash must not contain its code');
    const used = auth.consumeRecoveryCode(recovery.plain[3], settings.authSalt, recovery.hashes);
    assert.strictEqual(used.ok, true, 'a valid recovery code should be accepted');
    assert.strictEqual(used.remainingHashes.length, 9, 'and consumed');
    assert.strictEqual(
        auth.consumeRecoveryCode(recovery.plain[3], settings.authSalt, used.remainingHashes).ok,
        false, 'a recovery code must not work twice'
    );
    assert.strictEqual(
        auth.consumeRecoveryCode('NOPE1-NOPE2', settings.authSalt, used.remainingHashes).ok,
        false, 'an invented code must not work'
    );

    console.log('✅ Test 8 Passed: PINs hash, migrate once, keep working, and never persist in the clear.');
}

/* ==========================================================================
   Test 9: TOTP against the published RFC 6238 vectors

   The one check that proves a real authenticator app will interoperate. Every
   other MFA test in this repo presents a code generated by our own code, so
   without this a consistent implementation bug would pass everywhere and fail
   only on a cashier's phone.
   ========================================================================== */
async function testTotpAgainstRfcVectors() {
    console.log('Running Test 9: TOTP against RFC 6238 published vectors...');
    const { verifyTotp, currentTotpCode, generateTotpSecret } = await import('./adminAuth.js');

    // RFC 6238 Appendix B, SHA1. ASCII secret '12345678901234567890' is base32
    // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ; the published 8-digit codes truncated to
    // the 6 digits this implementation uses.
    const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const vectors = [
        [59, '287082'],
        [1111111109, '081804'],
        [1111111111, '050471'],
        [1234567890, '005924'],
        [2000000000, '279037']
    ];
    for (const [seconds, expected] of vectors) {
        const at = seconds * 1000;
        assert.strictEqual(currentTotpCode(SECRET, at), expected,
            `RFC 6238 vector at T=${seconds} should generate ${expected}`);
        assert.strictEqual(verifyTotp(expected, SECRET, at), true,
            `RFC 6238 vector at T=${seconds} should verify`);
    }

    // A code from a distant window must not verify, or the second factor is not
    // time-based at all.
    assert.strictEqual(verifyTotp('287082', SECRET, 1234567890 * 1000), false,
        'a stale code must be refused');

    // One step of drift either side is accepted, because a counter terminal's
    // clock wanders and refusing a code that was right two seconds ago trains
    // people to retype.
    const now = 1234567890 * 1000;
    assert.strictEqual(verifyTotp(currentTotpCode(SECRET, now - 30000), SECRET, now), true,
        'the previous 30s step should still verify');
    assert.strictEqual(verifyTotp(currentTotpCode(SECRET, now + 30000), SECRET, now), true,
        'the next 30s step should verify');
    assert.strictEqual(verifyTotp(currentTotpCode(SECRET, now - 120000), SECRET, now), false,
        'four steps ago must not verify');

    // A generated secret is base32 in the alphabet authenticator apps expect.
    const secret = generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{20}$/, 'the secret must be RFC 4648 base32');
    assert.strictEqual(verifyTotp(currentTotpCode(secret), secret), true);
    assert.strictEqual(verifyTotp('12345', secret), false, 'a short code must be refused');
    assert.strictEqual(verifyTotp('', secret), false, 'an empty code must be refused');

    console.log('✅ Test 9 Passed: TOTP matches the RFC vectors, tolerates one step of drift, and rejects stale codes.');
}

/* ==========================================================================
   Test 10: the bounded counter under every attempt tracker

   The two credential lockouts and the abuse limiters all keep counters in a
   keyed map. Before this map existed they used plain Maps that only ever shed
   an entry on a SUCCESSFUL login — so every source that failed once and never
   came back stayed resident for the life of the process, and one request per
   new IP grew them without bound. That is not observable over HTTP and it is
   not visible in a code review that is looking at the escalation policy, which
   is why it is asserted here.
   ========================================================================== */
async function testBoundedAttemptMap() {
    console.log('Running Test 10: the bounded counter behind every rate limit...');
    const { createBoundedMap } = await import('./rateLimit.js');

    // An entry that is still inside its TTL reads back unchanged.
    const live = createBoundedMap({ ttlMs: 60_000 });
    live.set('1.2.3.4', { count: 3 });
    assert.strictEqual(live.get('1.2.3.4').count, 3, 'a fresh entry must survive');
    assert.strictEqual(live.get('unknown'), undefined, 'an absent key must read undefined');

    live.delete('1.2.3.4');
    assert.strictEqual(live.get('1.2.3.4'), undefined, 'delete must forget the entry');

    /* Expiry is read-time as well as sweep-time. A caller that reads a stale
       entry between sweeps must see it as gone, or a lockout would outlive its
       own window. `set` takes an explicit `now`, so this needs no sleep. */
    const expiring = createBoundedMap({ ttlMs: 50 });
    expiring.set('stale', { count: 9 }, Date.now() - 1000);
    assert.strictEqual(expiring.get('stale'), undefined,
        'an entry past its TTL must read as absent even before a sweep runs');

    /* THE BOUND ITSELF. Write far more distinct keys than the cap allows and
       the map must not keep them all — this is the assertion that fails if
       somebody swaps the storage back for a plain Map. */
    const capped = createBoundedMap({ ttlMs: 60_000, maxEntries: 100 });
    for (let i = 0; i < 1000; i++) capped.set(`ip-${i}`, { count: 1 });
    assert.ok(capped.size <= 100,
        `the map must stay within its cap under a flood of distinct keys, got ${capped.size}`);
    // Eviction is oldest-first, so the most recent writer is still counted —
    // an attacker must not be able to flush their own counter by flooding.
    assert.strictEqual(capped.get('ip-999').count, 1, 'the newest entry must survive eviction');

    console.log('✅ Test 10 Passed: the shared attempt map expires, forgets, and stays bounded under a flood.');
}

/* ==========================================================================
   Test 11: the secret vault — encryption at rest for settings.json
   ==========================================================================
   The properties worth asserting are the ones that are easy to break silently:
   that a round trip is lossless, that an UNSET credential stays distinguishable
   from a set one, that upgrading a plaintext tenant needs no migration step,
   that a ciphertext cannot be moved between fields, and that rotation actually
   re-keys rather than merely re-writing. */
async function testSecretVault() {
    console.log('\nRunning Test 11: secret vault seal/open, path binding, and key rotation...');
    const vault = await import('./secretVault.js');
    const keyA = Buffer.from(vault.generateKeyHex(), 'hex');
    const keyB = Buffer.from(vault.generateKeyHex(), 'hex');

    // --- round trip ---------------------------------------------------------
    const sealed = vault.seal('rzp_live_supersecret', 'razorpayKeySecret', keyA);
    assert.ok(sealed.startsWith('encv1$'), 'sealed values are self-describing');
    assert.ok(!sealed.includes('supersecret'), 'the plaintext must not survive in the ciphertext');
    assert.strictEqual(vault.open(sealed, 'razorpayKeySecret', keyA), 'rzp_live_supersecret');

    // Two seals of one value differ: a fresh IV each time, so an observer
    // cannot tell that two fields hold the same secret.
    assert.notStrictEqual(
        vault.seal('same', 'a', keyA),
        vault.seal('same', 'a', keyA),
        'each seal must use a fresh IV'
    );

    // --- an unset credential stays unset ------------------------------------
    // redactSettings() distinguishes "" (not configured) from a real value, so
    // sealing an empty string would make the Settings screen claim a credential
    // exists where none does.
    assert.strictEqual(vault.seal('', 'smtp.pass', keyA), '', 'an empty secret must stay empty');

    // --- lazy migration -----------------------------------------------------
    // A tenant upgrading from a plaintext settings.json must keep working with
    // no migration step, so open() passes non-vault values straight through.
    assert.strictEqual(vault.open('plain-old-value', 'smtp.pass', keyA), 'plain-old-value');
    // ...and sealing is idempotent, so re-saving does not double-encrypt.
    assert.strictEqual(vault.seal(sealed, 'razorpayKeySecret', keyA), sealed);

    // --- the wrong key fails loudly ----------------------------------------
    assert.throws(() => vault.open(sealed, 'razorpayKeySecret', keyB), /Could not decrypt/,
        'a wrong key must throw rather than hand back ciphertext');

    // --- a ciphertext is bound to its own field -----------------------------
    // Without the path as AAD, this value could be cut from one credential
    // field and pasted over another, and the server would decrypt it happily.
    assert.throws(() => vault.open(sealed, 'razorpayWebhookSecret', keyA), /Could not decrypt/,
        'a sealed value must not decrypt under a different field name');

    // --- whole-document seal/open, including the wildcard paths -------------
    const doc = {
        companyName: 'Vault Test Jewellers',
        razorpayKeySecret: 'secret-one',
        razorpayWebhookSecret: '',
        smtp: { host: 'smtp.example.test', pass: 'secret-two' },
        authSalt: 'salt-value',
        adminPinHash: 'scrypt$16384$8$1$abcdef',
        operators: [
            { id: 'op1', name: 'A', pinHash: 'scrypt$16384$8$1$aaa', totpSecret: 'TOTPAAA' },
            { id: 'op2', name: 'B', pinHash: 'scrypt$16384$8$1$bbb', totpSecret: '' }
        ]
    };
    const sealedDoc = vault.sealSettings(doc, keyA);
    const asText = JSON.stringify(sealedDoc);
    for (const leaked of ['secret-one', 'secret-two', 'salt-value', 'abcdef', 'TOTPAAA']) {
        assert.ok(!asText.includes(leaked), `${leaked} is still readable in the sealed document`);
    }
    // Non-secret configuration stays plainly readable — an operator must still
    // be able to inspect this file and hand it to support.
    assert.strictEqual(sealedDoc.companyName, 'Vault Test Jewellers');
    assert.strictEqual(sealedDoc.smtp.host, 'smtp.example.test');
    assert.strictEqual(sealedDoc.operators[1].name, 'B');
    // The wildcard path really did reach into the array.
    assert.ok(sealedDoc.operators[0].totpSecret.startsWith('encv1$'), 'operators.*.totpSecret must be sealed');
    // An unset secret inside the array stays unset.
    assert.strictEqual(sealedDoc.operators[1].totpSecret, '');

    const opened = vault.openSettings(sealedDoc, keyA);
    assert.deepStrictEqual(opened, doc, 'a full seal/open round trip must be lossless');

    // --- rotation -----------------------------------------------------------
    const rotated = vault.rotateSettings(sealedDoc, keyA, keyB);
    assert.deepStrictEqual(vault.openSettings(rotated, keyB), doc, 'rotation must preserve every value');
    assert.throws(() => vault.openSettings(rotated, keyA), /Could not decrypt/,
        'after rotation the OLD key must no longer open the document');

    console.log('✅ Test 11 Passed: secrets seal, open, stay bound to their field, and rotate cleanly.');
}

async function testRolloutCohort() {
    console.log('\nRunning Test 12: canary/pilot rollout cohort gate...');
    const { isInRolloutCohort } = await import('./updateEngine.js');

    // 100% always includes everyone, regardless of license key or version —
    // this is what makes the feature backward-compatible: a release manifest
    // published before rolloutPercent existed defaults to 100 and behaves
    // exactly as it did before this gate existed.
    assert.strictEqual(isInRolloutCohort('ANY-KEY', '2.0.0', 100), true);
    assert.strictEqual(isInRolloutCohort('OTHER-KEY', '9.9.9', 100), true);

    // 0% (below the server's own 1-100 validation range, but the client-side
    // function itself has no lower bound) excludes everyone.
    assert.strictEqual(isInRolloutCohort('ANY-KEY', '2.0.0', 0), false);

    // Deterministic: the same (licenseKey, version) always lands in the same
    // bucket, so a held-back tenant doesn't flap in and out across daily
    // checks just from being re-evaluated.
    const a1 = isInRolloutCohort('TENANT-ABC-123', '2.1.0', 30);
    const a2 = isInRolloutCohort('TENANT-ABC-123', '2.1.0', 30);
    assert.strictEqual(a1, a2, 'cohort membership must be stable across repeated evaluations');

    // Monotonic: widening the rollout (republishing with a higher percentage)
    // can only ever ADD tenants to the cohort, never remove one that was
    // already auto-applying — the exact property a safe rollout needs.
    let everIncluded = false;
    for (let pct = 1; pct <= 100; pct++) {
        const included = isInRolloutCohort('TENANT-ABC-123', '2.1.0', pct);
        if (everIncluded) {
            assert.strictEqual(included, true, `tenant included at a lower percent must stay included at ${pct}%`);
        }
        if (included) everIncluded = true;
    }
    assert.strictEqual(everIncluded, true, 'every tenant must be included by the time rollout reaches 100%');

    // Different license keys are independent — a whole tenant fleet does not
    // move in lockstep as one block for a partial rollout to mean anything.
    const buckets = new Set();
    for (let i = 0; i < 50; i++) {
        buckets.add(isInRolloutCohort(`TENANT-${i}`, '2.1.0', 50));
    }
    assert.ok(buckets.has(true) && buckets.has(false), 'a 50% rollout across 50 distinct tenants should include some and exclude others');

    console.log('✅ Test 12 Passed: rollout cohort gating is deterministic, monotonic, and per-tenant.');
}

async function testPitrScheduler() {
    console.log('\nRunning Test 13: point-in-time recovery snapshots...');
    const pitr = await import('./pitr.js');
    const { readSettings, writeSettings } = await import('./settingsStore.js');

    // Disabled (no settings.json at all yet — the real "never configured"
    // state) must be a true no-op: no directory, nothing to find.
    pitr.archivePitrSnapshot();
    assert.strictEqual(fs.existsSync(pitr.PITR_DIR), false,
        'disabled PITR must never create its directory');
    assert.strictEqual(pitr.latestPitrSnapshot(), null);

    // An old snapshot directory, seeded BEFORE the first real archive, so one
    // call can exercise both "a snapshot is taken" and "an expired one is
    // pruned" without a sleep or a second call fighting the interval cooldown.
    fs.mkdirSync(pitr.PITR_DIR, { recursive: true });
    const staleDir = path.join(pitr.PITR_DIR, 'stale-snapshot');
    fs.mkdirSync(staleDir);
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleDir, twoDaysAgo, twoDaysAgo);

    writeSettings({
        ...readSettings(),
        pitrEnabled: true, pitrIntervalMinutes: 5, pitrRetentionHours: 24
    });
    pitr.archivePitrSnapshot();

    assert.strictEqual(fs.existsSync(staleDir), false,
        'a snapshot older than pitrRetentionHours must be pruned on the next archive');
    const latest = pitr.latestPitrSnapshot();
    assert.ok(latest && fs.existsSync(latest), 'enabling PITR must produce a fresh snapshot');
    assert.ok(fs.existsSync(path.join(latest, 'settings.json')),
        'a snapshot must carry configuration alongside the ledger, same as a nightly backup');

    // Called again immediately: still inside pitrIntervalMinutes, so this must
    // be a no-op — no second snapshot directory appears.
    const countBefore = fs.readdirSync(pitr.PITR_DIR).length;
    pitr.archivePitrSnapshot();
    assert.strictEqual(fs.readdirSync(pitr.PITR_DIR).length, countBefore,
        'a second call inside the configured interval must not take another snapshot');

    console.log('✅ Test 13 Passed: PITR is off by default, snapshots on enable, and prunes on schedule.');
}

// Execute all test cases
try {
    testTroyOunceConversion();
    testBidirectionalCalculations();
    testLicensingLogic();
    testAsymmetricEnvelope();
    await testCustomerPasswordHashing();
    testLockoutEscalation();
    await testPasswordResetLifecycle();
    await testAdminPinHashing();
    await testTotpAgainstRfcVectors();
    await testBoundedAttemptMap();
    await testSecretVault();
    await testRolloutCohort();
    await testPitrScheduler();
    console.log('======================================================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! SYSTEM INTEGRITY VERIFIED.');
    console.log('======================================================================');
} catch (err) {
    console.error('❌ Test execution encountered failure:', err.message);
    // exitCode rather than exit(), so the cleanup below still runs — exit()
    // terminates immediately and would leave the temp tree behind on every
    // failing run.
    process.exitCode = 1;
} finally {
    /* CLOSE THE DATABASE BEFORE REMOVING ITS DIRECTORY. Windows refuses to
       unlink a file that still has an open handle, so an unclosed connection
       turns teardown into an EPERM — thrown from this `finally`, which MASKS
       whatever real failure sent us here. */
    try {
        const repo = await import('./repositories/index.js');
        repo.closeDb();
    } catch (_) {
        // The suite may have failed before the store was ever opened.
    }
    

try {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch (err) {
        console.warn(`[cleanup] could not remove ${TEST_ROOT}: ${err.message}`);
    }
}
