/**
 * ==========================================================================
 * Returns and refunds.
 *
 * Three rules define this module, unchanged from the JSON implementation
 * because they were the right rules — only the storage under them changed:
 *
 *   1. THE STORE ISSUES RETURNS, NOBODY ELSE. There is no customer-facing way
 *      to raise one; a refund moves money out of the till and that decision is
 *      made at the counter with the goods in hand.
 *   2. THE INVOICE IS NEVER REWRITTEN. A return is a credit note pointing back
 *      at the invoice. The invoice's own figures stay exactly as filed, so a
 *      reprint still reproduces the original document.
 *   3. THE REFUND IS PRICED BY THE OLD INVOICE, NOT BY TODAY. All of that
 *      arithmetic is computeReturnRefund() in billingMath.js, which the Return
 *      Desk previews with and this service re-runs authoritatively.
 *
 * WHAT SQL ADDS. The credit note now carries a sequential, per-financial-year
 * number, because a GST credit note is a numbered document rather than a row
 * with a random id. And the gold-mode advance credit is a row in the same ACID
 * transaction as the credit note, so a crash between them is not expressible.
 * ==========================================================================
 */

import {
    inTransaction, invoices, creditNotes, advances, sequences, audit, customers, inventory,
    dataStoreContext, businessDate, financialYear, documentNumber
} from '../repositories/index.js';
import { newId, logError, logTelemetry } from '../db.js';
import { computeReturnRefund, round2, round3, toPaise } from '../../frontend/js/lib/billingMath.js';
import { DomainRefusal, isUniqueViolation } from './saleService.js';

export const REFUND_MODES = ['cash', 'gold', 'exchange'];

/** The number printed on a credit note: CN-000001-26. */
export const CREDIT_NOTE_PREFIX = 'CN';

/**
 * Files a return against an invoice.
 *
 * @param {object} input
 * @param {string} input.invoiceId    the invoice NUMBER as printed
 * @param {number} input.weightGrams
 * @param {'cash'|'gold'} input.refundMode
 * @param {string} [input.note]
 * @param {string} [input.idempotencyKey]
 * @param {number} [input.lineNumber] which item is coming back; required when the
 *        invoice has more than one, refused rather than guessed
 * @param {object} deps
 * @param {() => object} deps.getActiveGoldRates
 * @param {(phone: string) => boolean} deps.isValidPhone
 * @param {(refundAmount: number) => ({ok: true}|{ok: false, status?: number, error: string, message?: string})}
 *        [deps.authorizeRefund] the store's approval threshold, applied to the
 *        SERVER's priced refund rather than to any figure the client proposed.
 *        Called inside the transaction, so a refusal unwinds rather than
 *        leaving a credit note behind.
 * @returns {{ok: true, returnId: string, return: object, advanceCredit: object|null,
 *            remainingWeightGrams: number, duplicate?: boolean}
 *         |{ok: false, status: number, error: string}}
 */
