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
    inTransaction, invoices, creditNotes, advances, sequences, rates, audit, customers, inventory,
    dataStoreContext, businessDate, financialYear, documentNumber
} from '../repositories/index.js';
import { newId, logError, logTelemetry } from '../db.js';
import {
    computeInvoiceTotals, computeMetalValue, computeWastageAmount, normalizeTaxMode,
    fromPaise, round2, round3, toPaise
} from '../../frontend/js/lib/billingMath.js';

const WASTAGE_MODES = ['weight_uplift', 'making_charge_percent', 'separate_line'];

const VALID_PURITIES = ['24K', '22K', '18K'];
const PURITY_RATE_KEY = { '24K': 'price24K', '22K': 'price22K', '18K': 'price18K' };

/* The sanity limits, and the tender vocabulary, live HERE rather than in the
   route — they are properties of what a sale may be, not of how one arrives
   over HTTP, and a second copy at the boundary is a second thing to keep in
   step (§1). A test, an offline-sync job and the route all get the same
   answer because there is only one implementation to get it from.

   `tenders.method` matches the SQL CHECK exactly, so a tender is a copy rather
   than a translation. */
export const MAX_INVOICE_LINES = 50;
export const MAX_SANE_WEIGHT_GRAMS = 100000;
export const MAX_SANE_AMOUNT = 100000000;
export const TENDER_METHODS = ['cash', 'card', 'upi', 'razorpay', 'advance', 'bank_transfer', 'other'];
export const MAX_TENDERS = 10;

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
 * Prices one requested item against the store's own rate.
 *
 * THE RATE IS THE STORE'S, NOT THE BROWSER'S. A tampered payload could
 * otherwise bill 50g of 22K at ₹1/g and file an invoice that is internally
 * consistent and completely wrong. `clientRate` is kept only long enough to
 * notice a disagreement and is never persisted as money.
 *
 * @returns {{ok: true, line: object}|{ok: false, status?: number, error: string}}
 */
