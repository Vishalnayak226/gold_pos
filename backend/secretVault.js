/**
 * ============================================================================
 *  SECRET VAULT — encryption at rest for the credentials inside settings.json
 * ============================================================================
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR.
 *
 * `redactSettings()` already stops a credential reaching the browser or a
 * support export. This closes the other half of that roadmap line: until now
 * the Razorpay secret, the SMTP password, the tenant salt, every operator's
 * PIN hash and every TOTP secret sat in `backend/data/settings.json` as
 * plaintext, so anyone who obtained that one file — a stolen counter PC, a
 * mis-scoped backup, a support bundle assembled by hand — held live keys.
 *
 * This does NOT defend against an attacker who already runs code as the
 * server, because the server must be able to decrypt in order to work. It
 * defends against **theft of the data directory**, which is the realistic loss
 * for a shop counter PC and the one a file-level control can actually answer.
 *
 * THAT IS WHY THE KEY MUST NOT LIVE IN THE DATA DIRECTORY IN PRODUCTION.
 * A key stored beside the ciphertext it protects turns the whole exercise into
 * obfuscation: whoever took the directory took both halves. So:
 *
 *   - `GOLD_POS_SECRET_KEY` (64 hex characters = 32 bytes) is the real source,
 *     and under NODE_ENV=production it is the ONLY accepted source.
 *   - Outside production a keyfile at `<DATA_DIR>/.secret.key` is created on
 *     demand so the dev loop and the test suites need no ceremony. It is
 *     written 0600 and says loudly in the log that it is not a production
 *     control.
 *
 * FORMAT: `encv1$<iv_b64>$<tag_b64>$<ciphertext_b64>`
 *
 * Modelled on the existing `scrypt$N$r$p$<hex>` convention so a human reading a
 * settings file can tell at a glance what a field holds. Base64 never produces
 * `$`, so splitting on it is unambiguous.
 *
 * AES-256-GCM, a fresh 12-byte IV per value, and **the field's own dotted path
 * as additional authenticated data**. That last part matters: without it a
 * ciphertext could be cut from `smtp.pass` and pasted over
 * `razorpayWebhookSecret`, and the server would decrypt it happily. Binding
 * each value to its location makes that swap fail authentication instead.
 *
 * MIGRATION IS LAZY AND BACKWARD-COMPATIBLE (CLAUDE.md §1). `open()` returns
 * anything not in `encv1$` form untouched, so a tenant upgrading with a
 * plaintext settings.json keeps working and is sealed on the next write. There
 * is no migration step to run and no flag day.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { mapSecretValues } from './defaultSettings.js';

const PREFIX = 'encv1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEYFILE_NAME = '.secret.key';

/* Resolved on first use rather than at import, so a suite can point
   GOLD_POS_DATA_DIR wherever it likes before anything touches the disk. */
let cachedKey = null;
let cachedKeySource = null;

/** Forget the memoised key. Used by the rotation tool and by the suites. */
export function resetKeyCache() {
    cachedKey = null;
    cachedKeySource = null;
}

function parseHexKey(hex, source) {
    const trimmed = String(hex).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        throw new Error(
            `${source} must be exactly 64 hexadecimal characters (32 bytes). ` +
            'Generate one with:  node backend/rotateSecretKey.js --generate'
        );
    }
    return Buffer.from(trimmed, 'hex');
}

/**
 * The 32-byte key, and where it came from.
 *
 * `dataDir` is passed in rather than imported so this module has no path to
 * db.js — which keeps it importable from a suite without dragging the whole
 * data layer along (CLAUDE.md §8).
 */
