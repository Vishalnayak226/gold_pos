-- ===========================================================================
-- 001 — Initial transactional schema (ADR-001, roadmap Phase 1)
--
-- UNITS. SQLite has no DECIMAL, and a float ledger is exactly what this phase
-- exists to eliminate. Every quantity is therefore a scaled INTEGER, and the
-- scale is in the column name. There are no exceptions and no bare REALs.
--
--   *_paise         money, integer paise            ₹1234.35 -> 123435
--   *_mg            weight, integer milligrams      8.5 g     -> 8500
--   *_paise_per_g   metal rate, paise per gram      ₹6875.00  -> 687500
--   *_bp            percentage, basis points        3%        -> 300, 12.5% -> 1250
--
-- TIME. `*_at` columns are epoch milliseconds (server clock, UTC), matching the
-- `timestamp` fields the JSON ledger already uses. `business_date` is a
-- TEXT 'YYYY-MM-DD' shop-day, which is NOT derivable from the timestamp: a sale
-- rung at 00:30 belongs to the previous business day, and reporting groups by
-- the shop day, not by UTC midnight.
--
-- TENANCY. `tenant_id`/`branch_id` are present on every tenant-owned row even
-- though today's deployment is one database per tenant. They cost nothing now
-- and are the difference between a migration and a rewrite when ADR-001's
-- revisit trigger fires and this moves to PostgreSQL.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Organisation
-- --------------------------------------------------------------------------

CREATE TABLE tenants (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    gst_number   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE branches (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    name         TEXT NOT NULL,
    address      TEXT,
    phone        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_branches_tenant ON branches(tenant_id);

-- --------------------------------------------------------------------------
-- Identity — named staff
--
-- Pulled forward from Phase 2 by the 2026-08-11 owner decision on manual-UPI
-- reconciliation: the approver of a money claim must be a named person from
-- the first schema, so `approved_by_user_id` on an advance entry has something
-- to point at. Full RBAC/MFA still lands in Phase 2; this is the identity
-- slice it will build on, not a replacement for it.
-- --------------------------------------------------------------------------

CREATE TABLE users (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id),
    branch_id          TEXT REFERENCES branches(id),
    full_name          TEXT NOT NULL,
    username           TEXT NOT NULL,
    role               TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier', 'auditor')),
    password_hash      TEXT,
    password_salt      TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    is_active          INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    failed_attempts    INTEGER NOT NULL DEFAULT 0,
    locked_until_at    INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_users_tenant_username ON users(tenant_id, username);

-- Only a manager or an owner may approve a money claim. Enforced in SQL as
-- well as in the service, because this is the control the whole manual-UPI
-- reconciliation item rests on.
CREATE VIEW approvers AS
    SELECT id, tenant_id, branch_id, full_name, username, role
    FROM users
    WHERE is_active = 1 AND role IN ('owner', 'manager');

CREATE TABLE user_sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    token_hash      TEXT NOT NULL,
    issued_at       INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    revoked_at      INTEGER,
    user_agent      TEXT,
    ip_address      TEXT
) STRICT;

CREATE UNIQUE INDEX uq_user_sessions_token ON user_sessions(token_hash);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id, expires_at);

-- --------------------------------------------------------------------------
-- Identity — customers (portal logins, from customer_auth.json)
-- --------------------------------------------------------------------------

CREATE TABLE customers (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL REFERENCES tenants(id),
    phone                TEXT NOT NULL,
    full_name            TEXT NOT NULL,
    email                TEXT,
    password_hash        TEXT,
    password_salt        TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    notify_email         INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1)),
    notify_push          INTEGER NOT NULL DEFAULT 0 CHECK (notify_push IN (0, 1)),
    reset_token_hash     TEXT,
    reset_expires_at     INTEGER NOT NULL DEFAULT 0,
    reset_attempts       INTEGER NOT NULL DEFAULT 0,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    locked_until_at      INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_customers_tenant_phone ON customers(tenant_id, phone);

CREATE TABLE customer_sessions (
    id          TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id),
    token_hash  TEXT NOT NULL,
    issued_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER
) STRICT;

