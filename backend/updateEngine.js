/**
 * ==========================================================================
 * Tiered Auto-Update Engine
 * ==========================================================================
 * Checks the central licensing server's signed release registry and applies
 * updates according to their channel (see CHANGELOG.md "Release channels"):
 *   - security  -> auto-applied (verified, backed up, rolled back on failure)
 *   - feature/patch -> surfaced as a reviewable banner; a human clicks
 *                      "Apply Update Now" (Settings -> License & Subscription)
 *
 * Hard guarantees, enforced structurally rather than just documented:
 *   1. A release is never trusted, downloaded, or applied unless its RSA
 *      signature verifies against the bundled release_public.pem. A
 *      compromised or spoofed licensing server cannot get arbitrary code
 *      auto-applied to a tenant.
 *   2. The downloaded package's SHA-256 must match the signed manifest
 *      before extraction even begins.
 *   3. backend/data/, backend/logs/, backend/backups/, backend/.env,
 *      backend/keys/, backend/extensions/*.extension.js, and
 *      frontend/js/extensions/ are NEVER touched by an apply — a patch can
 *      only ever replace application code, never a tenant's data or
 *      customizations. This is the technical guarantee behind "no data
 *      loss, ever" — not a promise, a code path that cannot reach those
 *      paths.
 *   4. Every apply snapshots the current code first. Any failure during
 *      download/verify/extract/copy triggers an automatic rollback to that
 *      snapshot — a tenant is never left mid-patch.
 * ==========================================================================
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import cron from 'node-cron';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readJSON, writeJSON, logError, logTelemetry, DATA_DIR } from './db.js';
import { createBackup } from './backupEngine.js';
import { raiseAlert } from './alerting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const RELEASE_PUBLIC_KEY_FILE = path.join(__dirname, 'keys', 'release_public.pem');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const ROLLBACK_DIR = path.join(__dirname, '_rollback');
const STAGING_DIR = path.join(__dirname, '_staging');

const LICENSING_SERVER_URL = process.env.LICENSING_SERVER_URL || 'http://127.0.0.1:6060';
const LOCAL_PACKAGE_JSON = path.join(__dirname, 'package.json');

// Paths (relative to project root) an apply must never overwrite. Checked
// against every file copied during extraction — see isProtectedPath().
const PROTECTED_PATHS = [
    'backend/data',
    'backend/logs',
    'backend/backups',
    'backend/.env',
    'backend/keys',
    'backend/_rollback',
    'backend/_staging',
    'frontend/js/extensions',
    'licensing_server' // a POS client's update package never touches the licensing server
];

function isNewerVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n) || 0);
    const pb = String(b).split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] || 0, vb = pb[i] || 0;
        if (va > vb) return true;
        if (va < vb) return false;
    }
    return false;
}

function getLocalVersion() {
    try {
        return JSON.parse(fs.readFileSync(LOCAL_PACKAGE_JSON, 'utf8')).version || '0.0.0';
    } catch (_) {
        return '0.0.0';
    }
}

/**
 * Verifies a release manifest's signature against the bundled release
 * public key. Returns the parsed manifest on success, or null (never
 * throws) if the key is missing, the signature is invalid, or the payload
 * doesn't parse — any of which means "do not trust this release."
 */
function verifyRelease(payloadStr, signature) {
    try {
        if (!fs.existsSync(RELEASE_PUBLIC_KEY_FILE)) {
            logError('updateEngine: release_public.pem is missing from backend/keys/ — cannot verify any release, refusing to apply anything.');
            return null;
        }
        const publicKey = fs.readFileSync(RELEASE_PUBLIC_KEY_FILE, 'utf8');
        const verifier = crypto.createVerify('sha256');
        verifier.update(payloadStr);
        const isValid = verifier.verify(publicKey, signature, 'base64');
        if (!isValid) {
            logError('updateEngine: release signature verification FAILED — refusing to trust this release. Possible spoofed/tampered licensing server response.');
            raiseAlert({
                code: 'RELEASE_SIGNATURE_INVALID',
                severity: 'critical',
                message: 'A release from the licensing server failed signature verification and was refused. Possible spoofed or tampered update-channel response.'
            });
            return null;
        }
        return JSON.parse(payloadStr);
    } catch (err) {
        logError('updateEngine: error verifying release signature: ' + err.message, err.stack);
        return null;
    }
}

/**
 * Fetches and verifies the latest release on a given channel (or all
 * channels if omitted). Returns the verified manifest object, or null if
 * none exists / verification fails / the server is unreachable.
 */
