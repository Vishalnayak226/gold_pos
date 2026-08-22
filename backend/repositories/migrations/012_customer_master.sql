-- ===========================================================================
-- 012 — Customer master: marketing consent and anonymisation
-- (roadmap Phase 5.5 — "Customer master with consent/preferences,
-- deduplication, correction/export and legally appropriate
-- deletion/anonymisation.")
--
-- WHAT ALREADY EXISTED. `customers` (001_initial_schema.sql) already IS the
-- customer master — every walk-in gets a row via ensureCustomerId(), not
-- just portal logins — and already carries notify_email/notify_push (the
-- transactional-notification prefs a customer sets from their own portal).
-- This migration adds what did not exist yet: an explicit MARKETING consent
-- flag (distinct from those transactional prefs — DPDP-style affirmative
-- consent, off by default, never inferred from notify_email/notify_push),
-- and the one column an anonymised record needs to stay honestly labelled.
--
-- WHY NO "DELETE" PATH. `customerRepository.js`'s own header already
-- documents why rows are never deleted here: invoices, credit notes and
-- advance accounts hold foreign keys onto this table. A financial record is
-- also retained regardless of a deletion request under standard tax-record
-- retention law, and — separately — an invoice already carries its own
-- customer_name/customer_phone snapshot at the time of sale, so scrubbing
-- this table never rewrites a historical invoice. "Deletion" here means
-- anonymising the CUSTOMER record (name/email/login), not the ledger.
-- ===========================================================================

ALTER TABLE customers ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0
    CHECK (marketing_consent IN (0, 1));
ALTER TABLE customers ADD COLUMN consent_updated_at INTEGER;
ALTER TABLE customers ADD COLUMN is_anonymised INTEGER NOT NULL DEFAULT 0
    CHECK (is_anonymised IN (0, 1));

CREATE INDEX idx_customers_tenant_updated ON customers(tenant_id, updated_at DESC);