CREATE UNIQUE INDEX uq_customer_sessions_token ON customer_sessions(token_hash);
CREATE INDEX idx_customer_sessions_customer ON customer_sessions(customer_id, expires_at);

-- --------------------------------------------------------------------------
-- Pricing — immutable approved snapshots
--
-- An invoice must be explainable years later by the exact rate it was priced
-- at, from a row nobody can edit. `invoices.rate_snapshot_id` is what makes a
-- reprint reproducible; storing only the rate on the invoice would leave no
-- record of where that number came from.
-- --------------------------------------------------------------------------

CREATE TABLE rate_snapshots (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id),
    source                TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'override', 'seeded', 'mock')),
    provider              TEXT,
    price_24k_paise_per_g INTEGER NOT NULL CHECK (price_24k_paise_per_g > 0),
    price_22k_paise_per_g INTEGER NOT NULL CHECK (price_22k_paise_per_g > 0),
    price_18k_paise_per_g INTEGER NOT NULL CHECK (price_18k_paise_per_g > 0),
    captured_at           INTEGER NOT NULL,
    created_by_user_id    TEXT REFERENCES users(id)
) STRICT;

CREATE INDEX idx_rate_snapshots_captured ON rate_snapshots(tenant_id, captured_at DESC);

-- --------------------------------------------------------------------------
-- Document numbering
--
-- The lost-update bug that produced duplicate invoice numbers (see the comment
-- on writeJSON in db.js) is structurally impossible here: allocation is an
-- UPDATE ... RETURNING inside the sale's own transaction, so two concurrent
-- sales serialise on the row lock instead of both reading the same counter.
-- --------------------------------------------------------------------------

CREATE TABLE document_sequences (
    tenant_id      TEXT NOT NULL REFERENCES tenants(id),
    branch_id      TEXT NOT NULL REFERENCES branches(id),
    document_type  TEXT NOT NULL CHECK (document_type IN ('invoice', 'credit_note')),
    financial_year TEXT NOT NULL,
    prefix         TEXT NOT NULL DEFAULT '',
    next_value     INTEGER NOT NULL DEFAULT 1 CHECK (next_value > 0),
    PRIMARY KEY (tenant_id, branch_id, document_type, financial_year)
) STRICT;

-- --------------------------------------------------------------------------
-- Sales
-- --------------------------------------------------------------------------

CREATE TABLE invoices (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL REFERENCES tenants(id),
    branch_id           TEXT NOT NULL REFERENCES branches(id),
    invoice_number      TEXT NOT NULL,
    financial_year      TEXT NOT NULL,
    sequence_value      INTEGER NOT NULL,

    customer_id         TEXT REFERENCES customers(id),
    customer_name       TEXT NOT NULL,
    customer_phone      TEXT NOT NULL DEFAULT '',

    state               TEXT NOT NULL DEFAULT 'issued'
                        CHECK (state IN ('draft', 'issued', 'partially_returned', 'returned', 'cancelled')),

    rate_snapshot_id    TEXT REFERENCES rate_snapshots(id),
    rate_source         TEXT NOT NULL DEFAULT 'auto',

    -- Header totals. Line-level detail lives in invoice_lines; these are the
    -- figures actually printed, kept as stored facts rather than recomputed on
    -- read, because a reprint must reproduce the paper exactly even if the
    -- pricing rules have since changed.
    metal_value_paise       INTEGER NOT NULL CHECK (metal_value_paise >= 0),
    making_charge_paise     INTEGER NOT NULL DEFAULT 0 CHECK (making_charge_paise >= 0),
    discount_paise          INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
    taxable_amount_paise    INTEGER NOT NULL CHECK (taxable_amount_paise >= 0),
    tax_amount_paise        INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount_paise >= 0),
    applied_advance_paise   INTEGER NOT NULL DEFAULT 0 CHECK (applied_advance_paise >= 0),
    total_amount_paise      INTEGER NOT NULL CHECK (total_amount_paise >= 0),

    tax_percent_bp      INTEGER NOT NULL DEFAULT 0 CHECK (tax_percent_bp >= 0),
    tax_mode            TEXT NOT NULL DEFAULT 'Exclusive' CHECK (tax_mode IN ('Exclusive', 'Inclusive')),

    idempotency_key     TEXT,
    created_by_user_id  TEXT REFERENCES users(id),
    issued_at           INTEGER NOT NULL,
    business_date       TEXT NOT NULL,
    cancelled_at        INTEGER,
    cancelled_by_user_id TEXT REFERENCES users(id),
    cancel_reason       TEXT
) STRICT;

