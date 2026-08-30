/**
 * ==========================================================================
 * Automated Rolling Backup Engine
 * Creates daily database snapshots and maintains a strict rolling 7-day window.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { logError, logTelemetry, DATA_DIR } from './db.js';
import { DB_FILE, checkpointAndCopy } from './repositories/connection.js';
import { raiseAlert } from './alerting.js';
import { readSettings } from './settingsStore.js';
import { resolveKey } from './secretVault.js';
import { encryptFile, ENCRYPTED_EXTENSION } from './backupCrypto.js';

const BACKEND_DIR = path.dirname(fileURLToPath(import.meta.url));

// Same override convention as db.js's DATA_DIR/LOGS_DIR — test/recovery
// tooling can point this at an isolated directory. Production leaves it unset.
const BACKUPS_DIR = path.resolve(
    process.env.GOLD_POS_BACKUPS_DIR || process.env.GOLDPOS_BACKUPS_DIR || path.join(process.cwd(), 'backups')
);

// Ensure backups directory exists
if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

/**
 * Creates a database snapshot copy for the current day.
 */
export function createBackup() {
    const startTime = Date.now();
    try {
        const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const targetBackupDir = path.join(BACKUPS_DIR, `backup_${todayStr}`);

        if (!fs.existsSync(targetBackupDir)) {
            fs.mkdirSync(targetBackupDir, { recursive: true });
        }

        // List files in data directory to back up
        const files = fs.readdirSync(DATA_DIR);
        files.forEach(f => {
            if (f.endsWith('.json')) {
                const srcPath = path.join(DATA_DIR, f);
                const destPath = path.join(targetBackupDir, f);
                fs.copyFileSync(srcPath, destPath);
            }
        });

        // The ledger itself: a plain copy of a WAL-mode database can miss
        // recently-committed transactions still sitting in the -wal file, so
        // this goes through the same checkpoint-then-copy path the importer's
        // safety net uses (connection.js:checkpointAndCopy), not fs.copyFileSync.
        if (fs.existsSync(DB_FILE)) {
            checkpointAndCopy(path.join(targetBackupDir, path.basename(DB_FILE)));
        }

        // WHOLE-ARCHIVE ENCRYPTION. Everything copied above is plaintext on disk
        // right now — the SQLite ledger and every JSON document, not just the
        // credentials sealed inside settings.json (secretVault.js). Encrypt the
        // whole snapshot with that same vault key before it, or its off-site
        // copy shipped below, ever sits unprotected. A failure here throws into
        // this function's own catch, same as any other backup failure.
        const { key: archiveKey } = resolveKey(DATA_DIR);
        for (const name of fs.readdirSync(targetBackupDir)) {
            const plainPath = path.join(targetBackupDir, name);
            if (!fs.statSync(plainPath).isFile() || name.endsWith(ENCRYPTED_EXTENSION)) continue;
            encryptFile(plainPath, plainPath + ENCRYPTED_EXTENSION, archiveKey, name);
            fs.rmSync(plainPath);
        }

        logTelemetry('BACKUP_CREATE_SUCCESS', Date.now() - startTime, `Dir: backup_${todayStr}`);
        console.log(`[Backup] Daily database snapshot created: backup_${todayStr}`);

        // Prune backups older than 7 days
        pruneOldBackups();

        // A file that copied is not proof it can restore a shop (WAL still
        // holding committed rows, a pre-migration snapshot, secrets sealed
        // with a key nobody has any more — see verifyBackup.js's header).
        // Reuses the same tool `npm run backup:verify` and the monthly drill
        // use, rather than re-implementing the checks here.
        verifyLatestBackupAsync();

        const offsite = shipOffsite(targetBackupDir);

        return { success: true, folder: `backup_${todayStr}`, offsite };
    } catch (err) {
        logError('Daily backup execution failed: ' + err.message, err.stack);
        raiseAlert({
            code: 'BACKUP_CREATE_FAILED',
            severity: 'critical',
            message: 'The nightly database backup failed: ' + err.message
        });
        return { success: false, error: err.message };
    }
}

/** Hashes one copied file for source/destination verification. */
function fileSha256(filepath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filepath));
    return hash.digest('hex');
}

/**
 * Copies the completed nightly snapshot to a mounted/synchronised destination
 * and verifies every copied file byte-for-byte by SHA-256.  Transport (SMB,
 * rclone, encrypted disk, NAS) is an operator concern; this process only sees
 * a filesystem path and therefore stores no cloud credential.
 */
