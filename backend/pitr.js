/**
 * ==========================================================================
 * Point-in-time recovery: frequent local snapshots.
 *
 * PRODUCTION_READINESS_ROADMAP.md names two viable approaches to closing the
 * RPO gap a once-nightly backup leaves — WAL archiving, or much more frequent
 * snapshots — and this picks the second: it reuses backupEngine.js's already-
 * correct, already-tested `checkpointAndCopy()` (checkpoint the WAL, then
 * copy the main file) instead of hand-rolling WAL-frame archiving, which is
 * the lower-risk choice for a mechanism nobody has operated yet.
 *
 * No-ops unless settings.pitrEnabled is true — same "read the setting, bail
 * with a bare return" contract as alerting.js#checkTlsExpiry(). Off (the
 * default) means nothing here ever runs and the once-nightly backup is the
 * only recovery point, exactly as it always has been.
 *
 * STILL LOCAL ONLY. This closes the "how often" half of PITR. The other
 * half — shipping the archive off-site — has no destination yet (no VPS or
 * object store provisioned, per this project's own docs) and is a follow-on
 * once one exists. A disk failure that takes the data directory still takes
 * every snapshot with it; this only protects against "the ledger as it stood
 * N minutes ago", not "the ledger survives losing this machine".
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { logError, logTelemetry, DATA_DIR } from './db.js';
import { DB_FILE, checkpointAndCopy } from './repositories/connection.js';
import { readSettings } from './settingsStore.js';

const PITR_DIR = path.resolve(
    process.env.GOLD_POS_PITR_DIR || process.env.GOLDPOS_PITR_DIR || path.join(process.cwd(), 'backups', 'pitr')
);

/* In-memory, reset on restart — the same posture alerting.js's cooldown map
   already takes: a fresh process taking one snapshot immediately after
   startup rather than waiting out the interval is correct, not a bug. */
let lastArchivedAt = 0;

/**
 * Takes one PITR snapshot if enabled and due. Safe to call any time — no-ops
 * when disabled, misconfigured, or simply not due yet.
 */
export function archivePitrSnapshot() {
    const settings = readSettings();
    if (settings.pitrEnabled !== true) return;

    const intervalMinutes = Number(settings.pitrIntervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;

    const intervalMs = intervalMinutes * 60 * 1000;
    const now = Date.now();
    if (now - lastArchivedAt < intervalMs) return;

    try {
        const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
        const targetDir = path.join(PITR_DIR, stamp);
        fs.mkdirSync(targetDir, { recursive: true });

        // Configuration alongside the ledger — same convention createBackup()
        // uses, so a PITR snapshot restores exactly like a nightly one does.
        for (const f of fs.readdirSync(DATA_DIR)) {
            if (f.endsWith('.json')) {
                fs.copyFileSync(path.join(DATA_DIR, f), path.join(targetDir, f));
            }
        }
        if (fs.existsSync(DB_FILE)) {
            checkpointAndCopy(path.join(targetDir, path.basename(DB_FILE)));
        }

        lastArchivedAt = now;
        logTelemetry('PITR_SNAPSHOT_SUCCESS', 0, stamp);

        pruneExpiredSnapshots(Number(settings.pitrRetentionHours) || 24);
    } catch (err) {
        logError('PITR snapshot failed: ' + err.message, err.stack);
    }
}

/** Removes snapshot directories older than `retentionHours`. */
function pruneExpiredSnapshots(retentionHours) {
    if (!fs.existsSync(PITR_DIR)) return;
    const cutoffMs = retentionHours * 60 * 60 * 1000;
    const now = Date.now();
    for (const entry of fs.readdirSync(PITR_DIR)) {
        const entryPath = path.join(PITR_DIR, entry);
        try {
            const stats = fs.statSync(entryPath);
            if (now - stats.mtimeMs > cutoffMs) {
                fs.rmSync(entryPath, { recursive: true, force: true });
            }
        } catch (err) {
            logError(`PITR prune failed for ${entry}: ${err.message}`, err.stack);
        }
    }
}

/** The most recent snapshot directory, or null if none exists yet. */
export function latestPitrSnapshot() {
    if (!fs.existsSync(PITR_DIR)) return null;
    const entries = fs.readdirSync(PITR_DIR).sort();
    if (entries.length === 0) return null;
    return path.join(PITR_DIR, entries[entries.length - 1]);
}

/**
 * Fixed 5-minute tick (matching the alerting cooldown idiom, not a
 * dynamically-generated cron expression) — archivePitrSnapshot() itself
 * decides whether pitrIntervalMinutes have actually elapsed.
 */
export function initPitrScheduler() {
    cron.schedule('*/5 * * * *', () => archivePitrSnapshot());
    console.log('[PITR] Scheduler initialized (5-min tick, no-op unless pitrEnabled).');
}

export { PITR_DIR };