function priceLine(raw, index, activeRates, settings) {
    const where = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
        return { ok: false, status: 400, error: `${where} is not a valid item.` };
    }
    if (!VALID_PURITIES.includes(raw.purity)) {
        return { ok: false, status: 400, error: `${where} needs a valid purity (24K, 22K, or 18K).` };
    }

    const weightGrams = Number(raw.weightGrams);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
        return { ok: false, status: 400, error: `${where} needs a positive gold weight.` };
    }
    if (weightGrams > MAX_SANE_WEIGHT_GRAMS) {
        return { ok: false, status: 400, error: `${where} exceeds the ${MAX_SANE_WEIGHT_GRAMS}g limit.` };
    }

    const makingChargeAmount = raw.makingChargeAmount === undefined ? 0 : Number(raw.makingChargeAmount);
    if (!Number.isFinite(makingChargeAmount) || makingChargeAmount < 0) {
        return { ok: false, status: 400, error: `${where} has an invalid making charge.` };
    }
    const makingChargePercent = raw.makingChargePercent === undefined ? 0 : Number(raw.makingChargePercent);
    if (!Number.isFinite(makingChargePercent) || makingChargePercent < 0 || makingChargePercent > 100) {
        return { ok: false, status: 400, error: `${where} has an invalid making charge percent.` };
    }
    const discountPercent = raw.discountPercent === undefined ? 0 : Number(raw.discountPercent);
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        return { ok: false, status: 400, error: `${where} has a discount outside 0–100%.` };
    }

    const inventoryItemId = String(raw.inventoryItemId || '').trim() || null;
    const inventoryLotId = String(raw.inventoryLotId || '').trim() || null;
    if ((inventoryItemId && !inventoryLotId) || (!inventoryItemId && inventoryLotId)) {
        return { ok: false, status: 400, error: `${where} must identify both its catalogue item and stock lot.` };
    }

    const rateKey = PURITY_RATE_KEY[raw.purity];
    const ratePerGram = Number(activeRates[rateKey]);
    if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
        logError(`Refusing to bill ${raw.purity}: the active gold rate is unusable (${activeRates[rateKey]}).`);
        return {
            ok: false, status: 503,
            error: 'The current gold rate is unavailable, so this invoice cannot be priced. Check the gold rate in Settings and retry.'
        };
    }

    /* WASTAGE IS A STORE-WIDE POLICY, NOT A CLIENT-SUPPLIED FIGURE.
       Same posture as the tax slab and tax mode above: when
       settings.wastageEnabled is true, every line is charged using the
       tenant's configured mode and percentage — never a value the request
       body proposes — so a tampered payload cannot invent or inflate a
       wastage charge. Off (the default) leaves every line at
       mode 'none' / 0 / 0, identical to a build that never had wastage. */
    let wastageMode = 'none';
    let wastageWeightGrams = 0;
    let wastageAmount = 0;
    if (settings && settings.wastageEnabled === true) {
        wastageMode = WASTAGE_MODES.includes(settings.wastageMode) ? settings.wastageMode : 'weight_uplift';
        const wastage = computeWastageAmount({
            mode: wastageMode,
            weightGrams,
            ratePerGram,
            makingChargeAmount: round2(makingChargeAmount),
            wastagePercent: settings.wastagePercent
        });
        wastageWeightGrams = wastage.wastageWeightGrams;
        wastageAmount = wastage.wastageAmount;
    }

    return {
        ok: true,
        line: {
            lineNumber: index + 1,
            description: String(raw.description || '').trim().slice(0, 120),
            inventoryItemId,
            inventoryLotId,
            purity: raw.purity,
            weightGrams,
            goldPricePerGram: ratePerGram,
            goldRateSource: activeRates.sources[rateKey],
            metalValue: computeMetalValue(weightGrams, ratePerGram),
            makingChargePercent,
            makingChargeAmount: round2(makingChargeAmount),
            wastageMode,
            wastageWeightGrams,
            wastageAmount,
            discountPercent,
            /* What the cashier's screen quoted for this line, kept only to
               detect and log a disagreement — never persisted as money. The
               Billing Desk sends it as `goldPricePerGram` (the rate it printed
               on the cart row); a direct service caller names it `clientRate`.
               Both are the same claim, so both are read. */
            clientRate: raw.goldPricePerGram === undefined
                ? Number(raw.clientRate)
                : Number(raw.goldPricePerGram)
        }
    };
}

