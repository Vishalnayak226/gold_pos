/**
 * ==========================================================================
 * Encrypted "Black Box" Engine Log
 * A dedicated, PII-scrubbed structured event stream — separate from the
 * tenant-pullable Level-1 telemetry.log — encrypted for export with its own
 * RSA-4096 keypair (independent of the Level-2 developer key in
 * cryptoHelper.js, so compromising one key never unlocks the other). Never
 * ships plaintext to tenants; exported only on request via
 * GET /api/diagnostics/blackbox-export and decrypted offline by the
 * platform owner using developer_blackbox_keys/analyze_blackbox.js.
 * ==========================================================================
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOGS_DIR, logError as dbLogError } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, 'keys');
const PUBLIC_KEY_FILE = path.join(KEYS_DIR, 'blackbox_public.pem');
const BLACKBOX_LOG_FILE = path.join(LOGS_DIR, 'blackbox.log');

// Defense-in-depth redaction list — belt-and-suspenders alongside only ever
// passing technical fields (method/path/status/duration/memory) into this
// logger in the first place. Matched case-insensitively against object keys.
const PII_KEYS = new Set([
    'customername', 'customerphone', 'phone', 'address', 'gstnumber', 'email',
    'reportemail', 'razorpaykeysecret', 'razorpaykeyid', 'pass', 'password',
    'licensekey', 'adminpin', 'upiid', 'referenceid'
]);

function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
        const clean = {};
        for (const [key, v] of Object.entries(value)) {
            clean[key] = PII_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : scrub(v);
        }
        return clean;
    }
    return value;
}

function ensureBlackBoxKeysExist() {
    try {
        if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });
        if (!fs.existsSync(PUBLIC_KEY_FILE)) {
            // Security audit L1: never mint a fresh throwaway keypair on a live
            // tenant machine — the private half would land in
            // developer_blackbox_keys/ right beside the data it protects. A
            // production install ships blackbox_public.pem already (see
            // release_pipeline.js); a missing key there means an incomplete
            // deploy, and the black-box export is the only thing that degrades.
            if (process.env.NODE_ENV === 'production') {
                dbLogError('Black-box public key (backend/keys/blackbox_public.pem) is missing in production. Refusing to auto-generate a new keypair on this machine — black-box export will fail until the shipped key is restored. See docs/SECURITY_AUDIT.md L1.');
                return;
            }

            console.log('[BlackBox] Generating dedicated black-box RSA-4096 keypair (separate from the Level-2 developer key)...');

            const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
                modulusLength: 4096,
                publicKeyEncoding: { type: 'spki', format: 'pem' },
                privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
            });

            fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, 'utf8');

            const devDir = path.join(__dirname, '../developer_blackbox_keys');
            if (!fs.existsSync(devDir)) fs.mkdirSync(devDir, { recursive: true });
            fs.writeFileSync(path.join(devDir, 'blackbox_private.pem'), privateKey, 'utf8');

            console.log(`[BlackBox] Public key embedded at: ${PUBLIC_KEY_FILE}`);
            console.log(`[BlackBox] PRIVATE KEY (KEEP SECURE, developer-only, never ship to tenants) saved to: ${path.join(devDir, 'blackbox_private.pem')}`);
        }
    } catch (err) {
        dbLogError('Failed to initialize black-box RSA keypair: ' + err.message, err.stack);
    }
}

ensureBlackBoxKeysExist();

/**
 * Appends one PII-scrubbed structured event to the black-box flight
 * recorder. Call sites should only ever pass technical fields — this
 * scrubs defensively, but is not a substitute for not logging PII in the
 * first place.
 */
export function logBlackBoxEvent(eventType, meta = {}) {
    try {
        const entry = JSON.stringify({
            timestamp: new Date().toISOString(),
            eventType,
            ...scrub(meta)
        }) + '\n';
        fs.appendFileSync(BLACKBOX_LOG_FILE, entry, 'utf8');
    } catch (err) {
        dbLogError('Failed to write black-box log entry: ' + err.message, err.stack);
    }
}

/**
 * Encrypts the black-box log with an asymmetric envelope: an ephemeral
 * AES-256-GCM key encrypts the log content, and that AES key is itself
 * encrypted with the black-box RSA-4096 public key. Only
 * developer_blackbox_keys/blackbox_private.pem (offline, developer-only)
 * can unwrap it.
 */
export function exportBlackBoxEnvelope() {
    const publicKeyPem = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
    const content = fs.existsSync(BLACKBOX_LOG_FILE) ? fs.readFileSync(BLACKBOX_LOG_FILE, 'utf8') : '';

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    let ciphertext = cipher.update(content, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    const encryptedAesKey = crypto.publicEncrypt({
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, aesKey).toString('base64');

    return {
        encryptedAesKey,
        iv: iv.toString('hex'),
        authTag,
        ciphertext
    };
}
