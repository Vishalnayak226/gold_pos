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
import { logError, logTelemetry, DATA_DIR } from './db.js';
import { DB_FILE, checkpointAndCopy } from './repositories/connection.js';
import { raiseAlert } from './alerting.js';

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

        return { success: true, folder: `backup_${todayStr}` };
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
