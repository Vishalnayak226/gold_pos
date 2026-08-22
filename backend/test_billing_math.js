/**
 * ==========================================================================
 * Billing Arithmetic Test Suite
 *
 * Covers the invoice money pipeline in frontend/js/lib/billingMath.js:
 *   discount (pre-tax) → GST inclusive/exclusive → advance redemption.
 *
 * These are the paths the manual checklist (docs/TESTING_CHECKLIST.md §3, §7)
 * can only eyeball. Every expected value below is worked out by hand from the
 * inputs — never by re-running the production formula — so a change in the
 * formula fails the test instead of silently agreeing with it.
 *
 * Run: npm run test:billing   (from backend/)
 * ==========================================================================
 */

import {
    computeInvoiceTotals,
    computeReturnRefund,
    computeWastageAmount,
    computeOldGoldCredit,
    computeGoldGramsForAmount,
    computeGoldSchemePayout,
    round3,
    makingChargeFromPercent,
    makingPercentFromAmount,
    normalizeTaxMode,
    round2,
    toPaise,
    fromPaise,
    computeMetalValue,
    ADVANCE_STATUS,
    advanceEntryDelta,
    computeAdvanceBalance,
    isCountableAdvance,
    normalizeAdvanceStatus,
    summarizeAdvanceLedger,
    summarizeAdvanceLiability,
    saleLines,
    saleTotalWeight,
    describeSaleGoods
} from '../frontend/js/lib/billingMath.js';

/* ==========================================================================
   Minimal test harness — collects every failure instead of dying on the first
   ========================================================================== */
const EPSILON = 1e-9;
let passed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
    currentGroup = name;
    console.log(`\n  ${name}`);
}

function check(label, fn) {
    try {
        fn();
        passed++;
        console.log(`    ✅ ${label}`);
    } catch (err) {
        failures.push({ group: currentGroup, label, message: err.message });
        console.log(`    ❌ ${label}\n         ${err.message}`);
    }
}

/** Float-tolerant equality — money math runs through divisions. */
function near(actual, expected, what = 'value') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) {
        throw new Error(`${what}: expected finite ${expected}, got ${actual}`);
    }
    if (Math.abs(actual - expected) > EPSILON) {
        throw new Error(`${what}: expected ${expected}, got ${actual} (delta ${actual - expected})`);
    }
}

function exact(actual, expected, what = 'value') {
    if (actual !== expected) {
        throw new Error(`${what}: expected exactly ${expected}, got ${actual}`);
    }
}

console.log('======================================================================');
console.log('BILLING ARITHMETIC VERIFICATION');
console.log('======================================================================');

/* ==========================================================================
   1. EXCLUSIVE TAX — slab is added on top
   ========================================================================== */
group('1. Exclusive GST (tax added to the total)');

// 10 g @ ₹7,500/g = ₹75,000 metal; 8% making = ₹6,000; gross ₹81,000; 3% GST.
const EXCL_BASE = {
    metalValue: 75000,
    makingChargeAmount: 6000,
    discountPercent: 0,
    taxSlab: 3,
    taxMode: 'Exclusive'
};

check('gross of metal + making is ₹81,000', () => {
    near(computeInvoiceTotals(EXCL_BASE).preTaxTotal, 81000, 'preTaxTotal');
});

check('3% on ₹81,000 is ₹2,430 of tax', () => {
    near(computeInvoiceTotals(EXCL_BASE).taxAmount, 2430, 'taxAmount');
});

check('grand total is ₹83,430 (gross + tax)', () => {
    near(computeInvoiceTotals(EXCL_BASE).totalAmount, 83430, 'totalAmount');
});

check('taxable value equals the gross — nothing is carved out', () => {
    near(computeInvoiceTotals(EXCL_BASE).taxableAmount, 81000, 'taxableAmount');
});

/* ==========================================================================
   2. INCLUSIVE TAX — slab is carved back out of the total
   ========================================================================== */
group('2. Inclusive GST (tax already contained in the price)');

const INCL_BASE = { ...EXCL_BASE, taxMode: 'Inclusive' };

check('grand total stays ₹81,000 — inclusive tax never inflates the bill', () => {
    near(computeInvoiceTotals(INCL_BASE).totalAmount, 81000, 'totalAmount');
});

check('taxable value is ₹81,000 / 1.03 = ₹78,640.78 (to the paise)', () => {
    // 8,100,000 / 103 = 78,640.776699029126... → ₹78,640.78
    near(computeInvoiceTotals(INCL_BASE).taxableAmount, 78640.78, 'taxableAmount');
});

check('tax carved out is the remainder, ₹2,359.22', () => {
    // 81,000 − 78,640.78 = 2,359.22. Taken as the remainder rather than
    // rounded independently, so the pair always reconstructs the price.
    near(computeInvoiceTotals(INCL_BASE).taxAmount, 2359.22, 'taxAmount');
});

check('inclusive tax is NOT 3% of the gross (would be ₹2,430 — the exclusive figure)', () => {
    const { taxAmount } = computeInvoiceTotals(INCL_BASE);
    if (Math.abs(taxAmount - 2430) < 0.01) {
        throw new Error('inclusive mode computed tax on top of the price instead of carving it out');
    }
});

check('taxable + tax reconstructs the price exactly, at every slab', () => {
    for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
        for (const metalValue of [1, 999.99, 75000, 1234567.89]) {
            const t = computeInvoiceTotals({ metalValue, makingChargeAmount: 0, taxSlab, taxMode: 'Inclusive' });
            near(t.taxableAmount + t.taxAmount, metalValue, `slab ${taxSlab}% on ₹${metalValue}`);
        }
    }
});

check('exclusive always exceeds inclusive for the same price when slab > 0', () => {
    for (const taxSlab of [3, 5, 12, 18, 28]) {
        const excl = computeInvoiceTotals({ ...EXCL_BASE, taxSlab }).totalAmount;
        const incl = computeInvoiceTotals({ ...INCL_BASE, taxSlab }).totalAmount;
        if (!(excl > incl)) {
            throw new Error(`slab ${taxSlab}%: exclusive ₹${excl} should exceed inclusive ₹${incl}`);
        }
        near(excl, 81000 * (1 + taxSlab / 100), `exclusive total at ${taxSlab}%`);
        near(incl, 81000, `inclusive total at ${taxSlab}%`);
    }
});

check('0% slab makes both modes identical', () => {
    const excl = computeInvoiceTotals({ ...EXCL_BASE, taxSlab: 0 });
    const incl = computeInvoiceTotals({ ...INCL_BASE, taxSlab: 0 });
    near(excl.totalAmount, 81000, 'exclusive total');
    near(incl.totalAmount, 81000, 'inclusive total');
    near(excl.taxAmount, 0, 'exclusive tax');
    near(incl.taxAmount, 0, 'inclusive tax');
});

check('any casing or padding of "inclusive" selects inclusive pricing', () => {
    // Previously only the exact string 'Inclusive' switched modes, so a
    // settings.json holding 'inclusive' billed Exclusive — silently adding the
    // slab on top of a price that already contained it. Matching is now
    // case- and whitespace-insensitive.
    for (const variant of ['Inclusive', 'inclusive', 'INCLUSIVE', '  Inclusive  ', 'iNcLuSiVe']) {
        const t = computeInvoiceTotals({ ...EXCL_BASE, taxMode: variant });
        near(t.taxAmount, round2(243000 / 103), `taxMode ${JSON.stringify(variant)} carves tax out`);
        near(t.totalAmount, 81000, `taxMode ${JSON.stringify(variant)} total`);
        exact(t.taxMode, 'Inclusive', `taxMode ${JSON.stringify(variant)} canonicalised`);
    }
});

check('anything unrecognised still falls back to Exclusive', () => {
    for (const variant of [undefined, null, '', 'Nonsense', 'excl', 42, {}]) {
        const t = computeInvoiceTotals({ ...EXCL_BASE, taxMode: variant });
        near(t.taxAmount, 2430, `taxMode ${JSON.stringify(variant) ?? String(variant)} adds tax on top`);
        exact(t.taxMode, 'Exclusive', `taxMode ${JSON.stringify(variant) ?? String(variant)} canonicalised`);
    }
});

check('normalizeTaxMode canonicalises to exactly one of the two modes', () => {
    exact(normalizeTaxMode('inclusive'), 'Inclusive', 'lowercase');
    exact(normalizeTaxMode(' INCLUSIVE '), 'Inclusive', 'padded uppercase');
    exact(normalizeTaxMode('Exclusive'), 'Exclusive', 'exclusive');
    exact(normalizeTaxMode(undefined), 'Exclusive', 'undefined');
    exact(normalizeTaxMode(null), 'Exclusive', 'null');
    exact(normalizeTaxMode('garbage'), 'Exclusive', 'garbage');
});

/* ==========================================================================
   3. DISCOUNT ORDERING — the GST-critical property
   ========================================================================== */
group('3. Discount applies before tax (taxable value must shrink)');

// ₹100,000 metal + ₹10,000 making = ₹110,000 gross; 10% discount; 3% GST.
const DISC_BASE = {
    metalValue: 100000,
    makingChargeAmount: 10000,
    discountPercent: 10,
    taxSlab: 3,
    taxMode: 'Exclusive'
};

check('10% of ₹110,000 is ₹11,000 discount', () => {
    near(computeInvoiceTotals(DISC_BASE).discountAmount, 11000, 'discountAmount');
});

check('discounted base is ₹99,000', () => {
    near(computeInvoiceTotals(DISC_BASE).afterDiscount, 99000, 'afterDiscount');
});

check('tax is ₹2,970 — charged on the DISCOUNTED ₹99,000, not the ₹110,000 gross', () => {
    // This is the assertion that actually pins the ordering. Taxing the gross
    // would give ₹3,300. Both orderings produce the same grand total (a
    // percentage discount and a percentage tax commute), so the grand total
    // cannot detect the bug — only the declared taxable value can, and that
    // is the number that goes on the GST return.
    const { taxAmount } = computeInvoiceTotals(DISC_BASE);
    near(taxAmount, 2970, 'taxAmount');
    if (Math.abs(taxAmount - 3300) < 0.01) {
        throw new Error('tax was charged on the pre-discount gross — over-declares GST');
    }
});

check('taxable value on the invoice is ₹99,000, not ₹110,000', () => {
    near(computeInvoiceTotals(DISC_BASE).taxableAmount, 99000, 'taxableAmount');
});

check('grand total is ₹101,970', () => {
    near(computeInvoiceTotals(DISC_BASE).totalAmount, 101970, 'totalAmount');
});

check('discount is taken on metal + making together, not metal alone', () => {
    // Discounting metal only would give ₹10,000 of discount, not ₹11,000.
    const { discountAmount } = computeInvoiceTotals(DISC_BASE);
    if (Math.abs(discountAmount - 10000) < 0.01) {
        throw new Error('discount skipped the making charge');
    }
    near(discountAmount, 11000, 'discountAmount');
});