export function createReturn(input, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    const invoiceNumber = String(input.invoiceId || '').trim();
    if (!invoiceNumber) {
        return { ok: false, status: 400, error: 'An invoice number is required to file a return.' };
    }
    if (!REFUND_MODES.includes(input.refundMode)) {
        return { ok: false, status: 400, error: 'Refund mode must be cash, gold credit, or exchange credit.' };
    }
    const weightGrams = Number(input.weightGrams);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
        return { ok: false, status: 400, error: 'A valid positive return weight is required.' };
    }

    if (input.idempotencyKey) {
        const existing = creditNotes.findByIdempotencyKey(context.tenantId, input.idempotencyKey);
        if (existing) return projectExisting(existing);
    }

    const header = invoices.findByNumber(context.tenantId, invoiceNumber);
    if (!header) {
        return {
            ok: false, status: 404,
            error: `No filed invoice ${invoiceNumber} exists. Only saved invoices can be returned against.`
        };
    }

    // Gold credit has to land in somebody's account, and every customer ledger
    // here is keyed on phone. A walk-in "Cash Sale" filed without one can still
    // be refunded — in cash, over the counter, which is how it was paid.
    if (input.refundMode !== 'cash' && !deps.isValidPhone(header.customer_phone)) {
        return {
            ok: false, status: 400,
            error: 'This invoice has no customer phone number on it, so there is no account to credit. Refund it as cash, or re-file the sale against a customer.'
        };
    }

    try {
        return inTransaction(() => {
            /* Re-read inside the transaction. The prior-returns figure is what
               every further return is measured against, so reading it outside
               would let two simultaneous returns each see "nothing returned
               yet" and together refund more than the invoice was worth. */
            const lines = invoices.linesFor(header.id);
            const sale = invoices.toLegacySale(header, lines);
            const prior = creditNotes.summarizeForInvoice(header.id);

            /* WHICH ITEM IS COMING BACK. On a one-line invoice the caller need
               not say, and every invoice filed before multi-line is one line.
               On a multi-line invoice they must: computeReturnRefund() refuses
               to guess, because pricing a 22K return at an 18K line's rate
               would refund the wrong money — and it would do so quietly. */
            const requestedLine = input.lineNumber === undefined || input.lineNumber === null
                ? null
                : Number(input.lineNumber);
            let originalLine;
            if (requestedLine === null) {
                if (lines.length > 1) {
                    throw new DomainRefusal(400,
                        'This invoice has several items on it. Choose which line is being returned.');
                }
                originalLine = lines[0];
            } else {
                originalLine = lines.find(row => row.line_number === requestedLine);
                if (!originalLine) {
                    throw new DomainRefusal(400, `This invoice has no line ${input.lineNumber}.`);
                }
            }
            if (!originalLine) {
                throw new DomainRefusal(422,
                    `Invoice ${invoiceNumber} has no lines to return against; it cannot be refunded automatically.`);
            }

            /* Measured against THIS LINE's history, not the invoice's. The
               running counter lives on the line precisely so returning the
               chain does not consume the bangles' returnable weight — an
               invoice-wide figure would let a second line be over-returned
               while the CHECK on the first one still passed. */
            const refund = computeReturnRefund({
                sale,
                returnWeightGrams: weightGrams,
                lineNumber: originalLine.line_number,
                alreadyReturnedGrams: (originalLine.returned_weight_mg || 0) / 1000,
                invoiceRemainingGrams: round3(
                    lines.reduce((total, row) => total + (row.weight_mg - (row.returned_weight_mg || 0)), 0) / 1000
                ),
                alreadyRefundedAmount: prior.refundedAmount
            });
            if (!refund.ok) throw new DomainRefusal(400, refund.error);
            if (!(refund.refundAmount > 0)) {
                throw new DomainRefusal(400,
                    'This return prices to a zero refund, so there is nothing to pay back. Check the weight entered.');
            }

            /* APPROVAL THRESHOLD. A refund is the one counter action that takes
               money out of the till on the cashier's own say-so, and it is the
               obvious insider-fraud gap once roles exist.

               Applied HERE, after the server has priced the refund, because the
               amount that matters is the one about to be filed — not one the
               client proposed. Thrown rather than returned so a refusal unwinds
               the credit-note number that was just allocated. */
            if (deps.authorizeRefund) {
                const permitted = deps.authorizeRefund(refund.refundAmount);
                if (!permitted.ok) {
                    throw new DomainRefusal(
                        permitted.status || 403, permitted.error, permitted.code || undefined,
                        permitted.message
                    );
                }
            }

            const now = Date.now();
            const fy = financialYear(now);
            const { sequenceValue } = sequences.allocate({
                tenantId: context.tenantId,
                branchId: context.branchId,
                documentType: 'credit_note',
                financialYear: fy,
                prefix: CREDIT_NOTE_PREFIX
            });
            const creditNoteNumber = documentNumber(CREDIT_NOTE_PREFIX, sequenceValue, fy);
            const creditNoteId = newId('CRN');

            creditNotes.insertCreditNote({
                id: creditNoteId,
                tenantId: context.tenantId,
                branchId: context.branchId,
                creditNoteNumber,
                financialYear: fy,
                sequenceValue,
                invoiceId: header.id,
                customerId: header.customer_id,
                customerName: header.customer_name || 'Cash Sale',
                customerPhone: header.customer_phone || '',
                // Exchange is financially a posted customer credit.  Keep the
                // original constrained refund vocabulary on disk and mark the
                // workflow separately so old readers still understand it.
                refundMode: input.refundMode === 'exchange' ? 'gold' : input.refundMode,
                refundAmountPaise: toPaise(refund.refundAmount),
                closesInvoice: refund.closesInvoice ? 1 : 0,
                advanceEntryId: null,
                itemised: refund.itemised ? 1 : 0,
                isExchange: input.refundMode === 'exchange' ? 1 : 0,
                exchangeInvoiceId: null,
                note: String(input.note || '').trim().slice(0, 300),
                idempotencyKey: input.idempotencyKey || null,
                createdByUserId: actorUserId,
                issuedAt: now,
                businessDate: businessDate(now)
            });

            creditNotes.insertCreditNoteLine({
                id: newId('CLN'),
                creditNoteId,
                invoiceLineId: originalLine.id,
                lineNumber: 1,
                purity: refund.purity,
                weightMg: Math.round(refund.weightGrams * 1000),
                ratePaisePerG: Math.round(refund.goldPricePerGram * 100),
                // Zero rather than null on a non-itemised refund: the columns are
                // NOT NULL, and `itemised = 0` is what tells the projection to
                // report them as unknown instead of as zero. A guessed GST line
                // on a credit note is a statement about a tax period this system
                // never recorded.
                metalValuePaise: refund.itemised ? toPaise(refund.components.metalValue) : 0,
                makingChargePaise: refund.itemised ? toPaise(refund.components.makingChargeAmount) : 0,
                discountPaise: refund.itemised ? toPaise(refund.components.discountAmount) : 0,
                taxableAmountPaise: refund.itemised ? toPaise(refund.components.taxableAmount) : 0,
                taxAmountPaise: refund.itemised ? toPaise(refund.components.taxAmount) : 0,
                refundAmountPaise: toPaise(refund.refundAmount)
            });

            // The running counter on the line, plus the invoice's own state.
            // `CHECK (returned_weight_mg <= weight_mg)` makes an over-return
            // impossible even if the arithmetic above were bypassed.
            invoices.applyReturnToLine(originalLine.id, Math.round(refund.weightGrams * 1000));
            invoices.setState(header.id, refund.closesInvoice ? 'returned' : 'partially_returned');

            if (originalLine.inventory_lot_id) {
                inventory.recordDocumentMovement({
                    tenantId: context.tenantId,
                    lotId: originalLine.inventory_lot_id,
                    movementType: 'return',
                    weightDeltaMg: Math.round(refund.weightGrams * 1000),
                    invoiceId: header.id,
                    invoiceLineId: originalLine.id,
                    creditNoteId,
                    reason: `Return ${creditNoteNumber}`,
                    actorUserId,
                    at: now
                });
            }

            let creditEntry = null;
            if (input.refundMode !== 'cash') {
                const customerId = header.customer_id
                    || customers.ensureCustomerId(context.tenantId, header.customer_phone, header.customer_name);
                const accountId = advances.ensureAccount({
                    tenantId: context.tenantId,
                    customerPhone: header.customer_phone,
                    customerName: header.customer_name,
                    customerId
                });
                const entryId = newId('ADV');
                const activeRates = deps.getActiveGoldRates();

                advances.insertEntry({
                    id: entryId,
                    tenantId: context.tenantId,
                    branchId: context.branchId,
                    accountId,
                    entryType: 'deposit',
                    amountPaise: advances.signedPaise('deposit', refund.refundAmount),
                    // Posted outright, not pending: unlike a customer's claim to
                    // have sent a UPI transfer, this credit was created by the
                    // store itself at the counter. There is nothing left to verify.
                    status: 'posted',
                    paymentMethod: 'return_credit',
                    referenceId: null,
                    source: 'return',
                    lockedRate22kPaisePerG: Math.round(Number(activeRates.price22K) * 100),
                    invoiceId: header.id,
                    creditNoteId,
                    reversesEntryId: null,
                    idempotencyKey: null,
                    createdByUserId: actorUserId,
                    approvedByUserId: actorUserId,
                    approvedAt: now,
                    reviewNote: null,
                    createdAt: now,
                    businessDate: businessDate(now)
                });

                creditNotes.attachAdvanceEntry(creditNoteId, entryId);
                creditEntry = advances.findEntryById(entryId);
            }

            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'counter',
                action: 'RETURN_FILED',
                entityType: 'credit_note',
                entityId: creditNoteId,
                summary: `${creditNoteNumber} refunds ${round2(refund.refundAmount)} against ${invoiceNumber} (${input.refundMode})`,
                detail: {
                    creditNoteNumber,
                    invoiceNumber,
                    weightGrams: refund.weightGrams,
                    refundAmount: refund.refundAmount,
                    refundMode: input.refundMode,
                    closesInvoice: refund.closesInvoice,
                    itemised: refund.itemised
                },
                ipAddress: deps.ipAddress || null,
                occurredAt: now
            });

            const stored = creditNotes.findById(creditNoteId);
            /* Re-read the lines AFTER applyReturnToLine. `lines` above was
               fetched to price the refund and still carries the pre-return
               counters, so projecting from it would report `closesLine: false`
               on the very return that just closed the line — the desk would
               then offer another return against an item with nothing left. */
            const linesAfter = invoices.linesFor(header.id);
            return {
                ok: true,
                returnId: creditNoteNumber,
                return: creditNotes.toLegacyReturn(stored, {
                    invoice: invoices.findById(header.id),
                    invoiceLines: linesAfter,
                    advanceEntry: creditEntry
                }),
                advanceCredit: creditEntry ? advances.toLegacyAdvance(creditEntry) : null,
                // What is left on the LINE just returned against…
                remainingWeightGrams: refund.remainingWeightAfter,
                /* …and on the invoice as a whole. Read back from the lines
                   AFTER `applyReturnToLine` has run, so it reflects what was
                   actually committed rather than a figure computed alongside
                   it — which is the difference between the desk offering a
                   further return that will be refused and one that will not. */
                invoiceRemainingWeightGrams: round3(
                    linesAfter.reduce((total, row) => total + (row.weight_mg - (row.returned_weight_mg || 0)), 0) / 1000
                )
            };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return {
                ok: false, status: err.status, error: err.message,
                // Present only on a coded refusal (the approval threshold), where
                // the desk shows the prose and branches on the code.
                ...(err.detail ? { message: err.detail } : {})
            };
        }
        if (input.idempotencyKey && isUniqueViolation(err)) {
            const existing = creditNotes.findByIdempotencyKey(context.tenantId, input.idempotencyKey);
            if (existing) return projectExisting(existing);
        }
        logError('Return transaction failed and was rolled back: ' + err.message, err.stack);
        return { ok: false, status: 500, error: 'Failed to process the return: ' + err.message };
    }
}

