/**
 * ==========================================================================
 * Billing Arithmetic — pure, DOM-free money math for the Billing Desk.
 *
 * Extracted out of BillingDesk.js so the invoice pipeline (discount → tax →
 * advance) can be verified by backend/test_billing_math.js without a browser.
 * Nothing in here may touch `document`, `window`, or `fetch` — the component
 * owns all rendering, this module owns all arithmetic.
 * ==========================================================================
 */

/** Coerce anything the UI hands us into a finite number (blank inputs, NaN). */
function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Round to 2 decimal places — the paise every money figure settles on. */
export function round2(value) {
    return Math.round(num(value) * 100) / 100;
}

/**
 * Round to 3 decimal places — the milligram every weight figure settles on.
 *
 * Invoices already print grams to three places; returns made that precision
 * load-bearing rather than cosmetic, because "how much of this invoice is
 * still returnable" is a subtraction across several rows and an unrounded
 * gram leaks a float tail into it.
 */
export function round3(value) {
    return Math.round(num(value) * 1000) / 1000;
}

/**
 * Rupees → integer paise.
 *
 * Payment gateways speak paise, and they speak it as an integer. Rupee floats
 * cannot represent every payable amount exactly — 1234.35 is stored as
 * 1234.3499999999999 — so comparing "what the gateway captured" against "what
 * we asked for" in rupees is a comparison of two roundings. In paise both
 * sides are integers and the comparison is exact, which is the entire point of
 * confirming a capture.
 *
 * Lives here rather than in server.js because this module is where this
 * project's money arithmetic is defined and tested; the payment routes are a
 * caller, not an owner.
 */
export function toPaise(rupees) {
    return Math.round(num(rupees) * 100);
}

/** Integer paise → rupees, for display and for the ledger's rupee columns. */
export function fromPaise(paise) {
    return round2(num(paise) / 100);
}

/**
 * Metal value for a weight at a rate — the first number on every invoice, and
 * the base every other figure is derived from.
 *
 * Rounded here, once, rather than left as a raw float for the tax and discount
 * steps to inherit: an unrounded metal value propagates a sub-paisa error
 * through the whole invoice, and the printed line item then fails to reconcile
 * against the total by a paisa.
 */
export function computeMetalValue(weightGrams, ratePerGram) {
    return round2(num(weightGrams) * num(ratePerGram));
}

/**
 * Canonicalise the configured tax mode to exactly 'Inclusive' or 'Exclusive'.
 *
 * Matching is case- and whitespace-insensitive: 'inclusive', ' Inclusive ' and
 * 'INCLUSIVE' all select inclusive pricing. Anything unrecognised — including
 * undefined, null and outright garbage — falls back to 'Exclusive', which is
 * the safe default (it never understates the tax collected).
 *
 * Both the browser and the server route their tax-mode decision through here
 * so a settings file written by an older build, by hand, or by a restored
 * backup cannot put the two halves of the system into different modes.
 */
export function normalizeTaxMode(taxMode) {
    return String(taxMode ?? '').trim().toLowerCase() === 'inclusive'
        ? 'Inclusive'
        : 'Exclusive';
}

/**
 * Making charge ₹ derived from a percentage of the metal value.
 * Percentage is clamped to the 1–100 range the UI allows.
 */
export function makingChargeFromPercent(metalValue, percent) {
    const pct = clampMakingPercent(percent);
    return { percent: pct, amount: num(metalValue) * (pct / 100) };
}

/**
 * Making charge percentage derived from a flat ₹ amount — the reverse leg of
 * the bi-directional input pair.
 *
 * NOTE: the returned `percent` is clamped to 1–100 for display while `amount`
 * is returned unclamped, mirroring the existing UI behaviour: an amount above
 * the metal value pins the percentage box at 100 but keeps charging the full
 * amount entered. The two fields are intentionally allowed to disagree there.
 */
