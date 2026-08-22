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

/** Total of a list of numbers, blanks and junk counted as zero. */
function sum(values) {
    return (values || []).reduce((total, value) => total + num(value), 0);
}

/**
 * Splits `totalPaise` across `weights` so the parts sum to it EXACTLY.
 *
 * Largest-remainder: each part takes its floor share, then the leftover paise go
 * one each to the lines with the largest discarded fractions. This is the whole
 * reason a multi-line invoice reconciles — rounding each line independently
 * leaves the rows short or over by a paise or two, and a customer adding up the
 * column on a printed invoice finds it does not match the total. Allocating a
 * figure that is already correct cannot drift from it.
 *
 * A zero total, or weights that are all zero, splits to all zeros — which is the
 * right answer for a fully-discounted or zero-rated invoice rather than a
 * division by zero.
 */
function allocatePaise(totalPaise, weights) {
    const total = Math.round(num(totalPaise));
    const w = (weights || []).map(x => Math.max(0, num(x)));
    const weightTotal = sum(w);
    if (w.length === 0) return [];
    if (weightTotal <= 0 || total === 0) return w.map(() => 0);

    const exact = w.map(x => (total * x) / weightTotal);
    const parts = exact.map(Math.floor);
    let remainder = total - sum(parts);

    // Hand the leftover paise to the largest fractional parts first.
    const order = exact
        .map((value, index) => ({ index, frac: value - Math.floor(value) }))
        .sort((a, b) => b.frac - a.frac);
    for (let i = 0; remainder > 0 && i < order.length; i++, remainder--) {
        parts[order[i].index] += 1;
    }
    return parts;
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

/**
 * Wastage charge for one line, resolved to ₹ (and, for the weight-uplift
 * model, extra grams) BEFORE it ever reaches computeInvoiceTotals() — that
 * function only accepts already-priced ₹ figures, exactly like metal value
 * and making charge; it never resolves a raw weight itself.
 *
 * Three interchangeable models, chosen by `mode` (see defaultSettings.js
 * `wastageMode`):
 *   'weight_uplift'         — extra weight billed at the line's own rate, as
 *                              if the item weighed wastagePercent% more.
 *   'making_charge_percent' — a percentage of the making charge.
 *   'separate_line'         — identical arithmetic to making_charge_percent;
 *                              the two differ only in how the invoice
 *                              DISPLAYS the charge, never in what it costs.
 * Anything else (including 'none', the default) returns zero — the safe,
 * disabled-by-default behaviour.
 */
export function computeWastageAmount({
    mode = 'none', weightGrams = 0, ratePerGram = 0, makingChargeAmount = 0, wastagePercent = 0
} = {}) {
    const pct = Math.max(0, num(wastagePercent));
    if (mode === 'weight_uplift') {
        const extraWeight = num(weightGrams) * (pct / 100);
        return { wastageWeightGrams: round2(extraWeight), wastageAmount: computeMetalValue(extraWeight, ratePerGram) };
    }
    if (mode === 'making_charge_percent' || mode === 'separate_line') {
        return { wastageWeightGrams: 0, wastageAmount: round2(num(makingChargeAmount) * (pct / 100)) };
    }
    return { wastageWeightGrams: 0, wastageAmount: 0 };
}

/**
 * Credit for gold a customer trades in ("old-gold exchange").
 *
 * `ratePerGram` is the store's own already-resolved rate for the TESTED
 * purity (activeRates.price22K etc — the same per-purity rate a sale line
 * prices from, never a 24K rate scaled by a fraction; this store already
 * configures one rate per purity, so there is nothing to scale). Resolving
 * which purity's rate that is stays the caller's job (backend/services/
 * oldGoldService.js), same as saleService.js resolves a sale line's rate —
 * this function only ever accepts an already-priced ₹/g figure.
 *
 * `deductionPercent` covers refining loss and margin — the store is not a
 * refiner and cannot turn traded-in gold back into billable stock at 100%
 * of its tested weight.
 *
 * Deliberately silent on tax: whether buying gold from a customer attracts
 * GST under reverse charge is an unresolved legal question (CLAUDE.md,
 * docs/PRODUCTION_READINESS_ROADMAP.md Phase 5 §4), not something this
 * function may guess at.
 */
export function computeOldGoldCredit({ grossWeightGrams = 0, ratePerGram = 0, deductionPercent = 0 } = {}) {
    const deduction = Math.min(100, Math.max(0, num(deductionPercent)));
    const netWeightGrams = round3(Math.max(0, num(grossWeightGrams)) * (1 - deduction / 100));
    return {
        netWeightGrams,
        creditAmount: computeMetalValue(netWeightGrams, ratePerGram)
    };
}

/**
 * Gold-gram equivalent an installment payment locks, at the rate in force
 * the moment it was paid. Simple division — the store's own already-resolved
 * per-purity rate (activeRates.price22K, matching every other place in this
 * codebase that locks a rate) — kept as a named function rather than inline
 * arithmetic because "how a scheme installment converts to grams" is exactly
 * the kind of formula a future reader should be able to find and test in one
 * place, not re-derive at each call site.
 */
export function computeGoldGramsForAmount(amountRupees, ratePerGram) {
    const rate = num(ratePerGram);
    if (!(rate > 0)) return 0;
    return round3(Math.max(0, num(amountRupees)) / rate);
}

/**
 * What a scheme enrollment is worth at maturity or early closure.
 *
 * BONUS IS VALUED IN GRAMS, NOT RUPEES: `bonusInstallments` worth of gold at
 * the enrollment's own AVERAGE per-installment gram rate — not a rupee
 * amount converted at today's rate — so the bonus scales with what the
 * customer actually paid in, the same way the real installments already do.
 * The whole accumulated gram total (real + bonus) is then valued at
 * `currentRatePerGram` — the maturity-day rate — because that is the rate at
 * which the accumulated gold is actually being handed back as spendable ₹.
 *
 * EARLY CLOSURE gets no bonus and pays a penalty, taken in grams before the
 * rupee conversion — `penaltyPercent` of the accumulated (non-bonus) grams.
 *
 * @param {object} args
 * @param {number} args.totalGramsLocked sum of every installment's locked grams
 * @param {number} args.installmentsPaid how many installments were actually paid
 * @param {number} [args.bonusInstallments] scheme terms — 0 for an early closure
 * @param {number} [args.penaltyPercent] scheme terms — 0 for a full-term maturity
 * @param {number} args.currentRatePerGram today's rate, for the final conversion
 */
export function computeGoldSchemePayout({
    totalGramsLocked = 0, installmentsPaid = 0, bonusInstallments = 0,
    penaltyPercent = 0, currentRatePerGram = 0
} = {}) {
    const grams = Math.max(0, num(totalGramsLocked));
    const paid = Math.max(0, Math.trunc(num(installmentsPaid)));
    const avgGramsPerInstallment = paid > 0 ? grams / paid : 0;

    const bonusGrams = round3(avgGramsPerInstallment * Math.max(0, num(bonusInstallments)));
    const penaltyGrams = round3(grams * (Math.min(100, Math.max(0, num(penaltyPercent))) / 100));
    const payoutGrams = round3(Math.max(0, grams - penaltyGrams) + bonusGrams);

    return {
        bonusGrams,
        penaltyGrams,
        payoutGrams,
        payoutAmount: computeMetalValue(payoutGrams, currentRatePerGram)
    };
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
 * The store's whole advance liability, split by customer — what the Dashboard
 * tile states and what an auditor would ask for.
 *
 * Per-customer balances are floored individually before being summed, for the
 * same reason computeAdvanceBalance() floors: one customer's reconciliation
 * error going negative must not quietly cancel out another customer's real
 * credit and understate what the store owes.
 *
 * Lives here rather than in Dashboard.js because the figure is now computed
 * server-side (GET /api/advances returns it, so the browser no longer downloads
 * the entire ledger to add it up) and the browser still renders it — two
 * callers, therefore one rule, in the module that owns money arithmetic.
 */
export function summarizeAdvanceLiability(entries) {
    const rows = entries || [];
    const balances = new Map();
    for (const entry of rows) {
        if (!entry) continue;
        const phone = entry.customerPhone || '';
        balances.set(phone, (balances.get(phone) || 0) + advanceEntryDelta(entry));
    }

    let outstandingTotal = 0;
    let outstandingCustomers = 0;
    for (const balance of balances.values()) {
        const owed = round2(balance);
        if (owed > 0) {
            outstandingTotal += owed;
            outstandingCustomers += 1;
        }
    }

    const pending = summarizeAdvanceLedger(rows);
    return {
        outstandingTotal: round2(outstandingTotal),
        outstandingCustomers,
        pendingTotal: pending.pendingTotal,
        pendingCount: pending.pendingCount
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
    wastageAmount = 0,
    discountPercent = 0,
    taxSlab = 0,
    taxMode = 'Exclusive',
    appliedAdvance = 0,
    customerAdvanceBalance = 0,
    lines = null
} = {}) {
    const mode = normalizeTaxMode(taxMode);
    const slab = Math.max(0, num(taxSlab));

    /* ONE INVOICE, ONE OR MANY LINES.
     *
     * `lines` is the multi-item form: each entry contributes its own metal value
     * and making charge, and may carry its own discount. The scalar
     * metalValue / makingChargeAmount arguments are the single-line form, which
     * every stored invoice filed before this used and which a one-item sale
     * still uses — they are normalised into a single line here so there is
     * exactly ONE arithmetic path below rather than a second one bolted on.
     *
     * The header figures are then computed over the SUMS, precisely as they
     * always were, which is what keeps a one-line invoice's total identical to
     * the paise before and after this change. Per-line taxable/tax/total
     * figures are an ALLOCATION of those header figures (see allocateLines
     * below), never an independent calculation — so the rows on a printed
     * invoice always add up to the total at the bottom, at any slab, with any
     * number of lines. */
    const inputLines = Array.isArray(lines) && lines.length > 0
        ? lines
        : [{ metalValue, makingChargeAmount, wastageAmount, discountPercent }];

    const normalizedLines = inputLines.map(line => {
        /* Floored at zero. A negative metal value or making charge is not a
         * discount — there is a discount field for that — and it silently broke
         * the invariant this whole allocation exists to hold: the header summed
         * the negative, while allocateLines() clamps its weights at zero and so
         * allocated nothing, leaving the printed rows disagreeing with the total
         * beneath them. Refusing the sign keeps the two halves reconciled. */
        const lineMetal = Math.max(0, round2((line && line.metalValue) ?? 0));
        const lineMaking = Math.max(0, round2((line && line.makingChargeAmount) ?? 0));
        // Absent on every caller before wastage existed, so an omitted field
        // defaults to 0 and this whole function is byte-identical to before —
        // the "disabled = never existed" contract wastage is built under.
        const lineWastage = Math.max(0, round2((line && line.wastageAmount) ?? 0));
        // A line without its own discount inherits the invoice's, so passing a
        // bare list of items behaves exactly like the single-line form did.
        const linePct = Math.min(100, Math.max(0,
            num((line && line.discountPercent) ?? discountPercent)
        ));
        const linePreTax = round2(lineMetal + lineMaking + lineWastage);
        return {
            metalValue: lineMetal,
            makingChargeAmount: lineMaking,
            wastageAmount: lineWastage,
            discountPercent: linePct,
            preTaxTotal: linePreTax,
            discountAmount: round2(linePreTax * (linePct / 100))
        };
    });

    const grossMetalValue = round2(sum(normalizedLines.map(l => l.metalValue)));
    const grossMakingCharge = round2(sum(normalizedLines.map(l => l.makingChargeAmount)));
    const grossWastageAmount = round2(sum(normalizedLines.map(l => l.wastageAmount)));
    const preTaxTotal = round2(grossMetalValue + grossMakingCharge + grossWastageAmount);
    const discountAmount = round2(sum(normalizedLines.map(l => l.discountAmount)));
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

    /* An applied advance always redeems as much as it can: the cashier's
     * "Apply Advance" button is all-or-nothing, and the amount is re-clamped on
     * every recalculation so editing the cart never leaves a stale advance
     * larger than the bill it is being redeemed against.
     *
     * FLOORED AT ZERO, and that floor is load-bearing rather than defensive
     * decoration. An advance is subtracted from the bill, so a NEGATIVE one adds
     * to it — the two ways that used to happen both produced a total ABOVE
     * `totalBeforeAdvance`, i.e. a customer overcharged by a figure that never
     * appeared on any line:
     *   - a negative `customerAdvanceBalance` passed the Math.min and became the
     *     resolved advance directly;
     *   - a negative `appliedAdvance` failed the `> 0` test, skipped the clamp
     *     entirely, and survived to the subtraction unchanged.
     * Neither is reachable through POST /api/sales, which rejects both — but
     * this module is the one place the arithmetic is defined, every other caller
     * (the desk preview, the reprint, a stored record with a bad figure on it)
     * runs through it, and "the route happens to check" is not a property the
     * math should depend on. */
    const availableBalance = Math.max(0, num(customerAdvanceBalance));
    let resolvedAdvance = Math.max(0, num(appliedAdvance));
    if (resolvedAdvance > 0) {
        resolvedAdvance = round2(
            Math.min(availableBalance, Math.max(0, totalBeforeAdvance))
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
    const netWastageAmount = round2(grossWastageAmount / divisor);
    const netDiscountAmount = round2(discountAmount / divisor);
    const netMetalValue = round2(taxableAmount - netMakingCharge - netWastageAmount + netDiscountAmount);

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
            wastageAmount: netWastageAmount,
            discountAmount: netDiscountAmount,
            // The gross, as-quoted figures, kept for the cart/catalogue side of
            // the UI which must keep showing what the cashier actually typed.
            grossMetalValue,
            grossMakingCharge,
            grossWastageAmount
        },
        // Per-line breakdown, allocated out of the header figures above so the
        // rows always sum back to them. A single-line invoice gets a one-entry
        // array whose values equal the header — which is what makes the printed
        // layout identical whether the sale had one item or six.
        lines: allocateLines(normalizedLines, { taxableAmount, taxAmount, divisor })
    };
}

/**
 * Turns the invoice's own taxable and tax figures into per-line shares.
 *
 * Weighted by each line's post-discount value, because that is the base the tax
 * was charged on. Everything is allocated in integer paise and every line's
 * `lineTotal` is its taxable plus its tax, so:
 *
 *   sum(line.taxableAmount) === invoice.taxableAmount
 *   sum(line.taxAmount)     === invoice.taxAmount
 *   sum(line.lineTotal)     === invoice.totalBeforeAdvance
 *
 * exactly, at every slab and in both tax modes. Those three identities are what
 * the printed invoice, the credit note and the returns arithmetic all rely on.
 *
 * NOTE the advance is deliberately absent: redeeming a customer's credit settles
 * the invoice as a whole and is not a property of any one item on it.
 */
function allocateLines(normalizedLines, { taxableAmount, taxAmount, divisor }) {
    const weights = normalizedLines.map(l => Math.max(0, round2(l.preTaxTotal - l.discountAmount)));
    const taxableParts = allocatePaise(toPaise(taxableAmount), weights);
    const taxParts = allocatePaise(toPaise(taxAmount), weights);

    return normalizedLines.map((line, i) => {
        const lineTaxable = fromPaise(taxableParts[i]);
        const lineTax = fromPaise(taxParts[i]);
        // Net-of-tax restatements, on the same rule the header uses: in
        // inclusive mode the quoted metal and making figures contain the tax, so
        // they are carved down by the same divisor and metal absorbs the
        // residual, keeping metal + making − discount === taxable per line.
        const netMaking = round2(line.makingChargeAmount / divisor);
        const netWastage = round2((line.wastageAmount || 0) / divisor);
        const netDiscount = round2(line.discountAmount / divisor);
        return {
            lineNumber: i + 1,
            // As quoted by the cashier — what the cart showed and what a
            // per-line return is re-priced from.
            grossMetalValue: line.metalValue,
            grossMakingCharge: line.makingChargeAmount,
            grossWastageAmount: line.wastageAmount || 0,
            discountPercent: line.discountPercent,
            preTaxTotal: line.preTaxTotal,
            // Net of tax, for printing beside a tax line.
            metalValue: round2(lineTaxable - netMaking - netWastage + netDiscount),
            makingChargeAmount: netMaking,
            wastageAmount: netWastage,
            discountAmount: netDiscount,
            taxableAmount: lineTaxable,
            taxAmount: lineTax,
            lineTotal: round2(lineTaxable + lineTax)
        };
    });
}

/* ==========================================================================
   Reading a stored sale

   An invoice on disk is one of two shapes and both must keep working forever:

     - MULTI-LINE (this version onward): a `lines` array, each entry a distinct
       item with its own purity, weight, rate, making charge and discount.
     - SINGLE-LINE (every invoice filed before it): the scalar purity /
       weightGrams / goldPricePerGram / makingChargeAmount fields on the record
       itself.

   Everything downstream — the reprint, the return, the dashboard row — reads
   through saleLines() and therefore never has to know which it is looking at.
   That is the point: a Phase 5 multi-line rollout that made a 2026 invoice
   unreprintable or unreturnable would be worse than no rollout.
   ========================================================================== */

/**
 * The items on a stored sale, oldest shape or newest, always as a list.
 *
 * A legacy record becomes exactly one line carrying its scalar fields, so
 * "line 1 of a one-item invoice" and "a pre-multi-line invoice" are the same
 * thing to every caller.
 */
export function saleLines(sale) {
    if (!sale || typeof sale !== 'object') return [];

    if (Array.isArray(sale.lines) && sale.lines.length > 0) {
        return sale.lines.map((line, i) => ({
            lineNumber: num(line.lineNumber) || i + 1,
            description: String(line.description || ''),
            purity: line.purity || sale.purity || '',
            weightGrams: round3(line.weightGrams),
            goldPricePerGram: round2(line.goldPricePerGram),
            metalValue: round2(line.grossMetalValue ?? line.metalValue),
            makingChargePercent: num(line.makingChargePercent),
            makingChargeAmount: round2(line.grossMakingCharge ?? line.makingChargeAmount),
            // Absent on every invoice filed before wastage existed, so a legacy
            // line reads as 'none'/0 — identical to a line where wastage was
            // simply never enabled.
            wastageMode: line.wastageMode || 'none',
            wastageWeightGrams: round3(line.wastageWeightGrams || 0),
            wastageAmount: round2(line.grossWastageAmount ?? line.wastageAmount ?? 0),
            discountPercent: num(line.discountPercent ?? sale.discountPercent),
            lineTotal: round2(line.lineTotal)
        }));
    }

    return [{
        lineNumber: 1,
        description: '',
        purity: sale.purity || '',
        weightGrams: round3(sale.weightGrams),
        goldPricePerGram: round2(sale.goldPricePerGram),
        metalValue: round2(sale.metalValue),
        makingChargePercent: num(sale.makingChargePercent),
        makingChargeAmount: round2(sale.makingChargeAmount),
        wastageMode: sale.wastageMode || 'none',
        wastageWeightGrams: round3(sale.wastageWeightGrams || 0),
        wastageAmount: round2(sale.wastageAmount || 0),
        discountPercent: num(sale.discountPercent),
        lineTotal: round2(num(sale.totalAmount) + num(sale.appliedAdvance))
    }];
}

/** Total weight on a sale, whichever shape it is stored in. */
export function saleTotalWeight(sale) {
    return round3(sum(saleLines(sale).map(l => l.weightGrams)));
}

/**
 * A one-line description of what was sold — "22K · 10.500g" for a single item,
 * "3 items · 22K, 18K · 25.400g" for a cart. Used by the dashboard row and the
 * reprint search result, which have room for a phrase and not a table.
 */
export function describeSaleGoods(sale) {
    const lines = saleLines(sale);
    if (lines.length === 0) return '';
    const weight = saleTotalWeight(sale).toFixed(3);
    if (lines.length === 1) {
        return `${lines[0].purity} · ${weight}g`;
    }
    const purities = [...new Set(lines.map(l => l.purity).filter(Boolean))];
    return `${lines.length} items · ${purities.join(', ')} · ${weight}g`;
}

/* ==========================================================================
   Returns

   A return is priced from the invoice it reverses, never from today. The gold
   rate moves daily and the tax slab is editable in Settings, so re-pricing a
   returned ornament against the current configuration would refund an amount
   the store never charged — over-refunding after a rate rise, short-changing
   the customer after a fall. Every input below therefore comes off the stored
   sale record: its rate, its making charge, its discount, its slab, its mode.

   A return is against ONE LINE of an invoice, because that is the only level at
   which it can be priced: a cart holding 22K bangles and an 18K chain has two
   rates and two making charges on it, and "5g came back" is not a answerable
   question until you know which of the two it was. A single-line invoice has
   exactly one line, so the caller may leave `lineNumber` out and get the old
   behaviour unchanged.
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
 * @param {number} [args.lineNumber]           which line — required only when the
 *                                             invoice has more than one
 * @param {number} [args.alreadyReturnedGrams] grams already returned off THAT LINE
 * @param {number} [args.invoiceRemainingGrams] grams still returnable across the
 *                                             whole invoice; defaults to the
 *                                             line's own remainder, which is the
 *                                             correct value for a one-line sale
 * @param {number} [args.alreadyRefundedAmount] rupees already refunded earlier
 * @returns {{ok: true, ...}|{ok: false, error: string}}
 */
export function computeReturnRefund({
    sale,
    returnWeightGrams,
    lineNumber = null,
    alreadyReturnedGrams = 0,
    invoiceRemainingGrams = null,
    alreadyRefundedAmount = 0
} = {}) {
    if (!sale || typeof sale !== 'object') {
        return { ok: false, error: 'A filed invoice is required to price a return.' };
    }

    const lines = saleLines(sale);
    if (lines.length === 0) {
        return { ok: false, error: 'This invoice has no items on it, so nothing can be returned against it.' };
    }

    // One line means the caller need not name it. More than one and they must:
    // guessing would price a 22K return at an 18K rate.
    let line;
    if (lineNumber === null || lineNumber === undefined) {
        if (lines.length > 1) {
            return {
                ok: false,
                error: 'This invoice has several items on it. Choose which line is being returned.'
            };
        }
        line = lines[0];
    } else {
        line = lines.find(l => l.lineNumber === num(lineNumber));
        if (!line) {
            return { ok: false, error: `This invoice has no line ${lineNumber}.` };
        }
    }

    const originalWeight = round3(line.weightGrams);
    if (!(originalWeight > 0)) {
        return { ok: false, error: 'This invoice carries no gold weight, so nothing can be returned against it.' };
    }

    const returnedSoFar = round3(Math.max(0, alreadyReturnedGrams));
    const remainingWeight = round3(originalWeight - returnedSoFar);
    if (!(remainingWeight > 0)) {
        return {
            ok: false,
            error: lines.length > 1
                ? `Line ${line.lineNumber} of this invoice has already been returned in full.`
                : 'This invoice has already been returned in full.'
        };
    }

    const returnWeight = round3(returnWeightGrams);
    if (!(returnWeight > 0)) {
        return { ok: false, error: 'Enter the weight being returned.' };
    }
    if (returnWeight > remainingWeight) {
        return {
            ok: false,
            error: lines.length > 1
                ? `Only ${remainingWeight.toFixed(3)}g of line ${line.lineNumber} is still returnable.`
                : `Only ${remainingWeight.toFixed(3)}g of this invoice is still returnable.`
        };
    }

    // The gross the invoice actually charged, advance included — see above.
    const filedGross = round2(num(sale.totalAmount) + num(sale.appliedAdvance));
    const refundedSoFar = round2(Math.max(0, alreadyRefundedAmount));
    const refundableRemaining = round2(Math.max(0, filedGross - refundedSoFar));

    // Does the stored record still reconcile against its own line items? Same
    // question ReprintDesk asks before it dares split a stored total into rows,
    // asked here before we dare derive money from those same line items. Rebuilt
    // from ALL the lines, so a multi-line invoice is checked as a whole.
    const storesTaxSplit = sale.taxableAmount !== undefined && sale.taxAmount !== undefined;
    const wholeInvoice = computeInvoiceTotals({
        lines: lines.map(l => ({
            metalValue: l.metalValue,
            makingChargeAmount: l.makingChargeAmount,
            wastageAmount: l.wastageAmount,
            discountPercent: l.discountPercent
        })),
        discountPercent: sale.discountPercent,
        taxSlab: sale.taxPercent,
        taxMode: sale.taxMode
    });
    const itemisable = storesTaxSplit
        && Math.abs(wholeInvoice.totalBeforeAdvance - filedGross) < 0.01;

    const closesLine = returnWeight >= remainingWeight;
    // Whether this is the LAST weight on the whole invoice — which is what the
    // true-up below keys on, because the remainder being trued up is the
    // invoice's unrefunded gross, not the line's.
    const invoiceRemaining = invoiceRemainingGrams === null || invoiceRemainingGrams === undefined
        ? remainingWeight
        : round3(Math.max(0, invoiceRemainingGrams));
    const closesInvoice = closesLine && round3(invoiceRemaining - returnWeight) <= 0;

    const fraction = returnWeight / originalWeight;

    let refundAmount;
    let components = null;

    if (itemisable) {
        // Metal is priced at the LINE's own rate and the returned weight,
        // exactly as the sale was; the making charge — a flat rupee figure on
        // the line — scales with the share of that line's weight going back.
        // The discount is the line's, and the tax slab and mode are the
        // invoice's, because GST is levied on the document.
        const metalValue = computeMetalValue(returnWeight, line.goldPricePerGram);
        const makingChargeAmount = round2(line.makingChargeAmount * fraction);
        // Wastage scales with the same share of the line going back, whichever
        // model priced it — a weight uplift or a making-charge percentage both
        // collapse to "this much of the line's wastage charge" once resolved to ₹.
        const wastageAmount = round2((line.wastageAmount || 0) * fraction);
        const totals = computeInvoiceTotals({
            metalValue,
            makingChargeAmount,
            wastageAmount,
            discountPercent: line.discountPercent,
            taxSlab: sale.taxPercent,
            taxMode: sale.taxMode
        });
        refundAmount = totals.totalBeforeAdvance;
        components = {
            metalValue: totals.components.metalValue,
            makingChargeAmount: totals.components.makingChargeAmount,
            wastageAmount: totals.components.wastageAmount,
            discountAmount: totals.components.discountAmount,
            taxableAmount: totals.taxableAmount,
            taxAmount: totals.taxAmount
        };
    } else {
        // No trustworthy per-line split. Pro-rate the filed gross by this
        // return's share of the invoice's TOTAL weight, not the line's — the
        // line's share of the money is exactly what is not knowable here.
        const invoiceWeight = round3(sum(lines.map(l => l.weightGrams)));
        refundAmount = invoiceWeight > 0
            ? round2(filedGross * (returnWeight / invoiceWeight))
            : 0;
    }

    // True-up and cap. The return that closes the last of the invoice's weight
    // takes the whole unrefunded remainder; any earlier one is capped by it.
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
        lineNumber: line.lineNumber,
        weightGrams: returnWeight,
        remainingWeightAfter: round3(remainingWeight - returnWeight),
        fraction,
        closesLine,
        closesInvoice,
        itemised: components !== null,
        refundAmount,
        components,
        // Echoed from the LINE (rate, purity, making, discount) and the invoice
        // (slab, mode), so the credit note can state the terms the refund was
        // priced on without re-reading the sale record.
        goldPricePerGram: round2(line.goldPricePerGram),
        purity: line.purity || '',
        description: line.description || '',
        makingChargePercent: num(line.makingChargePercent),
        discountPercent: num(line.discountPercent),
        taxPercent: num(sale.taxPercent),
        taxMode: normalizeTaxMode(sale.taxMode)
    };
}
