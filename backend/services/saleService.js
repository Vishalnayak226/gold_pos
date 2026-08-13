/**
 * ==========================================================================
 * The sale.
 *
 * ONE TRANSACTION. Invoice-number allocation, the invoice header, its lines,
 * its tenders, the advance redemption and the audit row all commit together or
 * none of them do. The JSON version got close — `writeJSONTransaction` gave
 * all-or-nothing across three files — but it could not make the NUMBER part of
 * that unit: the counter lived in settings.json and was incremented by a
 * read-modify-write, so a failed write silently reissued a number that was
 * already on a customer's slip.
 *
 * WHAT THIS OWNS vs WHAT THE ROUTE OWNS. The route parses and validates HTTP
 * input and chooses status codes. Everything below the parse — the store's
 * rate, the store's tax configuration, the arithmetic, the persistence — is
 * here, so the same sale can be created by a route, a test, or a future
 * offline-sync job without any of them re-deriving the rules.
 *
 * THE MONEY IS ALWAYS THE SERVER'S. The browser's figures are a preview. The
 * rate comes from the store's configured source, the slab and mode come from
 * the store's settings, and a submitted total that disagrees is logged and
 * overridden rather than trusted.
 * ==========================================================================
 */

import {
    inTransaction, invoices, creditNotes, advances, sequences, rates, audit, customers,
    dataStoreContext, businessDate, financialYear, documentNumber
} from '../repositories/index.js';
import { newId, logError, logTelemetry } from '../db.js';
import {
    computeInvoiceTotals, computeMetalValue, normalizeTaxMode,
    round2, toPaise
} from '../../frontend/js/lib/billingMath.js';

const VALID_PURITIES = ['24K', '22K', '18K'];
const PURITY_RATE_KEY = { '24K': 'price24K', '22K': 'price22K', '18K': 'price18K' };

/** Rupees-per-gram → paise-per-gram, the schema's scale for a metal rate. */
function ratePaisePerGram(rupeesPerGram) {
    return Math.round(Number(rupeesPerGram) * 100);
}

/** Grams → milligrams, the schema's scale for a weight. */
function weightMilligrams(grams) {
    return Math.round(Number(grams) * 1000);
}

/** Percent → basis points. 2.5% → 250. */
function basisPoints(percent) {
    return Math.round(Number(percent || 0) * 100);
}

/**
 * Creates a sale.
 *
 * @param {object} input
 * @param {'24K'|'22K'|'18K'} input.purity
 * @param {number} input.weightGrams
 * @param {string} [input.customerName]
 * @param {string} [input.customerPhone]
 * @param {number} [input.makingChargeAmount]
 * @param {number} [input.makingChargePercent] descriptive; printed, not charged
 * @param {number} [input.discountPercent]
 * @param {number} [input.appliedAdvance]
 * @param {number} [input.clientTotal]  what the browser thought, for the mismatch log
 * @param {number} [input.clientRate]   what the browser quoted, for the mismatch log
 * @param {string} [input.idempotencyKey]
 * @param {Array<{method: string, amount: number, reference?: string}>} [input.tenders]
 * @param {object} deps
 * @param {() => object} deps.getActiveGoldRates
 * @param {() => object} deps.getSettings
 * @param {string} [deps.actorUserId]
 * @param {string} [deps.actorLabel]
 * @param {string} [deps.ipAddress]
 * @returns {{ok: true, sale: object, invoiceId: string, totalCorrected: boolean,
 *            rateCorrected: boolean, duplicate?: boolean}
 *         |{ok: false, status: number, error: string, code?: string}}
 */
