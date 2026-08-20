-- ===========================================================================
-- 006 — Lot inventory: items, lots, and immutable stock movements
-- (roadmap Phase 5.2, the ungated slice)
--
-- SCOPE. The P2 section of PRODUCTION_READINESS_ROADMAP.md gates "vendor/
-- purchase" and "branch transfer" behind a legal/business definition that has
-- never been made (GST reverse-charge treatment for buying from a vendor or
-- from a customer, inter-GSTIN accounting for moving stock between branches).
-- This migration deliberately stays out of both. Stock can only ever enter or
-- leave through an `opening_balance` or `adjustment` movement — internal
-- facts about what is physically on the shelf, with no tax event of their
-- own — never a `purchase` or `transfer` movement type. Add those only once
-- that business definition exists; this schema does not anticipate their
-- shape.
--
-- NOT WIRED INTO SALES. A sale does not yet decrement stock. Doing so would
-- touch computeInvoiceTotals — this codebase's own "Cost note" on multi-line
-- invoices (PRODUCTION_READINESS_ROADMAP.md) calls it the most-tested
-- function in the tree — and deserves a dedicated pass with its own
-- test_billing_math.js coverage, not a rider on this one.
--
-- LOTS, NOT JUST A RUNNING TOTAL. Each stock-in event (an opening balance, or
-- a count that found more than expected) creates its own `inventory_lots`
-- row, so "which batch is this" stays answerable — the roadmap asks for lot
-- inventory, not a single counter per item. A lot's current weight is
-- SUM(weight_delta_mg) over its own movements, derived rather than stored,
-- the same choice advance_entries made for balances.
--
-- WEIGHT ONLY, MATCHING invoice_lines. No piece-count unit: every physical
-- item here has a weight, gold is priced and moved by weight throughout this
-- codebase already, and inventing a second unit system for accessories can
-- wait until something actually needs it.
-- ===========================================================================

CREATE TABLE inventory_items (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id),
    name         TEXT NOT NULL,
    category     TEXT,
    purity       TEXT NOT NULL CHECK (purity IN ('24K', '22K', '18K')),
    -- Reserved for the barcode/SKU-catalogue slice (roadmap P2, separate from
    -- this one) — not populated or read by anything in this migration.
    sku_code     TEXT,
    is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX uq_inventory_items_sku
    ON inventory_items(tenant_id, sku_code)
    WHERE sku_code IS NOT NULL AND sku_code <> '';
CREATE INDEX idx_inventory_items_tenant ON inventory_items(tenant_id, is_active, name);

CREATE TABLE inventory_lots (
    id                 TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL REFERENCES tenants(id),
    branch_id          TEXT NOT NULL REFERENCES branches(id),
    item_id            TEXT NOT NULL REFERENCES inventory_items(id),
    label              TEXT,
    created_by_user_id TEXT REFERENCES users(id),
    created_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_inventory_lots_item ON inventory_lots(item_id, created_at DESC);
CREATE INDEX idx_inventory_lots_branch ON inventory_lots(tenant_id, branch_id, created_at DESC);

CREATE TABLE inventory_movements (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    item_id         TEXT NOT NULL REFERENCES inventory_items(id),
    lot_id          TEXT NOT NULL REFERENCES inventory_lots(id),

    movement_type   TEXT NOT NULL CHECK (movement_type IN ('opening_balance', 'adjustment')),
    -- Signed, matching advance_entries.amount_paise: a lot's on-hand weight is
    -- SUM(weight_delta_mg) over its movements, never a conditional sum that a
    -- future caller can get the sign wrong on. opening_balance > 0 always (you
    -- cannot open a lot negative); adjustment can go either way (a count found
    -- more, or found less / breakage), enforced not to take any lot negative
    -- — checked in the repository within the same transaction as the insert,
    -- the same place saleService checks an advance redemption against its
    -- balance, since SQLite has no portable way to assert an aggregate in a
    -- row-level trigger.
    weight_delta_mg INTEGER NOT NULL CHECK (weight_delta_mg <> 0),
    reason          TEXT,

    actor_user_id   TEXT NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    business_date   TEXT NOT NULL,

    CHECK (movement_type <> 'opening_balance' OR weight_delta_mg > 0)
) STRICT;

CREATE INDEX idx_inventory_movements_lot ON inventory_movements(lot_id, created_at);
CREATE INDEX idx_inventory_movements_item ON inventory_movements(tenant_id, item_id, created_at DESC);
CREATE INDEX idx_inventory_movements_branch ON inventory_movements(tenant_id, branch_id, created_at DESC);

-- Append-only, matching audit_events: no column here is ever legitimately
-- mutable (there is no status workflow, unlike advance_entries), so the rule
-- is simply "nothing may change after insert."
CREATE TRIGGER trg_inventory_movements_immutable
BEFORE UPDATE ON inventory_movements
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'inventory_movements is append-only: rows cannot be modified');
END;

CREATE TRIGGER trg_inventory_movements_no_delete
BEFORE DELETE ON inventory_movements
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'inventory_movements is append-only: rows cannot be deleted');
END;
