-- ===========================================================================
-- 009 — Sale drafts: quotes and holds (roadmap Phase 5.3)
--
-- NOT a ledger table, unlike every other table this session's phases have
-- added (advance_entries, inventory_movements, cash_shifts — all append-only
-- by trigger). A quote is a price estimate never charged; a hold is a cart
-- paused mid-transaction so the counter is free for the next customer.
-- Neither commits money or stock, so neither gets the immutable treatment —
-- this is scratch state, fully mutable, and deliberately not a financial
-- record. The permanent record is still only ever created by the existing
-- POST /api/sales path when a draft is actually turned into a sale; this
-- table never writes to invoices/invoice_lines/tenders itself.
--
-- The cart is stored as JSON rather than normalized rows, on purpose: a
-- draft is not priced yet (rates and settings can move between saving a
-- quote and resuming it — that is a real quote's whole point), so there is
-- no invoice_lines-shaped row to validate against a CHECK constraint. It is
-- re-priced through the ordinary Billing Desk flow at resume time, using
-- whatever rate is current then.
-- ===========================================================================

CREATE TABLE sale_drafts (
    id                    TEXT PRIMARY KEY,
    tenant_id             TEXT NOT NULL REFERENCES tenants(id),
    branch_id             TEXT NOT NULL REFERENCES branches(id),

    kind                  TEXT NOT NULL CHECK (kind IN ('quote', 'hold')),
    status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resumed', 'discarded')),

    customer_name         TEXT NOT NULL DEFAULT '',
    customer_phone        TEXT NOT NULL DEFAULT '',
    cart_json             TEXT NOT NULL CHECK (json_valid(cart_json)),
    discount_bp           INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp >= 0),
    note                  TEXT,
    -- Mainly for quotes, given gold price volatility — a hold has no natural
    -- expiry of its own. NULL means "no expiry set".
    valid_until           INTEGER,

    created_by_user_id    TEXT NOT NULL REFERENCES users(id),
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    business_date         TEXT NOT NULL,

    resumed_at            INTEGER,
    resumed_by_user_id    TEXT REFERENCES users(id),
    discarded_at          INTEGER,
    discarded_by_user_id  TEXT REFERENCES users(id)
) STRICT;

CREATE INDEX idx_sale_drafts_branch_status ON sale_drafts(tenant_id, branch_id, status, updated_at DESC);
CREATE INDEX idx_sale_drafts_phone ON sale_drafts(tenant_id, customer_phone) WHERE customer_phone <> '';