export function createSale(input, deps) {
    const { getActiveGoldRates, getSettings } = deps;
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    if (!VALID_PURITIES.includes(input.purity)) {
        return { ok: false, status: 400, error: 'A valid purity (24K, 22K, or 18K) is required.' };
    }

    // An idempotency key that has already produced an invoice returns THAT
    // invoice rather than making a second one. The unique index is the actual
    // guarantee (see the catch below); this is the fast path.
    if (input.idempotencyKey) {
        const existing = invoices.findByIdempotencyKey(context.tenantId, input.idempotencyKey);
        if (existing) {
            return {
                ok: true, duplicate: true,
                invoiceId: existing.invoice_number,
                sale: invoices.toLegacySale(existing),
                totalCorrected: false, rateCorrected: false
            };
        }
    }

    const settings = getSettings();
    const taxSlab = Number(settings.goldTaxSlab) || 0;
    const taxMode = normalizeTaxMode(settings.taxMode);

    // The rate is the store's, not the browser's. A tampered payload could
    // otherwise bill 50g of 22K at ₹1/g and file an invoice that is internally
    // consistent and completely wrong.
    const activeRates = getActiveGoldRates();
    const rateKey = PURITY_RATE_KEY[input.purity];
    const rate = Number(activeRates[rateKey]);
    if (!Number.isFinite(rate) || rate <= 0) {
        logError(`Refusing to bill ${input.purity}: the active gold rate is unusable (${activeRates[rateKey]}).`);
        return {
            ok: false, status: 503,
            error: 'The current gold rate is unavailable, so this invoice cannot be priced. Check the gold rate in Settings and retry.'
        };
    }

    const weightGrams = Number(input.weightGrams);
    const metalValue = computeMetalValue(weightGrams, rate);
    const appliedAdvanceRequested = Number(input.appliedAdvance) || 0;
    const customerPhone = input.customerPhone || '';

    if (appliedAdvanceRequested > 0 && !customerPhone) {
        return { ok: false, status: 400, error: 'Customer phone is required when redeeming an advance.' };
    }

    const clientRate = Number(input.clientRate);
    const rateCorrected = Number.isFinite(clientRate) && Math.abs(clientRate - rate) > 0.01;
    if (rateCorrected) {
        logError(
            `Sale rate mismatch — client billed ${input.purity} at ${clientRate}/g, server's active rate is ` +
            `${rate}/g (source: ${activeRates.sources[rateKey]}). Persisting the server rate.`
        );
        logTelemetry('SALE_RATE_MISMATCH', 0, `client: ${clientRate}, server: ${rate}`);
    }

    try {
        return inTransaction(() => {
            /* THE BALANCE CHECK LIVES INSIDE THE TRANSACTION, and that is the
               "reserve funds safely during checkout" requirement in one line.
               `BEGIN IMMEDIATE` takes the write lock before this read, so two
               tills redeeming the same customer's ₹5,000 balance serialise:
               the second one reads the balance the first already spent and is
               refused, instead of both reading ₹5,000 and both redeeming it. */
            let balance = 0;
            let accountId = null;
            if (appliedAdvanceRequested > 0) {
                const summary = advances.summaryForPhone(context.tenantId, customerPhone);
                balance = summary.balance;
                accountId = summary.accountId;
                if (round2(appliedAdvanceRequested) > round2(balance)) {
                    // Thrown rather than returned so the transaction unwinds; caught
                    // and converted back to a 400 below.
                    throw new DomainRefusal(400,
                        `Applied advance exceeds the customer's available balance of ${round2(balance)}.`);
                }
            }

            const totals = computeInvoiceTotals({
                metalValue,
                makingChargeAmount: Number(input.makingChargeAmount) || 0,
                discountPercent: Number(input.discountPercent) || 0,
                taxSlab,
                taxMode,
                appliedAdvance: appliedAdvanceRequested,
                customerAdvanceBalance: balance
            });

            const serverTotal = round2(totals.totalAmount);
            const clientTotal = Number(input.clientTotal);
            const totalCorrected = Number.isFinite(clientTotal) && Math.abs(round2(clientTotal) - serverTotal) > 0.01;
            if (totalCorrected) {
                logError(
                    `Sale total mismatch — client submitted ${round2(clientTotal)}, server computed ${serverTotal} ` +
                    `(taxSlab ${taxSlab}%, taxMode ${taxMode}, discount ${input.discountPercent || 0}%). Persisting the server value.`
                );
                logTelemetry('SALE_TOTAL_MISMATCH', 0, `client: ${round2(clientTotal)}, server: ${serverTotal}`);
            }

            const now = Date.now();
            const fy = financialYear(now);
            const prefix = settings.invoicePrefix || 'GOLD';

            // Seeded from settings.invoiceSeqStart only when this financial year
            // has never issued an invoice, so an install upgrading from the JSON
            // ledger continues its existing series rather than restarting at 1.
            const { sequenceValue } = sequences.allocate({
                tenantId: context.tenantId,
                branchId: context.branchId,
                documentType: 'invoice',
                financialYear: fy,
                prefix,
                startAt: Number(settings.invoiceSeqStart) || 1
            });

            const invoiceNumber = documentNumber(prefix, sequenceValue, fy);
            const invoiceId = newId('INV');

            const rateSnapshotId = rates.snapshotFor({
                tenantId: context.tenantId,
                source: activeRates.sources[rateKey] === 'manual' ? 'override' : 'auto',
                provider: settings.goldApiProvider || null,
                price24K: activeRates.price24K,
                price22K: activeRates.price22K,
                price18K: activeRates.price18K,
                capturedAt: now,
                createdByUserId: actorUserId
            });

            const customerId = customerPhone
                ? customers.ensureCustomerId(context.tenantId, customerPhone, input.customerName)
                : null;

            invoices.insertInvoice({
                id: invoiceId,
                tenantId: context.tenantId,
                branchId: context.branchId,
                invoiceNumber,
                financialYear: fy,
                sequenceValue,
                customerId,
                customerName: input.customerName ? String(input.customerName).slice(0, 200) : 'Cash Sale',
                customerPhone,
                state: 'issued',
                rateSnapshotId,
                rateSource: activeRates.sources[rateKey],
                /* GROSS figures, exactly as the JSON ledger filed them.
                   `totals.components` restates these NET of tax for printing an
                   inclusive-mode invoice whose rows add up; it is a presentation
                   projection, not the filed fact. computeReturnRefund() reads
                   these stored fields back and re-prices a refund from them, so
                   storing the net values here would quietly change what every
                   future return pays out. */
                metalValuePaise: toPaise(metalValue),
                makingChargePaise: toPaise(Number(input.makingChargeAmount) || 0),
                discountPaise: toPaise(totals.discountAmount),
                taxableAmountPaise: toPaise(totals.taxableAmount),
                taxAmountPaise: toPaise(totals.taxAmount),
                appliedAdvancePaise: toPaise(totals.appliedAdvance),
                totalAmountPaise: toPaise(serverTotal),
                taxPercentBp: basisPoints(taxSlab),
                taxMode,
                idempotencyKey: input.idempotencyKey || null,
                createdByUserId: actorUserId,
                issuedAt: now,
                businessDate: businessDate(now)
            });

            invoices.insertLine({
                id: newId('ILN'),
                invoiceId,
                lineNumber: 1,
                description: `${input.purity} gold`,
                purity: input.purity,
                weightMg: weightMilligrams(weightGrams),
                ratePaisePerG: ratePaisePerGram(rate),
                metalValuePaise: toPaise(metalValue),
                makingChargeBp: basisPoints(input.makingChargePercent),
                makingChargePaise: toPaise(Number(input.makingChargeAmount) || 0),
                discountBp: basisPoints(input.discountPercent),
                discountPaise: toPaise(totals.discountAmount),
                taxableAmountPaise: toPaise(totals.taxableAmount),
                taxAmountPaise: toPaise(totals.taxAmount),
                lineTotalPaise: toPaise(totals.totalBeforeAdvance)
            });

            /* The advance redemption, in the same transaction as the invoice it
               pays for. In the JSON ledger these were two files committed
               together, which was the right instinct; here they are two rows in
               one ACID transaction, and the FK from the entry to the invoice
               makes an orphaned redemption unrepresentable rather than merely
               unlikely. */
            let redemptionId = null;
            if (totals.appliedAdvance > 0) {
                accountId = accountId || advances.ensureAccount({
                    tenantId: context.tenantId,
                    customerPhone,
                    customerName: input.customerName || '',
                    customerId
                });
                redemptionId = newId('RED');
                advances.insertEntry({
                    id: redemptionId,
                    tenantId: context.tenantId,
                    branchId: context.branchId,
                    accountId,
                    entryType: 'redeem',
                    amountPaise: advances.signedPaise('redeem', totals.appliedAdvance),
                    status: 'posted',
                    paymentMethod: 'other',
                    referenceId: null,
                    source: 'counter',
                    lockedRate22kPaisePerG: ratePaisePerGram(activeRates.price22K),
                    invoiceId,
                    creditNoteId: null,
                    reversesEntryId: null,
                    idempotencyKey: null,
                    createdByUserId: actorUserId,
                    // A redemption is a cashier-side fact with no separate
                    // approval step, but the schema still insists a posted entry
                    // names someone. That someone is whoever rang the sale.
                    approvedByUserId: actorUserId,
                    approvedAt: now,
                    reviewNote: null,
                    createdAt: now,
                    businessDate: businessDate(now)
                });

                invoices.insertTender({
                    id: newId('TND'),
                    invoiceId,
                    method: 'advance',
                    amountPaise: toPaise(totals.appliedAdvance),
                    reference: null,
                    paymentOrderId: null,
                    advanceEntryId: redemptionId,
                    capturedAt: now,
                    createdByUserId: actorUserId
                });
            }

            /* Other tenders are recorded only when the caller actually knows
               them. The Billing Desk captures a cash/card/UPI split and always
               sends one, but the argument stays optional: every invoice already
               on disk predates tenders, and writing a speculative "cash" tender
               for the balance would be inventing a fact about how the customer
               paid. An absent tender means unknown, not zero. */
            recordSuppliedTenders(input.tenders, {
                invoiceId, actorUserId, now,
                payablePaise: toPaise(serverTotal)
            });

            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'counter',
                action: 'SALE_ISSUED',
                entityType: 'invoice',
                entityId: invoiceId,
                summary: `Invoice ${invoiceNumber} for ${round2(serverTotal)}`,
                detail: {
                    invoiceNumber,
                    totalAmount: serverTotal,
                    appliedAdvance: totals.appliedAdvance,
                    purity: input.purity,
                    weightGrams,
                    ratePerGram: rate,
                    rateSource: activeRates.sources[rateKey],
                    totalCorrected,
                    rateCorrected
                },
                ipAddress: deps.ipAddress || null,
                occurredAt: now
            });

            const header = invoices.findById(invoiceId);
            return {
                ok: true,
                invoiceId: invoiceNumber,
                sale: invoices.toLegacySale(header),
                totalCorrected,
                rateCorrected
            };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { ok: false, status: err.status, error: err.message, code: err.code };
        }
        // A racing duplicate that got past the fast-path read loses its INSERT
        // to uq_invoices_idempotency. That is the same answer, arrived at
        // safely — return the invoice the winner created.
        if (input.idempotencyKey && isUniqueViolation(err)) {
            const existing = invoices.findByIdempotencyKey(context.tenantId, input.idempotencyKey);
            if (existing) {
                return {
                    ok: true, duplicate: true,
                    invoiceId: existing.invoice_number,
                    sale: invoices.toLegacySale(existing),
                    totalCorrected: false, rateCorrected: false
                };
            }
        }
        logError('Sale transaction failed and was rolled back: ' + err.message, err.stack);
        return { ok: false, status: 500, error: 'Failed to process sale transaction: ' + err.message };
    }
}

