/**
 * ==========================================================================
 * The audit trail.
 *
 * Append-only by trigger, not by convention: `trg_audit_events_immutable` and
 * `trg_audit_events_no_delete` abort any UPDATE or DELETE. That is what makes
 * a manager approval mean something — a control that can be quietly edited
 * afterwards is a log, not a control.
 *
 * `record()` deliberately never throws. An audit write failing must not roll
 * back the money it was describing; a sale that succeeded and was not logged
 * is bad, a sale that was refused because logging failed is worse. Failures go
 * to the error log, which is the one place that cannot itself depend on the
 * database being writable.
 * ==========================================================================
 */

import { getDb, inTransaction, inTransactionNow } from './connection.js';
import { newId, logError } from '../db.js';
import { businessDate } from './calendar.js';

/**
 * Appends one event.
 *
 * When called inside a transaction it joins it, so the audit row commits or
 * rolls back with the fact it describes — an audit trail recording sales that
 * were rolled back is worse than none.
 *
 * @param {{tenantId: string, action: string, entityType: string, entityId?: string|null,
 *          summary?: string, detail?: object|null, actorUserId?: string|null,
 *          actorLabel?: string, branchId?: string|null, ipAddress?: string|null,
 *          occurredAt?: number}} event
 * @returns {string|null} the event id, or null if it could not be written
 */
export function record({ tenantId, action, entityType, entityId = null, summary = '',
                         detail = null, actorUserId = null, actorLabel = 'system',
                         branchId = null, ipAddress = null, occurredAt = Date.now() }) {
    const id = newId('AUD');
    const write = () => getDb().prepare(`
        INSERT INTO audit_events (id, tenant_id, branch_id, actor_user_id, actor_label, action,
                                  entity_type, entity_id, summary, detail_json, ip_address,
                                  occurred_at, business_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, branchId, actorUserId, actorLabel, action, entityType, entityId,
        String(summary || '').slice(0, 500),
        detail === null || detail === undefined ? null : JSON.stringify(detail),
        ipAddress, occurredAt, businessDate(occurredAt));

    try {
        if (inTransactionNow()) write(); else inTransaction(write);
        return id;
    } catch (err) {
        logError(`Failed to write audit event "${action}": ${err.message}`, err.stack);
        return null;
    }
}

/**
 * A page of the trail, newest first, optionally narrowed to one entity or one
 * actor. Every filter here is backed by an index from 001.
 * @returns {{rows: object[], total: number}}
 */
export function search({ tenantId, entityType = null, entityId = null, actorUserId = null,
                         action = null, fromAt = null, toAt = null, limit = 50, offset = 0 }) {
    // Filters only — see the note in invoiceRepository.search().
    const where = ['tenant_id = @tenantId'];
    const params = { tenantId };

    if (entityType) { where.push('entity_type = @entityType'); params.entityType = entityType; }
    if (entityId) { where.push('entity_id = @entityId'); params.entityId = entityId; }
    if (actorUserId) { where.push('actor_user_id = @actorUserId'); params.actorUserId = actorUserId; }
    if (action) { where.push('action = @action'); params.action = action; }
    if (fromAt !== null && fromAt !== undefined) { where.push('occurred_at >= @fromAt'); params.fromAt = fromAt; }
    if (toAt !== null && toAt !== undefined) { where.push('occurred_at <= @toAt'); params.toAt = toAt; }

    const whereSql = where.join(' AND ');
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE ${whereSql}`).get(params).n;
    const rows = db.prepare(`
        SELECT * FROM audit_events WHERE ${whereSql}
        ORDER BY occurred_at DESC, rowid DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: clampLimit(limit), offset: Math.max(0, Math.trunc(offset) || 0) });

    return { rows, total };
}

/** Everything recorded about one entity, oldest first — its life story. */
export function historyFor(tenantId, entityType, entityId) {
    return getDb().prepare(`
        SELECT * FROM audit_events
         WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?
         ORDER BY occurred_at, rowid
    `).all(tenantId, entityType, entityId);
}

export function countEvents(tenantId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ?').get(tenantId).n;
}

/* -------------------------------------------------------------------------- */

const MAX_PAGE = 200;

function clampLimit(limit) {
    const n = Math.trunc(Number(limit) || 50);
    if (n < 1) return 1;
    return Math.min(MAX_PAGE, n);
}