check('inclusive mode also discounts before carving out tax', () => {
    const t = computeInvoiceTotals({ ...DISC_BASE, taxMode: 'Inclusive' });
    near(t.afterDiscount, 99000, 'afterDiscount');
    near(t.totalAmount, 99000, 'totalAmount');
    near(t.taxableAmount, 96116.5, 'taxableAmount');   // 9,900,000/103 = 96,116.5049
    near(t.taxAmount, 2883.5, 'taxAmount');            // 99,000 − 96,116.50
});

check('0% discount leaves the bill untouched', () => {
    const t = computeInvoiceTotals({ ...DISC_BASE, discountPercent: 0 });
    near(t.discountAmount, 0, 'discountAmount');
    near(t.afterDiscount, 110000, 'afterDiscount');
    near(t.totalAmount, 113300, 'totalAmount');
});

check('99% discount (the UI maximum) leaves ₹1,133', () => {
    const t = computeInvoiceTotals({ ...DISC_BASE, discountPercent: 99 });
    near(t.discountAmount, 108900, 'discountAmount');
    near(t.afterDiscount, 1100, 'afterDiscount');
    near(t.taxAmount, 33, 'taxAmount');
    near(t.totalAmount, 1133, 'totalAmount');
});

check('100% discount zeroes the bill without going negative', () => {
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        const t = computeInvoiceTotals({ ...DISC_BASE, discountPercent: 100, taxMode });
        near(t.afterDiscount, 0, `afterDiscount (${taxMode})`);
        near(t.taxAmount, 0, `taxAmount (${taxMode})`);
        near(t.totalAmount, 0, `totalAmount (${taxMode})`);
    }
});

/* ==========================================================================
   4. DISCOUNT TOGGLE — the Apply/Remove button's two states
   ========================================================================== */
group('4. Discount toggle (Apply ⇄ Remove round-trip)');

check('toggling a 5% store default off restores the undiscounted bill exactly', () => {
    const withDiscount = computeInvoiceTotals({ ...EXCL_BASE, discountPercent: 5 });
    const removed = computeInvoiceTotals({ ...EXCL_BASE, discountPercent: 0 });

    near(withDiscount.discountAmount, 4050, 'discountAmount at 5%');   // 5% of 81,000
    near(withDiscount.afterDiscount, 76950, 'afterDiscount at 5%');
    near(withDiscount.totalAmount, 79258.5, 'total with discount');    // 76,950 × 1.03
    near(removed.discountAmount, 0, 'discountAmount after removal');
    near(removed.totalAmount, 83430, 'total after removal');
});

check('re-applying the default reproduces the discounted total (no drift)', () => {
    const applied = computeInvoiceTotals({ ...EXCL_BASE, discountPercent: 5 });
    const reapplied = computeInvoiceTotals({ ...EXCL_BASE, discountPercent: 5 });
    exact(applied.totalAmount, reapplied.totalAmount, 'total is deterministic');
});

check('toggle round-trip holds in inclusive mode too', () => {
    const on = computeInvoiceTotals({ ...INCL_BASE, discountPercent: 5 });
    const off = computeInvoiceTotals({ ...INCL_BASE, discountPercent: 0 });
    near(on.totalAmount, 76950, 'inclusive total with 5% off');
    near(off.totalAmount, 81000, 'inclusive total with discount removed');
});

/* ==========================================================================
   5. ADVANCE REDEMPTION
   ========================================================================== */
group('5. Customer advance redemption');

check('a balance larger than the bill redeems only up to the bill', () => {
    const t = computeInvoiceTotals({ ...EXCL_BASE, appliedAdvance: 50000, customerAdvanceBalance: 200000 });
    near(t.totalBeforeAdvance, 83430, 'totalBeforeAdvance');
    near(t.appliedAdvance, 83430, 'appliedAdvance capped at the bill');
    near(t.totalAmount, 0, 'totalAmount');
});

check('a balance smaller than the bill redeems in full', () => {
    const t = computeInvoiceTotals({ ...EXCL_BASE, appliedAdvance: 10000, customerAdvanceBalance: 10000 });
    near(t.appliedAdvance, 10000, 'appliedAdvance');
    near(t.totalAmount, 73430, 'totalAmount');
});

check('no advance applied leaves the bill alone', () => {
    const t = computeInvoiceTotals({ ...EXCL_BASE, appliedAdvance: 0, customerAdvanceBalance: 200000 });
    exact(t.appliedAdvance, 0, 'appliedAdvance');
    near(t.totalAmount, 83430, 'totalAmount');
});

check('shrinking the cart re-clamps a already-applied advance (never negative)', () => {
    // Cashier applies a ₹50,000 advance, then drops the weight to 1 g.
    const t = computeInvoiceTotals({
        metalValue: 7500, makingChargeAmount: 750, taxSlab: 3, taxMode: 'Exclusive',
        appliedAdvance: 50000, customerAdvanceBalance: 50000
    });
    near(t.totalBeforeAdvance, 8497.5, 'totalBeforeAdvance');   // 8,250 × 1.03
    near(t.appliedAdvance, 8497.5, 'advance re-clamped down to the new bill');
    near(t.totalAmount, 0, 'totalAmount floors at zero');
});

check('advance redeems after tax, not before', () => {
    // ₹10,000 off an ₹83,430 taxed bill leaves ₹73,430. Redeeming pre-tax
    // would leave (81,000 − 10,000) × 1.03 = ₹73,130.
    const t = computeInvoiceTotals({ ...EXCL_BASE, appliedAdvance: 10000, customerAdvanceBalance: 10000 });
    near(t.totalAmount, 73430, 'totalAmount');
    if (Math.abs(t.totalAmount - 73130) < 0.01) {
        throw new Error('advance was redeemed against the pre-tax amount');
    }
});

check('advance stacks correctly on top of a discount', () => {
    const t = computeInvoiceTotals({ ...DISC_BASE, appliedAdvance: 1970, customerAdvanceBalance: 1970 });
    near(t.totalBeforeAdvance, 101970, 'totalBeforeAdvance');
    near(t.appliedAdvance, 1970, 'appliedAdvance');
    near(t.totalAmount, 100000, 'totalAmount');
});

check('advance works the same in inclusive mode', () => {
    const t = computeInvoiceTotals({ ...INCL_BASE, appliedAdvance: 1000, customerAdvanceBalance: 1000 });
    near(t.totalAmount, 80000, 'totalAmount');
});

/* ==========================================================================
   6. MAKING CHARGE — the bi-directional %/₹ pair
   ========================================================================== */
group('6. Making charge bi-directional conversion');

check('8% of ₹75,000 metal is ₹6,000', () => {
    const r = makingChargeFromPercent(75000, 8);
    near(r.amount, 6000, 'amount');
    near(r.percent, 8, 'percent');
});

check('₹6,300 on ₹75,000 metal is 8.4%', () => {
    const r = makingPercentFromAmount(6300, 75000);
    near(r.percent, 8.4, 'percent');
    near(r.amount, 6300, 'amount');
});

check('percentage clamps to the 1–100 range', () => {
    near(makingChargeFromPercent(75000, 0).percent, 1, 'below-range percent');
    near(makingChargeFromPercent(75000, 0).amount, 750, 'amount at clamped 1%');
    near(makingChargeFromPercent(75000, 150).percent, 100, 'above-range percent');
    near(makingChargeFromPercent(75000, 150).amount, 75000, 'amount at clamped 100%');
});

check('an amount above the metal value pins the % box at 100 but still charges the amount', () => {
    // Documents the deliberate desync noted in makingPercentFromAmount: the
    // display clamps, the money does not. Checklist §3 exercises this by hand.
    const r = makingPercentFromAmount(80000, 75000);
    near(r.percent, 100, 'percent pinned');
    near(r.amount, 80000, 'amount left unclamped');
});

check('a negative amount is floored at zero', () => {
    near(makingPercentFromAmount(-500, 75000).amount, 0, 'amount');
});

check('no metal value yet leaves the percentage undecided rather than guessing', () => {
    const r = makingPercentFromAmount(5000, 0);
    exact(r.percent, null, 'percent');
    near(r.amount, 5000, 'amount');
});

check('percent → amount → percent round-trips', () => {
    for (const pct of [1, 2.5, 8, 8.4, 12.75, 50, 100]) {
        const { amount } = makingChargeFromPercent(75000, pct);
        near(makingPercentFromAmount(amount, 75000).percent, round2(pct), `round-trip at ${pct}%`);
    }
});

/* ==========================================================================
   7. INPUT HARDENING — blank/garbage fields must not produce ₹NaN
   ========================================================================== */
group('7. Input hardening');

/**
 * Every numeric member of a computeInvoiceTotals() result, flattened —
 * top-level figures, the printed `components`, and each entry of the per-line
 * `lines` allocation. The two guards below both need the same reach, and both
 * need it to keep reaching new fields automatically: a money figure that
 * escapes this walk is a money figure nothing is asserting anything about.
 */
function everyMoneyField(t) {
    const flat = {};
    const collect = (obj, prefix) => {
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'taxMode' || key === 'components' || key === 'lines') continue;
            flat[`${prefix}${key}`] = value;
        }
    };
    collect(t, '');
    collect(t.components || {}, 'components.');
    (t.lines || []).forEach((line, i) => collect(line, `lines[${i}].`));
    return flat;
}

check('empty inputs produce a zero bill, not NaN', () => {
    const t = computeInvoiceTotals();
    // Every money field — top level, printed components, and per-line — must be
    // a real number. taxMode is the one non-numeric member, asserted below.
    for (const [key, value] of Object.entries(everyMoneyField(t))) {
        if (!Number.isFinite(value)) throw new Error(`${key} is ${value}`);
    }
    near(t.totalAmount, 0, 'totalAmount');
    exact(t.taxMode, 'Exclusive', 'taxMode defaults to Exclusive');
});

check('NaN and undefined fields are coerced to zero', () => {
    const t = computeInvoiceTotals({
        metalValue: NaN,
        makingChargeAmount: undefined,
        discountPercent: parseFloat(''),
        taxSlab: NaN,
        taxMode: 'Exclusive'
    });
    near(t.totalAmount, 0, 'totalAmount');
    near(t.taxAmount, 0, 'taxAmount');
});

check('a blank weight with a live rate still yields ₹0, not NaN', () => {
    const t = computeInvoiceTotals({ metalValue: 0, makingChargeAmount: 0, taxSlab: 3, taxMode: 'Inclusive' });
    near(t.totalAmount, 0, 'totalAmount');
    near(t.taxableAmount, 0, 'taxableAmount');
    near(t.taxAmount, 0, 'taxAmount');
});

check('round2 rounds to paise', () => {
    near(round2(2359.223300970874), 2359.22, 'carved tax');
    near(round2(0.005), 0.01, 'half-up at the boundary');
    near(round2(NaN), 0, 'NaN');
});

/* ==========================================================================
   8. REALISTIC END-TO-END BILLS
   ========================================================================== */
group('8. End-to-end scenarios');