/**
 * Writes the tenders a caller supplied, insisting they add up.
 *
 * The sum must equal the amount the customer actually had to pay — the
 * advance, recorded separately above, has already reduced it. A supplied set
 * that does not balance is a bug in the caller and rolls the sale back rather
 * than filing an invoice whose payment record disagrees with its total.
 */
function recordSuppliedTenders(tenders, { invoiceId, actorUserId, now, payablePaise }) {
    if (!Array.isArray(tenders) || tenders.length === 0) return;

    let sum = 0;
    for (const tender of tenders) {
        const amountPaise = toPaise(tender.amount);
        if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
            throw new DomainRefusal(400, 'Every tender needs a positive amount.');
        }
        sum += amountPaise;
        invoices.insertTender({
            id: newId('TND'),
            invoiceId,
            method: tender.method,
            amountPaise,
            reference: tender.reference || null,
            paymentOrderId: tender.paymentOrderId || null,
            advanceEntryId: null,
            capturedAt: now,
            createdByUserId: actorUserId
        });
    }

    if (sum !== payablePaise) {
        throw new DomainRefusal(400,
            `Tenders total ${sum / 100} but the invoice is payable at ${payablePaise / 100}.`);
    }
}

/* ==========================================================================
   Reads
   ========================================================================== */

