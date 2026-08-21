-- ===========================================================================
-- 015 — Gold savings schemes (Phase 41, unit 6 of 6 — the largest, built last)
--
-- Roadmap Phase 6, rebased on the Phase-1 SQL model per that section's own
-- instruction, not on the JSON-file design `docs/SCHEME_MODULE_PLAN.md`
-- proposed before this ledger existed:
--   - installments are append-only entries, never array appends;
--   - a gold-gram lock references an immutable rate captured at payment time;
--   - maturity/closure/default are a state machine with a transition history.
--
-- PLACEHOLDER TERMS. installment_count/bonus_installments/default_grace_days/
-- early_closure_penalty_bp are snapshotted from gold_schemes onto the
-- enrollment at enroll time (the "legal-approved terms version" Phase 6's own
-- exit criteria asks for — here it is an engineering placeholder, not a
-- legally reviewed one; see PRODUCTION_READINESS_ROADMAP.md Phase 6). Editing
-- a scheme's terms later never rewrites an existing enrollment's terms.
--
-- FLAGGED OFF (goldSchemeEnabled=false in settings.json): nothing here is
-- ever written to unless a tenant explicitly turns this module on.
-- ===========================================================================

CREATE TABLE gold_schemes (
    id                        TEXT PRIMARY KEY,
    tenant_id                 TEXT NOT NULL REFERENCES tenants(id),
    name                      TEXT NOT NULL,
    installment_count         INTEGER NOT NULL CHECK (installment_count > 0),
    bonus_installments        INTEGER NOT NULL DEFAULT 0 CHECK (bonus_installments >= 0),
    default_grace_days        INTEGER NOT NULL DEFAULT 30 CHECK (default_grace_days > 0),
    early_closure_penalty_bp  INTEGER NOT NULL DEFAULT 0 CHECK (early_closure_penalty_bp >= 0 AND early_closure_penalty_bp <= 10000),
    is_active                 INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at                INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_gold_schemes_tenant ON gold_schemes(tenant_id, is_active);

CREATE TABLE gold_scheme_enrollments (
    id                        TEXT PRIMARY KEY,
    tenant_id                 TEXT NOT NULL REFERENCES tenants(id),
    branch_id                 TEXT NOT NULL REFERENCES branches(id),
    scheme_id                 TEXT NOT NULL REFERENCES gold_schemes(id),
    customer_id               TEXT NOT NULL REFERENCES customers(id),

    -- Snapshotted from gold_schemes at enroll time — see header note.
    installment_count         INTEGER NOT NULL CHECK (installment_count > 0),
    bonus_installments        INTEGER NOT NULL CHECK (bonus_installments >= 0),
    default_grace_days        INTEGER NOT NULL CHECK (default_grace_days > 0),
    early_closure_penalty_bp  INTEGER NOT NULL CHECK (early_closure_penalty_bp >= 0 AND early_closure_penalty_bp <= 10000),

    status                    TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'matured', 'closed_early', 'defaulted')),
    -- Set only once the enrollment leaves 'active' and its accumulated value
    -- is credited — the same advance_entries deposit mechanism old-gold
    -- exchange already uses, zero new redemption logic.
    advance_entry_id          TEXT REFERENCES advance_entries(id),

    created_by_user_id        TEXT NOT NULL REFERENCES users(id),
    enrolled_at               INTEGER NOT NULL,
    business_date             TEXT NOT NULL
) STRICT;

CREATE INDEX idx_gold_scheme_enrollments_tenant ON gold_scheme_enrollments(tenant_id, status, enrolled_at DESC);
CREATE INDEX idx_gold_scheme_enrollments_customer ON gold_scheme_enrollments(customer_id, enrolled_at DESC);

CREATE TRIGGER trg_gold_scheme_enrollments_no_delete
BEFORE DELETE ON gold_scheme_enrollments
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'gold_scheme_enrollments is append-only: rows cannot be deleted');
END;

-- Everything may change EXCEPT the terms snapshot and the enrollment facts —
-- status and advance_entry_id are the only columns a transition legitimately
-- touches, matching invoices.delivery_status's precedent for a deliberately
-- mutable operational field on an otherwise immutable row.
CREATE TRIGGER trg_gold_scheme_enrollments_immutable_terms
BEFORE UPDATE OF tenant_id, branch_id, scheme_id, customer_id, installment_count,
    bonus_installments, default_grace_days, early_closure_penalty_bp,
    created_by_user_id, enrolled_at, business_date
ON gold_scheme_enrollments
FOR EACH ROW
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.branch_id IS NOT OLD.branch_id
    OR NEW.scheme_id IS NOT OLD.scheme_id OR NEW.customer_id IS NOT OLD.customer_id
    OR NEW.installment_count IS NOT OLD.installment_count
    OR NEW.bonus_installments IS NOT OLD.bonus_installments
    OR NEW.default_grace_days IS NOT OLD.default_grace_days
    OR NEW.early_closure_penalty_bp IS NOT OLD.early_closure_penalty_bp
    OR NEW.created_by_user_id IS NOT OLD.created_by_user_id
    OR NEW.enrolled_at IS NOT OLD.enrolled_at OR NEW.business_date IS NOT OLD.business_date
BEGIN
    SELECT RAISE(ABORT, 'gold_scheme_enrollments: only status and advance_entry_id may change after enrollment');
END;

CREATE TABLE gold_scheme_transitions (
    id              TEXT PRIMARY KEY,
    enrollment_id   TEXT NOT NULL REFERENCES gold_scheme_enrollments(id),
    from_status     TEXT,
    to_status       TEXT NOT NULL,
    actor_user_id   TEXT NOT NULL REFERENCES users(id),
    note            TEXT,
    occurred_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_gold_scheme_transitions_enrollment ON gold_scheme_transitions(enrollment_id, occurred_at);

-- Append-only, matching audit_events/inventory_movements/old_gold_exchanges:
-- an installment payment is a physical fact (this much was paid, this much
-- gold it locked at the time) with no status workflow of its own.
CREATE TABLE gold_scheme_installments (
    id                        TEXT PRIMARY KEY,
    tenant_id                 TEXT NOT NULL REFERENCES tenants(id),
    enrollment_id              TEXT NOT NULL REFERENCES gold_scheme_enrollments(id),
    installment_number        INTEGER NOT NULL CHECK (installment_number > 0),
    amount_paise               INTEGER NOT NULL CHECK (amount_paise > 0),
    rate_paise_per_g_locked   INTEGER NOT NULL CHECK (rate_paise_per_g_locked > 0),
    gold_grams_locked_mg      INTEGER NOT NULL CHECK (gold_grams_locked_mg > 0),
    payment_method            TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'upi', 'bank_transfer', 'other')),
    actor_user_id             TEXT NOT NULL REFERENCES users(id),
    created_at                INTEGER NOT NULL,
    business_date             TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_gold_scheme_installments_number ON gold_scheme_installments(enrollment_id, installment_number);
CREATE INDEX idx_gold_scheme_installments_enrollment ON gold_scheme_installments(enrollment_id, installment_number);

CREATE TRIGGER trg_gold_scheme_installments_immutable
BEFORE UPDATE ON gold_scheme_installments
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'gold_scheme_installments is append-only: rows cannot be modified');
END;

CREATE TRIGGER trg_gold_scheme_installments_no_delete
BEFORE DELETE ON gold_scheme_installments
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'gold_scheme_installments is append-only: rows cannot be deleted');
END;
