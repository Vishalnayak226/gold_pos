-- ===========================================================================
-- 007 — Audit retention checkpoints
--
-- docs/AUDIT_AND_PII.md §5: trg_audit_events_no_delete refuses a DELETE
-- outright, so a retention job needs "a deliberate archive-then-prune path
-- that records a checkpoint hash for the pruned range — otherwise
-- verification reports a gap forever after." This table is that checkpoint.
--
-- Flagged off by default (auditRetentionEnabled=false in settings.json, see
-- defaultSettings.js): nothing ever writes to this table, and audit_events
-- behaves exactly as it always has, until a tenant turns retention on.
-- auditRetentionDays itself is a placeholder long enough to be safe for
-- common record-keeping practice, not a legal determination.
--
-- ONE ROW PER PRUNE RUN, never updated. auditRepository.js#verifyChain()
-- reads the row with the highest pruned_through_chain_seq as the seed for
-- the surviving chain: the first surviving row's prev_hash must equal
-- checkpoint_hash — the same invariant the live chain already enforces
-- between any two adjacent rows, just anchored at the prune boundary
-- instead of at the start of history.
-- ===========================================================================

CREATE TABLE audit_retention_checkpoints (
    id                          TEXT PRIMARY KEY,
    tenant_id                   TEXT NOT NULL REFERENCES tenants(id),
    pruned_through_chain_seq    INTEGER NOT NULL,
    pruned_through_occurred_at  INTEGER NOT NULL,
    checkpoint_hash             TEXT NOT NULL,
    rows_pruned                 INTEGER NOT NULL CHECK (rows_pruned >= 0),
    created_at                  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_audit_retention_checkpoints_tenant
    ON audit_retention_checkpoints(tenant_id, pruned_through_chain_seq DESC);