export function shipOffsite(localBackupDir) {
    const settings = readSettings();
    if (settings.offsiteBackupEnabled !== true) return { enabled: false };

    const configured = process.env.GOLD_POS_OFFSITE_BACKUP_DIR || settings.offsiteBackupPath;
    let staging = null;
    try {
        if (!configured || !String(configured).trim()) throw new Error('Off-site backup is enabled but no destination path is configured.');
        const destinationRoot = path.resolve(String(configured).trim());
        const localRoot = path.resolve(BACKUPS_DIR);
        const dataRoot = path.resolve(DATA_DIR);
        const relativeToLocal = path.relative(localRoot, destinationRoot);
        const relativeToData = path.relative(dataRoot, destinationRoot);
        if (relativeToLocal === '' || (!relativeToLocal.startsWith('..') && !path.isAbsolute(relativeToLocal))) {
            throw new Error('Off-site destination must not be inside the local backup directory.');
        }
        if (relativeToData === '' || (!relativeToData.startsWith('..') && !path.isAbsolute(relativeToData))) {
            throw new Error('Off-site destination must not be inside the live data directory.');
        }

        fs.mkdirSync(destinationRoot, { recursive: true });
        const folder = path.basename(localBackupDir);
        const target = path.join(destinationRoot, folder);
        staging = path.join(destinationRoot, `.${folder}.${process.pid}.${Date.now()}.tmp`);
        fs.mkdirSync(staging, { recursive: true });
        const manifest = [];
        for (const name of fs.readdirSync(localBackupDir)) {
            const source = path.join(localBackupDir, name);
            if (!fs.statSync(source).isFile()) continue;
            const copied = path.join(staging, name);
            fs.copyFileSync(source, copied);
            const sourceHash = fileSha256(source);
            const copiedHash = fileSha256(copied);
            if (sourceHash !== copiedHash) throw new Error(`Hash verification failed for ${name}.`);
            manifest.push({ name, bytes: fs.statSync(copied).size, sha256: copiedHash });
        }
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
            createdAt: new Date().toISOString(), sourceFolder: folder, files: manifest
        }, null, 2));

        // Publish only after every file and hash is complete. A repeat run for
        // the same date keeps the previous good directory until the verified
        // staging directory is ready, so a copy failure can never leave an old
        // manifest beside partially refreshed data.
        let previous = null;
        if (fs.existsSync(target)) {
            previous = path.join(destinationRoot, `.${folder}.${process.pid}.${Date.now()}.previous`);
            fs.renameSync(target, previous);
        }
        try {
            fs.renameSync(staging, target);
            staging = null;
        } catch (promotionError) {
            if (previous && fs.existsSync(previous) && !fs.existsSync(target)) {
                fs.renameSync(previous, target);
                previous = null;
            }
            throw promotionError;
        }
        if (previous) fs.rmSync(previous, { recursive: true, force: true });

        pruneOffsite(destinationRoot, Number(settings.offsiteBackupRetentionDays) || 30);
        logTelemetry('BACKUP_OFFSITE_SUCCESS', 0, `Dir: ${target}`);
        return { enabled: true, success: true, destination: target, verifiedFiles: manifest.length };
    } catch (err) {
        if (staging && fs.existsSync(staging)) {
            try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        }
        logError('Off-site backup failed: ' + err.message, err.stack);
        raiseAlert({
            code: 'BACKUP_OFFSITE_FAILED', severity: 'critical',
            message: 'The local backup succeeded but its off-site copy failed: ' + err.message
        });
        return { enabled: true, success: false, error: err.message };
    }
}

function pruneOffsite(destinationRoot, retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const name of fs.readdirSync(destinationRoot)) {
        if (!/^backup_\d{4}-\d{2}-\d{2}$/.test(name)) continue;
        const candidate = path.join(destinationRoot, name);
        const stat = fs.statSync(candidate);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) fs.rmSync(candidate, { recursive: true, force: true });
    }
}

/** Fire-and-forget: does not block the backup job on the extra restore+check work. */
function verifyLatestBackupAsync() {
    // No --quiet: on failure the alert email should carry the PASS/FAIL
    // checklist, not just an exit code.
    const child = spawn(process.execPath, ['verifyBackup.js'], { cwd: BACKEND_DIR });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (err) => {
        logError('Could not launch post-backup restore verification: ' + err.message);
    });
    child.on('exit', (code) => {
        if (code !== 0) {
            raiseAlert({
                code: 'BACKUP_VERIFY_FAILED',
                severity: 'critical',
                message: `Tonight's backup was created but failed restore verification (exit code ${code}). It may not be usable to recover the shop.`,
                details: { report: output.slice(0, 3000) }
            });
        } else {
            logTelemetry('BACKUP_VERIFY_SUCCESS', 0, 'Post-backup restore verification passed.');
        }
    });
}

/**
 * Sweeps the backups folder and deletes any snapshots older than 7 days.
 */
function pruneOldBackups() {
    try {
        const folders = fs.readdirSync(BACKUPS_DIR);
        const now = Date.now();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

        folders.forEach(folder => {
            if (folder.startsWith('backup_')) {
                const folderPath = path.join(BACKUPS_DIR, folder);
                const stats = fs.statSync(folderPath);

                // Check directory creation/modification age
                if (now - stats.mtimeMs > sevenDaysMs) {
                    // Recursively remove directory
                    fs.rmSync(folderPath, { recursive: true, force: true });
                    logTelemetry('BACKUP_PRUNE_SUCCESS', 0, `Pruned old backup: ${folder}`);
                    console.log(`[Backup] Pruned expired backup folder: ${folder}`);
                }
            }
        });
    } catch (err) {
        logError('Backup pruning failed: ' + err.message, err.stack);
    }
}

/**
 * Initializes the Backup Scheduler
 * Cron Pattern: '0 1 * * *' executes at 1:00 AM every night.
 */
export function initBackupScheduler() {
    cron.schedule('0 1 * * *', () => {
        console.log('[Scheduler] Executing daily rolling database backup...');
        createBackup();
    });
    console.log('[Scheduler] Daily 1:00 AM Rolling Backup Scheduler initialized.');
}
