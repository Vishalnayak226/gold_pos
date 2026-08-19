/**
 * ==========================================================================
 * Invoices, their lines and their tenders.
 *
 * SHAPE NOTE. The JSON ledger began with one gold item per invoice — purity and
 * weight sat on the sale record itself — and the schema was built with proper
 * lines because a jewellery invoice with a chain and two bangles could not be
 * expressed otherwise. The Billing Desk then started filing genuinely
 * multi-line invoices, so `toLegacySale()` no longer flattens: it returns
 * `lines[]`, `tenders[]` and the flat scalar rollup together, which is what a
 * sale record has been on disk since multi-line landed. The wire contract does
 * not change; only the storage does.
 *
 * READS RETURN STORED FACTS. Nothing here recomputes money. A reprint must
 * reproduce the paper that was handed over, so the figures that were printed
 * are the figures that were stored and the figures that come back — even if
 * the tax slab or the gold rate has moved since.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';
import { fromPaise, round2, round3 } from '../../frontend/js/lib/billingMath.js';

/* --------------------------------------------------------------------------
   Writes
   -------------------------------------------------------------------------- */

/**
 * Inserts an invoice header. Must run inside the sale's transaction — the
 * header, its lines, its tenders and any advance redemption are one unit.
 * @param {object} invoice fully-formed row, all money already in paise
 */
export function insertInvoice(invoice) {
    assertInTransaction('insertInvoice');
    getDb().prepare(`
        INSERT INTO invoices (
            id, tenant_id, branch_id, invoice_number, financial_year, sequence_value,
            customer_id, customer_name, customer_phone, state,
            rate_snapshot_id, rate_source,
            metal_value_paise, making_charge_paise, discount_bp, discount_paise, taxable_amount_paise,
            tax_amount_paise, applied_advance_paise, total_amount_paise,
            tax_percent_bp, tax_mode, idempotency_key, created_by_user_id,
            issued_at, business_date
        ) VALUES (
            @id, @tenantId, @branchId, @invoiceNumber, @financialYear, @sequenceValue,
            @customerId, @customerName, @customerPhone, @state,
            @rateSnapshotId, @rateSource,
            @metalValuePaise, @makingChargePaise, @discountBp, @discountPaise, @taxableAmountPaise,
            @taxAmountPaise, @appliedAdvancePaise, @totalAmountPaise,
            @taxPercentBp, @taxMode, @idempotencyKey, @createdByUserId,
            @issuedAt, @businessDate
        )
    `).run(invoice);
    return invoice.id;
}

/** Inserts one line of an invoice. */
export function insertLine(line) {
    assertInTransaction('insertLine');
    getDb().prepare(`
        INSERT INTO invoice_lines (
            id, invoice_id, line_number, description, purity, weight_mg, rate_paise_per_g, rate_source,
            metal_value_paise, making_charge_bp, making_charge_paise, discount_bp, discount_paise,
            taxable_amount_paise, tax_amount_paise, line_total_paise
        ) VALUES (
            @id, @invoiceId, @lineNumber, @description, @purity, @weightMg, @ratePaisePerG, @rateSource,
            @metalValuePaise, @makingChargeBp, @makingChargePaise, @discountBp, @discountPaise,
            @taxableAmountPaise, @taxAmountPaise, @lineTotalPaise
        )
    `).run(line);
    return line.id;
}

/**
 * Inserts one tender. The sale service asserts that posted tenders sum to the
 * invoice total inside the same transaction, so a half-paid invoice cannot be
 * committed.
 */
export function insertTender(tender) {
    assertInTransaction('insertTender');
    getDb().prepare(`
        INSERT INTO tenders (id, invoice_id, method, amount_paise, reference,
                             payment_order_id, advance_entry_id, captured_at, created_by_user_id)
        VALUES (@id, @invoiceId, @method, @amountPaise, @reference,
                @paymentOrderId, @advanceEntryId, @capturedAt, @createdByUserId)
    `).run(tender);
    return tender.id;
}

/**
 * Adds returned weight to a line and moves the invoice's state accordingly.
 *
 * The invoice itself is never rewritten — this touches only the running
 * `returned_weight_mg` counter and the `state` enum, both of which describe
 * what has happened SINCE issue rather than what was issued. The
 * `CHECK (returned_weight_mg <= weight_mg)` on the line is what makes an
 * over-return impossible even if a service check were bypassed.
 */
