-- ===========================================================================
-- 016 — Billing-linked lot movements, exchange/void links, and cost basis
--
-- The original inventory_movements table is deliberately constrained to the
-- physical-count vocabulary it launched with.  Keep that append-only history
-- intact and add a second append-only ledger for movements caused by legal
-- documents.  Stock is the sum of both ledgers; repositories expose that as
-- one movement stream.
-- ===========================================================================

ALTER TABLE invoice_lines ADD COLUMN inventory_item_id TEXT REFERENCES inventory_items(id);
ALTER TABLE invoice_lines ADD COLUMN inventory_lot_id TEXT REFERENCES inventory_lots(id);

ALTER TABLE inventory_lots ADD COLUMN unit_cost_paise_per_g INTEGER
    CHECK (unit_cost_paise_per_g IS NULL OR unit_cost_paise_per_g >= 0);

ALTER TABLE credit_notes ADD COLUMN is_exchange INTEGER NOT NULL DEFAULT 0
    CHECK (is_exchange IN (0, 1));
ALTER TABLE credit_notes ADD COLUMN exchange_invoice_id TEXT REFERENCES invoices(id);

CREATE UNIQUE INDEX uq_credit_notes_exchange_invoice
    ON credit_notes(exchange_invoice_id) WHERE exchange_invoice_id IS NOT NULL;
CREATE INDEX idx_invoice_lines_inventory_lot ON invoice_lines(inventory_lot_id);

CREATE TABLE inventory_document_movements (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    branch_id       TEXT NOT NULL REFERENCES branches(id),
    item_id         TEXT NOT NULL REFERENCES inventory_items(id),
    lot_id          TEXT NOT NULL REFERENCES inventory_lots(id),

    movement_type   TEXT NOT NULL CHECK (movement_type IN ('sale', 'return', 'void')),
    weight_delta_mg INTEGER NOT NULL CHECK (weight_delta_mg <> 0),
    reason          TEXT,

    invoice_id      TEXT NOT NULL REFERENCES invoices(id),
    invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id),
    credit_note_id  TEXT REFERENCES credit_notes(id),
    reverses_movement_id TEXT REFERENCES inventory_document_movements(id),

    actor_user_id   TEXT NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL,
    business_date   TEXT NOT NULL,

    CHECK (movement_type <> 'sale' OR weight_delta_mg < 0),
    CHECK (movement_type = 'sale' OR weight_delta_mg > 0),
    CHECK (movement_type <> 'return' OR credit_note_id IS NOT NULL),
    CHECK (movement_type <> 'void' OR reverses_movement_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX uq_inventory_document_sale_line
    ON inventory_document_movements(invoice_line_id)
    WHERE movement_type = 'sale';
CREATE UNIQUE INDEX uq_inventory_document_return_note_line
    ON inventory_document_movements(credit_note_id, invoice_line_id)
    WHERE movement_type = 'return';
CREATE UNIQUE INDEX uq_inventory_document_reversal
    ON inventory_document_movements(reverses_movement_id)
    WHERE reverses_movement_id IS NOT NULL;
CREATE INDEX idx_inventory_document_lot
    ON inventory_document_movements(lot_id, created_at);
CREATE INDEX idx_inventory_document_item
    ON inventory_document_movements(tenant_id, item_id, created_at DESC);
CREATE INDEX idx_inventory_document_invoice
    ON inventory_document_movements(invoice_id, created_at);

CREATE TRIGGER trg_inventory_document_movements_immutable
BEFORE UPDATE ON inventory_document_movements
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'inventory_document_movements is append-only: rows cannot be modified');
END;

CREATE TRIGGER trg_inventory_document_movements_no_delete
BEFORE DELETE ON inventory_document_movements
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'inventory_document_movements is append-only: rows cannot be deleted');
END;