check('22K, 12.5 g @ ₹6,875/g, 12% making, 5% off, 3% GST exclusive', () => {
    const metalValue = 12.5 * 6875;                       // 85,937.50
    const makingChargeAmount = metalValue * 0.12;         // 10,312.50
    const t = computeInvoiceTotals({
        metalValue, makingChargeAmount, discountPercent: 5, taxSlab: 3, taxMode: 'Exclusive'
    });
    near(t.preTaxTotal, 96250, 'preTaxTotal');            // 85,937.50 + 10,312.50
    near(t.discountAmount, 4812.5, 'discountAmount');     // 5% of 96,250
    near(t.afterDiscount, 91437.5, 'afterDiscount');
    near(t.taxAmount, 2743.13, 'taxAmount');              // 3% of 91,437.50 = 2,743.125 → 2,743.13
    near(t.totalAmount, 94180.63, 'totalAmount');         // settles to paise, not ₹94,180.625
});

check('same bill quoted GST-inclusive settles at the discounted price', () => {
    const metalValue = 12.5 * 6875;
    const t = computeInvoiceTotals({
        metalValue, makingChargeAmount: metalValue * 0.12,
        discountPercent: 5, taxSlab: 3, taxMode: 'Inclusive'
    });
    near(t.totalAmount, 91437.5, 'totalAmount');
    near(t.taxableAmount, 88774.27, 'taxableAmount');   // 91,437.50/1.03 = 88,774.27184
    near(t.taxAmount, 2663.23, 'taxAmount');            // 91,437.50 − 88,774.27
});

check('18K walk-in, no discount, no advance, inclusive pricing', () => {
    const metalValue = 4.2 * 5625;                        // 23,625
    const t = computeInvoiceTotals({
        metalValue, makingChargeAmount: 2000, taxSlab: 3, taxMode: 'Inclusive'
    });
    near(t.preTaxTotal, 25625, 'preTaxTotal');
    near(t.totalAmount, 25625, 'totalAmount');
    near(t.taxableAmount + t.taxAmount, 25625, 'components reconstruct the total');
});

/* ==========================================================================
   9. THE PRINTED INVOICE ADDS UP
   ==========================================================================
   The customer-facing check: take the rows as they appear on the printed
   invoice, add them the way a customer would, and land on the grand total.
   Inclusive mode used to fail this by exactly the tax amount — the metal and
   making rows printed gross while the grand total was the tax-inclusive price,
   so the visible lines overshot the total they sat above.
   ========================================================================== */
group('9. Printed invoice rows reconcile to the grand total');

/** Add up the invoice exactly as a customer reading the paper would. */
function sumPrintedRows(t) {
    const { metalValue, makingChargeAmount, discountAmount } = t.components;
    return round2(metalValue + makingChargeAmount - discountAmount + t.taxAmount - t.appliedAdvance);
}

check('inclusive rows sum to the grand total (the reported defect)', () => {
    const t = computeInvoiceTotals(INCL_BASE);
    near(sumPrintedRows(t), t.totalAmount, 'printed rows vs grand total');
    // And specifically NOT the old behaviour: gross rows overshot by the tax.
    const grossSum = round2(t.components.grossMetalValue + t.components.grossMakingCharge);
    if (Math.abs(round2(grossSum + t.taxAmount) - t.totalAmount) < 0.01) {
        throw new Error('gross rows + tax should NOT equal the inclusive total');
    }
    near(round2(grossSum + t.taxAmount - t.totalAmount), t.taxAmount, 'old overshoot was exactly the tax');
});

check('exclusive rows are unchanged — they always summed correctly', () => {
    const t = computeInvoiceTotals(EXCL_BASE);
    near(t.components.metalValue, 75000, 'metal row stays gross');
    near(t.components.makingChargeAmount, 6000, 'making row stays gross');
    near(sumPrintedRows(t), 83430, 'printed rows');
    near(sumPrintedRows(t), t.totalAmount, 'printed rows vs grand total');
});

check('rows sum in both modes, across slabs, discounts and advances', () => {
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
            for (const discountPercent of [0, 5, 10, 33.33, 99]) {
                for (const appliedAdvance of [0, 5000]) {
                    const t = computeInvoiceTotals({
                        metalValue: 85937.5, makingChargeAmount: 10312.5,
                        discountPercent, taxSlab, taxMode,
                        appliedAdvance, customerAdvanceBalance: appliedAdvance
                    });
                    near(
                        sumPrintedRows(t), t.totalAmount,
                        `${taxMode} ${taxSlab}% slab, ${discountPercent}% off, ₹${appliedAdvance} advance`
                    );
                }
            }
        }
    }
});

check('the line rows reconcile to the declared taxable value', () => {
    // metal + making − discount === taxableAmount is the identity the GST
    // return depends on; the metal line absorbs any rounding residual.
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
            for (const metalValue of [1, 999.99, 33333.33, 85937.5]) {
                const t = computeInvoiceTotals({
                    metalValue, makingChargeAmount: metalValue * 0.1234,
                    discountPercent: 7.5, taxSlab, taxMode
                });
                const { metalValue: m, makingChargeAmount: mk, discountAmount: d } = t.components;
                near(round2(m + mk - d), t.taxableAmount, `${taxMode} ${taxSlab}% on ₹${metalValue}`);
            }
        }
    }
});

check('gross figures stay available for the cart/catalogue display', () => {
    const t = computeInvoiceTotals(INCL_BASE);
    near(t.components.grossMetalValue, 75000, 'grossMetalValue');
    near(t.components.grossMakingCharge, 6000, 'grossMakingCharge');
});

/* ==========================================================================
   10. EVERY FIGURE SETTLES TO PAISE
   ==========================================================================
   A bill is payable in paise, so ₹94,180.625 is not a real amount to show,
   collect, or persist. Rounding happens once here, at the source, so the
   preview, the print-out, the POSTed payload and the stored ledger record all
   quote the identical number.
   ========================================================================== */
group('10. Money settles to paise at the source');

/** True when a value carries no fraction smaller than a paisa. */
function isPaiseExact(value) {
    return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

check('no returned money field carries sub-paise precision', () => {
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
            for (const discountPercent of [0, 5, 7.5, 33.33]) {
                const t = computeInvoiceTotals({
                    metalValue: 12.5 * 6875, makingChargeAmount: 12.5 * 6875 * 0.12,
                    discountPercent, taxSlab, taxMode,
                    appliedAdvance: 1234.567, customerAdvanceBalance: 1234.567
                });
                for (const [key, value] of Object.entries(everyMoneyField(t))) {
                    if (!isPaiseExact(value)) {
                        throw new Error(
                            `${key} = ${value} (${taxMode}, ${taxSlab}%, ${discountPercent}% off)`
                        );
                    }
                }
            }
        }
    }
});

check('the ₹94,180.625 case now settles at ₹94,180.63', () => {
    const metalValue = 12.5 * 6875;
    const t = computeInvoiceTotals({
        metalValue, makingChargeAmount: metalValue * 0.12,
        discountPercent: 5, taxSlab: 3, taxMode: 'Exclusive'
    });
    exact(t.totalAmount, 94180.63, 'totalAmount');
});

check('taxable + tax always reconstructs the pre-advance total exactly', () => {
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
            for (const metalValue of [1, 999.99, 33333.33, 1234567.89]) {
                const t = computeInvoiceTotals({ metalValue, taxSlab, taxMode });
                near(
                    round2(t.taxableAmount + t.taxAmount), t.totalBeforeAdvance,
                    `${taxMode} ${taxSlab}% on ₹${metalValue}`
                );
            }
        }
    }
});

check('a sub-paise advance cannot leave a fractional balance owing', () => {
    const t = computeInvoiceTotals({
        ...EXCL_BASE, appliedAdvance: 1000.005, customerAdvanceBalance: 1000.005
    });
    if (!isPaiseExact(t.appliedAdvance)) throw new Error(`appliedAdvance ${t.appliedAdvance}`);
    if (!isPaiseExact(t.totalAmount)) throw new Error(`totalAmount ${t.totalAmount}`);
});

/* ==========================================================================
   Advance ledger status arithmetic

   The rule under test: a deposit only becomes spendable balance once the store
   has confirmed it. The portal used to credit a customer-asserted UPI transfer
   instantly, which made it a self-service way to mint an advance balance and
   redeem it against a real bill.

   The backward-compatibility case is the one that matters most in practice —
   every advance row already sitting in a live backend/data/advances.json
   predates the status field and is real money the store took.
   ========================================================================== */
group('11. Advance ledger deposit status');

const deposit = (amount, status) => ({ type: 'deposit', amount, ...(status ? { status } : {}) });
const redeem = (amount) => ({ type: 'redeem', amount });

check('a status-less deposit still counts — existing ledgers keep their balances', () => {
    if (normalizeAdvanceStatus(deposit(5000)) !== ADVANCE_STATUS.APPROVED) {
        throw new Error('a missing status must read as approved');
    }
    exact(computeAdvanceBalance([deposit(5000), deposit(2500)]), 7500, 'legacy balance');
});

check('an approved deposit counts toward the balance', () => {
    exact(computeAdvanceBalance([deposit(5000, 'approved')]), 5000, 'approved balance');
});

check('a pending deposit contributes nothing — the whole point of the state', () => {
    if (isCountableAdvance(deposit(5000, 'pending'))) throw new Error('pending must not be countable');
    exact(advanceEntryDelta(deposit(5000, 'pending')), 0, 'pending delta');
    exact(computeAdvanceBalance([deposit(5000, 'pending')]), 0, 'pending balance');
});

check('a rejected deposit contributes nothing', () => {
    exact(advanceEntryDelta(deposit(5000, 'rejected')), 0, 'rejected delta');
    exact(computeAdvanceBalance([deposit(5000, 'rejected')]), 0, 'rejected balance');
});

check('a mixed ledger counts only what the store has confirmed', () => {
    const ledger = [
        deposit(10000),             // legacy row, counts
        deposit(5000, 'approved'),  // counts
        deposit(50000, 'pending'),  // must NOT count
        deposit(9000, 'rejected'),  // must NOT count
        redeem(3000)                // subtracts
    ];
    exact(computeAdvanceBalance(ledger), 12000, 'mixed balance');
});

check('an unapproved claim cannot be redeemed against a bill', () => {
    // The end-to-end version of the exploit: a customer submits ₹50,000 they
    // never sent, then tries to spend it. The balance the invoice pipeline is
    // handed must be 0, so the redemption clamps to nothing.
    const balance = computeAdvanceBalance([deposit(50000, 'pending')]);
    const t = computeInvoiceTotals({
        metalValue: 60000, appliedAdvance: 50000, customerAdvanceBalance: balance
    });
    exact(t.appliedAdvance, 0, 'appliedAdvance');
    exact(t.totalAmount, 60000, 'totalAmount');
});

check('redemptions always count — they carry no approval step', () => {
    if (!isCountableAdvance(redeem(1000))) throw new Error('a redemption must always count');
    exact(advanceEntryDelta(redeem(1000)), -1000, 'redeem delta');
});