async function fetchVerifiedRelease(channel) {
    try {
        const qs = channel ? `?channel=${encodeURIComponent(channel)}` : '';
        const res = await fetch(`${LICENSING_SERVER_URL}/api/releases/latest${qs}`);
        if (res.status === 404) return null; // no release published on this channel yet
        if (!res.ok) {
            logError(`updateEngine: release registry returned status ${res.status}`);
            return null;
        }
        const data = await res.json();
        if (!data.payload || !data.signature) return null;
        return verifyRelease(data.payload, data.signature);
    } catch (err) {
        // Server unreachable — same posture as licenseChecker.js: never
        // block anything, just skip this check cycle.
        logError('updateEngine: could not reach licensing server for release check: ' + err.message);
        raiseAlert({
            code: 'CONTROL_PLANE_UNREACHABLE',
            severity: 'warning',
            message: 'Could not reach the licensing server for a release/update check: ' + err.message
        });
        return null;
    }
}

function isProtectedRelativePath(relPath) {
    const normalized = relPath.split(path.sep).join('/');
    return PROTECTED_PATHS.some(p => normalized === p || normalized.startsWith(p + '/'));
}

/**
 * True if a path relative to the root resolves OUTSIDE that root (a
 * "zip-slip" style escape, e.g. "../../../etc/passwd") or is itself
 * absolute. Extraction tools (Expand-Archive, unzip) already refuse to
 * write such entries to disk in the first place — verified experimentally
 * — so this should never actually trigger in practice. It's kept as an
 * independent, tool-agnostic backstop rather than relying solely on
 * whichever OS utility happens to be extracting the archive.
 */
function escapesRoot(relPath) {
    return relPath.startsWith('..') || path.isAbsolute(relPath);
}

/**
 * Recursively copies a directory, skipping any path that matches
 * PROTECTED_PATHS (compared relative to `rootForProtection`, which should
 * always be the project root regardless of which subtree is being copied —
 * this is what lets one function serve both the "snapshot for rollback"
 * and "apply staged files" steps with the exact same safety rule).
 */
