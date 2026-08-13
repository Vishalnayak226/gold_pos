-- ===========================================================================
-- 002 — Credit-note projection fields and the reads the portal actually makes
--
-- Written as a second migration rather than an edit to 001 because 001 has
-- already been applied to developer databases and asserted against by
-- test_schema.js. migrate.js refuses an edited applied migration by name, and
-- that refusal is the mechanism working, not an obstacle to route around.
-- ===========================================================================

-- Whether this credit note's money could be broken down into metal / making /
-- discount / GST lines, or only stated as one refund figure.
--
-- computeReturnRefund() has two paths on purpose: an invoice whose stored
-- figures still reconcile gets a printed breakdown rebuilt through the same
-- pipeline that priced the sale, and one that does not (filed before the tax
-- split was stored, or internally inconsistent) gets a bare total. A guessed
-- GST line on a credit note is a statement about a tax period this system
-- never recorded, so the distinction has to survive into storage rather than
-- being re-derived from whether the component columns happen to be zero.
ALTER TABLE credit_notes ADD COLUMN itemised INTEGER NOT NULL DEFAULT 1
    CHECK (itemised IN (0, 1));

-- The customer portal lists a customer's own returns by phone, and the Return
-- Desk lists the ledger newest-first. Both were full scans; 001 indexed credit
-- notes only by the invoice they reverse.
CREATE INDEX idx_credit_notes_customer
    ON credit_notes(tenant_id, customer_phone, issued_at DESC);
CREATE INDEX idx_credit_notes_issued
    ON credit_notes(tenant_id, issued_at DESC);