export function applyReturnToLine(lineId, weightMg) {
    assertInTransaction('applyReturnToLine');
    const result = getDb().prepare(
        'UPDATE invoice_lines SET returned_weight_mg = returned_weight_mg + ? WHERE id = ?'
    ).run(weightMg, lineId);
    if (result.changes !== 1) throw new Error(`No invoice line ${lineId} to return against.`);
}

/** Sets an invoice's state. Legal values are enforced by the schema's CHECK. */
export function setState(invoiceId, state) {
    assertInTransaction('setState');
    const result = getDb().prepare('UPDATE invoices SET state = ? WHERE id = ?').run(state, invoiceId);
    if (result.changes !== 1) throw new Error(`No invoice ${invoiceId} to transition.`);
}

/* --------------------------------------------------------------------------
   Reads
   -------------------------------------------------------------------------- */

/** One invoice header by its internal id, or null. */
export function findById(invoiceId) {
    return getDb().prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) || null;
}

/** One invoice header by the number printed on the paper, or null. */
export function findByNumber(tenantId, invoiceNumber) {
    return getDb().prepare('SELECT * FROM invoices WHERE tenant_id = ? AND invoice_number = ?')
        .get(tenantId, invoiceNumber) || null;
}

/**
 * The invoice a duplicate request already produced, or null.
 *
 * The uniqueness is enforced by `uq_invoices_idempotency`, so this is a
 * fast-path read for returning the original result — not the safety
 * mechanism. A racing duplicate that gets past this read still fails its
 * INSERT, and the service turns that into the same answer.
 */
export function findByIdempotencyKey(tenantId, key) {
    if (!key) return null;
    return getDb().prepare('SELECT * FROM invoices WHERE tenant_id = ? AND idempotency_key = ?')
        .get(tenantId, key) || null;
}

/** Every line of an invoice, in printed order. */
export function linesFor(invoiceId) {
    return getDb().prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_number')
        .all(invoiceId);
}

/**
 * Several invoices at once. Batched because a list screen needs the invoice
 * behind every row it shows, and asking one at a time is the N+1 that makes a
 * paginated endpoint slower than the full-history load it replaced.
 */
export function findMany(invoiceIds) {
    if (!invoiceIds || invoiceIds.length === 0) return [];
    const placeholders = invoiceIds.map(() => '?').join(', ');
    return getDb().prepare(`SELECT * FROM invoices WHERE id IN (${placeholders})`).all(...invoiceIds);
}

/** Every line of several invoices, in invoice then printed order. */
export function linesForMany(invoiceIds) {
    if (!invoiceIds || invoiceIds.length === 0) return [];
    const placeholders = invoiceIds.map(() => '?').join(', ');
    return getDb().prepare(
        `SELECT * FROM invoice_lines WHERE invoice_id IN (${placeholders}) ORDER BY invoice_id, line_number`
    ).all(...invoiceIds);
}

/** Every tender against an invoice, oldest first. */
export function tendersFor(invoiceId) {
    return getDb().prepare('SELECT * FROM tenders WHERE invoice_id = ? ORDER BY captured_at')
        .all(invoiceId);
}

/**
 * Every tender against several invoices. Batched for the same reason
 * `linesForMany` is: a page of 50 invoices must cost one query per child table,
 * not fifty.
 */
export function tendersForMany(invoiceIds) {
    if (!invoiceIds || invoiceIds.length === 0) return [];
    const placeholders = invoiceIds.map(() => '?').join(', ');
    return getDb().prepare(
        `SELECT * FROM tenders WHERE invoice_id IN (${placeholders}) ORDER BY invoice_id, captured_at`
    ).all(...invoiceIds);
}

/**
 * A page of invoices, newest first, with optional text and date filters.
 *
 * PAGINATION IS THE POINT. The route this replaces read every sales partition
 * off disk, concatenated a decade of history into one array and serialised the
 * lot to the browser. Here the database does the filtering and returns at most
 * `limit` rows, plus the total so the UI can say "showing 50 of 8,412".
 *
 * @param {{tenantId: string, q?: string, fromAt?: number|null, toAt?: number|null,
 *          state?: string|null, limit?: number, offset?: number}} query
 * @returns {{rows: object[], total: number}}
 */