/**
 * Creates a sale.
 *
 * ONE OR MANY ITEMS, ONE CODE PATH. `input.lines` is the multi-item form; the
 * flat `purity`/`weightGrams` form is normalised into a one-line cart before
 * anything else happens, so a single-item sale prices to the paise exactly as
 * it did before lines existed (asserted in `test_billing_math.js` §16) and
 * there is no second arithmetic path to keep in step.
 *
 * @param {object} input
 * @param {Array<object>} [input.lines] per item: purity, weightGrams, makingChargeAmount,
 *        makingChargePercent, discountPercent, description
 * @param {'24K'|'22K'|'18K'} [input.purity]      single-item form
 * @param {number} [input.weightGrams]            single-item form
 * @param {string} [input.customerName]
 * @param {string} [input.customerPhone]
 * @param {number} [input.makingChargeAmount]
 * @param {number} [input.makingChargePercent] descriptive; printed, not charged
 * @param {number} [input.discountPercent] invoice-level; a line without its own inherits it
 * @param {number} [input.appliedAdvance]
 * @param {number} [input.clientTotal]  what the browser thought, for the mismatch log
 * @param {string} [input.idempotencyKey]
 * @param {Array<{method: string, amount: number, reference?: string}>} [input.tenders]
 * @param {object} deps
 * @param {() => object} deps.getActiveGoldRates
 * @param {() => object} deps.getSettings
 * @param {string} [deps.actorUserId]
 * @param {{id: string, name: string, role: string}} [deps.actor] echoed onto the record
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

    // An idempotency key that has already produced an invoice returns THAT
    // invoice rather than making a second one. The unique index is the actual
    // guarantee (see the catch below); this is the fast path.
    if (input.idempotencyKey) {
        const existing = invoices.findByIdempotencyKey(context.tenantId, input.idempotencyKey);
        if (existing) return duplicateResult(existing);
    }

    const settings = getSettings();

    /* `Number(x) || 0` on its own read a non-numeric slab as 0 and SILENTLY
       STOPPED CHARGING GST, and passed a negative or absurd one straight
       through to be stamped on the record as `taxPercent` — which is what a
       later return re-prices itself from. Clamped to the 0–100 a slab can
       actually be. POST /api/settings refuses these on the way in, but a
       restored backup or a hand-edited file has no such gate, and this is the
       last point before the figure becomes a permanent ledger fact. */
    const rawSlab = Number(settings.goldTaxSlab);
    const taxSlab = Number.isFinite(rawSlab) ? Math.min(100, Math.max(0, rawSlab)) : 0;
    if (Number.isFinite(rawSlab) ? rawSlab !== taxSlab : settings.goldTaxSlab !== undefined) {
        logError(
            `Configured GST slab ${JSON.stringify(settings.goldTaxSlab)} is not a usable percentage; `
            + `billing this invoice at ${taxSlab}%. Correct it in Settings.`
        );
    }
    // Canonicalised through the shared helper, so a settings.json written by an
    // older build, edited by hand, or restored from a backup with 'inclusive'
    // in it cannot leave the server billing Exclusive while the browser bills
    // Inclusive.
    const taxMode = normalizeTaxMode(settings.taxMode);

    /* The cart. Fetched once for the whole invoice so every line on one
       document is priced against the same rate snapshot, rather than a midnight
       sync landing between line 2 and line 3. */
    const activeRates = getActiveGoldRates();
    const requested = Array.isArray(input.lines) && input.lines.length > 0
        ? input.lines
        : [{
            purity: input.purity,
            weightGrams: input.weightGrams,
            goldPricePerGram: input.goldPricePerGram,
            clientRate: input.clientRate,
            makingChargeAmount: input.makingChargeAmount,
            makingChargePercent: input.makingChargePercent,
            discountPercent: input.discountPercent,
            description: input.description,
            inventoryItemId: input.inventoryItemId,
            inventoryLotId: input.inventoryLotId
        }];

    if (requested.length > MAX_INVOICE_LINES) {
        return { ok: false, status: 400, error: `An invoice may hold at most ${MAX_INVOICE_LINES} items.` };
    }

    const saleLineItems = [];
    for (const [i, raw] of requested.entries()) {
        const priced = priceLine(raw, i, activeRates, settings);
        if (!priced.ok) return { ok: false, status: priced.status || 400, error: priced.error };
        saleLineItems.push(priced.line);
    }

    const totalWeight = round3(saleLineItems.reduce((total, l) => total + l.weightGrams, 0));
    if (totalWeight > MAX_SANE_WEIGHT_GRAMS) {
        return {
            ok: false, status: 400,
            error: `The invoice totals ${totalWeight}g, over the ${MAX_SANE_WEIGHT_GRAMS}g per-invoice limit.`
        };
    }

    const invoiceDiscountPercent = Number(input.discountPercent) || 0;
    const appliedAdvanceRequested = Number(input.appliedAdvance) || 0;
    const customerPhone = input.customerPhone || '';

    if (appliedAdvanceRequested > 0 && !customerPhone) {
        return { ok: false, status: 400, error: 'Customer phone is required when redeeming an advance.' };
    }

    // The cashier quoted a rate on screen, per line. If any of them moved
    // between then and Save, the server's figure is what gets filed and the
    // desk is told, so it can reprint rather than hand over a slip that
    // disagrees with the ledger.
    const rateCorrected = saleLineItems.some(l =>
        Number.isFinite(l.clientRate) && Math.abs(l.clientRate - l.goldPricePerGram) > 0.01
    );
    if (rateCorrected) {
        for (const l of saleLineItems) {
            if (!Number.isFinite(l.clientRate) || Math.abs(l.clientRate - l.goldPricePerGram) <= 0.01) continue;
            logError(
                `Sale rate mismatch — client billed line ${l.lineNumber} (${l.purity}) at ${l.clientRate}/g, ` +
                `server's active rate is ${l.goldPricePerGram}/g (source: ${l.goldRateSource}). Persisting the server rate.`
            );
            logTelemetry('SALE_RATE_MISMATCH', 0, `client: ${l.clientRate}, server: ${l.goldPricePerGram}`);
        }
    }
    // Only ever needed for that comparison — not a money field, never stored.
    saleLineItems.forEach(l => { delete l.clientRate; });

    try {
        return inTransaction(() => {
            /* Catalogue-linked lines reserve their exact lot under the same
               BEGIN IMMEDIATE lock as the invoice.  A scan is convenience;
               these checks are the authority, so a stale browser cannot sell
               a disabled item, another branch's lot, or weight that is no
               longer on hand. */
            const reservedByLot = new Map();
            for (const line of saleLineItems) {
                if (!line.inventoryLotId) continue;
                const item = inventory.getItem(context.tenantId, line.inventoryItemId);
                const lot = inventory.getLot(context.tenantId, line.inventoryLotId);
                if (!item || item.is_active !== 1) {
                    throw new DomainRefusal(409, `Line ${line.lineNumber}'s catalogue item is no longer active.`);
                }
                if (!lot || lot.item_id !== item.id || lot.branch_id !== context.branchId) {
                    throw new DomainRefusal(409, `Line ${line.lineNumber}'s stock lot is unavailable at this branch.`);
                }
                if (item.purity !== line.purity) {
                    throw new DomainRefusal(409, `Line ${line.lineNumber}'s purity no longer matches its catalogue item.`);
                }
                const requestedMg = weightMilligrams(line.weightGrams);
                const reservedMg = (reservedByLot.get(lot.id) || 0) + requestedMg;
                if (lot.balance_mg < reservedMg) {
                    throw new DomainRefusal(409,
                        `Lines using lot ${lot.id} need ${round3(reservedMg / 1000)}g in total, but it has only ${round3(lot.balance_mg / 1000)}g on hand.`,
                        'INSUFFICIENT_STOCK');
                }
                reservedByLot.set(lot.id, reservedMg);
            }

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
                lines: saleLineItems.map(l => ({
                    metalValue: l.metalValue,
                    makingChargeAmount: l.makingChargeAmount,
                    wastageAmount: l.wastageAmount,
                    discountPercent: l.discountPercent
                })),
                discountPercent: invoiceDiscountPercent,
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

            /* The last point before a number is stamped into a permanent,
               legally-relevant ledger. POST /api/settings type-checks both of
               these on the way in, but a settings.json can also arrive from a
               restored backup, a hand edit, or an older build:
                 - a string sequence made `startSeq + 1` a string
                   CONCATENATION, so the series ran 10 → 101 → 1011;
                 - a non-numeric one produced invoice "GOLD-000abc-26";
                 - an object prefix produced "[object Object]-000011-26", and
                   one with a non-callable toString threw on every sale. */
            const rawPrefix = settings.invoicePrefix;
            const prefix = typeof rawPrefix === 'string' && /^[A-Za-z0-9_-]+$/.test(rawPrefix.trim())
                ? rawPrefix.trim()
                : 'GOLD';
            const rawSeq = Number(settings.invoiceSeqStart);
            const startSeq = Number.isInteger(rawSeq) && rawSeq >= 1 ? rawSeq : 1;
            if (prefix !== rawPrefix || startSeq !== settings.invoiceSeqStart) {
                logError(
                    `Invoice numbering settings were unusable and have been corrected — `
                    + `prefix ${JSON.stringify(rawPrefix)} → ${JSON.stringify(prefix)}, `
                    + `sequence ${JSON.stringify(settings.invoiceSeqStart)} → ${startSeq}.`
                );
            }

            // Seeded from settings.invoiceSeqStart only when this financial year
            // has never issued an invoice, so an install upgrading from the JSON
            // ledger continues its existing series rather than restarting at 1.
            const { sequenceValue } = sequences.allocate({
                tenantId: context.tenantId,
                branchId: context.branchId,
                documentType: 'invoice',
                financialYear: fy,
                prefix,
                startAt: startSeq
            });

            const invoiceNumber = documentNumber(prefix, sequenceValue, fy);
            const invoiceId = newId('INV');

            let exchangeNote = null;
            if (input.exchangeCreditNoteId) {
                exchangeNote = creditNotes.findByNumber(context.tenantId, String(input.exchangeCreditNoteId).trim());
                if (!exchangeNote || exchangeNote.is_exchange !== 1 || exchangeNote.exchange_invoice_id) {
                    throw new DomainRefusal(409, 'That exchange credit is invalid or has already been used.');
                }
                if (!customerPhone || exchangeNote.customer_phone !== customerPhone) {
                    throw new DomainRefusal(400, 'The replacement sale must use the same customer phone as the exchange return.');
                }
                if (!(appliedAdvanceRequested > 0)) {
                    throw new DomainRefusal(400, 'Apply some of the exchange credit before filing the replacement invoice.');
                }
            }

            // Provenance of the rates this invoice was priced at. A single
            // source when every line agrees, 'auto+manual' when they do not —
            // enough for an audit to notice a mixed invoice, with the per-line
            // truth stored on each line itself.
            const rateSources = [...new Set(saleLineItems.map(l => l.goldRateSource))];
            const invoiceRateSource = rateSources.join('+');

            const rateSnapshotId = rates.snapshotFor({
                tenantId: context.tenantId,
                source: rateSources.includes('manual') ? 'override' : 'auto',
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
                rateSource: invoiceRateSource,
                /* GROSS figures, exactly as the JSON ledger filed them.
                   `totals.components` restates these NET of tax for printing an
                   inclusive-mode invoice whose rows add up; it is a presentation
                   projection, not the filed fact. computeReturnRefund() reads
                   these stored fields back and re-prices a refund from them, so
                   storing the net values here would quietly change what every
                   future return pays out. */
                metalValuePaise: toPaise(totals.components.grossMetalValue),
                makingChargePaise: toPaise(totals.components.grossMakingCharge),
                discountBp: basisPoints(invoiceDiscountPercent),
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

            /* THE ITEMS. Each line stores the GROSS figures the cashier was
               quoted plus its allocated share of the invoice's taxable value
               and GST — `totals.lines[i]`, which `allocateLines()` guarantees
               sums back to the header exactly, at any slab and in either tax
               mode. That identity is what makes the printed rows add up to the
               total at the bottom, and it is asserted in
               `test_billing_math.js` §16. */
            saleLineItems.forEach((line, i) => {
                const allocated = totals.lines[i];
                const invoiceLineId = newId('ILN');
                invoices.insertLine({
                    id: invoiceLineId,
                    invoiceId,
                    lineNumber: line.lineNumber,
                    description: line.description || `${line.purity} gold`,
                    inventoryItemId: line.inventoryItemId,
                    inventoryLotId: line.inventoryLotId,
                    purity: line.purity,
                    weightMg: weightMilligrams(line.weightGrams),
                    ratePaisePerG: ratePaisePerGram(line.goldPricePerGram),
                    rateSource: line.goldRateSource,
                    metalValuePaise: toPaise(allocated.grossMetalValue),
                    makingChargeBp: basisPoints(line.makingChargePercent),
                    makingChargePaise: toPaise(allocated.grossMakingCharge),
                    wastageMode: line.wastageMode,
                    wastageWeightMg: weightMilligrams(line.wastageWeightGrams),
                    wastageAmountPaise: toPaise(allocated.grossWastageAmount),
                    discountBp: basisPoints(allocated.discountPercent),
                    // The line's gross discount, matching the gross metal and
                    // making figures beside it. `allocated.discountAmount` is
                    // the net-of-tax restatement and would not reconcile with
                    // them.
                    discountPaise: toPaise(round2(allocated.preTaxTotal * (allocated.discountPercent / 100))),
                    taxableAmountPaise: toPaise(allocated.taxableAmount),
                    taxAmountPaise: toPaise(allocated.taxAmount),
                    lineTotalPaise: toPaise(allocated.lineTotal)
                });

                if (line.inventoryLotId) {
                    inventory.recordDocumentMovement({
                        tenantId: context.tenantId,
                        lotId: line.inventoryLotId,
                        movementType: 'sale',
                        weightDeltaMg: -weightMilligrams(line.weightGrams),
                        invoiceId,
                        invoiceLineId,
                        reason: `Sale ${invoiceNumber}`,
                        actorUserId,
                        at: now
                    });
                }
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

            if (exchangeNote) creditNotes.attachExchangeInvoice(exchangeNote.id, invoiceId);

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
                    lineCount: saleLineItems.length,
                    // The rollup an audit reads at a glance — 'MIXED' and a 0
                    // rate where the lines genuinely disagree, per-line detail
                    // on the lines themselves.
                    purity: [...new Set(saleLineItems.map(l => l.purity))].length === 1
                        ? saleLineItems[0].purity : 'MIXED',
                    weightGrams: round2(saleLineItems.reduce((t, l) => t + l.weightGrams, 0)),
                    ratePerGram: [...new Set(saleLineItems.map(l => l.goldPricePerGram))].length === 1
                        ? saleLineItems[0].goldPricePerGram : 0,
                    rateSource: invoiceRateSource,
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
                sale: invoices.toLegacySale(header, invoices.linesFor(invoiceId), {
                    tenders: invoices.tendersFor(invoiceId),
                    actor: deps.actor || null
                }),
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
            if (existing) return duplicateResult(existing);
        }
        logError('Sale transaction failed and was rolled back: ' + err.message, err.stack);
        return { ok: false, status: 500, error: 'Failed to process sale transaction: ' + err.message };
    }

    /**
     * The answer a duplicate request gets: the invoice the first one filed,
     * projected exactly as a fresh sale would be. Nested so both the fast-path
     * read and the unique-violation catch return an identical shape — they are
     * the same answer reached two ways, and a caller must not be able to tell.
     */
    function duplicateResult(existing) {
        return {
            ok: true, duplicate: true,
            invoiceId: existing.invoice_number,
            sale: invoices.toLegacySale(existing, invoices.linesFor(existing.id), {
                tenders: invoices.tendersFor(existing.id),
                actor: invoices.actorsByUserId([existing.created_by_user_id]).get(existing.created_by_user_id) || null
            }),
            totalCorrected: false, rateCorrected: false
        };
    }
}

/**
 * Same-business-date void.  Nothing is erased: the invoice changes state,
 * redeemed customer credit gets an opposite entry, and each sale stock
 * movement gets a linked void movement in one transaction.
 */
export function voidSale(invoiceNumber, reason, deps = {}) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;
    const cleanNumber = String(invoiceNumber || '').trim();
    const cleanReason = String(reason || '').trim();
    if (!cleanNumber) return { ok: false, status: 400, error: 'Invoice number is required.' };
    if (cleanReason.length < 5 || cleanReason.length > 300) {
        return { ok: false, status: 400, error: 'Cancellation reason must be 5–300 characters.' };
    }

    try {
        return inTransaction(() => {
            const header = invoices.findByNumber(context.tenantId, cleanNumber);
            if (!header) throw new DomainRefusal(404, `No filed invoice ${cleanNumber} exists.`);
            if (header.state !== 'issued') {
                throw new DomainRefusal(409, 'Only an issued invoice with no returns can be cancelled.');
            }
            const now = Date.now();
            if (header.business_date !== businessDate(now)) {
                throw new DomainRefusal(409,
                    'Only a sale from the current business date can be voided. Use a return/credit note for an earlier sale.');
            }

            const priorReturns = creditNotes.summarizeForInvoice(header.id);
            if (priorReturns.count > 0 || priorReturns.returnedWeightGrams > 0) {
                throw new DomainRefusal(409, 'This invoice already has a return and must not be cancelled.');
            }

            for (const movement of inventory.documentSaleMovementsForInvoice(header.id)) {
                inventory.recordDocumentMovement({
                    tenantId: context.tenantId,
                    lotId: movement.lot_id,
                    movementType: 'void',
                    weightDeltaMg: Math.abs(movement.weight_delta_mg),
                    invoiceId: header.id,
                    invoiceLineId: movement.invoice_line_id,
                    reversesMovementId: movement.id,
                    reason: `Void ${cleanNumber}: ${cleanReason}`,
                    actorUserId,
                    at: now
                });
            }

            const advanceTender = invoices.tendersFor(header.id).find(row => row.method === 'advance' && row.advance_entry_id);
            if (advanceTender) {
                const redemption = advances.findEntryById(advanceTender.advance_entry_id);
                if (!redemption || redemption.status !== 'posted') {
                    throw new DomainRefusal(409, 'The invoice advance redemption is not in a reversible state.');
                }
                advances.insertEntry({
                    id: newId('REV'),
                    tenantId: context.tenantId,
                    branchId: context.branchId,
                    accountId: redemption.account_id,
                    entryType: 'reversal',
                    amountPaise: Math.abs(redemption.amount_paise),
                    status: 'posted',
                    paymentMethod: 'other',
                    referenceId: null,
                    source: 'counter',
                    lockedRate22kPaisePerG: redemption.locked_rate_22k_paise_per_g,
                    invoiceId: header.id,
                    creditNoteId: null,
                    reversesEntryId: redemption.id,
                    idempotencyKey: null,
                    createdByUserId: actorUserId,
                    approvedByUserId: actorUserId,
                    approvedAt: now,
                    reviewNote: `Void ${cleanNumber}: ${cleanReason}`,
                    createdAt: now,
                    businessDate: businessDate(now)
                });
            }

            invoices.cancelInvoice(header.id, { actorUserId, reason: cleanReason, at: now });
            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'counter',
                action: 'SALE_VOIDED',
                entityType: 'invoice',
                entityId: header.id,
                summary: `Invoice ${cleanNumber} cancelled`,
                detail: { invoiceNumber: cleanNumber, reason: cleanReason },
                ipAddress: deps.ipAddress || null,
                occurredAt: now
            });

            const cancelled = invoices.findById(header.id);
            return {
                ok: true,
                invoiceId: cleanNumber,
                sale: invoices.toLegacySale(cancelled, invoices.linesFor(header.id), {
                    tenders: invoices.tendersFor(header.id), actor: deps.actor || null
                })
            };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) return { ok: false, status: err.status, error: err.message, code: err.code };
        if (isUniqueViolation(err)) {
            return { ok: false, status: 409, error: 'This invoice has already been cancelled.' };
        }
        logError('Sale void failed and was rolled back: ' + err.message, err.stack);
        return { ok: false, status: 500, error: 'Failed to cancel invoice: ' + err.message };
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
function recordSuppliedTenders(raw, { invoiceId, actorUserId, now, payablePaise }) {
    if (raw === undefined || raw === null) return;
    if (!Array.isArray(raw)) throw new DomainRefusal(400, 'Tenders must be a list.');
    if (raw.length === 0) return;
    if (raw.length > MAX_TENDERS) {
        throw new DomainRefusal(400,
            `An invoice may be split across at most ${MAX_TENDERS} tenders.`);
    }
    /* Nothing left to pay — an invoice fully settled by a redeemed advance has
       no counter tender, and recording a ₹0 one would be a row that means
       nothing. The advance's own tender row was written above. */
    if (payablePaise <= 0) return;

    let sum = 0;
    for (const [i, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object') {
            throw new DomainRefusal(400, `Tender ${i + 1} is not a valid payment.`);
        }
        const method = String(entry.method || '').trim().toLowerCase();
        if (!TENDER_METHODS.includes(method)) {
            throw new DomainRefusal(400,
                `Tender ${i + 1} has an unknown method. Use one of: ${TENDER_METHODS.join(', ')}.`);
        }

        /* A LONE TENDER WITH NO AMOUNT means "the whole bill, by this method".
           The desk sends that for the ordinary unsplit sale, and it matters
           because the server may legitimately price the invoice differently
           from the browser — a rate synced overnight, a tax slab edited
           mid-shift. The cashier's intent was "the customer is paying the whole
           bill in cash", not "the customer is paying ₹4,532", so pinning the
           amount to the browser's stale total would refuse a sale the store
           genuinely wants to make.

           A cashier who has actually split the payment sends explicit amounts,
           and those must reconcile exactly — see the check below. */
        const amountOmitted = raw.length === 1
            && (entry.amount === undefined || entry.amount === null || entry.amount === '');
        const amount = amountOmitted ? fromPaise(payablePaise) : Number(entry.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new DomainRefusal(400, `Tender ${i + 1} needs a positive amount.`);
        }
        if (amount > MAX_SANE_AMOUNT) {
            throw new DomainRefusal(400, `Tender ${i + 1} exceeds the per-payment limit.`);
        }

        const amountPaise = toPaise(round2(amount));
        sum += amountPaise;
        invoices.insertTender({
            id: newId('TND'),
            invoiceId,
            method,
            amountPaise,
            // A card slip number, a UPI UTR, a cheque number — whatever the
            // reconciliation will be done against. Free text by necessity;
            // clamped, and never used as an identifier by this system.
            reference: String(entry.reference || '').trim().slice(0, 100) || null,
            paymentOrderId: entry.paymentOrderId || null,
            advanceEntryId: null,
            capturedAt: now,
            createdByUserId: actorUserId
        });
    }

    /* Compared in integer paise, not rupees. Two rupee floats that both look
       like the same amount need not be equal, and this is precisely the
       comparison that must not be approximate. Thrown, not returned, so the
       whole invoice unwinds rather than committing a payment record that
       disagrees with the total above it. */
    if (sum !== payablePaise) {
        throw new DomainRefusal(400,
            `The payments recorded (₹${fromPaise(sum)}) do not add up to the amount due (₹${fromPaise(payablePaise)}). `
            + 'Adjust the split so the two match.');
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
    const linesByInvoice = groupByInvoice(invoices.linesForMany(ids));
    const tendersByInvoice = groupByInvoice(invoices.tendersForMany(ids));
    const actorsByUser = invoices.actorsByUserId(rows.map(row => row.created_by_user_id));
    const returnSummaries = creditNotes.summarizeForInvoices(ids);

    return rows.map(row => {
        const sale = invoices.toLegacySale(row, linesByInvoice.get(row.id) || [], {
            tenders: tendersByInvoice.get(row.id) || [],
            actor: actorsByUser.get(row.created_by_user_id) || null
        });
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

/** Child rows keyed by their invoice, preserving the order they arrived in. */
function groupByInvoice(rows) {
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.invoice_id)) grouped.set(row.invoice_id, []);
        grouped.get(row.invoice_id).push(row);
    }
    return grouped;
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
    /**
     * @param {number} status  HTTP status the route should answer with
     * @param {string} message the `error` field — usually prose, but a machine
     *        code such as 'APPROVER_REQUIRED' where the client branches on it
     * @param {string} [code]  a secondary code for callers that need both
     * @param {string} [detail] human-readable text accompanying a coded refusal,
     *        surfaced as `message` so the desk can show something specific
     */
    constructor(status, message, code, detail) {
        super(message);
        this.name = 'DomainRefusal';
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

/** Whether an error is SQLite refusing a duplicate on a unique index. */
export function isUniqueViolation(err) {
    return Boolean(err) && /UNIQUE constraint failed/i.test(String(err.message || ''));
}
