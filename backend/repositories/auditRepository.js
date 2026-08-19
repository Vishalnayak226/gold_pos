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

import crypto from 'crypto';
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
    const write = () => {
        /* The chain head, read INSIDE the writing transaction. Two tills writing
           at once serialise on SQLite's write lock, so the second reads the
           first's row and cannot claim the same slot — the same property the
           invoice sequence relies on. */
        const head = getDb().prepare(`
            SELECT chain_seq, row_hash FROM audit_events
            WHERE tenant_id = ? AND chain_seq IS NOT NULL
            ORDER BY chain_seq DESC LIMIT 1
        `).get(tenantId);

        const chainSeq = (head ? head.chain_seq : 0) + 1;
        const prevHash = head ? head.row_hash : null;
        const summaryText = String(summary || '').slice(0, 500);
        const detailJson = detail === null || detail === undefined ? null : JSON.stringify(detail);
        const rowHash = hashRow({
            chain_seq: chainSeq, prev_hash: prevHash, id, tenant_id: tenantId, branch_id: branchId,
            actor_user_id: actorUserId, actor_label: actorLabel, action, entity_type: entityType,
            entity_id: entityId, summary: summaryText, detail_json: detailJson,
            ip_address: ipAddress, occurred_at: occurredAt, business_date: businessDate(occurredAt)
        });

        return getDb().prepare(`
            INSERT INTO audit_events (id, tenant_id, branch_id, actor_user_id, actor_label, action,
                                      entity_type, entity_id, summary, detail_json, ip_address,
                                      occurred_at, business_date, chain_seq, prev_hash, row_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, tenantId, branchId, actorUserId, actorLabel, action, entityType, entityId,
            summaryText, detailJson, ipAddress, occurredAt, businessDate(occurredAt),
            chainSeq, prevHash, rowHash);
    };

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


/* ==========================================================================
   Tamper evidence
   ==========================================================================
   The append-only triggers stop the APPLICATION from rewriting history. They
   do not stop whoever holds the database file, because dropping a trigger is
   one statement. The chain below answers the question those triggers cannot:
   not "can this be edited?" but "has it been?".
   ========================================================================== */

/* The exact field set and order that go into a row's hash.

   Order matters and must never change: a different order over the same values
   produces a different digest, which would read as tampering on every row
   written before the change. If a future migration adds a column worth
   chaining, append it to the END of this list and say so in that migration —
   older rows keep verifying, newer ones cover the new field. */
const HASHED_FIELDS = [
    'chain_seq', 'prev_hash', 'id', 'tenant_id', 'branch_id', 'actor_user_id',
    'actor_label', 'action', 'entity_type', 'entity_id', 'summary',
    'detail_json', 'ip_address', 'occurred_at', 'business_date'
];

/**
 * SHA-256 over one row's chained content, lowercase hex.
 *
 * Values are joined with a delimiter that cannot occur in them (a NUL byte) and
 * NULL is encoded distinctly from the empty string — without both, a row with
 * summary "a" + detail null could hash identically to one with summary "a" and
 * detail "", and two different histories would be indistinguishable.
 */
export function hashRow(row) {
    const canonical = HASHED_FIELDS
        .map(field => (row[field] === null || row[field] === undefined ? '\u0000NULL' : String(row[field])))
        .join('\u0000');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Recompute the whole chain and report the first place it disagrees.
 *
 * @param {string} tenantId
 * @returns {{ok: boolean, checked: number, unchained: number, head: string|null,
 *            brokenAt: {chainSeq: number, id: string, reason: string}|null}}
 */
export function verifyChain(tenantId) {
    const rows = getDb().prepare(`
        SELECT * FROM audit_events
        WHERE tenant_id = ? AND chain_seq IS NOT NULL
        ORDER BY chain_seq ASC
    `).all(tenantId);

    /* Rows written before migration 005 have no chain columns. They are counted
       and reported rather than skipped silently — "12 events predate the chain"
       is a fact a reader of this report needs, and hiding it would overstate
       what the chain covers. */
    const unchained = getDb().prepare(
        'SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ? AND chain_seq IS NULL'
    ).get(tenantId).n;

    let previousHash = null;
    let previousSeq = 0;
    for (const row of rows) {
        if (row.chain_seq !== previousSeq + 1) {
            return brokenAt(row, `chain_seq jumped from ${previousSeq} to ${row.chain_seq} — an event was removed`,
                rows.length, unchained);
        }
        if (row.prev_hash !== previousHash) {
            return brokenAt(row, 'prev_hash does not match the previous row — the chain was re-linked',
                rows.length, unchained);
        }
        if (hashRow(row) !== row.row_hash) {
            return brokenAt(row, 'row_hash does not match the row content — this event was edited',
                rows.length, unchained);
        }
        previousHash = row.row_hash;
        previousSeq = row.chain_seq;
    }

    return {
        ok: true,
        checked: rows.length,
        unchained,
        head: previousHash,
        brokenAt: null
    };
}

function brokenAt(row, reason, checked, unchained) {
    return {
        ok: false,
        checked,
        unchained,
        head: null,
        brokenAt: { chainSeq: row.chain_seq, id: row.id, reason }
    };
}

/**
 * The trail plus the evidence needed to check it later.
 *
 * The manifest is the point of the whole exercise: once a head hash has left
 * the building, the rows behind it are pinned. Someone who later re-hashes an
 * edited chain produces a head that no longer matches the copy already in
 * somebody else's hands.
 *
 * @param {string} tenantId
 * @param {{from?: number, to?: number}} [range] occurred_at bounds, inclusive
 */
export function exportChain(tenantId, { from = null, to = null } = {}) {
    const clauses = ['tenant_id = ?'];
    const params = [tenantId];
    if (from !== null) { clauses.push('occurred_at >= ?'); params.push(from); }
    if (to !== null) { clauses.push('occurred_at <= ?'); params.push(to); }

    const rows = getDb().prepare(
        `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY chain_seq ASC, occurred_at ASC`
    ).all(...params);

    const verification = verifyChain(tenantId);

    return {
        manifest: {
            generatedAt: Date.now(),
            tenantId,
            range: { from, to },
            rowsExported: rows.length,
            /* Deliberately about the WHOLE chain, not the exported slice: a head
               hash over a filtered subset would pin nothing, because the filter
               itself could be chosen to exclude an edited row. */
            chain: {
                verified: verification.ok,
                eventsInChain: verification.checked,
                eventsPredatingChain: verification.unchained,
                headHash: verification.head,
                brokenAt: verification.brokenAt
            },
            algorithm: 'sha256(chain_seq \u0000 prev_hash \u0000 ...row fields), lowercase hex',
            howToVerify: 'node backend/verifyAuditChain.js --data-dir <dir>'
        },
        events: rows
    };
}