export function makingPercentFromAmount(amount, metalValue) {
    const amt = Math.max(0, num(amount));
    const base = num(metalValue);
    if (base <= 0) {
        // No metal value yet — percentage is undefined, leave it to the caller.
        return { percent: null, amount: amt };
    }
    const raw = (amt / base) * 100;
    return { percent: round2(clampMakingPercent(raw)), amount: amt };
}

function clampMakingPercent(percent) {
    const pct = num(percent);
    if (pct < 1) return 1;
    if (pct > 100) return 100;
    return pct;
}

/* ==========================================================================
   Advance ledger arithmetic

   A deposit row's `status` decides whether it is spendable money or only a
   customer's claim to have paid. Three places used to sum advances.json by
   hand — computeAdvanceLedger() server-side, the Dashboard's outstanding
   tile, and the Advances tab's per-customer rollup — so a pending row would
   have counted as real credit in whichever of them was missed. They all route
   through here now instead.
   ========================================================================== */

export const ADVANCE_STATUS = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected'
};

/**
 * The status of a ledger row, normalised.
 *
 * A MISSING status reads as APPROVED, and that is the load-bearing part: every
 * advance row already on disk in a live backend/data/advances.json predates
 * this field, and each one is money the store has genuinely taken. Defaulting
 * the other way would silently zero every existing customer's balance the
 * moment this version shipped. New rows are always written with an explicit
 * status (see recordAdvanceDeposit in backend/server.js), so the default only
 * ever applies to pre-existing history.
 */
export function normalizeAdvanceStatus(entry) {
    const raw = String((entry && entry.status) ?? '').trim().toLowerCase();
    if (raw === ADVANCE_STATUS.PENDING) return ADVANCE_STATUS.PENDING;
    if (raw === ADVANCE_STATUS.REJECTED) return ADVANCE_STATUS.REJECTED;
    return ADVANCE_STATUS.APPROVED;
}

/** Whether a row is settled money that belongs in a spendable balance. */
export function isCountableAdvance(entry) {
    if (!entry) return false;
    // Redemptions are cashier-side facts with no approval step — they always
    // count. Only deposits carry a reviewable status.
    if (entry.type === 'redeem') return true;
    if (entry.type !== 'deposit') return false;
    return normalizeAdvanceStatus(entry) === ADVANCE_STATUS.APPROVED;
}

/**
 * A single row's signed effect on the balance: a countable deposit adds, a
 * redemption subtracts, and a pending or rejected deposit contributes nothing.
 */
export function advanceEntryDelta(entry) {
    if (!isCountableAdvance(entry)) return 0;
    const amount = round2(Math.abs(num(entry.amount)));
    return entry.type === 'redeem' ? -amount : amount;
}

/**
 * Spendable balance across a set of ledger rows, floored at zero.
 *
 * Floored because a negative advance balance is not a debt this system tracks
 * — it would only ever come from a reconciliation error, and letting it go
 * negative would silently discount the customer's next bill.
 */
export function computeAdvanceBalance(entries) {
    const total = (entries || []).reduce((sum, entry) => sum + advanceEntryDelta(entry), 0);
    return Math.max(0, round2(total));
}

/**
 * Balance plus the awaiting-approval figures the UI shows beside it, so a
 * customer who has submitted a UPI reference can see that their money is
 * acknowledged but not yet credited — the alternative is a deposit that
 * appears to have vanished.
 */
export function summarizeAdvanceLedger(entries) {
    const rows = entries || [];
    const pending = rows.filter(e =>
        e && e.type === 'deposit' && normalizeAdvanceStatus(e) === ADVANCE_STATUS.PENDING
    );
    return {
        balance: computeAdvanceBalance(rows),
        pendingTotal: round2(pending.reduce((sum, e) => sum + Math.abs(num(e.amount)), 0)),
        pendingCount: pending.length
    };
}