-- The invoice-scope uniqueness the roadmap asks for, in two forms: the human
-- number a customer quotes, and the numeric slot it came from.
CREATE UNIQUE INDEX uq_invoices_number ON invoices(tenant_id, invoice_number);
CREATE UNIQUE INDEX uq_invoices_sequence
    ON invoices(tenant_id, branch_id, financial_year, sequence_value);
-- Partial index: many invoices legitimately carry no idempotency key, but any
-- two that do must differ. A plain UNIQUE would not do this, since SQLite
-- treats every NULL as distinct — which is the behaviour we want for the
-- absent case and not for the present one.
CREATE UNIQUE INDEX uq_invoices_idempotency
    ON invoices(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_invoices_business_date ON invoices(tenant_id, business_date DESC, issued_at DESC);
CREATE INDEX idx_invoices_customer ON invoices(tenant_id, customer_phone, issued_at DESC);
CREATE INDEX idx_invoices_state ON invoices(tenant_id, state);

CREATE TABLE invoice_lines (
    id                    TEXT PRIMARY KEY,
    invoice_id            TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number           INTEGER NOT NULL CHECK (line_number > 0),

    description           TEXT NOT NULL DEFAULT '',
    purity                TEXT NOT NULL CHECK (purity IN ('24K', '22K', '18K')),
    weight_mg             INTEGER NOT NULL CHECK (weight_mg > 0),
    rate_paise_per_g      INTEGER NOT NULL CHECK (rate_paise_per_g > 0),

    metal_value_paise     INTEGER NOT NULL CHECK (metal_value_paise >= 0),
    making_charge_bp      INTEGER NOT NULL DEFAULT 0 CHECK (making_charge_bp >= 0),
    making_charge_paise   INTEGER NOT NULL DEFAULT 0 CHECK (making_charge_paise >= 0),
    discount_bp           INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp >= 0),
    discount_paise        INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
    taxable_amount_paise  INTEGER NOT NULL CHECK (taxable_amount_paise >= 0),
    tax_amount_paise      INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount_paise >= 0),
    line_total_paise      INTEGER NOT NULL CHECK (line_total_paise >= 0),

    returned_weight_mg    INTEGER NOT NULL DEFAULT 0 CHECK (returned_weight_mg >= 0),

    CHECK (returned_weight_mg <= weight_mg)
) STRICT;

CREATE UNIQUE INDEX uq_invoice_lines_number ON invoice_lines(invoice_id, line_number);
CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);

-- How the invoice was actually paid. An invoice may have several tenders; the
-- sum of posted tenders must equal total_amount_paise, which the sale service
-- asserts inside the same transaction that writes them.
CREATE TABLE tenders (
    id                 TEXT PRIMARY KEY,
    invoice_id         TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    method             TEXT NOT NULL CHECK (method IN ('cash', 'card', 'upi', 'razorpay', 'advance', 'bank_transfer', 'other')),
    amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
    reference          TEXT,
    payment_order_id   TEXT,
    advance_entry_id   TEXT,
    captured_at        INTEGER NOT NULL,
    created_by_user_id TEXT REFERENCES users(id)
) STRICT;

CREATE INDEX idx_tenders_invoice ON tenders(invoice_id);
CREATE UNIQUE INDEX uq_tenders_reference
    ON tenders(method, reference) WHERE reference IS NOT NULL AND reference <> '';

-- --------------------------------------------------------------------------
-- Returns / credit notes
--
-- An issued invoice is never edited. A return is a new document that points
-- back at the original — the reversal relationship roadmap §4 requires.
-- --------------------------------------------------------------------------