/**
 * A page of invoices with return state attached.
 *
 * PAGINATION IS NOT COSMETIC HERE. The route this replaces read every
 * `sales_YYYY.json` off disk on every request, concatenated the store's entire
 * history into one array and serialised the lot to the browser. On a store with
 * a decade of trading that is the single largest thing the server does, and it
 * gets slower every day it operates. The database now filters and returns one
 * page, plus the total so the UI can say "showing 50 of 8,412".
 *
 * @param {{q?: string, fromAt?: number|null, toAt?: number|null,
 *          limit?: number, offset?: number}} [query]
 * @returns {{results: object[], total: number, limit: number, offset: number, truncated: boolean}}
 */
export function listSales({ q = '', fromAt = null, toAt = null, limit = 50, offset = 0 } = {}) {
    const context = dataStoreContext();
    const { rows, total } = invoices.search({
        tenantId: context.tenantId, q, fromAt, toAt, limit, offset
    });

    const resolvedLimit = Math.max(1, Math.trunc(Number(limit) || 50));
    const resolvedOffset = Math.max(0, Math.trunc(Number(offset) || 0));

    return {
        results: projectSalesPage(rows),
        total,
        limit: resolvedLimit,
        offset: resolvedOffset,
        // Kept for the Reprint Desk, which has always shown a "narrow your
        // search" hint when the result set outran the page it asked for.
        truncated: total > resolvedOffset + rows.length
    };
}