/**
 * The invoice pipeline, in the order the numbers must be applied:
 *
 *   1. preTaxTotal   = metal value + making charges
 *   2. discount      = preTaxTotal × discount%          (BEFORE tax)
 *   3. tax           = f(afterDiscount, slab, taxMode)
 *   4. advance       = redeemed against the taxed total, capped at balance
 *
 * Step 2 preceding step 3 is a GST requirement, not a preference: the taxable
 * value declared on the invoice must be the discounted value. Because both a
 * percentage discount and a percentage tax are multiplicative, the GRAND TOTAL
 * is identical either way — only the tax line reveals the ordering. That is
 * why the tests assert on `taxAmount`, not just `totalAmount`.
 *
 * Tax modes (resolved through normalizeTaxMode, so casing does not matter):
 *   'Exclusive' — slab is ADDED on top of the discounted amount.
 *   'Inclusive' — the discounted amount already CONTAINS the tax, which is
 *                 carved back out. Grand total therefore equals afterDiscount.
 *
 * ROUNDING. Every figure returned is settled to paise here, at the point the
 * money is computed, rather than being left at full float precision for each
 * caller to round on its own. A bill is payable in paise, so ₹94,180.625 is not
 * a real amount to display, hand to a customer, or persist. Rounding once at
 * the source keeps the browser preview, the printed invoice, the POSTed payload
 * and the stored ledger record all quoting the identical number.
 *
 * The rounding is arranged so the invoice still reconciles exactly:
 *   taxableAmount + taxAmount === totalBeforeAdvance   (to the paise)
 * In inclusive mode the tax is taken as the REMAINDER after carving out the
 * rounded taxable value, rather than being rounded independently, so the two
 * can never drift a paise apart and leave the printed total off by one.
 *
 * COMPONENTS. `components` restates the metal / making / discount lines in the
 * same terms as the tax line printed beneath them, so a customer adding up the
 * rows on the invoice arrives at the grand total. See the block below.
 */
export function computeInvoiceTotals({
    metalValue = 0,
    makingChargeAmount = 0,
    discountPercent = 0,
    taxSlab = 0,
    taxMode = 'Exclusive',
    appliedAdvance = 0,
    customerAdvanceBalance = 0
} = {}) {
    const mode = normalizeTaxMode(taxMode);
    const slab = Math.max(0, num(taxSlab));

    const grossMetalValue = round2(metalValue);
    const grossMakingCharge = round2(makingChargeAmount);
    const preTaxTotal = round2(grossMetalValue + grossMakingCharge);
    const discountAmount = round2(preTaxTotal * (num(discountPercent) / 100));
    const afterDiscount = round2(preTaxTotal - discountAmount);

    let taxableAmount;
    let taxAmount;
    if (mode === 'Inclusive') {
        taxableAmount = round2(afterDiscount / (1 + slab / 100));
        // Remainder, not an independent rounding — guarantees the pair sums
        // back to the price the customer was quoted.
        taxAmount = round2(afterDiscount - taxableAmount);
    } else {
        taxableAmount = afterDiscount;
        taxAmount = round2(taxableAmount * (slab / 100));
    }

    const totalBeforeAdvance = round2(taxableAmount + taxAmount);

    // An applied advance always redeems as much as it can: the cashier's
    // "Apply Advance" button is all-or-nothing, and the amount is re-clamped
    // on every recalculation so editing the cart never leaves a stale advance
    // larger than the bill it is being redeemed against.
    let resolvedAdvance = num(appliedAdvance);
    if (resolvedAdvance > 0) {
        resolvedAdvance = round2(
            Math.min(num(customerAdvanceBalance), Math.max(0, totalBeforeAdvance))
        );
    }

    const totalAmount = round2(Math.max(0, totalBeforeAdvance - resolvedAdvance));

    /*
     * The printed line items.
     *
     * An invoice that prints a tax line must print the lines above it NET of
     * that tax, otherwise the tax is represented twice and the rows overshoot
     * the total. In exclusive mode that is already the case — the quoted metal
     * and making figures are pre-tax and the slab is added underneath — so the
     * divisor is 1 and these values are just the gross ones.
     *
     * In inclusive mode the quoted figures already CONTAIN the tax, so each
     * line is carved down by the same factor used on the total. Printing the
     * gross figures alongside a tax line is what made an inclusive invoice
     * appear to overcharge by exactly the tax amount.
     *
     * Metal absorbs the rounding residual (it is reliably the largest line, so
     * a stray paise distorts it least), which makes the identity
     *   metalValue + makingChargeAmount − discountAmount === taxableAmount
     * hold exactly, at every slab, with no drift for the customer to spot.
     */
    const divisor = mode === 'Inclusive' ? (1 + slab / 100) : 1;
    const netMakingCharge = round2(grossMakingCharge / divisor);
    const netDiscountAmount = round2(discountAmount / divisor);
    const netMetalValue = round2(taxableAmount - netMakingCharge + netDiscountAmount);

    return {
        preTaxTotal,
        discountAmount,
        afterDiscount,
        taxableAmount,
        taxAmount,
        totalBeforeAdvance,
        appliedAdvance: resolvedAdvance,
        totalAmount,
        taxMode: mode,
        components: {
            metalValue: netMetalValue,
            makingChargeAmount: netMakingCharge,
            discountAmount: netDiscountAmount,
            // The gross, as-quoted figures, kept for the cart/catalogue side of
            // the UI which must keep showing what the cashier actually typed.
            grossMetalValue,
            grossMakingCharge
        }
    };
}

