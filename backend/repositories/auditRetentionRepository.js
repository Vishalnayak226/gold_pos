/**
 * ==========================================================================
 * Audit retention: the single privileged writer that may prune audit_events.
 *
 * Everywhere else in this codebase, trg_audit_events_no_delete makes a DELETE
 * on audit_events fail — that is the point of the trigger. This module is the
 * one deliberate exception, and only for rows older than a tenant-configured
 * cutoff, and only ever a CONTIGUOUS PREFIX of the chain: the boundary is the
 * lowest chain_seq that must be KEPT (occurred_at >= cutoff), so pruning can
 * never open a gap in the middle of the surviving chain. If a row's
 * occurred_at is (for whatever reason) older than the cutoff but a
 * lower-chain_seq row is not, pruning simply stops at that row rather than
 * skip it — under-pruning is the safe failure mode, a broken chain is not.
 *
 * The trigger is dropped and recreated inside the SAME transaction as the
 * delete, so a crash or thrown error mid-prune rolls back to the trigger
 * being in place, never leaves audit_events deletable.
 * ==========================================================================
 */

import { getDb, inTransaction } from './connection.js';
import { newId } from '../db.js';

const NO_DELETE_TRIGGER_SQL = `
    CREATE TRIGGER trg_audit_events_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW
    BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only: rows cannot be deleted');
    END;
`;

/** The most recent prune checkpoint for a tenant, or null if none has ever run. */
export function latestCheckpoint(tenantId) {
    return getDb().prepare(`
        SELECT * FROM audit_retention_checkpoints
        WHERE tenant_id = ?
        ORDER BY pruned_through_chain_seq DESC LIMIT 1
    `).get(tenantId) || null;
}

/**
 * Prunes chained and unchained audit_events older than `cutoffMs`, recording
 * a checkpoint for the chained portion so the chain still verifies afterward.
 *
 * @param {string} tenantId
 * @param {number} cutoffMs rows with occurred_at strictly before this are eligible
 * @returns {{chainRowsPruned: number, unchainedRowsPruned: number, checkpoint: object|null}}
 */
export function pruneOlderThan(tenantId, cutoffMs) {
    return inTransaction(() => {
        const db = getDb();
        const prior = latestCheckpoint(tenantId);
        const priorBoundary = prior ? prior.pruned_through_chain_seq : 0;

        const keepFrom = db.prepare(`
            SELECT MIN(chain_seq) AS chainSeq FROM audit_events
            WHERE tenant_id = ? AND chain_seq IS NOT NULL AND occurred_at >= ?
        `).get(tenantId, cutoffMs).chainSeq;
        const maxChained = db.prepare(`
            SELECT MAX(chain_seq) AS chainSeq FROM audit_events
            WHERE tenant_id = ? AND chain_seq IS NOT NULL
        `).get(tenantId).chainSeq;

        // Nothing must be kept ⇒ everything chained is eligible; otherwise the
        // boundary is just before the oldest row that must survive.
        const pruneThrough = keepFrom !== null ? keepFrom - 1 : maxChained;

        let checkpointRow = null;
        if (pruneThrough !== null && pruneThrough > priorBoundary) {
            checkpointRow = db.prepare(`
                SELECT chain_seq, row_hash, occurred_at FROM audit_events
                WHERE tenant_id = ? AND chain_seq = ?
            `).get(tenantId, pruneThrough);
        }

        let chainRowsPruned = 0;
        let unchainedRowsPruned = 0;

        // IF EXISTS: a handful of test-only tamper scenarios elsewhere in this
        // codebase drop this trigger directly and don't always recreate it, so
        // production code must not assume it's still there to drop.
        db.exec('DROP TRIGGER IF EXISTS trg_audit_events_no_delete');
        try {
            if (checkpointRow) {
                chainRowsPruned = db.prepare(`
                    DELETE FROM audit_events
                    WHERE tenant_id = ? AND chain_seq IS NOT NULL AND chain_seq > ? AND chain_seq <= ?
                `).run(tenantId, priorBoundary, pruneThrough).changes;

                db.prepare(`
                    INSERT INTO audit_retention_checkpoints
                        (id, tenant_id, pruned_through_chain_seq, pruned_through_occurred_at,
                         checkpoint_hash, rows_pruned, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(newId('ARC'), tenantId, checkpointRow.chain_seq, checkpointRow.occurred_at,
                    checkpointRow.row_hash, chainRowsPruned, Date.now());
            }

            // Rows written before migration 005 carry no chain_seq at all and
            // are not part of the chain the checkpoint above protects — they
            // age out on occurred_at alone, no checkpoint needed.
            unchainedRowsPruned = db.prepare(`
                DELETE FROM audit_events
                WHERE tenant_id = ? AND chain_seq IS NULL AND occurred_at < ?
            `).run(tenantId, cutoffMs).changes;
        } finally {
            db.exec(NO_DELETE_TRIGGER_SQL);
        }

        return { chainRowsPruned, unchainedRowsPruned, checkpoint: checkpointRow };
    });
}