check('status matching is case- and whitespace-insensitive', () => {
    for (const variant of ['PENDING', ' pending ', 'Pending']) {
        exact(computeAdvanceBalance([deposit(5000, variant)]), 0, `variant "${variant}"`);
    }
});

check('an unrecognised status falls back to approved, never to silently zero', () => {
    // Safe direction: a garbled or hand-edited status must not make real money
    // disappear from a customer's balance.
    exact(computeAdvanceBalance([deposit(5000, 'garbage')]), 5000, 'unknown status balance');
});

check('the balance never goes negative', () => {
    exact(computeAdvanceBalance([deposit(1000), redeem(5000)]), 0, 'over-redeemed balance');
});

check('a negative or absurd amount cannot inflate the balance', () => {
    // A hand-edited or corrupted row must not turn a redemption into a credit.
    exact(advanceEntryDelta({ type: 'redeem', amount: -5000 }), -5000, 'negative redeem');
    exact(advanceEntryDelta({ type: 'deposit', amount: -5000 }), 5000, 'negative deposit magnitude');
    exact(computeAdvanceBalance([deposit('not a number')]), 0, 'non-numeric amount');
});

check('summarizeAdvanceLedger reports pending separately from the balance', () => {
    const s = summarizeAdvanceLedger([
        deposit(10000, 'approved'),
        deposit(2500, 'pending'),
        deposit(1500, 'pending'),
        deposit(9000, 'rejected')
    ]);
    exact(s.balance, 10000, 'balance');
    exact(s.pendingTotal, 4000, 'pendingTotal');
    exact(s.pendingCount, 2, 'pendingCount');
});

check('an empty or malformed ledger summarises to zeroes rather than NaN', () => {
    exact(computeAdvanceBalance([]), 0, 'empty balance');
    exact(computeAdvanceBalance(null), 0, 'null balance');
    const s = summarizeAdvanceLedger([null, undefined, {}, { type: 'deposit' }]);
    if (!Number.isFinite(s.balance) || !Number.isFinite(s.pendingTotal)) {
        throw new Error(`summary produced a non-finite figure: ${JSON.stringify(s)}`);
    }
});

check('pending totals settle to paise', () => {
    const s = summarizeAdvanceLedger([deposit(1000.005, 'pending'), deposit(0.004, 'pending')]);
    if (!isPaiseExact(s.pendingTotal)) throw new Error(`pendingTotal ${s.pendingTotal}`);
});

/* --------------------------------------------------------------------------
   The store's whole advance liability — the Dashboard tile, now computed
   server-side so the browser no longer downloads the ledger to add it up.
   -------------------------------------------------------------------------- */

/** A ledger row for a named customer, so the per-customer split can be tested. */
function row(phone, type, amount, status = 'approved') {
    return { customerPhone: phone, type, amount, status, timestamp: 1 };
}

check('liability sums each customer’s spendable balance', () => {
    const s = summarizeAdvanceLiability([
        row('9000000001', 'deposit', 10000),
        row('9000000001', 'redeem', 4000),
        row('9000000002', 'deposit', 2500)
    ]);
    exact(s.outstandingTotal, 8500, 'outstandingTotal');
    exact(s.outstandingCustomers, 2, 'outstandingCustomers');
});

check('a customer with nothing left is not counted as owed', () => {
    const s = summarizeAdvanceLiability([
        row('9000000001', 'deposit', 5000),
        row('9000000001', 'redeem', 5000),
        row('9000000002', 'deposit', 1000)
    ]);
    exact(s.outstandingTotal, 1000, 'outstandingTotal');
    exact(s.outstandingCustomers, 1, 'outstandingCustomers');
});

check('one customer over-redeemed cannot cancel out another’s real credit', () => {
    // The floor is applied PER CUSTOMER. Summing raw deltas would report ₹0
    // owed here and understate what the store actually holds.
    const s = summarizeAdvanceLiability([
        row('9000000001', 'redeem', 3000),
        row('9000000002', 'deposit', 3000)
    ]);
    exact(s.outstandingTotal, 3000, 'outstandingTotal');
    exact(s.outstandingCustomers, 1, 'outstandingCustomers');
});

check('an unapproved claim is not a liability but is reported alongside it', () => {
    const s = summarizeAdvanceLiability([
        row('9000000001', 'deposit', 10000),
        row('9000000002', 'deposit', 7000, 'pending')
    ]);
    exact(s.outstandingTotal, 10000, 'outstandingTotal excludes the pending claim');
    exact(s.outstandingCustomers, 1, 'outstandingCustomers');
    exact(s.pendingTotal, 7000, 'pendingTotal');
    exact(s.pendingCount, 1, 'pendingCount');
});

check('an empty or malformed ledger has no liability rather than NaN', () => {
    const s = summarizeAdvanceLiability([null, undefined, {}]);
    exact(s.outstandingTotal, 0, 'outstandingTotal');
    exact(s.outstandingCustomers, 0, 'outstandingCustomers');
    exact(summarizeAdvanceLiability(null).outstandingTotal, 0, 'null ledger');
});

/* ==========================================================================
   Metal value — the server's authoritative first figure

   /api/sales no longer accepts metalValue from the browser; it derives it from
   the invoice weight and the store's own active rate through computeMetalValue.
   Every other number on the invoice is a percentage of this one, so an error
   here is an error everywhere.
   ========================================================================== */
group('9. Metal value (weight × server rate)');

check('10 g at ₹6,875/g is ₹68,750', () => {
    exact(computeMetalValue(10, 6875), 68750, 'metalValue');
});

check('a fractional weight settles on paise, not on a float tail', () => {
    // 8.335 × 7500 = 62512.5 exactly; the risk is a 62512.499999999996 tail.
    const value = computeMetalValue(8.335, 7500);
    exact(value, 62512.5, 'metalValue');
    if (!isPaiseExact(value)) throw new Error(`metalValue ${value} is not paise-exact`);
});

check('a three-decimal weight (milligram precision) still lands on paise', () => {
    // 1.333 × 6875 = 9164.375 → half-up to 9164.38.
    const value = computeMetalValue(1.333, 6875);
    exact(value, 9164.38, 'metalValue');
    if (!isPaiseExact(value)) throw new Error(`metalValue ${value} is not paise-exact`);
});

check('a rounded metal value flows through to a reconcilable invoice total', () => {
    // The line item that prints must be the one the total was built from.
    const metalValue = computeMetalValue(1.333, 6875); // 9164.38
    const totals = computeInvoiceTotals({
        metalValue,
        makingChargeAmount: 0,
        discountPercent: 0,
        taxSlab: 3,
        taxMode: 'Exclusive',
        appliedAdvance: 0,
        customerAdvanceBalance: 0
    });
    near(totals.taxableAmount, 9164.38, 'taxableAmount');
    near(round2(totals.taxAmount), 274.93, 'taxAmount');   // 9164.38 × 0.03 = 274.9314
    near(round2(totals.totalAmount), 9439.31, 'totalAmount');
});

check('garbage weight or rate yields zero rather than NaN', () => {
    exact(computeMetalValue(undefined, 6875), 0, 'undefined weight');
    exact(computeMetalValue(10, null), 0, 'null rate');
    exact(computeMetalValue('abc', 'def'), 0, 'non-numeric');
});

/* ==========================================================================
   Rupees ↔ paise

   Payment gateways settle in integer paise. Every comparison between "what we
   asked for" and "what was captured" happens in that integer domain, because
   the rupee float for a payable amount is frequently not exact.
   ========================================================================== */
group('10. Rupee ↔ paise conversion');

check('whole rupees convert exactly', () => {
    exact(toPaise(2500), 250000, '₹2500');
    exact(toPaise(1), 100, '₹1');
    exact(toPaise(0), 0, '₹0');
});

check('the classic float-tail amounts convert to the right integer', () => {
    // 1234.35 is stored as 1234.3499999999999; a bare *100 truncates to
    // 123434 paise and the capture comparison then fails on a real payment.
    exact(toPaise(1234.35), 123435, '₹1234.35');
    exact(toPaise(0.07), 7, '₹0.07');
    exact(toPaise(8.29), 829, '₹8.29');
});

check('a sub-paisa input rounds the same way round2 does', () => {
    // 1.005 is not representable: the nearest double is 1.00499999999999989,
    // so it rounds DOWN to 100 paise, not up to 101. That is the correct
    // answer for the value actually held, and the property worth pinning is
    // that both helpers agree on it — a ledger whose rupee column said 1.00
    // while its paise column said 101 would never reconcile.
    exact(toPaise(1.005), 100, '₹1.005');
    exact(round2(1.005), 1, 'round2(1.005)');
    for (const rupees of [1.005, 2.675, 8.615, 1234.355]) {
        exact(toPaise(rupees), Math.round(round2(rupees) * 100), `toPaise/round2 agree on ₹${rupees}`);
    }
});

check('every conversion is an integer — a gateway never accepts a fraction', () => {
    for (const rupees of [0.01, 0.99, 5.555, 99.994, 12345.678, 1e6 + 0.33]) {
        const paise = toPaise(rupees);
        if (!Number.isInteger(paise)) throw new Error(`toPaise(${rupees}) = ${paise} is not an integer`);
    }
});

check('paise round-trip back to the same rupee figure', () => {
    for (const rupees of [100, 2500.5, 1234.35, 0.07, 99999.99]) {
        exact(fromPaise(toPaise(rupees)), round2(rupees), `round-trip ₹${rupees}`);
    }
});

check('fromPaise produces a paise-exact rupee amount', () => {
    for (const paise of [1, 7, 250000, 123435, 999999999]) {
        const rupees = fromPaise(paise);
        if (!isPaiseExact(rupees)) throw new Error(`fromPaise(${paise}) = ${rupees} is not paise-exact`);
    }
});

check('an amount and its capture compare equal in paise where they would not in rupees', () => {
    // The actual production comparison: order amount vs. gateway-reported
    // capture. In rupees these two expressions differ by a float epsilon.
    const ordered = 1234.35;
    const capturedFromGateway = 123435; // what Razorpay reports
    exact(toPaise(ordered), capturedFromGateway, 'paise comparison');
    if (ordered * 100 === capturedFromGateway) {
        throw new Error('expected the naive rupee×100 comparison to be the unreliable one');
    }
});

/* ==========================================================================
   11. THE TAX BASE IS THE WHOLE BILL, NOT THE METAL

   Groups 1 and 2 already price a bill that happens to carry a making charge,
   so a regression to a metal-only tax base would fail them. These checks make
   that property explicit and isolated, because "does GST apply to making
   charges too?" is a question the store gets asked and must be able to answer
   from the invoice — under Indian GST a jewellery sale is a composite supply,
   taxed at one rate on the whole consideration.

   Each check moves ONLY the making charge and asserts the tax moves with it.
   A base that ignored making charges would hold the tax constant and fail.
   ========================================================================== */