/**
 * Projects a page of invoices to the legacy sale shape with return state.
 *
 * Return state rides along on every row because both the Reprint Desk and the
 * Return Desk search through this one path — it is the same "find the invoice
 * the customer is holding" question — and each needs to know what is still
 * returnable. Three queries for the whole page, not three per row.
 */
export function projectSalesPage(rows) {
    if (!rows || rows.length === 0) return [];

    const ids = rows.map(row => row.id);
    const linesByInvoice = new Map();
    for (const line of invoices.linesForMany(ids)) {
        if (!linesByInvoice.has(line.invoice_id)) linesByInvoice.set(line.invoice_id, []);
        linesByInvoice.get(line.invoice_id).push(line);
    }
    const returnSummaries = creditNotes.summarizeForInvoices(ids);

    return rows.map(row => {
        const sale = invoices.toLegacySale(row, linesByInvoice.get(row.id) || []);
        const summary = returnSummaries.get(row.id)
            || { count: 0, returnedWeightGrams: 0, refundedAmount: 0 };
        const returnableWeightGrams = Math.max(0,
            Math.round((sale.weightGrams - summary.returnedWeightGrams) * 1000) / 1000);

        return {
            ...sale,
            returnedWeightGrams: summary.returnedWeightGrams,
            refundedAmount: summary.refundedAmount,
            returnCount: summary.count,
            returnableWeightGrams,
            fullyReturned: summary.count > 0 && returnableWeightGrams <= 0
        };
    });
}

/** One filed invoice by its printed number, with return state, or null. */
export function findSale(invoiceNumber) {
    const context = dataStoreContext();
    const header = invoices.findByNumber(context.tenantId, invoiceNumber);
    if (!header) return null;
    return projectSalesPage([header])[0];
}

/**
 * A refusal that must unwind the transaction it was raised in.
 *
 * Returning `{ok:false}` from inside `inTransaction()` would COMMIT the
 * partial work — the callback returned normally, so the transaction is
 * considered successful. Throwing is what makes a refusal atomic.
 */
export class DomainRefusal extends Error {
    constructor(status, message, code) {
        super(message);
        this.name = 'DomainRefusal';
        this.status = status;
        this.code = code;
    }
}

/** Whether an error is SQLite refusing a duplicate on a unique index. */
export function isUniqueViolation(err) {
    return Boolean(err) && /UNIQUE constraint failed/i.test(String(err.message || ''));
}
