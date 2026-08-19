/**
 * ============================================================================
 *  SETTINGS STORE — the one door in and out of settings.json
 * ============================================================================
 *
 * WHY THIS EXISTS.
 *
 * `settings.json` was read in about thirty places across eight files, each one
 * calling `readJSON(path.join(DATA_DIR, 'settings.json'), {})` directly. That
 * was fine while the document was plaintext. It stopped being fine the moment
 * the credentials in it became ciphertext: a single reader that skipped
 * decryption would hand the Razorpay client a string starting `encv1$`, and a
 * single writer that skipped encryption would quietly put a live secret back
 * on disk in the clear, undoing the control for that field forever.
 *
 * So this is the choke point CLAUDE.md §1 asks for — created rather than
 * found, because none existed. Every caller goes through `readSettings()` and
 * `writeSettings()`, and `test_suite.js` asserts that no file outside this one
 * reaches settings.json with a raw `readJSON`/`writeJSON` again.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * It does not merge defaults, validate, or migrate. `migrateSettings()` in
 * db.js still owns the additive-merge path and `validateSettingsPatch()` still
 * owns type-checking; adding a second place that shapes this document is the
 * "parallel third way" §1 forbids. This only seals and opens.
 *
 * db.js is the one legitimate exception. `migrateSettings()` merges the
 * template over a tenant's document and writes it straight back; it never
 * reads or sets a credential (no credential may sit in DEFAULT_SETTINGS — §0),
 * so it round-trips ciphertext untouched, and keeping it on raw readJSON
 * avoids an import cycle between db.js and this module.
 */

import path from 'path';
import { readJSON, writeJSON, DATA_DIR } from './db.js';
import { resolveKey, sealSettings, openSettings } from './secretVault.js';

/** Absolute path of the tenant's settings document. */
export function settingsPath(dataDir = DATA_DIR) {
    return path.join(dataDir, 'settings.json');
}

/**
 * The tenant's settings, with every credential decrypted and ready to use.
 *
 * A plaintext document from before the vault existed reads back unchanged —
 * `open()` passes non-vault values straight through — so an upgrading tenant
 * needs no migration step.
 */
export function readSettings(dataDir = DATA_DIR) {
    const raw = readJSON(settingsPath(dataDir), {});
    const { key } = resolveKey(dataDir);
    return openSettings(raw, key);
}

/**
 * Persist settings, encrypting every credential on the way to disk.
 *
 * Returns whatever `writeJSON` returns, so the existing
 * `if (!writeSettings(...)) return res.status(500)` call sites keep working
 * exactly as they did.
 */
export function writeSettings(settings, dataDir = DATA_DIR) {
    const { key } = resolveKey(dataDir);
    return writeJSON(settingsPath(dataDir), sealSettings(settings, key));
}

/**
 * The raw on-disk document, credentials still sealed.
 *
 * Only two things legitimately want this: the rotation tool, which must read
 * ciphertext under the old key and write it under the new one, and any check
 * that wants to prove a secret really is encrypted at rest. Ordinary code
 * wants `readSettings()`.
 */
export function readSealedSettings(dataDir = DATA_DIR) {
    return readJSON(settingsPath(dataDir), {});
}
