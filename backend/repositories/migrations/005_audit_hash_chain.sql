-- ===========================================================================
-- 005 — Making the audit trail tamper-EVIDENT, not merely tamper-resistant
--
-- Since 001 the trail has been append-only by trigger: `trg_audit_events_
-- immutable` and `trg_audit_events_no_delete` abort any UPDATE or DELETE. That
-- stops the application from rewriting history, and it is the right control.
--
-- It proves nothing to a third party.
--
-- Triggers live inside the same file an attacker with the data directory
-- already holds. `sqlite3 ledger.db "DROP TRIGGER ..."` is one command, and
-- after it the rows can be edited freely with no trace. So the question a
-- dispute actually asks — "is this the trail the shop wrote, or one it edited
-- after the fact?" — could not be answered. That is the gap this closes.
--
-- HOW: each event carries the hash of the one before it.
--
--   row_hash = SHA-256(chain_seq ‖ prev_hash ‖ every field of this row)
--
-- Changing any field of any row changes that row's hash, which breaks every
-- hash after it. Re-hashing the whole tail to cover it up is possible for
-- whoever holds the file — which is why the export in auditRepository.js
-- publishes the head hash: once a head hash has left the building (in a
-- support export, a mailed report, a regulator's copy), the rows behind it are
-- pinned, and a re-hashed chain no longer matches the value already in
-- somebody else's hands.
--
-- WHAT IS DELIBERATELY NOT DONE: existing rows are NOT backfilled.
--
-- Hashing rows that predate the chain would compute a hash over whatever those
-- rows say *now*, which proves exactly nothing about what they said when they
-- were written, while looking authoritative. It would be evidence theatre.
-- Pre-chain rows keep NULL chain columns, and verifyChain() reports their count
-- explicitly as "predating the chain" rather than quietly skipping them.
--
-- Additive and backward-compatible (CLAUDE.md §1): three nullable columns, no
-- rewrite of an existing row, and nothing above the repository seam changes.
-- ===========================================================================

-- Position in the tenant's chain. Assigned by auditRepository.record() as
-- MAX(chain_seq) + 1 within the writing transaction, so concurrent writers
-- serialise on SQLite's write lock and cannot both claim the same slot.
ALTER TABLE audit_events ADD COLUMN chain_seq INTEGER;

-- The row_hash of the preceding event in this tenant's chain. NULL for the
-- first chained row, which is what makes a chain's start identifiable.
ALTER TABLE audit_events ADD COLUMN prev_hash TEXT;

-- SHA-256 over this row's own content and prev_hash, lowercase hex.
ALTER TABLE audit_events ADD COLUMN row_hash TEXT;

-- Walking the chain in order, and finding its head to append to, are the only
-- two access patterns these columns have. Partial, because pre-chain rows are
-- NULL here and are never part of a walk.
CREATE INDEX idx_audit_chain ON audit_events(tenant_id, chain_seq)
    WHERE chain_seq IS NOT NULL;
