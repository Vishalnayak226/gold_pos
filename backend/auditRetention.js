/**
 * ==========================================================================
 * Audit retention scheduler.
 *
 * No-ops unless settings.auditRetentionEnabled is true — same "read the
 * setting, bail with a bare return" contract as alerting.js#checkTlsExpiry().
 * Disabled (the default) means audit_events grows forever exactly as it
 * always has; nothing here ever touches the table.
 *
 * The actual prune is repositories/auditRetentionRepository.js#pruneOlderThan(),
 * the one place allowed to defeat trg_audit_events_no_delete. This module only
 * decides WHEN to call it and records that it happened.
 * ==========================================================================
 */

import cron from 'node-cron';
import { logError, logTelemetry } from './db.js';
import { readSettings } from './settingsStore.js';
import * as repo from './repositories/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs one prune pass. Safe to call any time — no-ops when disabled or misconfigured. */
export function pruneExpiredAuditEvents() {
    const settings = readSettings();
    if (settings.auditRetentionEnabled !== true) return;

    const days = Number(settings.auditRetentionDays);
    if (!Number.isFinite(days) || days <= 0) return;

    const cutoffMs = Date.now() - days * DAY_MS;

    try {
        const context = repo.dataStoreContext();
        const result = repo.auditRetention.pruneOlderThan(context.tenantId, cutoffMs);
        const totalPruned = result.chainRowsPruned + result.unchainedRowsPruned;
        if (totalPruned === 0) return;

        logTelemetry('AUDIT_RETENTION_PRUNED', totalPruned, result.chainRowsPruned, result.unchainedRowsPruned);

        // Written AFTER the prune transaction commits and the no-delete trigger
        // is back in place — this event documents the prune in the trail going
        // forward, the same way GET /api/audit/export records AUDIT_EXPORTED.
        repo.audit.record({
            tenantId: context.tenantId,
            action: 'AUDIT_RETENTION_PRUNED',
            entityType: 'audit',
            summary: `Pruned ${totalPruned} audit event(s) older than ${days} days`,
            detail: {
                chainRowsPruned: result.chainRowsPruned,
                unchainedRowsPruned: result.unchainedRowsPruned,
                checkpointChainSeq: result.checkpoint ? result.checkpoint.chain_seq : null
            },
            actorLabel: 'system'
        });
    } catch (err) {
        logError('Audit retention prune failed: ' + err.message, err.stack);
    }
}

/** Nightly at 02:00 — after the 01:00 backup, ahead of the 06:30 alert health checks. */
export function initAuditRetentionScheduler() {
    cron.schedule('0 2 * * *', () => pruneExpiredAuditEvents());
    console.log('[AuditRetention] Scheduler initialized (nightly at 02:00, no-op unless auditRetentionEnabled).');
}
