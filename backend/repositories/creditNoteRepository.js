/**
 * ==========================================================================
 * Credit notes — the reversal document for a returned invoice.
 *
 * An issued invoice is never edited. A return is a NEW document pointing back
 * at the original, which is what makes "how much of this invoice has come
 * back" a query over rows rather than a mutable counter that can disagree with
 * the rows it summarises.
 *
 * As with invoices, `toLegacyReturn()` projects back to the shape
 * `returns_YYYY.json` held so the Return Desk, the credit-note print and the
 * customer portal keep working unchanged.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';
import { fromPaise, round2, round3 } from '../../frontend/js/lib/billingMath.js';

/* --------------------------------------------------------------------------
   Writes
   -------------------------------------------------------------------------- */

export function insertCreditNote(note) {
    assertInTransaction('insertCreditNote');
    getDb().prepare(`
        INSERT INTO credit_notes (
            id, tenant_id, branch_id, credit_note_number, financial_year, sequence_value,
            invoice_id, customer_id, customer_name, customer_phone,
            refund_mode, refund_amount_paise, closes_invoice, advance_entry_id,
            itemised, note, idempotency_key, created_by_user_id, issued_at, business_date
        ) VALUES (
            @id, @tenantId, @branchId, @creditNoteNumber, @financialYear, @sequenceValue,
            @invoiceId, @customerId, @customerName, @customerPhone,
            @refundMode, @refundAmountPaise, @closesInvoice, @advanceEntryId,
            @itemised, @note, @idempotencyKey, @createdByUserId, @issuedAt, @businessDate
        )
    `).run(note);
    return note.id;
}

export function insertCreditNoteLine(line) {
    assertInTransaction('insertCreditNoteLine');
    getDb().prepare(`
        INSERT INTO credit_note_lines (
            id, credit_note_id, invoice_line_id, line_number, purity, weight_mg, rate_paise_per_g,
            metal_value_paise, making_charge_paise, discount_paise, taxable_amount_paise,
            tax_amount_paise, refund_amount_paise
        ) VALUES (
            @id, @creditNoteId, @invoiceLineId, @lineNumber, @purity, @weightMg, @ratePaisePerG,
            @metalValuePaise, @makingChargePaise, @discountPaise, @taxableAmountPaise,
            @taxAmountPaise, @refundAmountPaise
        )
    `).run(line);
    return line.id;
}

/**
 * Links a credit note to the advance entry its gold-mode refund credited.
 * Written after the advance entry exists, inside the same transaction.
 */
export function attachAdvanceEntry(creditNoteId, advanceEntryId) {
    assertInTransaction('attachAdvanceEntry');
    getDb().prepare('UPDATE credit_notes SET advance_entry_id = ? WHERE id = ?')
        .run(advanceEntryId, creditNoteId);
}

/* --------------------------------------------------------------------------
   Reads
   -------------------------------------------------------------------------- */

export function findById(id) {
    return getDb().prepare('SELECT * FROM credit_notes WHERE id = ?').get(id) || null;
}

export function findByNumber(tenantId, number) {
    return getDb().prepare('SELECT * FROM credit_notes WHERE tenant_id = ? AND credit_note_number = ?')
        .get(tenantId, number) || null;
}

export function findByIdempotencyKey(tenantId, key) {
    if (!key) return null;
    return getDb().prepare('SELECT * FROM credit_notes WHERE tenant_id = ? AND idempotency_key = ?')
        .get(tenantId, key) || null;
}

export function linesFor(creditNoteId) {
    return getDb().prepare('SELECT * FROM credit_note_lines WHERE credit_note_id = ? ORDER BY line_number')
        .all(creditNoteId);
}

/** Every line of several credit notes — the batched read a list page needs. */
export function linesForMany(creditNoteIds) {
    if (!creditNoteIds || creditNoteIds.length === 0) return [];
    const placeholders = creditNoteIds.map(() => '?').join(', ');
    return getDb().prepare(
        `SELECT * FROM credit_note_lines WHERE credit_note_id IN (${placeholders}) ORDER BY credit_note_id, line_number`
    ).all(...creditNoteIds);
}