/* ==========================================================================
   Returns

   A return is priced from the invoice it reverses, never from today. The gold
   rate moves daily and the tax slab is editable in Settings, so re-pricing a
   returned ornament against the current configuration would refund an amount
   the store never charged — over-refunding after a rate rise, short-changing
   the customer after a fall. Every input below therefore comes off the stored
   sale record: its rate, its making charge, its discount, its slab, its mode.
   ========================================================================== */

/**
 * What to refund for `returnWeightGrams` off a filed invoice.
 *
 * WHAT IS REFUNDED. The returned share of the invoice's TAXED value — that is
 * `totalAmount + appliedAdvance`, not `totalAmount`. An advance redeemed on the
 * original bill was the customer's own money being spent, so the value owed
 * back on a return includes it; re-crediting the advance separately on top of
 * that would pay the same rupees out twice. The refund mode (cash or gold
 * credit) decides how that one figure is handed back, never how large it is.
 *
 * TWO PATHS, deliberately. Where the stored record still reconciles against
 * its own line items, the refund is rebuilt through computeInvoiceTotals —
 * the same pipeline that priced the sale — so the credit note can print a
 * metal / making / discount / GST breakdown that adds up. Where it does not
 * (an invoice filed before Phase 20 stored the tax split at all, or one whose
 * stored figures disagree), the refund falls back to a straight pro-rata share
 * of the filed gross and the breakdown is omitted rather than invented. A
 * guessed GST figure on a credit note is a statement about a tax period this
 * system never recorded.
 *
 * NO DRIFT ACROSS PARTIAL RETURNS. Three returns of a third each would each
 * round independently and need not sum back to the invoice. So the return that
 * closes out the last of the weight is trued up to exactly the unrefunded
 * remainder, and every refund is capped at that remainder. The sum of all
 * refunds against an invoice therefore equals its filed gross, to the paise,
 * however it was split up.
 *
 * @param {object}  args.sale                  the stored sale record, as filed
 * @param {number}  args.returnWeightGrams     grams coming back on this return
 * @param {number} [args.alreadyReturnedGrams] grams already returned earlier
 * @param {number} [args.alreadyRefundedAmount] rupees already refunded earlier
 * @returns {{ok: true, ...}|{ok: false, error: string}}
 */
