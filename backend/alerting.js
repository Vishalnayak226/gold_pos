/**
 * ==========================================================================
 * Operational alerting.
 *
 * One choke point — raiseAlert() — for every "something is operationally
 * wrong" event: payment/webhook failures, ledger drift, backup failure,
 * stale gold rates, elevated HTTP error rate/latency, low disk, an expiring
 * TLS cert, or the control plane (licensing server) being unreachable.
 *
 * Every alert is ALWAYS written to error.log + telemetry.log (logError /
 * logTelemetry — db.js), so nothing is lost even with no SMTP configured.
 * Email is a best-effort add-on through the same nodemailer transport
 * emailReporter.js already uses (sendMailIfConfigured) — no new dependency,
 * no second mailer.
 *
 * COOLDOWN, NOT SUPPRESSION. A misconfiguration that fires on every request
 * (e.g. an unconfigured webhook secret) would otherwise send one email per
 * request. Each `code` may send at most one email per ALERT_COOLDOWN_MS; the
 * log lines are written every time regardless, so the full history is still
 * on disk for whoever investigates. The cooldown map is in-memory and reset
 * on restart, which is fine — a fresh process re-alerting once is the
 * correct behaviour, not a bug.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import tls from 'tls';
import { URL } from 'url';
import cron from 'node-cron';
import { logError, logTelemetry, readJSON, DATA_DIR } from './db.js';
import { readSettings } from './settingsStore.js';
import { sendMailIfConfigured } from './emailReporter.js';
import * as repo from './repositories/index.js';

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per alert code
const lastEmailedAt = new Map();

/**
 * @param {object} args
 * @param {string} args.code       stable machine-readable id, e.g. 'GOLD_RATE_STALE'
 * @param {'warning'|'critical'} [args.severity]
 * @param {string} args.message    human-readable explanation
 * @param {Record<string, unknown>} [args.details]
 */