export function resolveKey(dataDir, { env = process.env, log = console.warn } = {}) {
    if (cachedKey) return { key: cachedKey, source: cachedKeySource };

    if (env.GOLD_POS_SECRET_KEY) {
        cachedKey = parseHexKey(env.GOLD_POS_SECRET_KEY, 'GOLD_POS_SECRET_KEY');
        cachedKeySource = 'env';
        return { key: cachedKey, source: cachedKeySource };
    }

    if (env.NODE_ENV === 'production') {
        throw new Error(
            'GOLD_POS_SECRET_KEY is not set. Production refuses to fall back to a keyfile inside the ' +
            'data directory, because a key stored beside the data it protects defends against nothing. ' +
            'See docs/RUNBOOKS.md - "Rotating the secret-vault key".'
        );
    }

    const keyfile = path.join(dataDir, KEYFILE_NAME);
    if (fs.existsSync(keyfile)) {
        cachedKey = parseHexKey(fs.readFileSync(keyfile, 'utf8'), keyfile);
        cachedKeySource = 'keyfile';
        return { key: cachedKey, source: cachedKeySource };
    }

    const generated = crypto.randomBytes(KEY_BYTES).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyfile, generated, { mode: 0o600 });
    try { fs.chmodSync(keyfile, 0o600); } catch { /* best effort; Windows ACLs differ */ }
    log(
        `[secretVault] No GOLD_POS_SECRET_KEY set - generated a development keyfile at ${keyfile}. ` +
        'This is NOT a production control: it sits in the directory it protects. Production requires the env var.'
    );
    cachedKey = Buffer.from(generated, 'hex');
    cachedKeySource = 'keyfile';
    return { key: cachedKey, source: cachedKeySource };
}

/** True if `value` is already vault ciphertext. */
export function isSealed(value) {
    return typeof value === 'string' && value.startsWith(`${PREFIX}$`);
}

/**
 * Encrypt one value, binding it to `aad` (its dotted path in the document).
 *
 * An empty value is returned untouched: an unset credential must stay
 * distinguishable from a set one, and `redactSettings()` relies on exactly
 * that distinction to render "not configured yet".
 */
export function seal(value, aad, key) {
    const plain = String(value ?? '');
    if (plain.length === 0) return plain;
    if (isSealed(plain)) return plain;

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [PREFIX, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('$');
}

/**
 * Decrypt one value. Anything not in `encv1$` form is returned as-is, which is
 * what makes the upgrade path lazy rather than a flag day.
 *
 * A value that IS in vault form but fails to decrypt throws rather than
 * degrading to the ciphertext: silently handing the Razorpay client a string
 * beginning `encv1$` would fail later, further away, and much less clearly.
 */
export function open(value, aad, key) {
    if (!isSealed(value)) return value;
    const parts = String(value).split('$');
    const [, ivB64, tagB64, dataB64] = parts;
    if (parts.length !== 4 || !ivB64 || !tagB64 || dataB64 === undefined) {
        throw new Error(`Malformed vault value at "${aad}".`);
    }
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(dataB64, 'base64')),
            decipher.final()
        ]).toString('utf8');
    } catch {
        throw new Error(
            `Could not decrypt the secret at "${aad}". Either GOLD_POS_SECRET_KEY is not the key this ` +
            'value was written with, or the value was moved here from another field. ' +
            'See docs/RUNBOOKS.md - "Recovering from a lost or wrong vault key".'
        );
    }
}

/** Every secret in `settings` encrypted. Already-sealed values are left alone. */
export function sealSettings(settings, key) {
    return mapSecretValues(settings, (value, dotted) => seal(value, dotted, key));
}

/** Every secret in `settings` decrypted. Plaintext values pass through. */
export function openSettings(settings, key) {
    return mapSecretValues(settings, (value, dotted) => open(value, dotted, key));
}

/**
 * Re-encrypt every secret from `oldKey` to `newKey`.
 *
 * Deliberately a pure function over the document: the rotation script does the
 * reading, backing up and writing, so this half is trivially testable and has
 * no way to lose a file.
 */
export function rotateSettings(settings, oldKey, newKey) {
    const opened = openSettings(settings, oldKey);
    return mapSecretValues(opened, (value, dotted) => seal(value, dotted, newKey));
}

/** A fresh key, hex-encoded, for the rotation runbook. */
export function generateKeyHex() {
    return crypto.randomBytes(KEY_BYTES).toString('hex');
}
