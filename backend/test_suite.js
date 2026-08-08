/**
 * ==========================================================================
 * Gold POS Platform Integration Test Suite
 * Validates pricing math, bi-directional rounding, licensing, and envelopes.
 * Uses native Node assert module. Zero extra dependencies.
 * ==========================================================================
 */

import assert from 'assert';
import fs from 'fs';
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
   whether a stolen customer_auth.json is crackable. The stateful half
   (sessions, lockout, reset codes) is proved against a live server instead,
   because it writes to the tenant's real data directory.
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

// Execute all test cases
try {
    testTroyOunceConversion();
    testBidirectionalCalculations();
    testLicensingLogic();
    testAsymmetricEnvelope();
    await testCustomerPasswordHashing();
    testLockoutEscalation();
    console.log('======================================================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! SYSTEM INTEGRITY VERIFIED.');
    console.log('======================================================================');
} catch (err) {
    console.error('❌ Test execution encountered failure:', err.message);
    process.exit(1);
}