group('11. Making charge sits inside the tax base (both modes)');

// Same bill throughout: 10 g @ ₹7,500/g = ₹75,000 metal, 3% GST.
const TAX_BASE_METAL = 75000;

check('EXCLUSIVE: tax rises by slab × making charge, not slab × metal', () => {
    const withoutMaking = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 0, taxSlab: 3, taxMode: 'Exclusive'
    });
    const withMaking = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 6000, taxSlab: 3, taxMode: 'Exclusive'
    });
    near(withoutMaking.taxAmount, 2250, 'tax on metal alone (3% of 75,000)');
    near(withMaking.taxAmount, 2430, 'tax on metal + making (3% of 81,000)');
    // The delta is exactly the slab applied to the making charge: 3% of 6,000.
    near(withMaking.taxAmount - withoutMaking.taxAmount, 180, 'tax attributable to making');
});

check('EXCLUSIVE: the taxable value IS metal + making', () => {
    const t = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 6000, taxSlab: 3, taxMode: 'Exclusive'
    });
    near(t.taxableAmount, 81000, 'taxableAmount');
    if (Math.abs(t.taxableAmount - TAX_BASE_METAL) < 0.01) {
        throw new Error('taxable value collapsed to the metal value — making charge fell out of the base');
    }
});

check('INCLUSIVE: the carve-out runs on metal + making, not metal alone', () => {
    const t = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 6000, taxSlab: 3, taxMode: 'Inclusive'
    });
    // 81,000 / 1.03 = 78,640.78 → tax 2,359.22. Carving out of the metal only
    // would leave 75,000/1.03 = 72,815.53 and a tax of 2,184.47.
    near(t.taxableAmount, 78640.78, 'taxableAmount');
    near(t.taxAmount, 2359.22, 'taxAmount');
    if (Math.abs(t.taxAmount - 2184.47) < 0.01) {
        throw new Error('inclusive carve-out ran on the metal value alone');
    }
});

check('INCLUSIVE: raising the making charge raises the tax carved out', () => {
    const low = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 6000, taxSlab: 3, taxMode: 'Inclusive'
    });
    const high = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 12000, taxSlab: 3, taxMode: 'Inclusive'
    });
    if (!(high.taxAmount > low.taxAmount)) {
        throw new Error(`making charge did not move the inclusive tax (₹${low.taxAmount} vs ₹${high.taxAmount})`);
    }
    // 87,000 / 1.03 = 84,466.02 → remainder 2,533.98.
    near(high.taxAmount, 2533.98, 'taxAmount at ₹12,000 making');
});

check('a making-charge-only bill is still taxed', () => {
    // Repairs and labour-only jobs: no metal sold, making charge alone. A
    // metal-driven tax base would hand this customer a zero-GST invoice.
    const excl = computeInvoiceTotals({
        metalValue: 0, makingChargeAmount: 5000, taxSlab: 3, taxMode: 'Exclusive'
    });
    near(excl.taxableAmount, 5000, 'exclusive taxable');
    near(excl.taxAmount, 150, 'exclusive tax');
    near(excl.totalAmount, 5150, 'exclusive total');

    const incl = computeInvoiceTotals({
        metalValue: 0, makingChargeAmount: 5000, taxSlab: 3, taxMode: 'Inclusive'
    });
    near(incl.taxableAmount, 4854.37, 'inclusive taxable');   // 5,000 / 1.03
    near(incl.taxAmount, 145.63, 'inclusive tax');
    near(incl.totalAmount, 5000, 'inclusive total');
});

check('the discount also applies to metal + making before the slab does', () => {
    // 10% off ₹81,000 = ₹8,100 (not ₹7,500, which is 10% of the metal alone).
    const t = computeInvoiceTotals({
        metalValue: TAX_BASE_METAL, makingChargeAmount: 6000,
        discountPercent: 10, taxSlab: 3, taxMode: 'Exclusive'
    });
    near(t.discountAmount, 8100, 'discountAmount');
    near(t.taxableAmount, 72900, 'taxableAmount after discount');
    near(t.taxAmount, 2187, 'taxAmount (3% of 72,900)');
    near(t.totalAmount, 75087, 'totalAmount');
});

check('the property holds at every slab, in both modes', () => {
    for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
        const base = { metalValue: TAX_BASE_METAL, makingChargeAmount: 6000, taxSlab };

        const excl = computeInvoiceTotals({ ...base, taxMode: 'Exclusive' });
        near(excl.taxableAmount, 81000, `exclusive taxable at ${taxSlab}%`);
        near(excl.taxAmount, round2(81000 * taxSlab / 100), `exclusive tax at ${taxSlab}%`);

        const incl = computeInvoiceTotals({ ...base, taxMode: 'Inclusive' });
        near(incl.taxableAmount, round2(81000 / (1 + taxSlab / 100)), `inclusive taxable at ${taxSlab}%`);
        // Carved out of the gross, so the two always reconstruct the quote.
        near(incl.taxableAmount + incl.taxAmount, 81000, `inclusive reconstruction at ${taxSlab}%`);
    }
});

check('the printed rows still reconcile once making charge is in the base', () => {
    // metal + making − discount === taxable value, so a customer adding the
    // invoice rows up lands on the figure the tax line is computed from.
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 18]) {
            for (const discountPercent of [0, 7.5]) {
                const t = computeInvoiceTotals({
                    metalValue: TAX_BASE_METAL, makingChargeAmount: 6000,
                    discountPercent, taxSlab, taxMode
                });
                const c = t.components;
                near(
                    round2(c.metalValue + c.makingChargeAmount - c.discountAmount),
                    t.taxableAmount,
                    `${taxMode} ${taxSlab}% disc ${discountPercent}%: rows vs taxable`
                );
            }
        }
    }
});

/* ==========================================================================
   RETURNS — refunding part or all of a filed invoice

   Every expected figure below is worked out by hand from the invoice being
   returned, never by re-running computeReturnRefund and writing down what it
   said. The whole point of this block is that a change to the refund formula
   fails here instead of quietly agreeing with itself.
   ========================================================================== */
group('11. Returns — full invoice');

// 10 g @ ₹7,500/g = ₹75,000 metal; 8% making = ₹6,000; gross ₹81,000;
// 3% exclusive GST = ₹2,430; nothing discounted, no advance. Total ₹83,430.
const SALE_EXCL = {
    id: 'GOLD-000001-26',
    weightGrams: 10,
    goldPricePerGram: 7500,
    metalValue: 75000,
    purity: '22K',
    makingChargePercent: 8,
    makingChargeAmount: 6000,
    discountPercent: 0,
    taxPercent: 3,
    taxMode: 'Exclusive',
    taxableAmount: 81000,
    taxAmount: 2430,
    appliedAdvance: 0,
    totalAmount: 83430
};

check('returning the whole invoice refunds exactly what it charged (₹83,430)', () => {
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 10 });
    exact(r.ok, true, 'ok');
    near(r.refundAmount, 83430, 'refundAmount');
});

check('a full return closes the invoice and leaves nothing returnable', () => {
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 10 });
    exact(r.closesInvoice, true, 'closesInvoice');
    near(r.remainingWeightAfter, 0, 'remainingWeightAfter');
});

check('a full return itemises: ₹75,000 metal + ₹6,000 making + ₹2,430 GST', () => {
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 10 });
    exact(r.itemised, true, 'itemised');
    near(r.components.metalValue, 75000, 'metalValue');
    near(r.components.makingChargeAmount, 6000, 'makingChargeAmount');
    near(r.components.taxableAmount, 81000, 'taxableAmount');
    near(r.components.taxAmount, 2430, 'taxAmount');
});

check('the refund is priced at the INVOICE rate, not at any current rate', () => {
    // Nothing in the signature accepts a live rate — this asserts the echoed
    // terms come off the sale record, which is what the credit note prints.
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 10 });
    near(r.goldPricePerGram, 7500, 'goldPricePerGram');
    exact(r.taxMode, 'Exclusive', 'taxMode');
    near(r.taxPercent, 3, 'taxPercent');
});

group('12. Returns — partial by weight');

check('4 g of a 10 g invoice refunds ₹33,372 (₹30,000 + ₹2,400 + 3%)', () => {
    // 4 g @ 7,500 = 30,000 metal; making 6,000 × 0.4 = 2,400; gross 32,400;
    // 3% of 32,400 = 972. Refund 33,372.
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 4 });
    near(r.refundAmount, 33372, 'refundAmount');
    near(r.components.metalValue, 30000, 'metalValue');
    near(r.components.makingChargeAmount, 2400, 'makingChargeAmount');
    near(r.components.taxAmount, 972, 'taxAmount');
});

check('a partial return does not close the invoice; 6 g stays returnable', () => {
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 4 });
    exact(r.closesInvoice, false, 'closesInvoice');
    near(r.remainingWeightAfter, 6, 'remainingWeightAfter');
});

check('the second return takes only the remaining 6 g and ₹50,058', () => {
    const r = computeReturnRefund({
        sale: SALE_EXCL,
        returnWeightGrams: 6,
        alreadyReturnedGrams: 4,
        alreadyRefundedAmount: 33372
    });
    near(r.refundAmount, 50058, 'refundAmount');
    exact(r.closesInvoice, true, 'closesInvoice');
});

check('two partial refunds sum to the invoice exactly', () => {
    const first = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 4 });
    const second = computeReturnRefund({
        sale: SALE_EXCL,
        returnWeightGrams: 6,
        alreadyReturnedGrams: 4,
        alreadyRefundedAmount: first.refundAmount
    });
    near(round2(first.refundAmount + second.refundAmount), 83430, 'sum of refunds');
});

check('three awkward thirds still sum to the invoice to the paise', () => {
    // 3.333 + 3.333 + 3.334 g. Each leg rounds on its own, so only the
    // closing true-up keeps the total honest — this is the drift guard.
    const a = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 3.333 });
    const b = computeReturnRefund({
        sale: SALE_EXCL, returnWeightGrams: 3.333,
        alreadyReturnedGrams: 3.333, alreadyRefundedAmount: a.refundAmount
    });
    const c = computeReturnRefund({
        sale: SALE_EXCL, returnWeightGrams: 3.334,
        alreadyReturnedGrams: round3(3.333 + 3.333),
        alreadyRefundedAmount: round2(a.refundAmount + b.refundAmount)
    });
    exact(c.closesInvoice, true, 'the last leg closes the invoice');
    near(round2(a.refundAmount + b.refundAmount + c.refundAmount), 83430, 'sum of three refunds');
});

group('13. Returns — the refunded gross includes any advance redeemed');

// Same 10 g, but 10% discount, 3% INCLUSIVE GST, and ₹2,900 of the customer's
// advance credit spent on it. preTax 81,000 − 8,100 discount = 72,900, which
// already contains the tax; the customer paid 70,000 in money and 2,900 in
// credit they had already deposited.
const SALE_INCL_ADV = {
    id: 'GOLD-000002-26',
    weightGrams: 10,
    goldPricePerGram: 7500,
    metalValue: 75000,
    purity: '22K',
    makingChargePercent: 8,
    makingChargeAmount: 6000,
    discountPercent: 10,
    taxPercent: 3,
    taxMode: 'Inclusive',
    taxableAmount: 70776.70,
    taxAmount: 2123.30,
    appliedAdvance: 2900,
    totalAmount: 70000
};

