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
