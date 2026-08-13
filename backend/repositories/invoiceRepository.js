/**
 * ==========================================================================
 * Invoices, their lines and their tenders.
 *
 * SHAPE NOTE. The JSON ledger held one gold item per invoice — purity and
 * weight sat on the sale record itself. The schema has proper lines, because
 * a jewellery invoice with a chain and two bangles is Phase 5's problem and a
 * table that cannot express it would have to be rebuilt. A sale filed today is
 * therefore an invoice with exactly one line, and `toLegacySale()` flattens it
 * back to the shape the Billing Desk, the Reprint Desk and every existing test
 * already speak. The wire contract does not change; only the storage does.
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
            metal_value_paise, making_charge_paise, discount_paise, taxable_amount_paise,
            tax_amount_paise, applied_advance_paise, total_amount_paise,
            tax_percent_bp, tax_mode, idempotency_key, created_by_user_id,
            issued_at, business_date
        ) VALUES (
            @id, @tenantId, @branchId, @invoiceNumber, @financialYear, @sequenceValue,
            @customerId, @customerName, @customerPhone, @state,
            @rateSnapshotId, @rateSource,
            @metalValuePaise, @makingChargePaise, @discountPaise, @taxableAmountPaise,
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
            id, invoice_id, line_number, description, purity, weight_mg, rate_paise_per_g,
            metal_value_paise, making_charge_bp, making_charge_paise, discount_bp, discount_paise,
            taxable_amount_paise, tax_amount_paise, line_total_paise
        ) VALUES (
            @id, @invoiceId, @lineNumber, @description, @purity, @weightMg, @ratePaisePerG,
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
    // Filter parameters only. node:sqlite rejects a named parameter the
    // statement does not reference, so the COUNT query must not be handed the
    // page's limit/offset — they are added for the SELECT alone, below.
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

    const whereSql = where.join(' AND ');
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE ${whereSql}`).get(params).n;
    const rows = db.prepare(`
        SELECT * FROM invoices WHERE ${whereSql}
        ORDER BY issued_at DESC, rowid DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: clampLimit(limit), offset: Math.max(0, Math.trunc(offset) || 0) });

    return { rows, total };
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

/* --------------------------------------------------------------------------
   The legacy projection
   -------------------------------------------------------------------------- */

/**
 * An invoice in the exact shape `sales_YYYY.json` held, so every existing
 * consumer — Billing Desk, Reprint Desk, Return Desk, the customer portal, the
 * diagnostics export and both HTTP test suites — keeps working unchanged.
 *
 * @param {object} invoice header row
 * @param {object[]} [lines] its lines; fetched if omitted
 */
export function toLegacySale(invoice, lines) {
    if (!invoice) return null;
    const rows = lines || linesFor(invoice.id);
    // One line per invoice today (see the shape note at the top). The header
    // fields the JSON ledger kept — purity, weight, rate — come from the first
    // line; a future multi-line invoice will need a richer wire shape, and
    // that is a deliberate Phase 5 decision rather than a silent widening here.
    const first = rows[0] || {};

    return {
        id: invoice.invoice_number,
        timestamp: invoice.issued_at,
        customerName: invoice.customer_name,
        customerPhone: invoice.customer_phone || '',
        purity: first.purity || null,
        weightGrams: first.weight_mg ? round3(first.weight_mg / 1000) : 0,
        goldPricePerGram: first.rate_paise_per_g ? fromPaise(first.rate_paise_per_g) : 0,
        goldRateSource: invoice.rate_source,
        metalValue: fromPaise(invoice.metal_value_paise),
        makingChargePercent: first.making_charge_bp ? round2(first.making_charge_bp / 100) : 0,
        makingChargeAmount: fromPaise(invoice.making_charge_paise),
        taxPercent: round2(invoice.tax_percent_bp / 100),
        taxMode: invoice.tax_mode,
        taxableAmount: fromPaise(invoice.taxable_amount_paise),
        taxAmount: fromPaise(invoice.tax_amount_paise),
        discountPercent: first.discount_bp ? round2(first.discount_bp / 100) : 0,
        discount: fromPaise(invoice.discount_paise),
        appliedAdvance: fromPaise(invoice.applied_advance_paise),
        totalAmount: fromPaise(invoice.total_amount_paise)
    };
}

/* -------------------------------------------------------------------------- */

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
