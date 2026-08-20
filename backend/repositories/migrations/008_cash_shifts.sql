-- ===========================================================================
-- 008 — Cash shifts: open with a float, close with a count, and a variance
-- (roadmap Phase 5.3)
--
-- Was blocked until split tenders existed (2026-08-12) — before that a sale
-- carried no record of HOW it was paid, so a drawer count had nothing to
-- reconcile against. Now that `tenders.method = 'cash'` exists, "expected
-- cash" is answerable: opening float, plus every cash tender and cash
-- advance deposit while the shift was open, minus every cash refund in the
-- same window.
--
-- ONE OPEN SHIFT PER BRANCH. Two concurrently-open shifts on one branch would
-- make "which shift does this cash tender belong to" ambiguous — the same
-- reason `advance_entries` refuses a duplicate reference, expressed here as
-- a partial unique index instead.
--
-- OPENING FACTS ARE IMMUTABLE FROM INSERT; A CLOSED SHIFT IS TERMINAL. A
-- shift's opening float and who opened it cannot be rewritten after the
-- fact, and once closed (counted, variance recorded) it cannot be reopened
-- or edited — a correction is a new shift and a note, never an edit to the
-- historical one, the same posture `advance_entries` takes on a posted entry.
-- ===========================================================================

CREATE TABLE cash_shifts (
    id                   TEXT PRIMARY KEY,
    tenant_id            TEXT NOT NULL REFERENCES tenants(id),
    branch_id            TEXT NOT NULL REFERENCES branches(id),

    status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

    opening_float_paise  INTEGER NOT NULL CHECK (opening_float_paise >= 0),
    opened_by_user_id    TEXT NOT NULL REFERENCES users(id),
    opened_at            INTEGER NOT NULL,
    opening_note         TEXT,

    -- NULL until close.
    counted_cash_paise   INTEGER CHECK (counted_cash_paise IS NULL OR counted_cash_paise >= 0),
    expected_cash_paise  INTEGER,
    variance_paise       INTEGER,
    closed_by_user_id    TEXT REFERENCES users(id),
    closed_at            INTEGER,
    closing_note         TEXT,

    business_date        TEXT NOT NULL,

    CHECK (status <> 'closed' OR (
        counted_cash_paise IS NOT NULL AND expected_cash_paise IS NOT NULL
        AND variance_paise IS NOT NULL AND closed_by_user_id IS NOT NULL AND closed_at IS NOT NULL
    ))
) STRICT;

-- At most one open shift per branch at a time.
CREATE UNIQUE INDEX uq_cash_shifts_one_open_per_branch
    ON cash_shifts(tenant_id, branch_id) WHERE status = 'open';

CREATE INDEX idx_cash_shifts_branch ON cash_shifts(tenant_id, branch_id, opened_at DESC);

CREATE TRIGGER trg_cash_shifts_no_delete
BEFORE DELETE ON cash_shifts
FOR EACH ROW
BEGIN
    SELECT RAISE(ABORT, 'cash_shifts is append-only: rows cannot be deleted');
END;

-- The facts recorded at open time cannot be rewritten after the fact.
CREATE TRIGGER trg_cash_shifts_opening_immutable
BEFORE UPDATE ON cash_shifts
FOR EACH ROW
WHEN OLD.tenant_id            IS NOT NEW.tenant_id
  OR OLD.branch_id            IS NOT NEW.branch_id
  OR OLD.opening_float_paise  IS NOT NEW.opening_float_paise
  OR OLD.opened_by_user_id    IS NOT NEW.opened_by_user_id
  OR OLD.opened_at            IS NOT NEW.opened_at
  OR OLD.business_date        IS NOT NEW.business_date
BEGIN
    SELECT RAISE(ABORT, 'cash_shifts: the opening facts cannot be changed once recorded');
END;

-- Once closed, nothing about the row may change again — not even a second
-- close. The only legitimate write after this trigger fires is the single
-- open -> closed transition itself, which is why this checks OLD.status
-- rather than NEW.status.
CREATE TRIGGER trg_cash_shifts_closed_is_terminal
BEFORE UPDATE ON cash_shifts
FOR EACH ROW
WHEN OLD.status = 'closed'
BEGIN
    SELECT RAISE(ABORT, 'cash_shifts: a closed shift cannot be reopened or edited');
END;