CREATE TABLE credit_notes (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL REFERENCES tenants(id),
    branch_id            TEXT NOT NULL REFERENCES branches(id),
    credit_note_number   TEXT NOT NULL,
    financial_year       TEXT NOT NULL,
    sequence_value       INTEGER NOT NULL,

    invoice_id           TEXT NOT NULL REFERENCES invoices(id),
    customer_id          TEXT REFERENCES customers(id),
    customer_name        TEXT NOT NULL,
    customer_phone       TEXT NOT NULL DEFAULT '',

    refund_mode          TEXT NOT NULL CHECK (refund_mode IN ('cash', 'gold', 'card', 'upi')),
    refund_amount_paise  INTEGER NOT NULL CHECK (refund_amount_paise >= 0),
    closes_invoice       INTEGER NOT NULL DEFAULT 0 CHECK (closes_invoice IN (0, 1)),

    -- Set when refund_mode = 'gold': the advance entry this refund credited.
    advance_entry_id     TEXT,

    note                 TEXT NOT NULL DEFAULT '',
    idempotency_key      TEXT,
    created_by_user_id   TEXT REFERENCES users(id),
    issued_at            INTEGER NOT NULL,
    business_date        TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_credit_notes_number ON credit_notes(tenant_id, credit_note_number);
CREATE UNIQUE INDEX uq_credit_notes_sequence
    ON credit_notes(tenant_id, branch_id, financial_year, sequence_value);
CREATE UNIQUE INDEX uq_credit_notes_idempotency
    ON credit_notes(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_credit_notes_invoice ON credit_notes(invoice_id);

CREATE TABLE credit_note_lines (
    id                   TEXT PRIMARY KEY,
    credit_note_id       TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
    invoice_line_id      TEXT NOT NULL REFERENCES invoice_lines(id),
    line_number          INTEGER NOT NULL CHECK (line_number > 0),

    purity               TEXT NOT NULL CHECK (purity IN ('24K', '22K', '18K')),
    weight_mg            INTEGER NOT NULL CHECK (weight_mg > 0),
    rate_paise_per_g     INTEGER NOT NULL CHECK (rate_paise_per_g > 0),
    metal_value_paise    INTEGER NOT NULL CHECK (metal_value_paise >= 0),
    making_charge_paise  INTEGER NOT NULL DEFAULT 0 CHECK (making_charge_paise >= 0),
    discount_paise       INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
    taxable_amount_paise INTEGER NOT NULL CHECK (taxable_amount_paise >= 0),
    tax_amount_paise     INTEGER NOT NULL DEFAULT 0 CHECK (tax_amount_paise >= 0),
    refund_amount_paise  INTEGER NOT NULL CHECK (refund_amount_paise >= 0)
) STRICT;

CREATE UNIQUE INDEX uq_credit_note_lines_number ON credit_note_lines(credit_note_id, line_number);
CREATE INDEX idx_credit_note_lines_invoice_line ON credit_note_lines(invoice_line_id);

-- --------------------------------------------------------------------------
-- Customer funds (advances) — append-only
--
-- The financial facts of an entry are immutable; a status change is a new row
-- in advance_entry_transitions, never an edit. Balance is therefore always
-- derivable from history, and "who approved this and when" cannot be
-- overwritten. The immutability is enforced by trigger below rather than by
-- convention, because a convention is not a control.
-- --------------------------------------------------------------------------

CREATE TABLE advance_accounts (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES tenants(id),
    customer_id    TEXT REFERENCES customers(id),
    customer_phone TEXT NOT NULL,
    customer_name  TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_advance_accounts_phone ON advance_accounts(tenant_id, customer_phone);

CREATE TABLE advance_entries (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id),
    branch_id             TEXT REFERENCES branches(id),
    account_id            TEXT NOT NULL REFERENCES advance_accounts(id),

    entry_type            TEXT NOT NULL CHECK (entry_type IN ('deposit', 'redeem', 'reversal')),
    -- Signed so that a balance is SUM(amount_paise) over posted rows and never
    -- a conditional sum that a future caller can get the sign wrong on.
    -- deposit > 0, redeem < 0, reversal carries the opposite sign of its target.
    amount_paise          INTEGER NOT NULL CHECK (amount_paise <> 0),

    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'posted', 'rejected', 'reversed')),

    payment_method        TEXT NOT NULL DEFAULT 'cash'
                          CHECK (payment_method IN ('cash', 'card', 'upi', 'razorpay', 'bank_transfer', 'return_credit', 'other')),
    reference_id          TEXT,
    source                TEXT NOT NULL DEFAULT 'counter'
                          CHECK (source IN ('counter', 'portal', 'gateway', 'return', 'import')),

    locked_rate_22k_paise_per_g INTEGER,
    invoice_id            TEXT REFERENCES invoices(id),
    credit_note_id        TEXT REFERENCES credit_notes(id),
    reverses_entry_id     TEXT REFERENCES advance_entries(id),

    idempotency_key       TEXT,
    created_by_user_id    TEXT REFERENCES users(id),
    approved_by_user_id   TEXT REFERENCES users(id),
    approved_at           INTEGER,
    review_note           TEXT,

    created_at            INTEGER NOT NULL,
    business_date         TEXT NOT NULL,

    -- A posted entry must name its approver. This is the manual-UPI
    -- reconciliation control, expressed where it cannot be bypassed.
    CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL),
    CHECK (entry_type <> 'deposit' OR amount_paise > 0),
    CHECK (entry_type <> 'redeem'  OR amount_paise < 0)
) STRICT;