function projectExisting(note) {
    const legacy = creditNotes.toLegacyReturn(note);
    return {
        ok: true,
        duplicate: true,
        returnId: note.credit_note_number,
        return: legacy,
        advanceCredit: note.advance_entry_id ? advances.toLegacyAdvance(advances.findEntryById(note.advance_entry_id)) : null,
        remainingWeightGrams: round2(Math.max(0, (legacy.originalWeightGrams || 0) - (legacy.weightGrams || 0)))
    };
}

/**
 * A page of the returns ledger, newest first.
 * @returns {{results: object[], total: number, limit: number, offset: number}}
 */
export function listReturns({ customerPhone = null, limit = 50, offset = 0, fromAt = null, toAt = null } = {}) {
    const context = dataStoreContext();
    const { rows, total } = creditNotes.search({
        tenantId: context.tenantId, customerPhone, fromAt, toAt, limit, offset
    });
    return {
        results: projectPage(rows),
        total,
        limit: Math.max(1, Math.trunc(Number(limit) || 50)),
        offset: Math.max(0, Math.trunc(Number(offset) || 0))
    };
}

/**
 * Projects a page of credit notes without one query per row.
 *
 * A returns list is exactly where an N+1 hides: each row needs its own lines,
 * the invoice it reverses, that invoice's lines (for the original weight and
 * percentages) and possibly an advance entry. Batched, that is four queries
 * regardless of page size.
 */