function copyTreeExcludingProtected(src, dest, rootForProtection) {
    const relFromRoot = path.relative(rootForProtection, dest);
    if (relFromRoot && escapesRoot(relFromRoot)) {
        logError(`updateEngine: refusing to write outside the project root during apply/restore: ${dest}`);
        return;
    }
    if (relFromRoot && isProtectedRelativePath(relFromRoot)) {
        return; // never descend into or overwrite a protected path
    }
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
        if (['node_modules', '.git'].includes(path.basename(src))) return;
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
            copyTreeExcludingProtected(path.join(src, child), path.join(dest, child), rootForProtection);
        }
    } else {
        // Individual-file protection: a tenant's own *.extension.js drop-ins
        // inside backend/extensions/ are preserved even though the
        // extensions/ folder itself (the loader, README) is not protected.
        if (dest.endsWith('.extension.js')) return;
        const parent = path.dirname(dest);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

// Directories that never need to be part of a code rollback snapshot: pure
// data/log/binary state (already protected separately during apply/restore)
// or the update engine's own scratch space. Deliberately NOT the same list
// as PROTECTED_PATHS/isProtectedRelativePath — that check is about what an
// apply is allowed to overwrite in the LIVE tree, which is a different
// question from what the snapshot itself needs to contain. Conflating the
// two previously made snapshotForRollback() silently copy nothing at all,
// because its own destination (backend/_rollback/...) matched the
// live-tree protection rule meant for a completely different step.
const SNAPSHOT_SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', 'backups', 'keys', '_rollback', '_staging']);

/**
 * Plain recursive copy used only for building the pre-apply rollback
 * snapshot (live tree -> backend/_rollback/). Skips SNAPSHOT_SKIP_DIRS;
 * otherwise copies everything, since this is a straight backup of "the code
 * as it is right now," not a filtered write into the live tree.
 */
function snapshotTree(src, dest) {
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(path.basename(src))) return;
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
            snapshotTree(path.join(src, child), path.join(dest, child));
        }
    } else {
        const parent = path.dirname(dest);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

/**
 * Extracts a zip, failing loudly on ANY problem — including a malicious or
 * malformed entry (e.g. a path-traversal "zip-slip" entry like
 * "../../../evil.txt"). Verified experimentally: PowerShell's
 * Expand-Archive already refuses to write such an entry outside destDir
 * (good), but by default that rejection is a non-terminating warning —
 * the process still exits 0 and execSync would NOT throw, meaning
 * applyUpdate() would treat a silently-partial extraction as a full
 * success and apply an inconsistent, never-tested mix of old/new files to
 * every tenant. `$ErrorActionPreference = 'Stop'` (plus `-ErrorAction
 * Stop` on the cmdlet itself) turns that into a real thrown exception, so
 * the existing rollback path in applyUpdate() actually engages instead.
 */
function extractZip(zipPath, destDir) {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (process.platform === 'win32') {
        execSync(`powershell -Command "$ErrorActionPreference = 'Stop'; Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force -ErrorAction Stop"`);
    } else {
        // -q: quiet; a non-zero exit (including for skipped/refused
        // entries) makes execSync throw, same fail-loud guarantee as above.
        execSync(`unzip -q -o '${zipPath}' -d '${destDir}'`);
    }
}

function sha256OfFile(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function isRunningUnderPM2() {
    return Boolean(process.env.pm_id);
}

/**
 * Snapshots the current backend/ + frontend/ (minus data/logs/backups/
 * node_modules/keys) into backend/_rollback/, overwriting any prior
 * snapshot. This is the "undo the last patch" mechanism.
 */
function snapshotForRollback() {
    if (fs.existsSync(ROLLBACK_DIR)) fs.rmSync(ROLLBACK_DIR, { recursive: true, force: true });
    fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
    snapshotTree(path.join(ROOT_DIR, 'backend'), path.join(ROLLBACK_DIR, 'backend'));
    snapshotTree(path.join(ROOT_DIR, 'frontend'), path.join(ROLLBACK_DIR, 'frontend'));
}

function restoreFromRollback() {
    if (!fs.existsSync(ROLLBACK_DIR)) {
        logError('updateEngine: rollback requested but no snapshot exists — cannot auto-revert. Manual intervention required.');
        return false;
    }
    copyTreeExcludingProtected(path.join(ROLLBACK_DIR, 'backend'), path.join(ROOT_DIR, 'backend'), ROOT_DIR);
    copyTreeExcludingProtected(path.join(ROLLBACK_DIR, 'frontend'), path.join(ROOT_DIR, 'frontend'), ROOT_DIR);
    return true;
}

/**
 * Applies a verified release: backup data, snapshot code, download,
 * verify checksum, extract, swap in, update version, restart. Any failure
 * rolls back automatically and leaves the tenant on the last-known-good
 * version with nothing partially applied.
 */
export async function applyUpdate(release, { auto = false } = {}) {
    const label = `${release.version} (${release.channel})`;
    logTelemetry('UPDATE_APPLY_START', 0, label);

    // 1. Data safety net first, always — even though an apply structurally
    // never touches backend/data/, this guarantees a recent same-day
    // snapshot exists regardless.
    createBackup();

    // 2. Snapshot current code for rollback.
    try {
        snapshotForRollback();
    } catch (err) {
        logError(`updateEngine: failed to snapshot current code before applying ${label}, aborting (nothing changed): ${err.message}`, err.stack);
        return { success: false, error: 'Pre-update snapshot failed' };
    }

    let zipPath;
    try {
        // 3. Download.
        const res = await fetch(release.downloadUrl);
        if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        zipPath = path.join(STAGING_DIR, 'release.zip');
        if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
        fs.writeFileSync(zipPath, buf);

        // 4. Verify checksum BEFORE extracting anything.
        const actualSha256 = sha256OfFile(zipPath);
        if (actualSha256 !== release.sha256) {
            throw new Error(`SHA-256 mismatch — expected ${release.sha256}, got ${actualSha256}. Refusing to extract a corrupted/tampered package.`);
        }

        // 5. Extract to staging, then copy into place (protected paths skipped).
        const extractDir = path.join(STAGING_DIR, 'extracted');
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
        extractZip(zipPath, extractDir);

        if (fs.existsSync(path.join(extractDir, 'backend'))) {
            copyTreeExcludingProtected(path.join(extractDir, 'backend'), path.join(ROOT_DIR, 'backend'), ROOT_DIR);
        }
        if (fs.existsSync(path.join(extractDir, 'frontend'))) {
            copyTreeExcludingProtected(path.join(extractDir, 'frontend'), path.join(ROOT_DIR, 'frontend'), ROOT_DIR);
        }

        // 6. Record the applied version.
        const license = readJSON(LICENSE_FILE, {});
        license.currentVersion = release.version;
        license.pendingRelease = null;
        license.lastAppliedRelease = { version: release.version, channel: release.channel, appliedAt: Date.now(), auto };
        writeJSON(LICENSE_FILE, license);

        // Clean up staging.
        fs.rmSync(STAGING_DIR, { recursive: true, force: true });

        logTelemetry('UPDATE_APPLY_SUCCESS', 0, label);
        console.log(`[UpdateEngine] Applied ${label} successfully.`);

        // 7. Restart. Under PM2, exiting cleanly triggers PM2's own restart
        // of the now-updated code. Outside PM2 (e.g. local dev via
        // `node server.js`), forcibly exiting would just leave the tenant
        // down with nothing to bring it back — log clear manual
        // instructions instead.
        if (isRunningUnderPM2()) {
            console.log('[UpdateEngine] Running under PM2 — exiting for automatic restart onto the new version.');
            setTimeout(() => process.exit(0), 500);
        } else {
            console.log(`[UpdateEngine] Update applied. Restart required to run the new version — restart via Restart_Server.bat or 'node server.js'.`);
        }

        return { success: true, version: release.version };
    } catch (err) {
        logError(`updateEngine: apply of ${label} failed, rolling back: ${err.message}`, err.stack);
        const rolledBack = restoreFromRollback();
        try {
            if (fs.existsSync(STAGING_DIR)) fs.rmSync(STAGING_DIR, { recursive: true, force: true });
        } catch (_) {}
        logTelemetry('UPDATE_APPLY_FAILED', 0, `${label} — rolled back: ${rolledBack}`);
        raiseAlert({
            code: 'UPDATE_APPLY_FAILED',
            severity: 'critical',
            message: `Applying ${label} failed: ${err.message}. ${rolledBack ? 'Rolled back to the previous code successfully.' : 'ROLLBACK ALSO FAILED — manual intervention required.'}`
        });
        return { success: false, error: err.message, rolledBack };
    }
}

/**
 * Daily check: security-channel releases newer than the running version are
 * applied automatically. Any other newer release (feature/patch) is only
 * ever recorded as a pending, human-approved action — never applied here.
 * Never throws.
 */
export async function checkForUpdates() {
    try {
        const localVersion = getLocalVersion();

        const securityRelease = await fetchVerifiedRelease('security');
        if (securityRelease && isNewerVersion(securityRelease.version, localVersion)) {
            console.log(`[UpdateEngine] Verified security release ${securityRelease.version} found — auto-applying.`);
            await applyUpdate(securityRelease, { auto: true });
            return; // a restart is likely imminent under PM2; nothing more to do this cycle
        }

        const anyRelease = await fetchVerifiedRelease(null);
        if (anyRelease && isNewerVersion(anyRelease.version, localVersion)) {
            const license = readJSON(LICENSE_FILE, {});
            license.pendingRelease = {
                version: anyRelease.version,
                channel: anyRelease.channel,
                changelog: anyRelease.changelog,
                publishedAt: anyRelease.publishedAt
            };
            writeJSON(LICENSE_FILE, license);
            logTelemetry('UPDATE_PENDING_MANUAL', 0, `${anyRelease.version} (${anyRelease.channel})`);
        }
    } catch (err) {
        logError('updateEngine: daily update check failed: ' + err.message, err.stack);
    }
}

/**
 * Manually applies whatever release is currently recorded as pending
 * (feature/patch channel — security releases never need this, they already
 * auto-applied). Called from POST /api/admin/update/apply.
 */
export async function applyPendingUpdate() {
    const license = readJSON(LICENSE_FILE, {});
    if (!license.pendingRelease) {
        return { success: false, error: 'No pending update to apply.' };
    }
    // Re-fetch and re-verify fresh rather than trusting the cached pendingRelease
    // shape, so a stale/edited local license.json can never be used to spoof an apply.
    const release = await fetchVerifiedRelease(license.pendingRelease.channel);
    if (!release || release.version !== license.pendingRelease.version) {
        return { success: false, error: 'Could not re-verify the pending release with the licensing server. Try checking for updates again.' };
    }
    return applyUpdate(release, { auto: false });
}

/**
 * Daily 2:00 AM check — deliberately off-hours, same reasoning as the
 * pricing/backup schedulers, so an auto-applied security patch's brief
 * restart lands when the store is very unlikely to be mid-sale.
 */
export function initUpdateScheduler() {
    cron.schedule('0 2 * * *', () => {
        console.log('[Scheduler] Executing daily release-registry check...');
        checkForUpdates();
    });
    console.log('[Scheduler] Daily 2:00 AM Update Check Scheduler initialized.');
}