check('a full return refunds ₹72,900 — the charge, not just the cash paid', () => {
    // Refunding only totalAmount (70,000) would keep 2,900 of the customer's
    // own deposited money against goods they no longer have.
    const r = computeReturnRefund({ sale: SALE_INCL_ADV, returnWeightGrams: 10 });
    near(r.refundAmount, 72900, 'refundAmount');
});

check('an inclusive-GST return carves the tax out rather than adding it', () => {
    const r = computeReturnRefund({ sale: SALE_INCL_ADV, returnWeightGrams: 10 });
    exact(r.itemised, true, 'itemised');
    near(r.components.taxableAmount, 70776.70, 'taxableAmount');
    near(r.components.taxAmount, 2123.30, 'taxAmount');
    near(round2(r.components.taxableAmount + r.components.taxAmount), 72900, 'rows vs refund');
});

check('half that invoice refunds exactly half — ₹36,450', () => {
    const r = computeReturnRefund({ sale: SALE_INCL_ADV, returnWeightGrams: 5 });
    near(r.refundAmount, 36450, 'refundAmount');
});

check('the discount is reversed on a partial return, not pocketed', () => {
    // 5 g: metal 37,500 + making 3,000 = 40,500; 10% discount = 4,050.
    const r = computeReturnRefund({ sale: SALE_INCL_ADV, returnWeightGrams: 5 });
    near(round2(r.components.taxableAmount + r.components.taxAmount), 36450, 'rows vs refund');
});

group('14. Returns — invoices whose breakdown was never stored');

// Filed before the tax split was recorded against a sale (pre-Phase-20).
const SALE_LEGACY = {
    id: 'GOLD-000003-24',
    weightGrams: 10,
    goldPricePerGram: 5000,
    metalValue: 50000,
    purity: '22K',
    makingChargeAmount: 4000,
    discountPercent: 0,
    appliedAdvance: 0,
    totalAmount: 55620
};

check('a legacy invoice still refunds its filed total in full', () => {
    const r = computeReturnRefund({ sale: SALE_LEGACY, returnWeightGrams: 10 });
    exact(r.ok, true, 'ok');
    near(r.refundAmount, 55620, 'refundAmount');
});

check('a legacy invoice refunds pro-rata on a partial return', () => {
    const r = computeReturnRefund({ sale: SALE_LEGACY, returnWeightGrams: 2.5 });
    near(r.refundAmount, 13905, 'refundAmount');
});

check('no GST breakdown is invented for an invoice that never carried one', () => {
    const r = computeReturnRefund({ sale: SALE_LEGACY, returnWeightGrams: 2.5 });
    exact(r.itemised, false, 'itemised');
    exact(r.components, null, 'components');
});

check('stored figures that do not reconcile refuse to be itemised', () => {
    // taxable + tax = 51,500, but the record claims a 99,999 total. The
    // ledger's own total is refunded; the disagreeing rows are not printed.
    const broken = {
        weightGrams: 10, goldPricePerGram: 5000, metalValue: 50000,
        makingChargeAmount: 0, discountPercent: 0,
        taxPercent: 3, taxMode: 'Exclusive',
        taxableAmount: 50000, taxAmount: 1500,
        appliedAdvance: 0, totalAmount: 99999
    };
    const r = computeReturnRefund({ sale: broken, returnWeightGrams: 10 });
    exact(r.itemised, false, 'itemised');
    near(r.refundAmount, 99999, 'refundAmount');
});

group('15. Returns — what must be refused');

check('a return larger than what is left is refused, naming what remains', () => {
    const r = computeReturnRefund({
        sale: SALE_EXCL, returnWeightGrams: 7, alreadyReturnedGrams: 4
    });
    exact(r.ok, false, 'ok');
    exact(/6\.000g/.test(r.error), true, `error names the remaining weight: ${r.error}`);
});

check('a return larger than the whole invoice is refused', () => {
    exact(computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 10.001 }).ok, false, 'ok');
});

check('a fully-returned invoice refuses any further return', () => {
    const r = computeReturnRefund({
        sale: SALE_EXCL, returnWeightGrams: 1,
        alreadyReturnedGrams: 10, alreadyRefundedAmount: 83430
    });
    exact(r.ok, false, 'ok');
});

check('zero and negative weights are refused', () => {
    exact(computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 0 }).ok, false, 'zero');
    exact(computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: -5 }).ok, false, 'negative');
    exact(computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 'abc' }).ok, false, 'garbage');
});

check('a missing or weightless invoice is refused rather than priced at zero', () => {
    exact(computeReturnRefund({ returnWeightGrams: 1 }).ok, false, 'no sale');
    exact(computeReturnRefund({ sale: null, returnWeightGrams: 1 }).ok, false, 'null sale');
    exact(computeReturnRefund({
        sale: { ...SALE_EXCL, weightGrams: 0 }, returnWeightGrams: 1
    }).ok, false, 'zero-weight invoice');
});

check('a refund can never exceed what is left unrefunded on the invoice', () => {
    // A ledger that somehow already refunded most of the invoice must not
    // hand out a full pro-rata slice on top of it.
    const r = computeReturnRefund({
        sale: SALE_EXCL, returnWeightGrams: 4,
        alreadyReturnedGrams: 1, alreadyRefundedAmount: 83000
    });
    exact(r.ok, true, 'ok');
    exact(r.refundAmount <= 430, true, `refund capped at the remainder, got ${r.refundAmount}`);
});

/* ==========================================================================
   16. MULTI-LINE INVOICES

   One invoice, several items, each with its own purity, rate, making charge and
   discount. Two properties matter more than any individual figure:

     (a) A one-line invoice must price EXACTLY as it did before lines existed,
         to the paise. Every check above this section is that assertion.
     (b) The rows must sum to the header. A customer adding up a printed column
         has to arrive at the total, at every slab, in both tax modes.

   (b) is asserted as an identity over a spread of slabs and discounts rather
   than against hand-worked figures, because it is the identity — not any one
   number — that the allocation exists to guarantee.
   ========================================================================== */
group('16. Multi-line invoices');

// Line 1: 10 g 22K @ ₹7,500 = ₹75,000 metal, 8% making = ₹6,000.
// Line 2:  5 g 18K @ ₹6,000 = ₹30,000 metal, 10% making = ₹3,000.
const TWO_LINES = [
    { metalValue: 75000, makingChargeAmount: 6000, discountPercent: 0 },
    { metalValue: 30000, makingChargeAmount: 3000, discountPercent: 0 }
];

check('a two-line invoice grosses the sum of its lines (₹1,14,000)', () => {
    near(computeInvoiceTotals({ lines: TWO_LINES, taxSlab: 3, taxMode: 'Exclusive' }).preTaxTotal,
        114000, 'preTaxTotal');
});

check('3% GST on ₹1,14,000 is ₹3,420, total ₹1,17,420', () => {
    const t = computeInvoiceTotals({ lines: TWO_LINES, taxSlab: 3, taxMode: 'Exclusive' });
    near(t.taxAmount, 3420, 'taxAmount');
    near(t.totalAmount, 117420, 'totalAmount');
});

check('a two-line invoice equals the single-line invoice of its summed values', () => {
    // The load-bearing compatibility claim: splitting a bill into lines must not
    // move a paise of it.
    const split = computeInvoiceTotals({ lines: TWO_LINES, taxSlab: 3, taxMode: 'Exclusive' });
    const whole = computeInvoiceTotals({
        metalValue: 105000, makingChargeAmount: 9000, taxSlab: 3, taxMode: 'Exclusive'
    });
    for (const key of ['preTaxTotal', 'discountAmount', 'taxableAmount', 'taxAmount', 'totalAmount']) {
        near(split[key], whole[key], key);
    }
});

check('one line in, one line out — and it equals the header', () => {
    const t = computeInvoiceTotals(EXCL_BASE);
    exact(t.lines.length, 1, 'line count');
    near(t.lines[0].taxableAmount, t.taxableAmount, 'line taxable');
    near(t.lines[0].taxAmount, t.taxAmount, 'line tax');
    near(t.lines[0].lineTotal, t.totalBeforeAdvance, 'line total');
});

check('the rows sum to the header at every slab, in both modes, with any discount', () => {
    const lines = [
        { metalValue: 75000, makingChargeAmount: 6000, discountPercent: 0 },
        { metalValue: 30000, makingChargeAmount: 3000, discountPercent: 7.5 },
        { metalValue: 1234.56, makingChargeAmount: 99.99, discountPercent: 33.33 },
        // A zero-value line (a fully discounted giveaway) must not break the
        // weighting or steal a residual paise from a real line.
        { metalValue: 0, makingChargeAmount: 0, discountPercent: 0 }
    ];
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
            const t = computeInvoiceTotals({ lines, taxSlab, taxMode });
            const where = `${taxMode} @ ${taxSlab}%`;
            near(round2(t.lines.reduce((s, l) => s + l.taxableAmount, 0)), t.taxableAmount, `taxable sum, ${where}`);
            near(round2(t.lines.reduce((s, l) => s + l.taxAmount, 0)), t.taxAmount, `tax sum, ${where}`);
            near(round2(t.lines.reduce((s, l) => s + l.lineTotal, 0)), t.totalBeforeAdvance, `total sum, ${where}`);
        }
    }
});

check('a per-line discount applies to that line alone', () => {
    // Line 2 is 25% off: ₹33,000 × 0.25 = ₹8,250 off, nothing off line 1.
    const t = computeInvoiceTotals({
        lines: [
            { metalValue: 75000, makingChargeAmount: 6000, discountPercent: 0 },
            { metalValue: 30000, makingChargeAmount: 3000, discountPercent: 25 }
        ],
        taxSlab: 0, taxMode: 'Exclusive'
    });
    near(t.discountAmount, 8250, 'invoice discount');
    near(t.lines[0].discountAmount, 0, 'line 1 discount');
    near(t.lines[1].discountAmount, 8250, 'line 2 discount');
    near(t.totalAmount, 105750, 'totalAmount');
});

check('a line with no discount of its own inherits the invoice discount', () => {
    const t = computeInvoiceTotals({
        lines: [{ metalValue: 75000, makingChargeAmount: 6000 }, { metalValue: 30000, makingChargeAmount: 3000 }],
        discountPercent: 10, taxSlab: 0, taxMode: 'Exclusive'
    });
    near(t.discountAmount, 11400, 'invoice discount (10% of ₹1,14,000)');
});

