-- ===========================================================================
-- 003 — A rejected claim releases its payment reference
--
-- `uq_advance_entries_reference` in 001 made a payment reference unique across
-- every entry regardless of status. That is one step too strict, and it
-- contradicts the rule the JSON layer actually enforced: recordAdvanceDeposit()
-- excluded rejected rows from its duplicate check on purpose.
--
-- The case is ordinary. A customer types their UTR wrongly, the cashier cannot
-- find the transfer and rejects the claim, and the customer resubmits with the
-- correct reference — which may well be the number the first claim should have
-- carried. Under 001's index that resubmission is refused forever, and the only
-- way to take the customer's money is to record it without a reference at all,
-- which defeats the point of having one.
--
-- A rejected claim is, by definition, money the store decided it never
-- received. It has no reference to hold, so it releases it. Every claim that is
-- still pending or already posted keeps the guarantee 001 gave it: one
-- real-world transfer, credited once.
--
-- Caught by test_repositories.js §5 before any of this reached a route.
-- ===========================================================================

DROP INDEX uq_advance_entries_reference;

CREATE UNIQUE INDEX uq_advance_entries_reference
    ON advance_entries(tenant_id, payment_method, reference_id)
    WHERE reference_id IS NOT NULL AND reference_id <> '' AND status <> 'rejected';
