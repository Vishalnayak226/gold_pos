-- ===========================================================================
-- 017 — Indexes for the Phase 44 management-report date-range queries
--
-- settlement()/reconciliation()/profitability() (reportRepository.js) filter
-- invoices by tenant_id + issued_at range; reconciliation()/settlement() also
-- filter payment_orders by tenant_id + created_at range. Neither existing
-- index leads with the column these queries actually range-scan on
-- (idx_invoices_business_date leads with business_date, which these queries
-- never constrain; idx_payment_orders_customer leads with customer_phone),
-- so without these a report run scans the tenant's entire invoice/order
-- history instead of seeking the requested period.
-- ===========================================================================

CREATE INDEX idx_invoices_tenant_issued ON invoices(tenant_id, issued_at);
CREATE INDEX idx_payment_orders_tenant_created ON payment_orders(tenant_id, created_at);