export function projectPage(notes) {
    if (!notes || notes.length === 0) return [];

    const linesByNote = groupBy(
        creditNotes.linesForMany(notes.map(note => note.id)),
        row => row.credit_note_id
    );

    const invoiceIds = [...new Set(notes.map(note => note.invoice_id).filter(Boolean))];
    const invoiceById = new Map(invoices.findMany(invoiceIds).map(row => [row.id, row]));
    const invoiceLinesById = groupBy(invoices.linesForMany(invoiceIds), row => row.invoice_id);

    const entryIds = [...new Set(notes.map(note => note.advance_entry_id).filter(Boolean))];
    const entryById = new Map(advances.findEntriesByIds(entryIds).map(row => [row.id, row]));

    return notes.map(note => creditNotes.toLegacyReturn(note, {
        lines: linesByNote.get(note.id) || [],
        invoice: invoiceById.get(note.invoice_id) || null,
        invoiceLines: invoiceLinesById.get(note.invoice_id) || [],
        advanceEntry: note.advance_entry_id ? entryById.get(note.advance_entry_id) || null : null
    }));
}

function groupBy(rows, keyOf) {
    const grouped = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
    }
    return grouped;
}

/** Telemetry helper kept beside its only caller so the string lives once. */
export function logReturnFiled(creditNoteNumber, invoiceNumber, weightGrams, refundAmount, mode) {
    logTelemetry('SAVE_RETURN', 0,
        `Return: ${creditNoteNumber}, Invoice: ${invoiceNumber}, Weight: ${weightGrams}g, Refund: ${refundAmount} (${mode})`);
}
