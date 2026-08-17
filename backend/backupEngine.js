/**
 * ==========================================================================
 * Automated Rolling Backup Engine
 * Creates daily database snapshots and maintains a strict rolling 7-day window.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { logError, logTelemetry, DATA_DIR } from './db.js';
import { DB_FILE, checkpointAndCopy } from './repositories/connection.js';

const BACKUPS_DIR = path.join(process.cwd(), 'backups');

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

        return { success: true, folder: `backup_${todayStr}` };
    } catch (err) {
        logError('Daily backup execution failed: ' + err.message, err.stack);
        return { success: false, error: err.message };
    }
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