export function search({ tenantId, q = '', fromAt = null, toAt = null, state = null,
                         limit = 50, offset = 0 }) {
    const { whereSql, params } = buildInvoiceFilter({ tenantId, q, fromAt, toAt, state });
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE ${whereSql}`).get(params).n;
    const rows = db.prepare(`
        SELECT * FROM invoices WHERE ${whereSql}
        ORDER BY issued_at DESC, rowid DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: clampLimit(limit), offset: Math.max(0, Math.trunc(offset) || 0) });

    return { rows, total };
}

/**
 * The period's aggregates, summed by the database over the whole matched set.
 *
 * SEPARATE FROM THE PAGE, DELIBERATELY. The figures a cashier reads at the top
 * of the ledger — "412 invoices, ₹38,60,240, 5,204.310g" — describe everything
 * the filter matched, not the fifty rows currently on screen. Summing the page
 * would silently report a fraction of the day's takings as the day's takings.
 * Doing it in SQL is also the whole point of the cutover: the route this
 * replaces summed in JavaScript, which required reading every invoice in the
 * range into memory to produce four numbers.
 *
 * Shares its filter construction with `search()` so a query and its totals can
 * never describe different sets of rows.
 */
export function periodTotals({ tenantId, q = '', fromAt = null, toAt = null, state = null }) {
    const { whereSql, params } = buildInvoiceFilter({ tenantId, q, fromAt, toAt, state });
    const row = getDb().prepare(`
        SELECT COUNT(*)                                AS count,
               COALESCE(SUM(total_amount_paise), 0)    AS total_amount_paise,
               COALESCE(SUM(applied_advance_paise), 0) AS applied_advance_paise,
               COALESCE((
                   SELECT SUM(weight_mg) FROM invoice_lines
                    WHERE invoice_id IN (SELECT id FROM invoices WHERE ${whereSql})
               ), 0)                                   AS weight_mg
          FROM invoices WHERE ${whereSql}
    `).get(params);

    return {
        count: row.count,
        totalAmount: fromPaise(row.total_amount_paise),
        appliedAdvance: fromPaise(row.applied_advance_paise),
        weightGrams: round3(row.weight_mg / 1000)
    };
}

/** Invoice count for a tenant. */
export function countInvoices(tenantId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ?').get(tenantId).n;
}

/** Sum of every invoice total in paise. */
export function sumInvoiceTotals(tenantId) {
    return getDb().prepare('SELECT COALESCE(SUM(total_amount_paise), 0) AS total FROM invoices WHERE tenant_id = ?')
        .get(tenantId).total;
}

/**
 * Count and value of invoices carrying an idempotency key with this prefix.
 *
 * The importer reconciles against THIS, not against the whole table. A
 * reconciliation that compares "rows in the JSON file" to "rows in the
 * database" is only true when importing into an empty database — the moment
 * anything else has ever been written it reports a failure that is not one,
 * and an operator who sees a spurious FAIL learns to ignore the report.
 */