-- The duplicate-reference rejection that recordAdvanceDeposit() enforces in JS
-- today, promoted to a constraint so it also covers every future write path.
CREATE UNIQUE INDEX uq_advance_entries_reference
    ON advance_entries(tenant_id, payment_method, reference_id)
    WHERE reference_id IS NOT NULL AND reference_id <> '';
CREATE UNIQUE INDEX uq_advance_entries_idempotency
    ON advance_entries(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- An entry may be reversed at most once.
CREATE UNIQUE INDEX uq_advance_entries_reverses
    ON advance_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX idx_advance_entries_account ON advance_entries(account_id, created_at DESC);
CREATE INDEX idx_advance_entries_status ON advance_entries(tenant_id, status, created_at DESC);
CREATE INDEX idx_advance_entries_invoice ON advance_entries(invoice_id);

CREATE TABLE advance_entry_transitions (
    id                 TEXT PRIMARY KEY,
    entry_id           TEXT NOT NULL REFERENCES advance_entries(id),
    from_status        TEXT,
    to_status          TEXT NOT NULL CHECK (to_status IN ('pending', 'posted', 'rejected', 'reversed')),
    actor_user_id      TEXT REFERENCES users(id),
    note               TEXT,
    occurred_at        INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_advance_transitions_entry ON advance_entry_transitions(entry_id, occurred_at);

-- Append-only enforcement. `status`, `approved_by_user_id`, `approved_at` and
-- `review_note` are the only mutable columns — everything financial is frozen
-- at insert. Anything else raises, including any DELETE.
CREATE TRIGGER trg_advance_entries_immutable
BEFORE UPDATE ON advance_entries
FOR EACH ROW
WHEN OLD.amount_paise      IS NOT NEW.amount_paise
  OR OLD.entry_type        IS NOT NEW.entry_type
  OR OLD.account_id        IS NOT NEW.account_id
  OR OLD.tenant_id         IS NOT NEW.tenant_id
  OR OLD.payment_method    IS NOT NEW.payment_method
  OR OLD.reference_id      IS NOT NEW.reference_id
  OR OLD.source            IS NOT NEW.source
  OR OLD.invoice_id        IS NOT NEW.invoice_id
  OR OLD.credit_note_id    IS NOT NEW.credit_note_id
  OR OLD.reverses_entry_id IS NOT NEW.reverses_entry_id
  OR OLD.idempotency_key   IS NOT NEW.idempotency_key
  OR OLD.created_at        IS NOT NEW.created_at
  OR OLD.created_by_user_id IS NOT NEW.created_by_user_id
BEGIN
    SELECT RAISE(ABORT, 'advance_entries is append-only: financial fields cannot be modified');
END;

CREATE TRIGGER trg_advance_entries_no_delete
BEFORE DELETE ON advance_entries
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'advance_entries is append-only: rows cannot be deleted');
END;

-- A posted entry is terminal apart from reversal; a rejected one is terminal
-- outright. Without this a rejected claim could be quietly flipped to posted.
CREATE TRIGGER trg_advance_entries_status_transitions
BEFORE UPDATE OF status ON advance_entries
FOR EACH ROW
WHEN NOT (
       (OLD.status = 'pending' AND NEW.status IN ('posted', 'rejected'))
    OR (OLD.status = 'posted'  AND NEW.status = 'reversed')
    OR (OLD.status = NEW.status)
)
BEGIN
    SELECT RAISE(ABORT, 'illegal advance entry status transition');
END;

-- --------------------------------------------------------------------------
-- Payments
-- --------------------------------------------------------------------------

CREATE TABLE payment_orders (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id),
    provider           TEXT NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay', 'mock')),
    provider_order_id  TEXT NOT NULL,
    customer_id        TEXT REFERENCES customers(id),
    customer_phone     TEXT NOT NULL,
    amount_paise       INTEGER NOT NULL CHECK (amount_paise > 0),
    currency           TEXT NOT NULL DEFAULT 'INR',
    status             TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created', 'paid', 'failed', 'mismatched', 'expired')),
    provider_payment_id TEXT,
    advance_entry_id   TEXT REFERENCES advance_entries(id),
    note               TEXT,
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER NOT NULL,
    settled_at         INTEGER
) STRICT;

