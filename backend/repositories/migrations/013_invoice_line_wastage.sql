-- ===========================================================================
-- 013 — Wastage on an invoice line (Phase 41, unit 2 of 6)
--
-- Wastage did not exist anywhere in this codebase before this migration — no
-- field, no helper, no setting, no test (PRODUCTION_READINESS_ROADMAP.md
-- Phase 5's own note). It needed a product decision first: whether wastage is
-- a weight uplift, a percentage of the making charge, or a separate charged
-- line. Decided (owner, 2026-08-21): support all three, selectable per
-- tenant, flagged off by default so an existing invoice_lines row — and the
-- pricing of any sale filed while the flag is off — is untouched.
--
-- Every column here defaults to the "wastage never happened" value, so this
-- is additive with zero migration risk to a live backend/data/ directory:
-- every invoice filed before this migration reads wastage_mode = 'none' and
-- both amounts as 0, which is exactly true of them.
-- ===========================================================================

ALTER TABLE invoice_lines ADD COLUMN wastage_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (wastage_mode IN ('none', 'weight_uplift', 'making_charge_percent', 'separate_line'));

ALTER TABLE invoice_lines ADD COLUMN wastage_weight_mg INTEGER NOT NULL DEFAULT 0
    CHECK (wastage_weight_mg >= 0);

ALTER TABLE invoice_lines ADD COLUMN wastage_amount_paise INTEGER NOT NULL DEFAULT 0
    CHECK (wastage_amount_paise >= 0);