export function computeReturnRefund({
    sale,
    returnWeightGrams,
    alreadyReturnedGrams = 0,
    alreadyRefundedAmount = 0
} = {}) {
    if (!sale || typeof sale !== 'object') {
        return { ok: false, error: 'A filed invoice is required to price a return.' };
    }

    const originalWeight = round3(sale.weightGrams);
    if (!(originalWeight > 0)) {
        return { ok: false, error: 'This invoice carries no gold weight, so nothing can be returned against it.' };
    }

    const returnedSoFar = round3(Math.max(0, alreadyReturnedGrams));
    const remainingWeight = round3(originalWeight - returnedSoFar);
    if (!(remainingWeight > 0)) {
        return { ok: false, error: 'This invoice has already been returned in full.' };
    }

    const returnWeight = round3(returnWeightGrams);
    if (!(returnWeight > 0)) {
        return { ok: false, error: 'Enter the weight being returned.' };
    }
    if (returnWeight > remainingWeight) {
        return {
            ok: false,
            error: `Only ${remainingWeight.toFixed(3)}g of this invoice is still returnable.`
        };
    }

    // The gross the invoice actually charged, advance included — see above.
    const filedGross = round2(num(sale.totalAmount) + num(sale.appliedAdvance));
    const refundedSoFar = round2(Math.max(0, alreadyRefundedAmount));
    const refundableRemaining = round2(Math.max(0, filedGross - refundedSoFar));

    // Does the stored record still reconcile against its own line items? Same
    // question ReprintDesk asks before it dares split a stored total into rows,
    // asked here before we dare derive money from those same line items.
    const storesTaxSplit = sale.taxableAmount !== undefined && sale.taxAmount !== undefined;
    const wholeInvoice = computeInvoiceTotals({
        metalValue: sale.metalValue,
        makingChargeAmount: sale.makingChargeAmount,
        discountPercent: sale.discountPercent,
        taxSlab: sale.taxPercent,
        taxMode: sale.taxMode
    });
    const itemisable = storesTaxSplit
        && Math.abs(wholeInvoice.totalBeforeAdvance - filedGross) < 0.01;

    const closesInvoice = returnWeight >= remainingWeight;
    const fraction = returnWeight / originalWeight;

    let refundAmount;
    let components = null;

    if (itemisable) {
        // Metal is priced at the invoice's own rate and the returned weight,
        // exactly as the sale was; the making charge — a flat rupee figure on
        // the record — scales with the share of the weight going back.
        const metalValue = computeMetalValue(returnWeight, sale.goldPricePerGram);
        const makingChargeAmount = round2(num(sale.makingChargeAmount) * fraction);
        const totals = computeInvoiceTotals({
            metalValue,
            makingChargeAmount,
            discountPercent: sale.discountPercent,
            taxSlab: sale.taxPercent,
            taxMode: sale.taxMode
        });
        refundAmount = totals.totalBeforeAdvance;
        components = {
            metalValue: totals.components.metalValue,
            makingChargeAmount: totals.components.makingChargeAmount,
            discountAmount: totals.components.discountAmount,
            taxableAmount: totals.taxableAmount,
            taxAmount: totals.taxAmount
        };
    } else {
        refundAmount = round2(filedGross * fraction);
    }

    // True-up and cap. The closing return takes the whole unrefunded
    // remainder; any earlier one is capped by it.
    if (closesInvoice) {
        refundAmount = refundableRemaining;
    } else {
        refundAmount = round2(Math.min(refundAmount, refundableRemaining));
    }

    // A trued-up or capped figure no longer equals the sum of the rows above
    // it, so the breakdown is dropped rather than printed alongside a total it
    // disagrees with.
    if (components && Math.abs(
        round2(components.taxableAmount + components.taxAmount) - refundAmount
    ) >= 0.01) {
        components = null;
    }

    return {
        ok: true,
        weightGrams: returnWeight,
        remainingWeightAfter: round3(remainingWeight - returnWeight),
        fraction,
        closesInvoice,
        itemised: components !== null,
        refundAmount,
        components,
        // Echoed from the invoice so the credit note can state the terms the
        // refund was priced on without re-reading the sale record.
        goldPricePerGram: round2(sale.goldPricePerGram),
        purity: sale.purity || '',
        makingChargePercent: num(sale.makingChargePercent),
        discountPercent: num(sale.discountPercent),
        taxPercent: num(sale.taxPercent),
        taxMode: normalizeTaxMode(sale.taxMode)
    };
}
