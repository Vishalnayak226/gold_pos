-- ===========================================================================
-- 010 — Invoice delivery status (roadmap Phase 5.3, the last piece of
-- "split tenders, cash shifts/closing, quotes/holds, reprint and delivery")
--
-- Four additive columns on the existing `invoices` table, not a new table —
-- unlike lot inventory / cash shifts / sale drafts earlier this session,
-- delivery is one more fact about an invoice that already exists, not a
-- ledger of its own events. `delivery_status` defaults to 'pending' so
-- every invoice ever filed, before this column existed, reads correctly:
-- nothing was ever marked delivered, which is exactly true.
--
-- Deliberately reversible (marking pending again is a plain UPDATE, no
-- append-only trigger here) — this is operational status, not a financial
-- fact, and a cashier who mis-tapped needs to be able to correct it the
-- same way `credit_notes`/`cash_shifts` never allow but a status flag can.
-- ===========================================================================

ALTER TABLE invoices ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered'));
ALTER TABLE invoices ADD COLUMN delivered_at INTEGER;
ALTER TABLE invoices ADD COLUMN delivered_by_user_id TEXT REFERENCES users(id);
ALTER TABLE invoices ADD COLUMN delivery_note TEXT;

CREATE INDEX idx_invoices_delivery_status ON invoices(tenant_id, delivery_status);