check('the advance still redeems against the invoice, not against a line', () => {
    const t = computeInvoiceTotals({
        lines: TWO_LINES, taxSlab: 3, taxMode: 'Exclusive',
        appliedAdvance: 20000, customerAdvanceBalance: 20000
    });
    near(t.appliedAdvance, 20000, 'appliedAdvance');
    near(t.totalAmount, 97420, 'totalAmount after advance');
    // No line carries a share of it — a redemption settles the document.
    near(round2(t.lines.reduce((s, l) => s + l.lineTotal, 0)), 117420, 'rows still gross');
});

/* ==========================================================================
   17. READING A STORED SALE — old shape and new

   saleLines() is the seam that lets a multi-line rollout keep every invoice
   already on disk reprintable and returnable.
   ========================================================================== */
group('17. Reading a stored sale of either shape');

const SALE_MULTI = {
    id: 'GOLD-000009-26',
    lines: [
        {
            lineNumber: 1, description: 'Bangles', purity: '22K', weightGrams: 10,
            goldPricePerGram: 7500, grossMetalValue: 75000,
            makingChargePercent: 8, grossMakingCharge: 6000, discountPercent: 0,
            taxableAmount: 81000, taxAmount: 2430, lineTotal: 83430
        },
        {
            lineNumber: 2, description: 'Chain', purity: '18K', weightGrams: 5,
            goldPricePerGram: 6000, grossMetalValue: 30000,
            makingChargePercent: 10, grossMakingCharge: 3000, discountPercent: 0,
            taxableAmount: 33000, taxAmount: 990, lineTotal: 33990
        }
    ],
    metalValue: 105000,
    makingChargeAmount: 9000,
    discountPercent: 0,
    taxPercent: 3,
    taxMode: 'Exclusive',
    taxableAmount: 114000,
    taxAmount: 3420,
    appliedAdvance: 0,
    totalAmount: 117420
};

check('a legacy scalar sale reads as exactly one line', () => {
    const lines = saleLines(SALE_EXCL);
    exact(lines.length, 1, 'line count');
    exact(lines[0].purity, '22K', 'purity');
    near(lines[0].weightGrams, 10, 'weightGrams');
    near(lines[0].goldPricePerGram, 7500, 'rate');
    near(lines[0].makingChargeAmount, 6000, 'making charge');
});

check('a multi-line sale reads back its own lines', () => {
    const lines = saleLines(SALE_MULTI);
    exact(lines.length, 2, 'line count');
    exact(lines[1].purity, '18K', 'line 2 purity');
    near(lines[1].goldPricePerGram, 6000, 'line 2 rate');
});

check('total weight sums across lines', () => {
    near(saleTotalWeight(SALE_MULTI), 15, 'multi-line weight');
    near(saleTotalWeight(SALE_EXCL), 10, 'legacy weight');
});

check('a sale is described in one phrase, whichever shape it is', () => {
    exact(describeSaleGoods(SALE_EXCL), '22K · 10.000g', 'legacy');
    exact(describeSaleGoods(SALE_MULTI), '2 items · 22K, 18K · 15.000g', 'multi-line');
});

/* ==========================================================================
   18. RETURNING ONE LINE OF A MULTI-LINE INVOICE

   A return has to name its line. A cart holding 22K bangles at ₹7,500 and an
   18K chain at ₹6,000 has two rates on it, so "5 g came back" cannot be priced
   until it is known which 5 g — pricing it against the wrong line would refund
   money the store never charged.
   ========================================================================== */
group('18. Returning one line of a multi-line invoice');

check('a multi-line invoice refuses a return that does not name a line', () => {
    const r = computeReturnRefund({ sale: SALE_MULTI, returnWeightGrams: 5 });
    exact(r.ok, false, 'refused');
    exact(/several items/i.test(r.error), true, `error names the ambiguity, got: ${r.error}`);
});

check('a single-line invoice still needs no line number', () => {
    const r = computeReturnRefund({ sale: SALE_EXCL, returnWeightGrams: 10 });
    exact(r.ok, true, 'ok');
    near(r.refundAmount, 83430, 'refundAmount');
});

check('an unknown line number is refused', () => {
    exact(computeReturnRefund({ sale: SALE_MULTI, returnWeightGrams: 1, lineNumber: 7 }).ok,
        false, 'refused');
});

check('returning line 2 in full refunds line 2 only (₹33,990)', () => {
    const r = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 5, lineNumber: 2,
        invoiceRemainingGrams: 15
    });
    exact(r.ok, true, 'ok');
    // 5 g @ ₹6,000 = ₹30,000 metal + ₹3,000 making = ₹33,000 + 3% = ₹33,990.
    near(r.refundAmount, 33990, 'refundAmount');
    exact(r.purity, '18K', 'priced at line 2 purity');
    near(r.goldPricePerGram, 6000, 'priced at line 2 rate');
    exact(r.closesLine, true, 'closes the line');
    exact(r.closesInvoice, false, 'does NOT close the invoice — line 1 is untouched');
});

check('returning line 1 is priced at line 1 rate, not line 2', () => {
    const r = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 10, lineNumber: 1,
        invoiceRemainingGrams: 15
    });
    exact(r.ok, true, 'ok');
    near(r.refundAmount, 83430, 'refundAmount');
    near(r.goldPricePerGram, 7500, 'priced at line 1 rate');
});

check('a partial return off one line is priced pro-rata within that line', () => {
    // 2 of line 2's 5 g: ₹12,000 metal + ₹1,200 making = ₹13,200 + 3% = ₹13,596.
    const r = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 2, lineNumber: 2,
        invoiceRemainingGrams: 15
    });
    exact(r.ok, true, 'ok');
    near(r.refundAmount, 13596, 'refundAmount');
    near(r.remainingWeightAfter, 3, 'line remainder');
});

check("a line's remainder is its own, not the invoice's", () => {
    // Line 2 is fully returned; a further gram off it is refused even though
    // line 1 still has 10 g of returnable weight on the same invoice.
    const r = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 1, lineNumber: 2,
        alreadyReturnedGrams: 5, invoiceRemainingGrams: 10
    });
    exact(r.ok, false, 'refused');
    exact(/line 2/i.test(r.error), true, `error names the line, got: ${r.error}`);
});

check('returning every line sums to exactly what the invoice charged', () => {
    // Line 2 first, then line 1 closing the invoice — the second is trued up to
    // the unrefunded remainder, so the two refunds must total ₹1,17,420 to the
    // paise however the invoice was split up.
    const first = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 5, lineNumber: 2, invoiceRemainingGrams: 15
    });
    const second = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 10, lineNumber: 1,
        invoiceRemainingGrams: 10, alreadyRefundedAmount: first.refundAmount
    });
    exact(second.closesInvoice, true, 'the second return closes the invoice');
    near(round2(first.refundAmount + second.refundAmount), 117420, 'refunds sum to the filed gross');
});

check('a multi-line refund still itemises into a printable breakdown', () => {
    const r = computeReturnRefund({
        sale: SALE_MULTI, returnWeightGrams: 5, lineNumber: 2, invoiceRemainingGrams: 15
    });
    exact(r.itemised, true, 'itemised');
    near(round2(r.components.taxableAmount + r.components.taxAmount), r.refundAmount,
        'the breakdown adds up to the refund');
    near(r.components.taxableAmount, 33000, 'taxable');
    near(r.components.taxAmount, 990, 'tax');
});

/* ==========================================================================
   §17 Hostile inputs — a bad figure must never INFLATE a bill

   Found by fuzzing computeInvoiceTotals against its own documented invariants.
   Every case below used to produce a total ABOVE `totalBeforeAdvance`, or rows
   that did not sum to the header — an overcharge with nothing on the invoice to
   explain it. POST /api/sales rejects all of these on the way in, but this
   module is where the arithmetic is DEFINED and every other caller (the desk
   preview, the reprint, a stored record carrying a bad figure) runs through it,
   so the floor belongs here rather than in whichever route happens to check.
   ========================================================================== */

check('a negative advance balance cannot inflate the bill', () => {
    const t = computeInvoiceTotals({
        metalValue: 10000, taxSlab: 3,
        appliedAdvance: 1, customerAdvanceBalance: -5000
    });
    near(t.totalBeforeAdvance, 10300, 'bill before any advance');
    exact(t.appliedAdvance, 0, 'a negative balance redeems nothing');
    near(t.totalAmount, 10300, 'the total is NOT 15300 — a negative balance is not a surcharge');
});

check('a negative applied advance cannot inflate the bill', () => {
    const t = computeInvoiceTotals({
        metalValue: 10000, taxSlab: 3,
        appliedAdvance: -500, customerAdvanceBalance: 5000
    });
    exact(t.appliedAdvance, 0, 'a negative advance redeems nothing');
    near(t.totalAmount, 10300, 'the total is NOT 10800');
});

check('the grand total can never exceed the pre-advance total', () => {
    // The property the two cases above are instances of, over a spread of
    // hostile advance/balance pairs.
    for (const appliedAdvance of [-1e6, -500, -0.01, 0, 1, 1e6]) {
        for (const customerAdvanceBalance of [-1e6, -500, 0, 250, 1e6]) {
            const t = computeInvoiceTotals({
                metalValue: 10000, makingChargeAmount: 500, taxSlab: 3,
                appliedAdvance, customerAdvanceBalance
            });
            if (t.totalAmount > t.totalBeforeAdvance + 0.001) {
                throw new Error(
                    `advance ${appliedAdvance} / balance ${customerAdvanceBalance} inflated `
                    + `${t.totalBeforeAdvance} to ${t.totalAmount}`
                );
            }
            if (t.appliedAdvance < 0) {
                throw new Error(`negative appliedAdvance ${t.appliedAdvance} would be persisted`);
            }
        }
    }
});

check('a negative line value cannot break the rows-sum-to-header invariant', () => {
    // A negative metal value is not a discount — there is a discount field for
    // that. It used to be summed into the header while allocateLines() clamped
    // its weight to zero, so the printed rows disagreed with the total beneath.
    const t = computeInvoiceTotals({
        lines: [
            { metalValue: -1000, makingChargeAmount: 0 },
            { metalValue: 5000, makingChargeAmount: 200 }
        ],
        taxSlab: 3
    });
    near(t.components.grossMetalValue, 5000, 'the negative line contributes nothing');
    near(round2(t.lines.reduce((s, l) => s + l.taxableAmount, 0)), t.taxableAmount,
        'line taxable values sum to the header');
    near(round2(t.lines.reduce((s, l) => s + l.taxAmount, 0)), t.taxAmount,
        'line tax values sum to the header');
    near(round2(t.lines.reduce((s, l) => s + l.lineTotal, 0)), t.totalBeforeAdvance,
        'line totals sum to the header');
});

check('a negative making charge is floored rather than credited', () => {
    const t = computeInvoiceTotals({ metalValue: 1000, makingChargeAmount: -400, taxSlab: 0 });
    near(t.preTaxTotal, 1000, 'the negative making charge does not reduce the bill');
    near(t.totalAmount, 1000, 'total');
});

group('19. Wastage (Phase 41, flagged off by default)');