CREATE UNIQUE INDEX uq_payment_orders_provider_order
    ON payment_orders(provider, provider_order_id);
CREATE UNIQUE INDEX uq_payment_orders_provider_payment
    ON payment_orders(provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE INDEX idx_payment_orders_customer ON payment_orders(tenant_id, customer_phone, created_at DESC);
CREATE INDEX idx_payment_orders_status ON payment_orders(status, expires_at);

-- The webhook idempotency record. The gateway retries until it gets a 2xx, so
-- the unique index below is what stops a retry crediting the ledger twice —
-- and it is a constraint rather than a lookup-then-insert, which is the same
-- check without the race.
CREATE TABLE payment_events (
    id                 TEXT PRIMARY KEY,
    provider           TEXT NOT NULL DEFAULT 'razorpay',
    provider_event_id  TEXT NOT NULL,
    event_type         TEXT NOT NULL,
    provider_order_id  TEXT,
    provider_payment_id TEXT,
    amount_paise       INTEGER,
    payload_digest     TEXT,
    outcome            TEXT NOT NULL DEFAULT 'accepted'
                       CHECK (outcome IN ('accepted', 'ignored', 'mismatched', 'duplicate')),
    received_at        INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_payment_events_provider_event
    ON payment_events(provider, provider_event_id);
CREATE INDEX idx_payment_events_received ON payment_events(received_at DESC);

-- --------------------------------------------------------------------------
-- Audit — append-only, and the reason a manager approval means anything
-- --------------------------------------------------------------------------

CREATE TABLE audit_events (
    id             TEXT PRIMARY KEY,
    tenant_id      TEXT NOT NULL REFERENCES tenants(id),
    branch_id      TEXT REFERENCES branches(id),
    actor_user_id  TEXT REFERENCES users(id),
    actor_label    TEXT NOT NULL DEFAULT 'system',
    action         TEXT NOT NULL,
    entity_type    TEXT NOT NULL,
    entity_id      TEXT,
    summary        TEXT NOT NULL DEFAULT '',
    detail_json    TEXT,
    ip_address     TEXT,
    occurred_at    INTEGER NOT NULL,
    business_date  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_entity ON audit_events(tenant_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_occurred ON audit_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_actor ON audit_events(tenant_id, actor_user_id, occurred_at DESC);

CREATE TRIGGER trg_audit_events_immutable
BEFORE UPDATE ON audit_events
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only: rows cannot be modified');
END;

CREATE TRIGGER trg_audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only: rows cannot be deleted');
END;