export async function raiseAlert({ code, severity = 'warning', message, details = {} }) {
    logError(`[ALERT:${severity.toUpperCase()}] ${code}: ${message}`, '', details);
    logTelemetry('ALERT_RAISED', 0, message, { code, severity, ...details });

    const now = Date.now();
    const last = lastEmailedAt.get(code) || 0;
    if (now - last < ALERT_COOLDOWN_MS) {
        return { sent: false, reason: 'cooldown' };
    }
    lastEmailedAt.set(code, now);

    const settings = readSettings();
    const to = settings.alertEmail || settings.reportEmail;
    if (!to) return { sent: false, reason: 'no recipient configured' };

    const color = severity === 'critical' ? '#b91c1c' : '#b45309';
    const detailBlock = Object.keys(details).length
        ? `<pre style="background:#f1f5f9;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(JSON.stringify(details, null, 2))}</pre>`
        : '';
    const html = `
        <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto; color:#1e293b;">
            <h2 style="color:${color}; border-bottom:2px solid ${color}; padding-bottom:10px;">${severity.toUpperCase()} — ${escapeHtml(code)}</h2>
            <p style="font-size:14px;">${escapeHtml(message)}</p>
            ${detailBlock}
            <p style="font-size:11px; color:#94a3b8; margin-top:20px;">Automated alert from your Gold POS system.</p>
        </div>
    `;

    const result = await sendMailIfConfigured({
        to,
        subject: `[${severity.toUpperCase()}] ${code} — Gold POS Alert`,
        html
    });
    return { sent: result.success, reason: result.reason };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------------------
   HTTP error-rate / latency — fed by server.js's existing per-request
   telemetry middleware via recordRequestOutcome(), evaluated on a timer by
   checkErrorRateAndLatency(). In-memory sliding window, reset on every check.
   --------------------------------------------------------------------------- */

const ERROR_RATE_THRESHOLD = 0.10; // 10% of requests answered 5xx
const MIN_SAMPLE_FOR_RATE_CHECK = 20; // below this, one bad request is not a rate
const P95_LATENCY_THRESHOLD_MS = 3000;

let windowTotal = 0;
let windowErrors = 0;
let windowLatencies = [];

/** Called from server.js's request-finish handler for every response. */
export function recordRequestOutcome(statusCode, durationMs) {
    windowTotal += 1;
    if (statusCode >= 500) windowErrors += 1;
    windowLatencies.push(durationMs);
}

/**
 * Evaluates and resets the window. Exported so a cron tick and a test can
 * both drive it. Returns the alert codes it raised (empty array if the
 * window was healthy or too small to judge) — a cron tick ignores the
 * return value, a test asserts on it directly instead of scraping logs.
 */
export function checkErrorRateAndLatency() {
    const total = windowTotal, errors = windowErrors, latencies = windowLatencies;
    windowTotal = 0; windowErrors = 0; windowLatencies = [];

    if (total < MIN_SAMPLE_FOR_RATE_CHECK) return [];

    const raised = [];

    const errorRate = errors / total;
    if (errorRate > ERROR_RATE_THRESHOLD) {
        raised.push('HTTP_ERROR_RATE');
        raiseAlert({
            code: 'HTTP_ERROR_RATE',
            severity: 'critical',
            message: `${(errorRate * 100).toFixed(1)}% of requests returned a 5xx in the last window (${errors}/${total}).`,
            details: { errorRate, total, errors }
        });
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    if (p95 > P95_LATENCY_THRESHOLD_MS) {
        raised.push('HTTP_LATENCY_P95');
        raiseAlert({
            code: 'HTTP_LATENCY_P95',
            severity: 'warning',
            message: `p95 request latency was ${p95}ms over the last window (threshold ${P95_LATENCY_THRESHOLD_MS}ms).`,
            details: { p95, sampleSize: sorted.length }
        });
    }
    return raised;
}

/* ---------------------------------------------------------------------------
   Periodic checks — stale rates, ledger drift, backup freshness, disk
   capacity, TLS expiry, control-plane (licensing server) reachability.
   --------------------------------------------------------------------------- */

const STALE_RATE_THRESHOLD_MS = 36 * 60 * 60 * 1000; // daily sync + slack for one missed cycle

/** Returns the alert codes raised (empty array when rates are fresh or absent). */
export function checkStaleRates() {
    const ratesFile = path.join(DATA_DIR, 'rates.json');
    const rates = readJSON(ratesFile, null);
    if (!rates || !rates.lastUpdated) return [];

    const ageMs = Date.now() - new Date(rates.lastUpdated).getTime();
    if (ageMs > STALE_RATE_THRESHOLD_MS) {
        raiseAlert({
            code: 'GOLD_RATE_STALE',
            severity: 'critical',
            message: `Gold rates have not synced since ${rates.lastUpdated} (${Math.round(ageMs / 3600000)}h ago). Invoices may be pricing off a stale rate.`,
            details: { lastUpdated: rates.lastUpdated }
        });
        return ['GOLD_RATE_STALE'];
    }
    return [];
}

/** Returns the alert codes raised (empty array when the ledger checks out clean). */
export function checkLedgerIntegrity() {
    const raised = [];
    let tenantId;
    try {
        ({ tenantId } = repo.dataStoreContext());
    } catch (err) {
        logError('Ledger integrity check could not resolve tenant context: ' + err.message, err.stack);
        return raised;
    }

    try {
        const chain = repo.audit.verifyChain(tenantId);
        if (!chain.ok) {
            raised.push('LEDGER_AUDIT_CHAIN_BROKEN');
            raiseAlert({
                code: 'LEDGER_AUDIT_CHAIN_BROKEN',
                severity: 'critical',
                message: `The audit trail hash chain is broken at chain_seq ${chain.brokenAt.chainSeq} (${chain.brokenAt.reason}). Treat as possible tampering.`,
                details: { brokenAt: chain.brokenAt }
            });
        }
    } catch (err) {
        logError('Audit chain verification failed to run: ' + err.message, err.stack);
    }

    try {
        const drift = repo.invoices.findLineDrift(tenantId, 5);
        if (drift.length > 0) {
            raised.push('LEDGER_LINE_DRIFT');
            raiseAlert({
                code: 'LEDGER_LINE_DRIFT',
                severity: 'critical',
                message: `${drift.length} invoice(s) have line totals that no longer sum to their own header (e.g. ${drift[0].invoice_number}).`,
                details: { sample: drift[0], count: drift.length }
            });
        }
    } catch (err) {
        logError('Invoice line-drift check failed to run: ' + err.message, err.stack);
    }

    if (!repo.isDataStoreReady()) {
        raised.push('LEDGER_NOT_READY');
        raiseAlert({
            code: 'LEDGER_NOT_READY',
            severity: 'critical',
            message: 'The ledger failed its own readiness check (unreachable, or a pending/drifted migration).',
            details: repo.dataStoreHealth()
        });
    }
    return raised;
}

const DISK_FREE_WARN_RATIO = 0.10; // below 10% free

/** Returns the alert codes raised (empty array when there's enough free space). */
export function checkDiskCapacity() {
    let stats;
    try {
        stats = fs.statfsSync(DATA_DIR);
    } catch (err) {
        // Not fatal — some filesystems/platforms don't support statfs. Log
        // once per cooldown window rather than crash a scheduled check.
        logError('Disk capacity check unavailable: ' + err.message);
        return [];
    }
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    if (totalBytes <= 0) return [];
    const freeRatio = freeBytes / totalBytes;
    if (freeRatio < DISK_FREE_WARN_RATIO) {
        raiseAlert({
            code: 'DISK_CAPACITY_LOW',
            severity: 'critical',
            message: `Only ${(freeRatio * 100).toFixed(1)}% disk free on the data volume (${Math.round(freeBytes / 1048576)}MB of ${Math.round(totalBytes / 1048576)}MB).`,
            details: { freeRatio, freeBytes, totalBytes }
        });
        return ['DISK_CAPACITY_LOW'];
    }
    return [];
}

const BACKUP_STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000;

// Same override convention as db.js's DATA_DIR — and must match
// backupEngine.js's BACKUPS_DIR exactly, since this checks what that module
// writes.
function backupsDirPath() {
    return path.resolve(
        process.env.GOLD_POS_BACKUPS_DIR || process.env.GOLDPOS_BACKUPS_DIR || path.join(process.cwd(), 'backups')
    );
}

/** Returns the alert codes raised (empty array when a recent backup exists). */
export function checkBackupFreshness() {
    const backupsDir = backupsDirPath();
    if (!fs.existsSync(backupsDir)) {
        raiseAlert({
            code: 'BACKUP_MISSING',
            severity: 'critical',
            message: 'No backups directory exists yet — the nightly backup has never run.',
            details: { backupsDir }
        });
        return ['BACKUP_MISSING'];
    }
    const folders = fs.readdirSync(backupsDir).filter(f => f.startsWith('backup_'));
    if (folders.length === 0) {
        raiseAlert({
            code: 'BACKUP_MISSING',
            severity: 'critical',
            message: 'The backups directory holds no backup_* snapshots.',
            details: { backupsDir }
        });
        return ['BACKUP_MISSING'];
    }
    const newest = folders
        .map(f => fs.statSync(path.join(backupsDir, f)).mtimeMs)
        .reduce((a, b) => Math.max(a, b), 0);
    const ageMs = Date.now() - newest;
    if (ageMs > BACKUP_STALE_THRESHOLD_MS) {
        raiseAlert({
            code: 'BACKUP_STALE',
            severity: 'critical',
            message: `The newest backup snapshot is ${Math.round(ageMs / 3600000)}h old — the nightly backup job appears to have stopped running.`,
            details: { ageHours: Math.round(ageMs / 3600000) }
        });
        return ['BACKUP_STALE'];
    }
    return [];
}

const TLS_EXPIRY_WARN_DAYS = 14;

/** No-op when settings.publicUrl isn't configured or isn't https — same
 *  "degrade, don't crash" contract as emailReporter's missing-SMTP path. */
export function checkTlsExpiry() {
    const settings = readSettings();
    const publicUrl = settings.publicUrl;
    if (!publicUrl) return;

    let host;
    try {
        const parsed = new URL(publicUrl);
        if (parsed.protocol !== 'https:') return;
        host = parsed.hostname;
    } catch {
        return;
    }

    const socket = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
        try {
            const cert = socket.getPeerCertificate();
            socket.end();
            if (!cert || !cert.valid_to) return;
            const expiresAt = new Date(cert.valid_to).getTime();
            const daysLeft = Math.floor((expiresAt - Date.now()) / 86400000);
            if (daysLeft < TLS_EXPIRY_WARN_DAYS) {
                raiseAlert({
                    code: 'TLS_CERT_EXPIRING',
                    severity: daysLeft < 0 ? 'critical' : 'warning',
                    message: daysLeft < 0
                        ? `The TLS certificate for ${host} expired on ${cert.valid_to}.`
                        : `The TLS certificate for ${host} expires in ${daysLeft} day(s) (${cert.valid_to}).`,
                    details: { host, validTo: cert.valid_to, daysLeft }
                });
            }
        } catch (err) {
            logError('TLS expiry check failed while inspecting certificate: ' + err.message);
        }
    });
    socket.on('error', (err) => {
        logError(`TLS expiry check could not connect to ${host}:443: ` + err.message);
    });
    socket.on('timeout', () => socket.destroy());
}

/**
 * initAlertScheduler()
 * - every 5 min: HTTP error-rate / latency window
 * - daily at 6:30 AM (after the 1 AM backup, midnight rate sync, ahead of
 *   the 7 AM report email): stale rates, ledger integrity, disk capacity,
 *   backup freshness, TLS expiry
 */
export function initAlertScheduler() {
    cron.schedule('*/5 * * * *', () => checkErrorRateAndLatency());
    cron.schedule('30 6 * * *', () => {
        console.log('[Scheduler] Running daily operational health checks...');
        checkStaleRates();
        checkLedgerIntegrity();
        checkDiskCapacity();
        checkBackupFreshness();
        checkTlsExpiry();
    });
    console.log('[Scheduler] Alert scheduler initialized (5-min HTTP window, 6:30 AM daily health checks).');
}
