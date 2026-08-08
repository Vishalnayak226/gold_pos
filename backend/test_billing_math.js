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
    makingChargeFromPercent,
    makingPercentFromAmount,
    normalizeTaxMode,
    round2,
    ADVANCE_STATUS,
    advanceEntryDelta,
    computeAdvanceBalance,
    isCountableAdvance,
    normalizeAdvanceStatus,
    summarizeAdvanceLedger
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

check('empty inputs produce a zero bill, not NaN', () => {
    const t = computeInvoiceTotals();
    // Every money field — top level and the per-line components — must be a
    // real number. taxMode is the one non-numeric member and is asserted below.
    const moneyFields = { ...t, ...t.components };
    delete moneyFields.taxMode;
    delete moneyFields.components;
    for (const [key, value] of Object.entries(moneyFields)) {
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
                const fields = { ...t, ...t.components };
                delete fields.taxMode;
                delete fields.components;
                for (const [key, value] of Object.entries(fields)) {
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