check('mode "none" (the default) charges nothing, regardless of the percentage', () => {
    const w = computeWastageAmount({ mode: 'none', weightGrams: 10, ratePerGram: 7500, makingChargeAmount: 6000, wastagePercent: 5 });
    near(w.wastageAmount, 0, 'wastageAmount');
    near(w.wastageWeightGrams, 0, 'wastageWeightGrams');
});

check('weight_uplift bills extra grams at the line\'s own rate', () => {
    // 10g @ ₹7,500, 5% uplift = 0.5g extra = ₹3,750.
    const w = computeWastageAmount({ mode: 'weight_uplift', weightGrams: 10, ratePerGram: 7500, wastagePercent: 5 });
    near(w.wastageWeightGrams, 0.5, 'wastageWeightGrams');
    near(w.wastageAmount, 3750, 'wastageAmount');
});

check('making_charge_percent and separate_line are the same arithmetic — a percentage of making charge', () => {
    // 8% of ₹6,000 making charge = ₹480.
    for (const mode of ['making_charge_percent', 'separate_line']) {
        const w = computeWastageAmount({ mode, makingChargeAmount: 6000, wastagePercent: 8 });
        near(w.wastageAmount, 480, `wastageAmount (${mode})`);
        near(w.wastageWeightGrams, 0, `wastageWeightGrams (${mode})`);
    }
});

check('disabled (wastageAmount omitted) leaves computeInvoiceTotals byte-identical to before wastage existed', () => {
    const withoutWastage = computeInvoiceTotals(EXCL_BASE);
    const withZeroWastage = computeInvoiceTotals({ ...EXCL_BASE, wastageAmount: 0 });
    for (const key of ['preTaxTotal', 'discountAmount', 'taxableAmount', 'taxAmount', 'totalAmount']) {
        near(withoutWastage[key], withZeroWastage[key], key);
    }
    near(withoutWastage.components.metalValue, withZeroWastage.components.metalValue, 'components.metalValue');
});

check('a wastage charge adds into the pre-tax total at the same tier as making charge', () => {
    const t = computeInvoiceTotals({
        metalValue: 75000, makingChargeAmount: 6000, wastageAmount: 480, taxSlab: 0, taxMode: 'Exclusive'
    });
    near(t.preTaxTotal, 81480, 'preTaxTotal');
    near(t.totalAmount, 81480, 'totalAmount');
    near(t.components.grossWastageAmount, 480, 'components.grossWastageAmount');
});

check('the rows still sum to the header with wastage present, at every slab, in both modes', () => {
    const lines = [
        { metalValue: 75000, makingChargeAmount: 6000, wastageAmount: 480, discountPercent: 0 },
        { metalValue: 30000, makingChargeAmount: 3000, wastageAmount: 0, discountPercent: 7.5 }
    ];
    for (const taxMode of ['Exclusive', 'Inclusive']) {
        for (const taxSlab of [0, 3, 5, 12, 18, 28]) {
            const t = computeInvoiceTotals({ lines, taxSlab, taxMode });
            const where = `${taxMode} @ ${taxSlab}%`;
            near(round2(t.lines.reduce((s, l) => s + l.taxableAmount, 0)), t.taxableAmount, `taxable sum, ${where}`);
            near(round2(t.lines.reduce((s, l) => s + l.taxAmount, 0)), t.taxAmount, `tax sum, ${where}`);
            near(round2(t.lines.reduce((s, l) => s + l.lineTotal, 0)), t.totalBeforeAdvance, `total sum, ${where}`);
            // metal + making + wastage − discount === taxable, per line — the
            // generalised form of the identity computeInvoiceTotals documents.
            for (const l of t.lines) {
                near(round2(l.metalValue + l.makingChargeAmount + l.wastageAmount - l.discountAmount),
                    l.taxableAmount, `line ${l.lineNumber} metal+making+wastage-discount==taxable, ${where}`);
            }
        }
    }
});

check('a one-line invoice with wastage prices identically whether wastage is a scalar arg or a one-item lines[] array', () => {
    const scalar = computeInvoiceTotals({ metalValue: 75000, makingChargeAmount: 6000, wastageAmount: 480, taxSlab: 3, taxMode: 'Exclusive' });
    const asLine = computeInvoiceTotals({ lines: [{ metalValue: 75000, makingChargeAmount: 6000, wastageAmount: 480 }], taxSlab: 3, taxMode: 'Exclusive' });
    for (const key of ['preTaxTotal', 'taxableAmount', 'taxAmount', 'totalAmount']) {
        near(scalar[key], asLine[key], key);
    }
});

check('a returned line refunds its share of the wastage charge too', () => {
    // A 10g line, 5% weight-uplift wastage already resolved to ₹3,750 at filing
    // time, half the weight now comes back — half the wastage should too.
    const sale = {
        lines: [{
            lineNumber: 1, weightGrams: 10, goldPricePerGram: 7500,
            grossMetalValue: 75000, grossMakingCharge: 6000, grossWastageAmount: 3750,
            discountPercent: 0, taxableAmount: 84750, taxAmount: 0, lineTotal: 84750
        }],
        metalValue: 75000, makingChargeAmount: 6000, discountPercent: 0,
        taxPercent: 0, taxMode: 'Exclusive',
        taxableAmount: 84750, taxAmount: 0,
        appliedAdvance: 0, totalAmount: 84750
    };
    const result = computeReturnRefund({ sale, returnWeightGrams: 5 });
    if (!result.ok) throw new Error(result.error);
    near(result.components.wastageAmount, 1875, 'half the wastage charge should be refunded');
    near(result.refundAmount, 42375, 'half the whole line, wastage included');
});

group('20. Old-gold exchange credit (Phase 41, flagged off by default)');

check('a 5% deduction on 10g nets 9.5g, credited at the tested purity\'s rate', () => {
    const r = computeOldGoldCredit({ grossWeightGrams: 10, ratePerGram: 6875, deductionPercent: 5 });
    near(r.netWeightGrams, 9.5, 'netWeightGrams');
    near(r.creditAmount, round2(9.5 * 6875), 'creditAmount');
});

check('a 0% deduction credits the full weight', () => {
    const r = computeOldGoldCredit({ grossWeightGrams: 10, ratePerGram: 1000, deductionPercent: 0 });
    near(r.netWeightGrams, 10, 'netWeightGrams');
    near(r.creditAmount, 10000, 'creditAmount');
});

check('a 100% deduction credits nothing, never a negative amount', () => {
    const r = computeOldGoldCredit({ grossWeightGrams: 10, ratePerGram: 1000, deductionPercent: 100 });
    near(r.netWeightGrams, 0, 'netWeightGrams');
    near(r.creditAmount, 0, 'creditAmount');
});

check('a deduction percentage outside 0-100 is clamped, not trusted', () => {
    const over = computeOldGoldCredit({ grossWeightGrams: 10, ratePerGram: 1000, deductionPercent: 150 });
    near(over.netWeightGrams, 0, 'over 100% clamps to 100%');
    const under = computeOldGoldCredit({ grossWeightGrams: 10, ratePerGram: 1000, deductionPercent: -20 });
    near(under.netWeightGrams, 10, 'a negative deduction clamps to 0%, never inflating the credit');
});

check('the credit is store-rate arithmetic, not a fraction of a 24K price', () => {
    // The store already configures a distinct rate per purity — the tested
    // purity's OWN rate is passed straight in, never a 24K rate scaled down.
    const at22K = computeOldGoldCredit({ grossWeightGrams: 5, ratePerGram: 6875, deductionPercent: 10 });
    const at18K = computeOldGoldCredit({ grossWeightGrams: 5, ratePerGram: 5625, deductionPercent: 10 });
    near(at22K.netWeightGrams, at18K.netWeightGrams, 'the SAME net weight');
    if (at22K.creditAmount === at18K.creditAmount) {
        throw new Error('different purity rates must produce different credit amounts');
    }
});

group('21. Gold savings schemes (Phase 41, flagged off by default)');

check('an installment locks amount/rate grams, simple division', () => {
    near(computeGoldGramsForAmount(6875, 6875), 1, '1g at that gram\'s own rate');
    near(computeGoldGramsForAmount(1000, 1000), 1);
    near(computeGoldGramsForAmount(0, 1000), 0, 'a zero amount locks zero grams');
});

check('a zero or unusable rate locks zero grams rather than dividing by it', () => {
    near(computeGoldGramsForAmount(1000, 0), 0);
    near(computeGoldGramsForAmount(1000, -5), 0);
});

check('a full-term maturity credits real grams plus a bonus valued at the SAME average rate', () => {
    // 11 installments of 1g each = 11g total, 1 bonus installment's worth =
    // another 1g at the same 1g/installment average — 12g total, valued at
    // today's rate.
    const r = computeGoldSchemePayout({
        totalGramsLocked: 11, installmentsPaid: 11, bonusInstallments: 1,
        penaltyPercent: 0, currentRatePerGram: 7000
    });
    near(r.bonusGrams, 1);
    near(r.penaltyGrams, 0);
    near(r.payoutGrams, 12);
    near(r.payoutAmount, 84000, '12g × ₹7,000');
});

check('an early closure gets no bonus and pays the penalty in grams before conversion', () => {
    // 5g locked, a 10% early-closure penalty = 0.5g forfeited, 4.5g paid out.
    const r = computeGoldSchemePayout({
        totalGramsLocked: 5, installmentsPaid: 5, bonusInstallments: 0,
        penaltyPercent: 10, currentRatePerGram: 1000
    });
    near(r.bonusGrams, 0);
    near(r.penaltyGrams, 0.5);
    near(r.payoutGrams, 4.5);
    near(r.payoutAmount, 4500);
});

check('a penalty percentage above 100 is clamped, never forfeiting more than everything', () => {
    const r = computeGoldSchemePayout({
        totalGramsLocked: 5, installmentsPaid: 5, penaltyPercent: 250, currentRatePerGram: 1000
    });
    near(r.penaltyGrams, 5);
    near(r.payoutGrams, 0);
    near(r.payoutAmount, 0);
});

check('an uneven average per installment still bonuses fairly', () => {
    // Two installments locking 1g and 3g (a rate move between payments) = 4g
    // over 2 installments, average 2g — a 1-installment bonus is 2g, not 1g.
    const r = computeGoldSchemePayout({
        totalGramsLocked: 4, installmentsPaid: 2, bonusInstallments: 1,
        currentRatePerGram: 1000
    });
    near(r.bonusGrams, 2);
    near(r.payoutGrams, 6);
});

/* ==========================================================================
   Summary
   ========================================================================== */
console.log('\n======================================================================');
if (failures.length === 0) {
    console.log(`🎉 ALL ${passed} BILLING ARITHMETIC CHECKS PASSED.`);
    console.log('======================================================================');
} else {
    console.log(`❌ ${failures.length} FAILED, ${passed} passed.`);
    failures.forEach(f => console.log(`   • [${f.group}] ${f.label}\n     ${f.message}`));
    console.log('======================================================================');
    process.exit(1);
}
