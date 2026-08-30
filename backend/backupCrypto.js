/**
 * ============================================================================
 *  BACKUP ARCHIVE CRYPTO — encryption at rest for a whole backup snapshot
 * ============================================================================
 *
 * `secretVault.js` already seals the credentials INSIDE settings.json. That
 * left the rest of a nightly snapshot — the checkpointed SQLite ledger, and
 * every other JSON document copied beside it — sitting on disk (and on
 * whatever off-site destination `backupEngine.js#shipOffsite` copies it to)
 * as plaintext. A stolen backup folder or a misconfigured off-site share
 * handed over the whole ledger, not just the Razorpay key.
 *
 * This closes that gap by encrypting each FILE in a snapshot whole, reusing
 * the same vault key infrastructure (`secretVault.resolveKey`) rather than
 * inventing a second key system — production still requires
 * `GOLD_POS_SECRET_KEY`; dev still falls back to the `.secret.key` file.
 *
 * FORMAT is binary, not the `encv1$` base64 text format secretVault uses for
 * short credential strings — that would waste ~33% on a multi-MB SQLite file
 * for no benefit. Layout: 5-byte magic `GPBK1` + 12-byte IV + 16-byte GCM
 * auth tag + ciphertext, written directly as a Buffer.
 *
 * AES-256-GCM, a fresh IV per file, and the file's own basename (e.g.
 * `goldpos.db`) as additional authenticated data — the same binding
 * `secretVault.js` uses a dotted settings path for, so a ciphertext lifted
 * from one backup file and pasted over another fails authentication instead
 * of decrypting.
 * ==========================================================================
 */

import crypto from 'crypto';
import fs from 'fs';

const MAGIC = Buffer.from('GPBK1', 'ascii');
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The suffix an encrypted backup file carries on top of its original name. */
export const ENCRYPTED_EXTENSION = '.enc';

/** Encrypts `srcPath` to `destPath`, binding the ciphertext to `aad`. */
export function encryptFile(srcPath, destPath, key, aad) {
    const plaintext = fs.readFileSync(srcPath);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(destPath, Buffer.concat([MAGIC, iv, tag, ciphertext]));
}

/**
 * Decrypts `srcPath` (written by `encryptFile`) to `destPath`.
 *
 * Throws rather than writing garbage on a bad key or a tampered/truncated
 * file — same "fail loud, not quiet" posture as `secretVault.open()`.
 */
export function decryptFile(srcPath, destPath, key, aad) {
    const raw = fs.readFileSync(srcPath);
    const headerBytes = MAGIC.length + IV_BYTES + TAG_BYTES;
    if (raw.length < headerBytes || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error(`"${srcPath}" is not a recognised encrypted backup file.`);
    }
    let offset = MAGIC.length;
    const iv = raw.subarray(offset, offset + IV_BYTES); offset += IV_BYTES;
    const tag = raw.subarray(offset, offset + TAG_BYTES); offset += TAG_BYTES;
    const ciphertext = raw.subarray(offset);
    try {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        fs.writeFileSync(destPath, plaintext);
    } catch {
        throw new Error(
            `Could not decrypt "${srcPath}". Either GOLD_POS_SECRET_KEY is not the key this backup was ` +
            'sealed with, or the file was moved/renamed after encryption. ' +
            'See docs/RUNBOOKS.md - "Recovering from a lost or wrong vault key".'
        );
    }
}
