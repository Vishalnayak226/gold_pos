#!/usr/bin/env node
/**
 * ============================================================================
 *  SECRET-VAULT KEY ROTATION
 * ============================================================================
 *
 *   node rotateSecretKey.js --generate
 *       Print a fresh 32-byte key as hex and exit. Changes nothing.
 *
 *   node rotateSecretKey.js --new-key <64-hex>
 *   node rotateSecretKey.js --generate-new
 *       Re-encrypt every credential in settings.json from the CURRENT key to a
 *       new one. Prints the new key, which you must put in the environment
 *       before the next boot.
 *
 *   --dry-run   rehearse without writing
 *   --data-dir  operate on a directory other than the resolved DATA_DIR
 *
 * WHY THIS IS A SCRIPT AND NOT A ROUTE.
 *
 * Rotation needs the old key and the new one at the same moment, and it has to
 * be done while the server is stopped — otherwise a running process holds the
 * old key in memory and will write a value back under it, leaving a document
 * encrypted under two keys at once. There is no safe way to expose that as a
 * button, so it is deliberately an operator task with a runbook
 * (docs/RUNBOOKS.md — "Rotating the secret-vault key").
 *
 * SAFETY: the current settings.json is copied to a timestamped backup beside
 * itself before anything is written, and the rotated document is verified to
 * open cleanly under the new key BEFORE it replaces the original. A rotation
 * that cannot be read back is abandoned with the original untouched.
 */

import fs from 'fs';
import path from 'path';
import {
    resolveKey, resetKeyCache, rotateSettings, openSettings, generateKeyHex
} from './secretVault.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
};

function fail(message) {
    console.error(`\n  ERROR: ${message}\n`);
    process.exit(1);
}

/* --generate is a pure convenience: it lets the runbook say "run this" instead
   of asking an operator to compose a crypto one-liner correctly under pressure. */
if (has('--generate')) {
    console.log(generateKeyHex());
    process.exit(0);
}

const dataDir = valueOf('--data-dir')
    || process.env.GOLD_POS_DATA_DIR
    || path.join(import.meta.dirname, 'data');

const settingsFile = path.join(dataDir, 'settings.json');
if (!fs.existsSync(settingsFile)) fail(`No settings.json at ${settingsFile}`);

let newKeyHex = valueOf('--new-key');
if (has('--generate-new')) {
    if (newKeyHex) fail('Pass either --new-key or --generate-new, not both.');
    newKeyHex = generateKeyHex();
}
if (!newKeyHex) {
    fail('Pass --new-key <64-hex> or --generate-new. Use --generate to mint a key without rotating.');
}
if (!/^[0-9a-fA-F]{64}$/.test(newKeyHex)) {
    fail('The new key must be exactly 64 hexadecimal characters (32 bytes).');
}

const dryRun = has('--dry-run');

/* The CURRENT key, resolved exactly as the server would: GOLD_POS_SECRET_KEY if
   set, otherwise the development keyfile. Rotating away from a dev keyfile onto
   a real environment key is the normal first rotation, so both must work. */
resetKeyCache();
let oldKey;
let oldSource;
try {
    ({ key: oldKey, source: oldSource } = resolveKey(dataDir));
} catch (error) {
    fail(`Could not resolve the CURRENT key: ${error.message}`);
}

const before = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

let rotated;
try {
    rotated = rotateSettings(before, oldKey, Buffer.from(newKeyHex, 'hex'));
} catch (error) {
    fail(
        `Could not re-encrypt: ${error.message}\n` +
        '  Nothing was written. The current key is probably not the one this file was sealed with.'
    );
}

/* Verify before replacing, not after. A rotated document that cannot be opened
   under the new key is a locked-out tenant, and the moment to find that out is
   while the original is still on disk. */
try {
    const check = openSettings(rotated, Buffer.from(newKeyHex, 'hex'));
    const original = openSettings(before, oldKey);
    if (JSON.stringify(check) !== JSON.stringify(original)) {
        fail('The rotated document does not match the original once opened. Nothing was written.');
    }
} catch (error) {
    fail(`The rotated document could not be read back under the new key: ${error.message}\n  Nothing was written.`);
}

console.log('\n  Secret-vault key rotation');
console.log('  ' + '-'.repeat(60));
console.log(`  Data directory : ${dataDir}`);
console.log(`  Current key    : resolved from ${oldSource === 'env' ? 'GOLD_POS_SECRET_KEY' : 'the development keyfile'}`);
console.log(`  Secrets re-keyed: ${countSealed(rotated)}`);

if (dryRun) {
    console.log('\n  DRY RUN — verified that every secret re-encrypts and reads back. Nothing written.\n');
    process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(dataDir, `settings.json.pre-rotation-${stamp}`);
fs.copyFileSync(settingsFile, backup);
fs.writeFileSync(settingsFile, JSON.stringify(rotated, null, 2));

console.log(`  Backup written : ${backup}`);
console.log('\n  NEW KEY (set this before the next boot — it is not stored anywhere):\n');
console.log(`      GOLD_POS_SECRET_KEY=${newKeyHex}\n`);
console.log('  The server will NOT start in production until that value is in its environment.');
console.log('  Once the new boot is confirmed healthy, delete the backup above — it is still');
console.log('  readable with the OLD key.\n');

function countSealed(doc) {
    return (JSON.stringify(doc).match(/encv1\$/g) || []).length;
}
