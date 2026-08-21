-- ===========================================================================
-- 011 — SKU catalogue mechanics: HSN, hallmark/HUID, gross/net/stone weight
-- (roadmap Phase 5.1, the catalogue-metadata half — see 006_lot_inventory.sql's
-- header comment on `sku_code`, which this migration is the "separate slice"
-- that comment already pointed to. `sku_code` itself is untouched: it already
-- exists, is already unique per tenant, and becomes the barcode value.)
--
-- SCOPE. Additive catalogue-description fields only. Deliberately NOT wired
-- into the sale/invoice flow — a Billing Desk line is still typed by staff
-- exactly as before. Auto-filling an invoice line from a catalogue item, or
-- decrementing stock on sale, would touch computeInvoiceTotals, which
-- 006_lot_inventory.sql's own header already calls out as needing its own
-- dedicated pass, not a rider on this one.
--
-- ITEM VS LOT. `purity` already lives on inventory_items (the reusable
-- design), and gross/net/stone weight and HSN follow the same precedent:
-- they are the design's NOMINAL figures, used for the catalogue and the
-- printed price tag — the ACTUAL weight of what's sold is still whatever
-- the scale reads at billing, unchanged. `hallmark_huid` is different: BIS
-- assigns one HUID per physical article, never per design, so it lives on
-- inventory_lots instead — correct when a lot represents one piece (the
-- common case when "+ New Lot" is used for a serialized item), a known
-- simplification when a lot is opened in bulk, exactly like this schema
-- already accepted for weight-only lots (006_lot_inventory.sql's own
-- "WEIGHT ONLY" note).
--
-- CROSS-COLUMN INVARIANTS LIVE IN JS, NOT SQL. SQLite refuses a CHECK added
-- via ALTER TABLE ADD COLUMN if it references any other column in the table
-- — so "net weight cannot exceed gross weight" cannot be a CHECK constraint
-- here. It is enforced in inventoryRepository.js instead, the same choice
-- already made for a lot's non-negative balance.
-- ===========================================================================

ALTER TABLE inventory_items ADD COLUMN hsn_code TEXT;
ALTER TABLE inventory_items ADD COLUMN gross_weight_mg INTEGER CHECK (gross_weight_mg IS NULL OR gross_weight_mg > 0);
ALTER TABLE inventory_items ADD COLUMN net_weight_mg INTEGER CHECK (net_weight_mg IS NULL OR net_weight_mg > 0);
ALTER TABLE inventory_items ADD COLUMN stone_weight_mg INTEGER CHECK (stone_weight_mg IS NULL OR stone_weight_mg >= 0);
ALTER TABLE inventory_items ADD COLUMN stone_value_paise INTEGER CHECK (stone_value_paise IS NULL OR stone_value_paise >= 0);

ALTER TABLE inventory_lots ADD COLUMN hallmark_huid TEXT;

CREATE UNIQUE INDEX uq_inventory_lots_huid
    ON inventory_lots(tenant_id, hallmark_huid)
    WHERE hallmark_huid IS NOT NULL AND hallmark_huid <> '';
