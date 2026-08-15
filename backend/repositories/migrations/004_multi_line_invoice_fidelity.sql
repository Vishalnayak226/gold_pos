-- ===========================================================================
-- 004 — What a multi-line invoice needs that 001 could not store
--
-- 001 was written when an invoice held exactly one gold item, and it is honest
-- about that: `toLegacySale()` flattened the single line back onto the header
-- and the shape note called a richer wire contract a later decision. The route
-- made that decision first. `POST /api/sales` has been filing genuine
-- multi-line invoices — each line with its own purity, weight, rate and
-- discount — into `sales_YYYY.json` for some time, which left the SQL side
-- unable to represent a document the JSON side was already writing.
--
-- Two facts had nowhere to live, and both of them are load-bearing:
--
--   rate_source PER LINE. Provenance of the rate a line was priced at — a
--   synced market rate or a counter override. The header carries the invoice's
--   rollup ('auto', 'manual', or 'auto+manual' when they differ), which is
--   enough to notice a mixed invoice and useless for auditing WHICH item was
--   overridden. That is exactly the question an audit asks, so the fact belongs
--   on the row it describes.
--
--   discount_bp ON THE HEADER. The invoice-level discount percentage. Deriving
--   it from line 1 is right only while there is one line: a cart whose lines
--   discount 0%, 5% and 10% has no line whose percentage is the invoice's, and
--   reporting line 1's 0% understates every such document. The paise figure was
--   always stored; only the rate it was struck at was missing.
--
-- Both are ADDITIVE with defaults, so an existing tenant database migrates
-- without a rewrite: every invoice already filed is single-line, its header
-- rate_source is its only line's, and its discount_bp backfills from that line.
-- ===========================================================================

ALTER TABLE invoice_lines ADD COLUMN rate_source TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE invoices ADD COLUMN discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp >= 0);

-- Backfill from what the single-line era already knew. Every row present when
-- this migration runs predates multi-line invoices, so the header's source is
-- its one line's source and that line's discount rate is the invoice's.
UPDATE invoice_lines
   SET rate_source = COALESCE(
       (SELECT i.rate_source FROM invoices i WHERE i.id = invoice_lines.invoice_id),
       'auto'
   );

UPDATE invoices
   SET discount_bp = COALESCE(
       (SELECT l.discount_bp FROM invoice_lines l
         WHERE l.invoice_id = invoices.id
         ORDER BY l.line_number
         LIMIT 1),
       0
   );