export function summariseByKeyPrefix(tenantId, prefix) {
    return getDb().prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(total_amount_paise), 0) AS total_paise
          FROM invoices WHERE tenant_id = ? AND idempotency_key LIKE ? || '%'
    `).get(tenantId, prefix);
}

/** The highest sequence value used per financial year, for sequence recovery. */
export function highestSequences(tenantId) {
    return getDb().prepare(`
        SELECT branch_id, financial_year, MAX(sequence_value) AS highest
          FROM invoices WHERE tenant_id = ?
         GROUP BY branch_id, financial_year
    `).all(tenantId);
}

/**
 * Invoices whose lines no longer sum to their own header — the invariant
 * `test_billing_math.js` §16 asserts at write time, re-checked here against
 * whatever is actually on disk. Should never return rows; existing only to be
 * called periodically is the point (CLAUDE.md §0 "the per-line figures always
 * sum exactly to the header").
 */
export function findLineDrift(tenantId, limit = 5) {
    return getDb().prepare(`
        SELECT i.invoice_number,
               i.taxable_amount_paise AS hdr_taxable,
               i.tax_amount_paise     AS hdr_tax,
               SUM(l.taxable_amount_paise) AS line_taxable,
               SUM(l.tax_amount_paise)     AS line_tax
          FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
         WHERE i.tenant_id = ?
      GROUP BY i.id
        HAVING line_taxable <> hdr_taxable OR line_tax <> hdr_tax
         LIMIT ?
    `).all(tenantId, limit);
}

/* --------------------------------------------------------------------------
   The legacy projection
   -------------------------------------------------------------------------- */

/**
 * An invoice in the exact shape `sales_YYYY.json` held, so every existing
 * consumer — Billing Desk, Reprint Desk, Return Desk, the customer portal, the
 * diagnostics export and both HTTP test suites — keeps working unchanged.
 *
 * BOTH SHAPES AT ONCE, ON PURPOSE (CLAUDE.md §0). The record carries `lines[]`
 * — per item: purity, weight, rate, making charge, discount, and that line's
 * allocated share of the taxable value and GST — *and* the flat scalar rollup
 * it always had. The rollup keeps every pre-multi-line reader working; `lines`
 * is what the invoice actually is. Both are emitted here because this is the
 * one place every read path passes through, so a caller can never see half of
 * the contract.
 *
 * `purity: 'MIXED'` and `goldPricePerGram: 0` are not sentinels. They are what
 * an honest rollup says when the lines disagree, and they must not be
 * "corrected" to line 1's value — a mixed cart has no single purity, and
 * reporting one would be a wrong answer rather than a missing one.
 *
 * @param {object} invoice header row
 * @param {object[]} [lines] its lines; fetched if omitted
 * @param {{tenders?: object[], actor?: {id: string, name: string, role: string}}} [extra]
 *        `tenders` fetched if omitted; `actor` resolved by the caller, which
 *        can batch one users lookup across a whole page instead of one per row.
 */
export function toLegacySale(invoice, lines, extra = {}) {
    if (!invoice) return null;
    const rows = lines || linesFor(invoice.id);
    const tenderRows = extra.tenders || tendersFor(invoice.id);

    // A distinct value if every line agrees on one, otherwise null — the single
    // test behind every rollup field below.
    const agreed = (pick) => {
        const values = [...new Set(rows.map(pick))];
        return values.length === 1 ? values[0] : null;
    };

    const agreedPurity = agreed(row => row.purity);
    const agreedRate = agreed(row => row.rate_paise_per_g);
    const agreedMakingBp = agreed(row => row.making_charge_bp);

    return {
        id: invoice.invoice_number,
        timestamp: invoice.issued_at,
        customerName: invoice.customer_name,
        customerPhone: invoice.customer_phone || '',

        /* THE ITEMS, in printed order. Field-for-field what the JSON ledger
           filed, so `saleLines()` reads this without branching. The money here
           is stored, never recomputed: `metalValue`/`makingChargeAmount` are
           the gross figures the cashier was quoted (which is what `saleLines()`
           prefers and what a per-line return re-prices from), and
           `taxableAmount`/`taxAmount`/`lineTotal` are the shares allocated out
           of the header at issue time — so the rows still sum exactly to the
           total at the bottom, years later, at whatever the slab is today. */
        lines: rows.map(row => ({
            lineNumber: row.line_number,
            description: row.description || '',
            purity: row.purity,
            weightGrams: round3(row.weight_mg / 1000),
            goldPricePerGram: fromPaise(row.rate_paise_per_g),
            goldRateSource: row.rate_source,
            metalValue: fromPaise(row.metal_value_paise),
            grossMetalValue: fromPaise(row.metal_value_paise),
            makingChargePercent: round2(row.making_charge_bp / 100),
            makingChargeAmount: fromPaise(row.making_charge_paise),
            grossMakingCharge: fromPaise(row.making_charge_paise),
            discountPercent: round2(row.discount_bp / 100),
            discountAmount: fromPaise(row.discount_paise),
            taxableAmount: fromPaise(row.taxable_amount_paise),
            taxAmount: fromPaise(row.tax_amount_paise),
            lineTotal: fromPaise(row.line_total_paise),
            returnedWeightGrams: round3((row.returned_weight_mg || 0) / 1000)
        })),

        /* THE ROLLUP. Redundant with `lines` above, and that is the point. */
        purity: rows.length === 0 ? null : (agreedPurity || 'MIXED'),
        weightGrams: round3(rows.reduce((total, row) => total + row.weight_mg, 0) / 1000),
        goldPricePerGram: agreedRate === null ? 0 : fromPaise(agreedRate),
        goldRateSource: invoice.rate_source,
        metalValue: fromPaise(invoice.metal_value_paise),
        makingChargePercent: agreedMakingBp === null ? 0 : round2(agreedMakingBp / 100),
        makingChargeAmount: fromPaise(invoice.making_charge_paise),
        taxPercent: round2(invoice.tax_percent_bp / 100),
        taxMode: invoice.tax_mode,
        taxableAmount: fromPaise(invoice.taxable_amount_paise),
        taxAmount: fromPaise(invoice.tax_amount_paise),
        discountPercent: round2(invoice.discount_bp / 100),
        discount: fromPaise(invoice.discount_paise),
        appliedAdvance: fromPaise(invoice.applied_advance_paise),
        totalAmount: fromPaise(invoice.total_amount_paise),

        /* HOW IT WAS PAID AT THE COUNTER. Empty means "not recorded", never
           "paid nothing" — every invoice filed before tenders existed has none.

           A REDEEMED ADVANCE IS EXCLUDED, deliberately. The schema records it as
           a tender row (linked to the advance entry it spent, which is what
           makes a drawer close reconcilable), but on this record it is already
           `appliedAdvance` above — and the contract for this array is that a
           non-empty one sums to `totalAmount`, which is the figure AFTER the
           advance came off. Listing it here would double-count the customer's
           credit and break exactly the reconciliation the array exists for. */
        tenders: tenderRows
            .filter(row => !row.advance_entry_id)
            .map(row => ({
                method: row.method,
                amount: fromPaise(row.amount_paise),
                reference: row.reference || ''
            })),

        /* WHO BILLED IT. Resolved from created_by_user_id back to the
           `{id, name, role}` an admin session carries, so the wire shape is the
           one the desk has always read. */
        actor: extra.actor || null
    };
}

// Re-exported so a caller holding invoices does not need a second import to
// name who filed them. The implementation lives beside the users table.
export { actorsByUserId } from './userRepository.js';

/* -------------------------------------------------------------------------- */

/**
 * The WHERE clause and its parameters, shared by `search()` and `periodTotals()`.
 *
 * ONE BUILDER, so a page and the totals printed above it can never describe
 * different sets of rows — a filter added to one and forgotten in the other
 * would show a cashier fifty invoices under a heading that counted a different
 * four hundred.
 *
 * Filter parameters only: node:sqlite rejects a named parameter the statement
 * does not reference, so the page's limit/offset are added by the caller for
 * the SELECT alone.
 */
function buildInvoiceFilter({ tenantId, q = '', fromAt = null, toAt = null, state = null }) {
    const where = ['tenant_id = @tenantId'];
    const params = { tenantId };

    if (fromAt !== null && fromAt !== undefined) { where.push('issued_at >= @fromAt'); params.fromAt = fromAt; }
    if (toAt !== null && toAt !== undefined) { where.push('issued_at <= @toAt'); params.toAt = toAt; }
    if (state) { where.push('state = @state'); params.state = state; }

    const term = String(q || '').trim();
    if (term) {
        // Three fields because the cashier has whichever one the customer can
        // produce: the number on the slip, the name, or the phone. Digits-only
        // for the phone so '98765 43210' and '9876543210' both match.
        const digits = term.replace(/\D/g, '');
        params.like = `%${term.toLowerCase()}%`;
        const clauses = [
            'LOWER(invoice_number) LIKE @like',
            'LOWER(customer_name) LIKE @like'
        ];
        if (digits) {
            params.phoneLike = `%${digits}%`;
            clauses.push('customer_phone LIKE @phoneLike');
        }
        where.push(`(${clauses.join(' OR ')})`);
    }

    return { whereSql: where.join(' AND '), params };
}

const MAX_PAGE = 200;

function clampLimit(limit) {
    const n = Math.trunc(Number(limit) || 50);
    if (n < 1) return 1;
    return Math.min(MAX_PAGE, n);
}

function assertInTransaction(operation) {
    if (!inTransactionNow()) {
        throw new Error(`${operation}() must run inside inTransaction(): an invoice and its lines commit together or not at all.`);
    }
}
