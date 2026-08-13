/**
 * ==========================================================================
 * Shop-day and financial-year arithmetic.
 *
 * `business_date` is NOT derivable from a timestamp, which is why it is its
 * own column and its own function. A sale rung at 00:30 belongs to the
 * previous shop day, and every report groups by the shop day rather than by
 * UTC midnight. The cut-over hour is a single constant here so the ledger, the
 * reports and the importer cannot each pick a different one.
 *
 * The financial year is India's: 1 April to 31 March. Invoice numbering resets
 * per financial year, so getting this wrong does not produce a slightly odd
 * report — it produces a duplicate invoice number in April.
 * ==========================================================================
 */

/**
 * Hour (local shop time) at which the books roll to the next day. Sales rung
 * before this hour are filed under the previous date. 0 = calendar midnight.
 *
 * Kept at 0 deliberately: the JSON ledger this replaces filed everything by
 * calendar date, and changing the boundary during a data migration would
 * silently re-date historical rows. Phase 5 can make it configurable; until
 * then it must match what the imported history already assumed.
 */
export const DAY_ROLLOVER_HOUR = 0;

function pad(value) {
    return String(value).padStart(2, '0');
}

/**
 * The shop day a moment belongs to, as 'YYYY-MM-DD' in server-local time.
 * @param {number|Date} [at] epoch ms, defaulting to now
 */
export function businessDate(at = Date.now()) {
    const moment = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    if (Number.isNaN(moment.getTime())) {
        throw new Error(`businessDate() needs a valid timestamp, received ${String(at)}`);
    }
    if (DAY_ROLLOVER_HOUR > 0 && moment.getHours() < DAY_ROLLOVER_HOUR) {
        moment.setDate(moment.getDate() - 1);
    }
    return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/**
 * India's financial year for a moment, as 'YYYY-YY' — e.g. 2026-08-11 falls in
 * '2026-27', and 2027-02-11 also falls in '2026-27'.
 */
export function financialYear(at = Date.now()) {
    const moment = at instanceof Date ? new Date(at.getTime()) : new Date(at);
    const year = moment.getFullYear();
    // Months are zero-based: 3 is April.
    const startYear = moment.getMonth() >= 3 ? year : year - 1;
    return `${startYear}-${pad((startYear + 1) % 100)}`;
}

/**
 * The number printed on a document: `GOLD-000042-26`.
 *
 * THE SUFFIX COMES FROM THE FINANCIAL YEAR, NOT THE CALENDAR YEAR, and that is
 * load-bearing rather than cosmetic. Sequences reset per financial year, and a
 * calendar year overlaps TWO of them: January–March 2026 is FY 2025-26 while
 * April–December 2026 is FY 2026-27. Stamping the calendar year on both makes
 * sequence 1 of each render as `-26`, and the two documents collide — the
 * duplicate-invoice-number bug this whole phase exists to eliminate,
 * reintroduced through the formatting.
 *
 * Deriving the suffix from the financial year's OPENING year makes the pair
 * `-25` and `-26`, distinct by construction. `uq_invoices_number` stands behind
 * it, so a future formatting mistake fails an insert rather than issuing a
 * customer a number somebody else already has.
 *
 * Caught by test_repositories.js §12 before any of this reached a route.
 *
 * @param {string} prefix         e.g. 'GOLD' or 'CN'
 * @param {number} sequenceValue  the allocated slot
 * @param {string} fy             'YYYY-YY' as returned by financialYear()
 */
export function documentNumber(prefix, sequenceValue, fy) {
    const openingYear = String(fy).slice(0, 4);
    if (!/^\d{4}$/.test(openingYear)) {
        throw new Error(`documentNumber() needs a 'YYYY-YY' financial year, received "${fy}"`);
    }
    return `${prefix}-${String(sequenceValue).padStart(6, '0')}-${openingYear.slice(-2)}`;
}

/** Epoch-ms bounds of a 'YYYY-MM-DD' shop day, inclusive of the whole day. */
export function businessDateBounds(date) {
    const start = Date.parse(`${date}T00:00:00`);
    const end = Date.parse(`${date}T23:59:59.999`);
    if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(`Not a YYYY-MM-DD business date: ${String(date)}`);
    }
    return { start, end };
}