/**
 * How much of one invoice has already gone back — count, weight and rupees.
 *
 * This is the figure every further return is measured against, and it is a
 * SUM over credit-note rows rather than a counter on the invoice, for exactly
 * the reason the JSON version derived it on every read: a stored "returned so
 * far" field is a second source of truth that can drift from the documents.
 */
export function summarizeForInvoice(invoiceId) {
    const row = getDb().prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(cn.refund_amount_paise), 0) AS refunded_paise,
               COALESCE((SELECT SUM(l.weight_mg) FROM credit_note_lines l
                          JOIN credit_notes c ON c.id = l.credit_note_id
                         WHERE c.invoice_id = ?), 0) AS weight_mg
          FROM credit_notes cn WHERE cn.invoice_id = ?
    `).get(invoiceId, invoiceId);

    return {
        count: row.count,
        returnedWeightGrams: round3(row.weight_mg / 1000),
        refundedAmount: fromPaise(row.refunded_paise)
    };
}

/**
 * The same summary for a page of invoices at once, keyed by invoice id.
 *
 * The list routes need return state on every row they show. Asking per row is
 * N+1 queries; this is one. `ids` is a page (at most a couple of hundred), so
 * the generated IN list is bounded.
 */
export function summarizeForInvoices(ids) {
    const summaries = new Map();
    if (!ids || ids.length === 0) return summaries;

    const placeholders = ids.map(() => '?').join(', ');
    const db = getDb();

    // Two flat aggregates rather than one join. Joining notes to their lines
    // and aggregating both sides at once multiplies each note's refund by its
    // line count — the classic fan-out double-count, and one that would inflate
    // every "already refunded" figure the moment a credit note grows a second
    // line in Phase 5.
    const headers = db.prepare(`
        SELECT invoice_id, COUNT(*) AS count, COALESCE(SUM(refund_amount_paise), 0) AS refunded_paise
          FROM credit_notes WHERE invoice_id IN (${placeholders})
         GROUP BY invoice_id
    `).all(...ids);

    const weights = db.prepare(`
        SELECT cn.invoice_id AS invoice_id, COALESCE(SUM(l.weight_mg), 0) AS weight_mg
          FROM credit_note_lines l
          JOIN credit_notes cn ON cn.id = l.credit_note_id
         WHERE cn.invoice_id IN (${placeholders})
         GROUP BY cn.invoice_id
    `).all(...ids);

    const weightByInvoice = new Map(weights.map(row => [row.invoice_id, row.weight_mg]));
    for (const row of headers) {
        summaries.set(row.invoice_id, {
            count: row.count,
            returnedWeightGrams: round3((weightByInvoice.get(row.invoice_id) || 0) / 1000),
            refundedAmount: fromPaise(row.refunded_paise)
        });
    }
    return summaries;
}

/**
 * A page of credit notes, newest first, optionally for one customer.
 * @returns {{rows: object[], total: number}}
 */
export function search({ tenantId, customerPhone = null, invoiceId = null,
                         fromAt = null, toAt = null, limit = 50, offset = 0 }) {
    // Filters only — see the note in invoiceRepository.search().
    const where = ['tenant_id = @tenantId'];
    const params = { tenantId };

    if (customerPhone) { where.push('customer_phone = @customerPhone'); params.customerPhone = customerPhone; }
    if (invoiceId) { where.push('invoice_id = @invoiceId'); params.invoiceId = invoiceId; }
    if (fromAt !== null && fromAt !== undefined) { where.push('issued_at >= @fromAt'); params.fromAt = fromAt; }
    if (toAt !== null && toAt !== undefined) { where.push('issued_at <= @toAt'); params.toAt = toAt; }

    const whereSql = where.join(' AND ');
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM credit_notes WHERE ${whereSql}`).get(params).n;
    const rows = db.prepare(`
        SELECT * FROM credit_notes WHERE ${whereSql}
        ORDER BY issued_at DESC, rowid DESC
        LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: clampLimit(limit), offset: Math.max(0, Math.trunc(offset) || 0) });

    return { rows, total };
}

export function countCreditNotes(tenantId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM credit_notes WHERE tenant_id = ?').get(tenantId).n;
}

export function sumRefunds(tenantId) {
    return getDb().prepare(
        'SELECT COALESCE(SUM(refund_amount_paise), 0) AS total FROM credit_notes WHERE tenant_id = ?'
    ).get(tenantId).total;
}

/** Count and value of credit notes whose idempotency key carries this prefix. */
export function summariseByKeyPrefix(tenantId, prefix) {
    return getDb().prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(refund_amount_paise), 0) AS total_paise
          FROM credit_notes WHERE tenant_id = ? AND idempotency_key LIKE ? || '%'
    `).get(tenantId, prefix);
}

