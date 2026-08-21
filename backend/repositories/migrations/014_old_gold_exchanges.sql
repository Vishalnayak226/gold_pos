-- ===========================================================================
-- 014 — Old-gold exchange (Phase 41, unit 4 of 6)
--
-- Roadmap Phase 5 §4: "Exchanges and old-gold remain blocked on legal
-- sign-off" (GST/RCM treatment of buying gold from a customer). The owner
-- decided not to wait: the engineering mechanism is built and flagged off
-- (oldGoldExchangeEnabled=false in settings.json), but this table and the
-- service above it deliberately do NOT compute or apply any GST/RCM
-- treatment — that stays a legal question, unresolved by this migration,
-- and must be settled before oldGoldExchangeEnabled is ever turned on for a
-- live tenant. See docs/PRODUCTION_READINESS_ROADMAP.md Phase 5 §4.
--
-- DOES NOT WIDEN advance_entries. SQLite cannot ALTER a CHECK constraint in
-- place, and the only way to widen one is a create-copy-drop-rename rebuild,
-- which trips checkMigrationSafety()'s DROP TABLE scan — correctly, since
-- that gate exists precisely so a live, heavily-tested table is not rebuilt
-- lightly. Instead: a dedicated table for the exchange itself, which then
-- posts an ORDINARY advance_entries deposit using method/source values that
-- already exist ('other'/'counter') — the existing advance/credit-redemption
-- machinery (already wired into computeInvoiceTotals() via appliedAdvance/
-- customerAdvanceBalance) applies the credit against a sale with zero new
-- redemption logic. advance_entries itself is untouched by this migration.
--
-- APPEND-ONLY, matching audit_events/inventory_movements/cash_shifts: an
-- exchange is a physical fact (this gold was weighed, tested and credited on
-- this date) with no status workflow of its own, so "nothing may change
-- after insert" is the whole rule — no transitions table needed.
-- ===========================================================================

CREATE TABLE old_gold_exchanges (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id),
    branch_id             TEXT NOT NULL REFERENCES branches(id),
    customer_id           TEXT REFERENCES customers(id),
    advance_entry_id      TEXT REFERENCES advance_entries(id),

    description           TEXT NOT NULL DEFAULT '',
    declared_purity       TEXT NOT NULL CHECK (declared_purity IN ('24K', '22K', '18K')),
    tested_purity         TEXT NOT NULL CHECK (tested_purity IN ('24K', '22K', '18K')),

    gross_weight_mg       INTEGER NOT NULL CHECK (gross_weight_mg > 0),
    -- Basis points: refining-loss/margin deduction off the gross weight.
    deduction_bp          INTEGER NOT NULL CHECK (deduction_bp >= 0 AND deduction_bp <= 10000),
    net_weight_mg         INTEGER NOT NULL CHECK (net_weight_mg >= 0),

    rate_paise_per_g      INTEGER NOT NULL CHECK (rate_paise_per_g > 0),
    credit_amount_paise   INTEGER NOT NULL CHECK (credit_amount_paise >= 0),

    actor_user_id         TEXT NOT NULL REFERENCES users(id),
    created_at            INTEGER NOT NULL,
    business_date         TEXT NOT NULL,

    CHECK (net_weight_mg <= gross_weight_mg)
) STRICT;

CREATE INDEX idx_old_gold_exchanges_tenant ON old_gold_exchanges(tenant_id, created_at DESC);
CREATE INDEX idx_old_gold_exchanges_customer ON old_gold_exchanges(customer_id, created_at DESC);

CREATE TRIGGER trg_old_gold_exchanges_immutable
BEFORE UPDATE ON old_gold_exchanges
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'old_gold_exchanges is append-only: rows cannot be modified');
END;

CREATE TRIGGER trg_old_gold_exchanges_no_delete
BEFORE DELETE ON old_gold_exchanges
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'old_gold_exchanges is append-only: rows cannot be deleted');
END;