export function highestSequences(tenantId) {
    return getDb().prepare(`
        SELECT branch_id, financial_year, MAX(sequence_value) AS highest
          FROM credit_notes WHERE tenant_id = ?
         GROUP BY branch_id, financial_year
    `).all(tenantId);
}

/* --------------------------------------------------------------------------
   The legacy projection
   -------------------------------------------------------------------------- */

/**
 * A credit note in the exact shape `returns_YYYY.json` held.
 *
 * Everything the JSON row carried is either stored or derivable: the original
 * invoice's timestamp, weight, making-charge and discount percentages and tax
 * configuration all come off the invoice it reverses, rather than being copied
 * onto every credit note.
 *
 * @param {object} note the credit-note header
 * @param {{lines?: object[], invoice?: object, invoiceLines?: object[],
 *          advanceEntry?: object}} [context] pre-fetched to avoid N+1 in lists
 */
export function toLegacyReturn(note, context = {}) {
    if (!note) return null;
    const lines = context.lines || linesFor(note.id);
    const first = lines[0] || {};
    const invoice = context.invoice !== undefined
        ? context.invoice
        : getDb().prepare('SELECT * FROM invoices WHERE id = ?').get(note.invoice_id) || null;
    const invoiceLines = context.invoiceLines
        || (invoice ? getDb().prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_number').all(invoice.id) : []);
    const originalLine = invoiceLines[0] || {};
    const advanceEntry = context.advanceEntry !== undefined
        ? context.advanceEntry
        : (note.advance_entry_id
            ? getDb().prepare('SELECT * FROM advance_entries WHERE id = ?').get(note.advance_entry_id) || null
            : null);

    const itemised = note.itemised === 1;

    return {
        id: note.credit_note_number,
        timestamp: note.issued_at,
        originalInvoiceId: invoice ? invoice.invoice_number : null,
        originalTimestamp: invoice ? invoice.issued_at : null,
        customerName: note.customer_name,
        customerPhone: note.customer_phone || '',
        purity: first.purity || null,
        weightGrams: first.weight_mg ? round3(first.weight_mg / 1000) : 0,
        originalWeightGrams: originalLine.weight_mg ? round3(originalLine.weight_mg / 1000) : 0,
        goldPricePerGram: first.rate_paise_per_g ? fromPaise(first.rate_paise_per_g) : 0,
        makingChargePercent: originalLine.making_charge_bp ? round2(originalLine.making_charge_bp / 100) : 0,
        discountPercent: originalLine.discount_bp ? round2(originalLine.discount_bp / 100) : 0,
        taxPercent: invoice ? round2(invoice.tax_percent_bp / 100) : 0,
        taxMode: invoice ? invoice.tax_mode : 'Exclusive',
        // Null, not zero, when the refund could not be broken down — the credit
        // note then prints the total and says so instead of inventing a GST line.
        metalValue: itemised ? fromPaise(first.metal_value_paise) : null,
        makingChargeAmount: itemised ? fromPaise(first.making_charge_paise) : null,
        discount: itemised ? fromPaise(first.discount_paise) : null,
        taxableAmount: itemised ? fromPaise(first.taxable_amount_paise) : null,
        taxAmount: itemised ? fromPaise(first.tax_amount_paise) : null,
        itemised,
        refundAmount: fromPaise(note.refund_amount_paise),
        refundMode: note.refund_mode,
        closesInvoice: note.closes_invoice === 1,
        note: note.note || '',
        ...(advanceEntry ? {
            advanceCreditId: advanceEntry.id,
            lockedGoldRate22K: advanceEntry.locked_rate_22k_paise_per_g
                ? fromPaise(advanceEntry.locked_rate_22k_paise_per_g)
                : null
        } : {})
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
        throw new Error(`${operation}() must run inside inTransaction(): a credit note and its lines commit together or not at all.`);
    }
}
