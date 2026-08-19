/**
 * ==========================================================================
 * Repository, service and importer suite (ADR-001, roadmap Phase 1).
 *
 * `test_schema.js` proves the CONSTRAINTS refuse bad writes. This suite proves
 * the code above them does the right thing with good ones: that the seam
 * projects the legacy wire shape exactly, that a sale is one transaction, that
 * pagination does not paginate the arithmetic, and that the importer moves a
 * real tenant's books across without losing a paise.
 *
 * The legacy-shape assertions are the load-bearing ones. Every screen, the
 * customer portal and both HTTP suites read the shapes `sales_YYYY.json`,
 * `returns_YYYY.json` and `advances.json` held; the storage changed underneath
 * them and the contract did not. A field quietly renamed or a rupee figure
 * turned into paise on the wire would break the desk without breaking a test,
 * unless that contract is asserted here.
 *
 * GOLD_POS_DATA_DIR is set on the FIRST line for the reason CLAUDE.md §8
 * spells out: db.js resolves DATA_DIR once at import and ESM caches it, so
 * setting it later would point this suite at the tenant's real ledger.
 *
 * Native assert only. Zero extra dependencies.
 * ==========================================================================
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-repo-'));
process.env.GOLD_POS_DATA_DIR = path.join(TEMP_ROOT, 'data');
process.env.GOLD_POS_LOGS_DIR = path.join(TEMP_ROOT, 'logs');

const assert = (await import('assert')).default;
const repo = await import('./repositories/index.js');
const saleService = await import('./services/saleService.js');
const returnService = await import('./services/returnService.js');
const { round2, toPaise } = await import('../frontend/js/lib/billingMath.js');
const advanceService = await import('./services/advanceService.js');
const paymentService = await import('./services/paymentService.js');
const importer = await import('./importLegacyJson.js');

let passed = 0;
function check(label, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${label}`);
}

function refuses(fn, pattern) {
    let threw = null;
    try { fn(); } catch (err) { threw = err; }
    assert.ok(threw, 'expected a refusal, but the call succeeded');
    if (pattern) assert.match(threw.message, pattern);
    return threw;
}

/* --------------------------------------------------------------------------
   Fixtures
   -------------------------------------------------------------------------- */

const RATES = {
    price24K: 7500, price22K: 6875, price18K: 5600,
    sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
};

const SETTINGS = {
    companyName: 'Test Jewellers',
    goldTaxSlab: 3,
    taxMode: 'Exclusive',
    invoicePrefix: 'GOLD',
    invoiceSeqStart: 1
};

const DEPS = {
    getActiveGoldRates: () => RATES,
    getSettings: () => SETTINGS,
    isValidPhone: phone => typeof phone === 'string' && /^\d{10}$/.test(phone)
};

const context = repo.initialiseDataStore({ name: SETTINGS.companyName });

console.log('\n🧪 Repositories, services and importer\n');

/* ==========================================================================
   1. Boot and organisation
   ========================================================================== */

console.log('1. Boot');

check('initialiseDataStore is idempotent and returns stable ids', () => {
    const again = repo.initialiseDataStore({ name: SETTINGS.companyName });
    assert.equal(again.tenantId, context.tenantId);
    assert.equal(again.branchId, context.branchId);
    assert.equal(again.ownerUserId, context.ownerUserId);
});

check('both bootstrap identities exist and can approve', () => {
    const approvers = repo.users.listApprovers(context.tenantId).map(u => u.username).sort();
    assert.deepEqual(approvers, ['owner', 'system']);
    assert.ok(repo.users.isApprover(context.tenantId, context.ownerUserId));
});

check('neither bootstrap identity can be logged into', () => {
    const owner = repo.users.findUserById(context.ownerUserId);
    assert.equal(owner.password_hash, null, 'an accountability anchor must not be a credential');
    assert.equal(owner.must_change_password, 1);
});

check('the data store reports itself ready once migrated', () => {
    assert.equal(repo.isDataStoreReady(), true);
});

/* ==========================================================================
   2. Calendar — business date and financial year
   ========================================================================== */

console.log('\n2. Shop-day and financial-year arithmetic');

check('financial year runs April to March', () => {
    assert.equal(repo.financialYear(new Date(2026, 3, 1).getTime()), '2026-27', '1 April starts the new FY');
    assert.equal(repo.financialYear(new Date(2026, 2, 31).getTime()), '2025-26', '31 March is still the old FY');
    assert.equal(repo.financialYear(new Date(2027, 1, 11).getTime()), '2026-27', 'February belongs to the FY that began the previous April');
});

check('business date is a shop day, not a UTC instant', () => {
    assert.equal(repo.businessDate(new Date(2026, 7, 11, 23, 30).getTime()), '2026-08-11');
    assert.equal(repo.businessDate(new Date(2026, 7, 12, 0, 30).getTime()), '2026-08-12');
});

check('business date refuses an unusable timestamp rather than inventing one', () => {
    refuses(() => repo.businessDate(NaN), /valid timestamp/);
});

/* ==========================================================================
   3. Sequence allocation — the duplicate-invoice-number fix
   ========================================================================== */

console.log('\n3. Document numbering');

check('sequential allocation never repeats a number', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
        const { sequenceValue } = repo.inTransaction(() => repo.sequences.allocate({
            tenantId: context.tenantId, branchId: context.branchId,
            documentType: 'invoice', financialYear: '2099-00', prefix: 'T'
        }));
        assert.ok(!seen.has(sequenceValue), `sequence ${sequenceValue} was issued twice`);
        seen.add(sequenceValue);
    }
    assert.equal(seen.size, 50);
});

check('allocation outside a transaction is refused, not silently allowed', () => {
    refuses(() => repo.sequences.allocate({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: '2099-00'
    }), /must run inside inTransaction/);
});

check('a rolled-back sale returns its number rather than burning it', () => {
    const before = repo.sequences.peek({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: '2098-99'
    });
    try {
        repo.inTransaction(() => {
            repo.sequences.allocate({
                tenantId: context.tenantId, branchId: context.branchId,
                documentType: 'invoice', financialYear: '2098-99', prefix: 'T'
            });
            throw new Error('sale failed after allocation');
        });
    } catch (_) { /* expected */ }

    const after = repo.sequences.peek({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: '2098-99'
    });
    assert.equal(after, before, 'a rolled-back allocation must leave no trace');
});

check('reserveUpTo raises the floor and never lowers it', () => {
    repo.inTransaction(() => repo.sequences.reserveUpTo({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: '2097-98', throughValue: 500
    }));
    repo.inTransaction(() => repo.sequences.reserveUpTo({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: '2097-98', throughValue: 12
    }));
    const next = repo.inTransaction(() => repo.sequences.allocate({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: '2097-98'
    }));
    assert.equal(next.sequenceValue, 501, 'a lower reservation must not rewind the series');
});

/* ==========================================================================
   4. The sale — one transaction, server-side money
   ========================================================================== */

console.log('\n4. Sales');

const CASH_SALE = saleService.createSale({
    purity: '22K', weightGrams: 10, customerName: 'Asha Rao', customerPhone: '9876543210',
    makingChargeAmount: 5000, makingChargePercent: 7.27, discountPercent: 0
}, DEPS);

check('a sale is created and numbered', () => {
    assert.equal(CASH_SALE.ok, true, CASH_SALE.error);
    assert.match(CASH_SALE.invoiceId, /^GOLD-\d{6}-\d{2}$/);
});

check('the persisted sale carries every legacy field, in rupees', () => {
    const sale = CASH_SALE.sale;
    // The exact key set sales_YYYY.json holds. Asserted as a set, not field by
    // field, so a field silently DROPPED fails as loudly as one renamed.
    // `lines`, `tenders` and `actor` are part of that set: a sale record is
    // BOTH shapes at once (CLAUDE.md §0), and a projection that returns only
    // the rollup is the regression this assertion exists to catch.
    const expected = [
        'actor', 'appliedAdvance', 'customerName', 'customerPhone', 'discount', 'discountPercent',
        'goldPricePerGram', 'goldRateSource', 'id', 'lines', 'makingChargeAmount', 'makingChargePercent',
        'metalValue', 'purity', 'taxAmount', 'taxMode', 'taxPercent', 'taxableAmount',
        'tenders', 'timestamp', 'totalAmount', 'weightGrams'
    ];
    assert.deepEqual(Object.keys(sale).sort(), expected);
});

check('a one-line invoice’s lines sum exactly to its header', () => {
    const sale = CASH_SALE.sale;
    assert.equal(sale.lines.length, 1, 'a single-item sale is a one-line invoice');
    const line = sale.lines[0];
    assert.equal(line.lineNumber, 1);
    assert.equal(line.purity, '22K');
    assert.equal(line.weightGrams, 10);
    assert.equal(line.goldPricePerGram, 6875);
    assert.equal(line.grossMetalValue, sale.metalValue);
    assert.equal(line.grossMakingCharge, sale.makingChargeAmount);
    assert.equal(line.taxableAmount, sale.taxableAmount);
    assert.equal(line.taxAmount, sale.taxAmount);
    // The rollup states a single line's own purity and rate, not 'MIXED'/0.
    assert.equal(sale.purity, '22K');
    assert.equal(sale.goldPricePerGram, 6875);
});

check('the money is the server’s own arithmetic, to the paise', () => {
    const sale = CASH_SALE.sale;
    assert.equal(sale.metalValue, 68750, '10g × ₹6,875');
    assert.equal(sale.makingChargeAmount, 5000);
    assert.equal(sale.taxableAmount, 73750);
    assert.equal(sale.taxAmount, 2212.5, '3% of ₹73,750');
    assert.equal(sale.totalAmount, 75962.5);
    assert.equal(sale.taxableAmount + sale.taxAmount, sale.totalAmount,
        'the invoice must reconcile exactly');
});

check('a client-supplied total is overridden and reported, never trusted', () => {
    const result = saleService.createSale({
        purity: '22K', weightGrams: 1, customerName: 'Tamper',
        clientTotal: 1, clientRate: 1
    }, DEPS);
    assert.equal(result.ok, true);
    assert.equal(result.totalCorrected, true);
    assert.equal(result.rateCorrected, true);
    assert.equal(result.sale.goldPricePerGram, 6875, 'the store’s rate, not the browser’s');
});

check('a sale is refused when the active rate is unusable', () => {
    const result = saleService.createSale({ purity: '22K', weightGrams: 1 }, {
        ...DEPS,
        getActiveGoldRates: () => ({ ...RATES, price22K: 0 })
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
});

check('the sale wrote exactly one invoice, one line and an audit row', () => {
    const header = repo.invoices.findByNumber(context.tenantId, CASH_SALE.invoiceId);
    assert.ok(header);
    assert.equal(repo.invoices.linesFor(header.id).length, 1);
    assert.equal(header.state, 'issued');
    const trail = repo.audit.historyFor(context.tenantId, 'invoice', header.id);
    assert.equal(trail.length, 1);
    assert.equal(trail[0].action, 'SALE_ISSUED');
});


/* ==========================================================================
   4b. The multi-line invoice

   The seam was built when an invoice held one gold item, while the Billing
   Desk had already started filing carts. Everything below is the gap that
   left: a projection that returned only the rollup, a rollup that reported
   line 1's purity for a mixed cart, and a return that refunded whichever line
   happened to be first.
   ========================================================================== */

console.log('\n4b. Multi-line invoices');

const MULTI_SALE = saleService.createSale({
    customerName: 'Cart Customer',
    customerPhone: '9876500011',
    lines: [
        { description: 'Bangles', purity: '22K', weightGrams: 4, makingChargeAmount: 400, makingChargePercent: 8 },
        { description: 'Chain', purity: '18K', weightGrams: 2, makingChargeAmount: 150, makingChargePercent: 6 },
        { description: 'Coin', purity: '24K', weightGrams: 1, makingChargeAmount: 0 }
    ]
}, DEPS);

check('a cart of three items files as one invoice with three lines', () => {
    assert.equal(MULTI_SALE.ok, true, MULTI_SALE.error);
    assert.equal(MULTI_SALE.sale.lines.length, 3);
    assert.deepEqual(MULTI_SALE.sale.lines.map(l => l.lineNumber), [1, 2, 3]);
    assert.deepEqual(MULTI_SALE.sale.lines.map(l => l.purity), ['22K', '18K', '24K']);
    assert.deepEqual(MULTI_SALE.sale.lines.map(l => l.description), ['Bangles', 'Chain', 'Coin']);
});

check('each line is priced at ITS OWN purity’s store rate', () => {
    const [bangles, chain, coin] = MULTI_SALE.sale.lines;
    assert.equal(bangles.goldPricePerGram, RATES.price22K);
    assert.equal(chain.goldPricePerGram, RATES.price18K);
    assert.equal(coin.goldPricePerGram, RATES.price24K);
    // …and the metal value follows the line's own rate and weight.
    assert.equal(bangles.grossMetalValue, round2(4 * RATES.price22K));
    assert.equal(coin.grossMetalValue, round2(1 * RATES.price24K));
});

check('the rollup answers honestly rather than reporting line 1', () => {
    const sale = MULTI_SALE.sale;
    // 'MIXED' and 0 are what an honest rollup says when the lines disagree —
    // not sentinels, and not to be "fixed" to the first line's value (§0).
    assert.equal(sale.purity, 'MIXED');
    assert.equal(sale.goldPricePerGram, 0, 'a mixed-rate invoice states no single rate');
    assert.equal(sale.weightGrams, 7, 'the rollup weight is the whole cart');
    assert.equal(sale.makingChargeAmount, 550, '400 + 150 + 0');
    assert.equal(sale.makingChargePercent, 0, 'no single making-charge rate to state');
});

check('the per-line figures sum EXACTLY to the header, in paise', () => {
    const sale = MULTI_SALE.sale;
    const sum = (pick) => sale.lines.reduce((total, line) => total + toPaise(pick(line)), 0);
    assert.equal(sum(l => l.taxableAmount), toPaise(sale.taxableAmount));
    assert.equal(sum(l => l.taxAmount), toPaise(sale.taxAmount));
    assert.equal(sum(l => l.grossMetalValue), toPaise(sale.metalValue));
    assert.equal(sum(l => l.grossMakingCharge), toPaise(sale.makingChargeAmount));
    // And the rows add up to what the customer actually pays.
    assert.equal(sum(l => l.lineTotal), toPaise(sale.totalAmount) + toPaise(sale.appliedAdvance));
});

check('a reprint reads back every line, unchanged', () => {
    const reread = saleService.findSale(MULTI_SALE.invoiceId);
    assert.equal(reread.lines.length, 3);
    assert.deepEqual(
        reread.lines.map(l => [l.purity, l.weightGrams, l.goldPricePerGram]),
        MULTI_SALE.sale.lines.map(l => [l.purity, l.weightGrams, l.goldPricePerGram])
    );
    assert.equal(reread.purity, 'MIXED');
});

check('a multi-line invoice refuses a return that does not name its line', () => {
    const refused = returnService.createReturn({
        invoiceId: MULTI_SALE.invoiceId, weightGrams: 1, refundMode: 'cash'
    }, DEPS);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.match(refused.error, /several items|which line/i);
});

check('returning line 3 prices it at the 24K rate, not line 1’s', () => {
    const filed = returnService.createReturn({
        invoiceId: MULTI_SALE.invoiceId, lineNumber: 3, weightGrams: 1, refundMode: 'cash'
    }, DEPS);
    assert.equal(filed.ok, true, filed.error);
    assert.equal(filed.return.lineNumber, 3);
    assert.equal(filed.return.purity, '24K');
    assert.equal(filed.return.goldPricePerGram, round2(RATES.price24K));
    // The coin is gone; the bangles and the chain are untouched.
    assert.equal(filed.return.closesLine, true);
    assert.equal(filed.return.closesInvoice, false);
    assert.equal(filed.invoiceRemainingWeightGrams, 6);
});

check('a line’s returnable weight is its own, not the invoice’s', () => {
    // Line 3 is exhausted. Asking for more of it is refused even though the
    // invoice as a whole still has 6 g on it — the counter lives on the line.
    const overReturn = returnService.createReturn({
        invoiceId: MULTI_SALE.invoiceId, lineNumber: 3, weightGrams: 1, refundMode: 'cash'
    }, DEPS);
    assert.equal(overReturn.ok, false);

    // And line 1 is still fully returnable.
    const line1 = returnService.createReturn({
        invoiceId: MULTI_SALE.invoiceId, lineNumber: 1, weightGrams: 4, refundMode: 'cash'
    }, DEPS);
    assert.equal(line1.ok, true, line1.error);
    assert.equal(line1.return.purity, '22K');
    assert.equal(line1.return.weightGrams, 4);
});

check('a one-line invoice still prices to the paise exactly as before', () => {
    // The invariant that makes the whole widening safe: passing a single item
    // through the multi-line path must not move a single paise.
    const flat = saleService.createSale({
        purity: '22K', weightGrams: 10, customerName: 'Flat Form',
        makingChargeAmount: 5000, makingChargePercent: 7.27, discountPercent: 0
    }, DEPS);
    const carted = saleService.createSale({
        customerName: 'Cart Form',
        lines: [{ purity: '22K', weightGrams: 10, makingChargeAmount: 5000, makingChargePercent: 7.27, discountPercent: 0 }]
    }, DEPS);

    assert.equal(flat.ok && carted.ok, true);
    for (const field of ['metalValue', 'makingChargeAmount', 'taxableAmount', 'taxAmount', 'totalAmount']) {
        assert.equal(flat.sale[field], carted.sale[field], `${field} must match between the two request shapes`);
    }
    assert.equal(flat.sale.purity, '22K', 'a single-purity invoice states its purity');
    assert.equal(flat.sale.lines.length, 1);
});

check('tenders are stored and read back, and must add up', () => {
    const paid = saleService.createSale({
        purity: '22K', weightGrams: 1, customerName: 'Split Payer',
        makingChargeAmount: 0, discountPercent: 0,
        tenders: [{ method: 'cash', amount: 1000 }, { method: 'upi', amount: 1000 }]
    }, DEPS);
    // Deliberately wrong on purpose: the split does not equal the bill.
    assert.equal(paid.ok, false, 'a tender split that does not reconcile must be refused');
    assert.match(paid.error, /do not add up|payable/i);

    const priced = saleService.createSale({
        purity: '22K', weightGrams: 1, customerName: 'Whole Bill',
        makingChargeAmount: 0, discountPercent: 0,
        tenders: [{ method: 'cash' }]   // no amount = "the whole bill, in cash"
    }, DEPS);
    assert.equal(priced.ok, true, priced.error);
    assert.equal(priced.sale.tenders.length, 1);
    assert.equal(priced.sale.tenders[0].method, 'cash');
    assert.equal(priced.sale.tenders[0].amount, priced.sale.totalAmount);
});

check('every stored quantity is a scaled integer, never a float', () => {
    const header = repo.invoices.findByNumber(context.tenantId, CASH_SALE.invoiceId);
    const line = repo.invoices.linesFor(header.id)[0];
    for (const [column, value] of Object.entries({ ...header, ...line })) {
        if (!/_paise$|_mg$|_paise_per_g$|_bp$/.test(column)) continue;
        assert.ok(Number.isInteger(value), `${column} is ${value}, which is not an integer`);
    }
});

/* ==========================================================================
   5. Advances — approval, balance, and the reference guard
   ========================================================================== */

console.log('\n5. Advances');

const DEPOSIT = advanceService.recordDeposit({
    customerPhone: '9876543210', customerName: 'Asha Rao',
    amount: 5000, paymentMethod: 'Cash', referenceId: 'UTR-COUNTER-1'
}, DEPS);

check('a counter deposit posts immediately and is spendable', () => {
    assert.equal(DEPOSIT.success, true, DEPOSIT.error);
    assert.equal(DEPOSIT.deposit.status, 'approved', 'the wire word is "approved", not "posted"');
    assert.equal(advanceService.customerLedger('9876543210').balance, 5000);
});

check('the deposit carries every legacy field', () => {
    const deposit = DEPOSIT.deposit;
    assert.equal(deposit.type, 'deposit');
    assert.equal(deposit.amount, 5000, 'amount is positive rupees on the wire');
    assert.equal(deposit.paymentMethod, 'Cash', 'the display spelling, not the stored enum');
    assert.equal(deposit.source, 'counter');
    assert.match(deposit.id, /^ADV-[0-9A-F]{12}$/);
    assert.equal(typeof deposit.timestamp, 'number');
    assert.equal(deposit.lockedGoldRate22K, 6875);
});

check('a reused payment reference is refused, case-insensitively', () => {
    const clash = advanceService.recordDeposit({
        customerPhone: '9876543210', amount: 100,
        paymentMethod: 'Cash', referenceId: 'utr-counter-1'
    }, DEPS);
    assert.equal(clash.success, false);
    assert.equal(clash.code, 'DUPLICATE_REFERENCE');
    assert.equal(clash.status, 409);
});

const PENDING = advanceService.recordDeposit({
    customerPhone: '9000000001', customerName: 'Bala',
    amount: 1200, paymentMethod: 'UPI', referenceId: 'UTR-PORTAL-1',
    status: 'pending', source: 'portal'
}, DEPS);

check('a customer’s unverified claim does not count as balance', () => {
    assert.equal(PENDING.success, true);
    const ledger = advanceService.customerLedger('9000000001');
    assert.equal(ledger.balance, 0, 'a pending claim is not spendable money');
    assert.equal(ledger.pendingTotal, 1200);
    assert.equal(ledger.pendingCount, 1);
});

check('approval credits the claim and names the approver', () => {
    const reviewed = advanceService.reviewDeposit(PENDING.deposit.id, 'approved', 'seen in bank');
    assert.equal(reviewed.success, true);
    assert.equal(advanceService.customerLedger('9000000001').balance, 1200);

    const stored = repo.advances.findEntryById(PENDING.deposit.id);
    assert.equal(stored.status, 'posted');
    assert.ok(stored.approved_by_user_id, 'a posted entry must name its approver');
    assert.equal(stored.approved_by_user_id, context.ownerUserId);
});

check('a reviewed claim cannot be reviewed again', () => {
    const again = advanceService.reviewDeposit(PENDING.deposit.id, 'rejected', 'changed my mind');
    assert.equal(again.success, false);
    assert.equal(again.status, 409);
});

check('every status change left a transition row', () => {
    const transitions = repo.advances.transitionsFor(PENDING.deposit.id);
    assert.equal(transitions.length, 2, 'one for the insert, one for the approval');
    assert.equal(transitions[0].to_status, 'pending');
    assert.equal(transitions[1].from_status, 'pending');
    assert.equal(transitions[1].to_status, 'posted');
    assert.equal(transitions[1].note, 'seen in bank');
});

check('a rejected claim stays rejected and out of the balance', () => {
    const claim = advanceService.recordDeposit({
        customerPhone: '9000000002', amount: 999, paymentMethod: 'UPI',
        referenceId: 'UTR-BOGUS', status: 'pending', source: 'portal'
    }, DEPS);
    advanceService.reviewDeposit(claim.deposit.id, 'rejected', 'never arrived');
    assert.equal(advanceService.customerLedger('9000000002').balance, 0);
    assert.equal(repo.advances.findEntryById(claim.deposit.id).status, 'rejected');
});

check('a rejected reference can be used again — it was never real money', () => {
    const retry = advanceService.recordDeposit({
        customerPhone: '9000000002', amount: 999, paymentMethod: 'UPI',
        referenceId: 'UTR-BOGUS', status: 'pending', source: 'portal'
    }, DEPS);
    assert.equal(retry.success, true, 'a mistyped-and-rejected reference must be reusable');
});

/* ==========================================================================
   6. Redemption at checkout — the reservation check
   ========================================================================== */

console.log('\n6. Advance redemption');

const REDEEMING_SALE = saleService.createSale({
    purity: '22K', weightGrams: 10, customerName: 'Asha Rao', customerPhone: '9876543210',
    makingChargeAmount: 5000, makingChargePercent: 7.27, appliedAdvance: 5000
}, DEPS);

check('a redemption is applied and the balance drops', () => {
    assert.equal(REDEEMING_SALE.ok, true, REDEEMING_SALE.error);
    assert.equal(REDEEMING_SALE.sale.appliedAdvance, 5000);
    assert.equal(REDEEMING_SALE.sale.totalAmount, 70962.5, '₹75,962.50 less the ₹5,000 advance');
    assert.equal(advanceService.customerLedger('9876543210').balance, 0);
});

check('the redemption is bound to its invoice in the same transaction', () => {
    const header = repo.invoices.findByNumber(context.tenantId, REDEEMING_SALE.invoiceId);
    const { rows } = repo.advances.search({ tenantId: context.tenantId, entryType: 'redeem', limit: 10 });
    const redemption = rows.find(row => row.invoice_id === header.id);
    assert.ok(redemption, 'the redemption must point at the invoice it paid for');
    assert.ok(redemption.amount_paise < 0, 'a redemption is stored negative so a balance is a plain SUM');
    assert.equal(redemption.status, 'posted');
});

check('the redemption was recorded as a tender', () => {
    const header = repo.invoices.findByNumber(context.tenantId, REDEEMING_SALE.invoiceId);
    const tenders = repo.invoices.tendersFor(header.id);
    assert.equal(tenders.length, 1);
    assert.equal(tenders[0].method, 'advance');
    assert.equal(tenders[0].amount_paise, 500000);
});

check('redeeming more than the balance is refused and nothing is written', () => {
    const before = repo.invoices.countInvoices(context.tenantId);
    const result = saleService.createSale({
        purity: '22K', weightGrams: 1, customerPhone: '9876543210', appliedAdvance: 999999
    }, DEPS);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.error, /exceeds the customer's available balance/);
    assert.equal(repo.invoices.countInvoices(context.tenantId), before,
        'a refused sale must not leave a half-written invoice behind');
});

check('redeeming without a phone number is refused', () => {
    const result = saleService.createSale({ purity: '22K', weightGrams: 1, appliedAdvance: 100 }, DEPS);
    assert.equal(result.ok, false);
    assert.match(result.error, /phone is required/i);
});

/* ==========================================================================
   7. Returns — priced by the old invoice, never by today
   ========================================================================== */

console.log('\n7. Returns');

const GOLD_RETURN = returnService.createReturn({
    invoiceId: REDEEMING_SALE.invoiceId, weightGrams: 4, refundMode: 'gold', note: 'wrong size'
}, DEPS);

check('a return is filed and numbered as a credit note', () => {
    assert.equal(GOLD_RETURN.ok, true, GOLD_RETURN.error);
    assert.match(GOLD_RETURN.returnId, /^CN-\d{6}-\d{2}$/,
        'a GST credit note is a numbered document, not a random id');
});

check('the credit note carries every legacy return field', () => {
    const record = GOLD_RETURN.return;
    assert.equal(record.originalInvoiceId, REDEEMING_SALE.invoiceId);
    assert.equal(record.purity, '22K');
    assert.equal(record.weightGrams, 4);
    assert.equal(record.originalWeightGrams, 10);
    assert.equal(record.goldPricePerGram, 6875, 'the rate the goods were SOLD at');
    assert.equal(record.taxPercent, 3);
    assert.equal(record.taxMode, 'Exclusive');
    assert.equal(record.itemised, true);
    assert.equal(record.refundMode, 'gold');
    assert.equal(record.closesInvoice, false);
    assert.ok(record.refundAmount > 0);
});

check('the refund is a share of the TAXED value including the redeemed advance', () => {
    // 4g of a 10g invoice worth ₹75,962.50 gross (₹70,962.50 paid + ₹5,000 advance).
    assert.equal(GOLD_RETURN.return.refundAmount, 30385);
});

check('a gold refund credits the ledger in the same transaction', () => {
    assert.ok(GOLD_RETURN.advanceCredit);
    assert.equal(GOLD_RETURN.advanceCredit.paymentMethod, 'Return Credit');
    assert.equal(GOLD_RETURN.advanceCredit.source, 'return');
    assert.equal(GOLD_RETURN.advanceCredit.status, 'approved');
    assert.equal(advanceService.customerLedger('9876543210').balance, 30385);
});

check('the invoice records what came back without being rewritten', () => {
    const header = repo.invoices.findByNumber(context.tenantId, REDEEMING_SALE.invoiceId);
    assert.equal(header.state, 'partially_returned');
    assert.equal(header.total_amount_paise, 7096250, 'the filed invoice figures are untouched');
    assert.equal(repo.invoices.linesFor(header.id)[0].returned_weight_mg, 4000);
});

check('returning more than remains is refused', () => {
    const over = returnService.createReturn({
        invoiceId: REDEEMING_SALE.invoiceId, weightGrams: 99, refundMode: 'cash'
    }, DEPS);
    assert.equal(over.ok, false);
    assert.match(over.error, /still returnable/);
});

check('a gold refund is refused on an invoice with no customer account', () => {
    const walkIn = saleService.createSale({ purity: '24K', weightGrams: 2 }, DEPS);
    const result = returnService.createReturn({
        invoiceId: walkIn.invoiceId, weightGrams: 1, refundMode: 'gold'
    }, DEPS);
    assert.equal(result.ok, false);
    assert.match(result.error, /no account to credit/);
});

check('a return against an unknown invoice is a 404', () => {
    const result = returnService.createReturn({
        invoiceId: 'GOLD-999999-99', weightGrams: 1, refundMode: 'cash'
    }, DEPS);
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
});

check('returns that close an invoice sum back to its filed gross exactly', () => {
    const sale = saleService.createSale({
        purity: '18K', weightGrams: 3, customerName: 'Split', customerPhone: '9000000003',
        makingChargeAmount: 111.11, makingChargePercent: 0.66, discountPercent: 7
    }, DEPS);
    const filedGross = sale.sale.totalAmount + sale.sale.appliedAdvance;

    const first = returnService.createReturn({ invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'cash' }, DEPS);
    const second = returnService.createReturn({ invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'cash' }, DEPS);
    const third = returnService.createReturn({ invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'cash' }, DEPS);

    const refunded = first.return.refundAmount + second.return.refundAmount + third.return.refundAmount;
    assert.equal(Math.round(refunded * 100), Math.round(filedGross * 100),
        'three partial returns must sum back to the invoice, with no rounding drift');
    assert.equal(third.return.closesInvoice, true);
    assert.equal(repo.invoices.findByNumber(context.tenantId, sale.invoiceId).state, 'returned');
});

/* ==========================================================================
   8. Pagination — and what must NOT be paginated
   ========================================================================== */

console.log('\n8. Pagination');

check('a page is bounded and reports the true total', () => {
    const page = saleService.listSales({ limit: 2, offset: 0 });
    assert.equal(page.results.length, 2);
    assert.ok(page.total > 2, 'total counts the whole ledger, not the page');
    assert.equal(page.truncated, true);
});

check('paging walks the whole ledger without repeating or skipping a row', () => {
    const total = saleService.listSales({ limit: 1 }).total;
    const seen = new Set();
    for (let offset = 0; offset < total; offset += 3) {
        for (const row of saleService.listSales({ limit: 3, offset }).results) {
            assert.ok(!seen.has(row.id), `${row.id} appeared on two pages`);
            seen.add(row.id);
        }
    }
    assert.equal(seen.size, total);
});

check('an absurd page size is clamped rather than honoured', () => {
    const page = saleService.listSales({ limit: 100000 });
    assert.ok(page.results.length <= 200, 'the repository caps a page at 200 rows');
});

check('a balance is computed over the whole ledger, never over the page', () => {
    const phone = '9000000004';
    for (let i = 0; i < 7; i++) {
        advanceService.recordDeposit({
            customerPhone: phone, amount: 100, paymentMethod: 'Cash', referenceId: `PAGE-${i}`
        }, DEPS);
    }
    const ledger = advanceService.customerLedger(phone, { limit: 2 });
    assert.equal(ledger.history.length, 2, 'the history is paginated');
    assert.equal(ledger.total, 7);
    assert.equal(ledger.balance, 700, 'the balance is NOT paginated');
});

check('search narrows by invoice number, name and phone alike', () => {
    assert.equal(saleService.listSales({ q: CASH_SALE.invoiceId }).total, 1);
    assert.ok(saleService.listSales({ q: 'Asha' }).total >= 2);
    assert.ok(saleService.listSales({ q: '9876543210' }).total >= 2);
    assert.equal(saleService.listSales({ q: 'no-such-customer-anywhere' }).total, 0);
});

check('a date window excludes what falls outside it', () => {
    const future = saleService.listSales({ fromAt: Date.now() + 86400000 });
    assert.equal(future.total, 0);
});

check('every listed sale carries its return state', () => {
    const row = saleService.listSales({ q: REDEEMING_SALE.invoiceId }).results[0];
    assert.equal(row.returnedWeightGrams, 4);
    assert.equal(row.returnableWeightGrams, 6);
    assert.equal(row.returnCount, 1);
    assert.equal(row.fullyReturned, false);
    assert.equal(row.refundedAmount, 30385);
});

check('return state does not fan out when a note has several lines', () => {
    // The summary joins notes to lines; aggregating both sides in one query
    // multiplies each refund by its line count. Guarded here because the bug
    // only appears once credit notes grow a second line, in Phase 5.
    const summary = repo.creditNotes.summarizeForInvoices([
        repo.invoices.findByNumber(context.tenantId, REDEEMING_SALE.invoiceId).id
    ]);
    const [only] = [...summary.values()];
    assert.equal(only.refundedAmount, 30385);
    assert.equal(only.count, 1);
});

/* ==========================================================================
   9. Payments
   ========================================================================== */

console.log('\n9. Gateway payments');

check('an order intent records what it was FOR', () => {
    assert.equal(paymentService.recordOrder({
        providerOrderId: 'order_test_1', customerPhone: '9876543210', amountPaise: 250000
    }), true);
    const order = paymentService.findOrder('order_test_1');
    assert.equal(order.amountPaise, 250000);
    assert.equal(order.status, 'created');
});

check('a capture matching the order credits the ledger once', () => {
    const order = paymentService.findOrder('order_test_1');
    const before = advanceService.customerLedger('9876543210').balance;
    const credited = paymentService.creditCapturedPayment({
        order, paymentId: 'pay_test_1', capturedPaise: 250000, source: 'checkout'
    }, DEPS);
    assert.equal(credited.ok, true);
    assert.equal(advanceService.customerLedger('9876543210').balance, before + 2500);
    assert.equal(paymentService.findOrder('order_test_1').status, 'paid');
});

check('the webhook replaying the same capture credits nothing further', () => {
    const order = paymentService.findOrder('order_test_1');
    const before = advanceService.customerLedger('9876543210').balance;
    const replay = paymentService.creditCapturedPayment({
        order, paymentId: 'pay_test_1', capturedPaise: 250000, source: 'webhook'
    }, DEPS);
    assert.equal(replay.ok, true);
    assert.equal(replay.duplicate, true);
    assert.equal(advanceService.customerLedger('9876543210').balance, before,
        'the checkout/webhook race must credit exactly once');
});

check('a capture for the wrong amount is never credited in either direction', () => {
    paymentService.recordOrder({
        providerOrderId: 'order_test_2', customerPhone: '9876543210', amountPaise: 100
    });
    const before = advanceService.customerLedger('9876543210').balance;
    const result = paymentService.creditCapturedPayment({
        order: paymentService.findOrder('order_test_2'),
        paymentId: 'pay_test_2', capturedPaise: 5000000, source: 'checkout'
    }, DEPS);
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(advanceService.customerLedger('9876543210').balance, before);
    assert.equal(paymentService.findOrder('order_test_2').status, 'mismatched');
});

check('a webhook event id can be claimed exactly once', () => {
    const first = paymentService.claimWebhookEvent('evt_test_1', 'payment.captured');
    assert.equal(first.alreadySeen, false);
    const second = paymentService.claimWebhookEvent('evt_test_1', 'payment.captured');
    assert.equal(second.alreadySeen, true);
});

check('releasing a claim lets a genuine retry through', () => {
    paymentService.claimWebhookEvent('evt_test_2', 'payment.captured');
    paymentService.releaseWebhookEvent('evt_test_2');
    const retry = paymentService.claimWebhookEvent('evt_test_2', 'payment.captured');
    assert.equal(retry.alreadySeen, false,
        'a delivery that failed after claiming must not look like a duplicate forever');
});

/* ==========================================================================
   10. Idempotency
   ========================================================================== */

console.log('\n10. Duplicate requests');

check('a repeated sale request produces one invoice', () => {
    const key = 'idem-sale-1';
    const first = saleService.createSale({ purity: '22K', weightGrams: 2, idempotencyKey: key }, DEPS);
    const second = saleService.createSale({ purity: '22K', weightGrams: 2, idempotencyKey: key }, DEPS);
    assert.equal(first.invoiceId, second.invoiceId);
    assert.equal(second.duplicate, true);
    assert.equal(saleService.listSales({ q: first.invoiceId }).total, 1);
});

check('a repeated deposit request produces one entry', () => {
    const key = 'idem-deposit-1';
    const first = advanceService.recordDeposit({
        customerPhone: '9000000005', amount: 400, paymentMethod: 'Cash', idempotencyKey: key
    }, DEPS);
    const second = advanceService.recordDeposit({
        customerPhone: '9000000005', amount: 400, paymentMethod: 'Cash', idempotencyKey: key
    }, DEPS);
    assert.equal(first.deposit.id, second.deposit.id);
    assert.equal(advanceService.customerLedger('9000000005').balance, 400);
});

check('a repeated return request produces one credit note', () => {
    const sale = saleService.createSale({
        purity: '22K', weightGrams: 5, customerName: 'Idem', customerPhone: '9000000006'
    }, DEPS);
    const key = 'idem-return-1';
    const first = returnService.createReturn({
        invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'cash', idempotencyKey: key
    }, DEPS);
    const second = returnService.createReturn({
        invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'cash', idempotencyKey: key
    }, DEPS);
    assert.equal(first.returnId, second.returnId);
    assert.equal(second.duplicate, true);
});

/* ==========================================================================
   11. Audit
   ========================================================================== */

console.log('\n11. Audit trail');

check('the trail records who did what to which entity', () => {
    const header = repo.invoices.findByNumber(context.tenantId, REDEEMING_SALE.invoiceId);
    const trail = repo.audit.historyFor(context.tenantId, 'invoice', header.id);
    assert.equal(trail[0].action, 'SALE_ISSUED');
    assert.equal(trail[0].actor_user_id, context.ownerUserId);
    assert.equal(JSON.parse(trail[0].detail_json).appliedAdvance, 5000);
});

check('an audit failure never rolls back the money it describes', () => {
    const written = repo.audit.record({
        tenantId: context.tenantId,
        action: 'TEST',
        entityType: 'invoice',
        // Deliberately unserialisable: JSON.stringify throws on a BigInt.
        detail: { bad: 10n }
    });
    assert.equal(written, null, 'the failure is reported as null, not thrown');
});

check('an approval and a rejection are both on the trail', () => {
    const actions = repo.audit.search({ tenantId: context.tenantId, entityType: 'advance_entry', limit: 200 })
        .rows.map(row => row.action);
    assert.ok(actions.includes('ADVANCE_APPROVED'));
    assert.ok(actions.includes('ADVANCE_REJECTED'));
    assert.ok(actions.includes('PAYMENT_CREDITED'));
});

/* ==========================================================================
   12. The importer
   ========================================================================== */

console.log('\n12. Legacy JSON importer');

const LEGACY_DIR = path.join(TEMP_ROOT, 'legacy');
fs.mkdirSync(LEGACY_DIR, { recursive: true });

function writeLegacy(name, data) {
    fs.writeFileSync(path.join(LEGACY_DIR, name), JSON.stringify(data, null, 2));
}

writeLegacy('settings.json', { companyName: 'Legacy Co', invoicePrefix: 'GOLD', invoiceSeqStart: 9 });
writeLegacy('customer_auth.json', [{
    phone: '9111111111', name: 'Imported', email: 'i@x.com',
    passwordHash: 'hash', salt: 'salt', mustChangePassword: false,
    notifyEmail: true, notifyPush: false, resetTokenHash: null, resetExpires: 0,
    resetAttempts: 0, failedAttempts: 0, lockedUntil: 0, sessions: [],
    createdAt: 1750000000000, updatedAt: 1750000000000
}]);
writeLegacy('sales_2026.json', [{
    id: 'GOLD-009010-26', timestamp: 1770000000000, customerName: 'Imported', customerPhone: '9111111111',
    purity: '22K', weightGrams: 8, goldPricePerGram: 6800, goldRateSource: 'auto',
    metalValue: 54400, makingChargePercent: 5, makingChargeAmount: 2720,
    taxPercent: 3, taxMode: 'Exclusive', taxableAmount: 57120, taxAmount: 1713.6,
    discountPercent: 0, discount: 0, appliedAdvance: 0, totalAmount: 58833.6
}]);
writeLegacy('returns_2026.json', [{
    id: 'RET-LEGACY000001', timestamp: 1770200000000, originalInvoiceId: 'GOLD-009010-26',
    customerName: 'Imported', customerPhone: '9111111111', purity: '22K', weightGrams: 2,
    originalWeightGrams: 8, goldPricePerGram: 6800, makingChargePercent: 5, discountPercent: 0,
    taxPercent: 3, taxMode: 'Exclusive', metalValue: 13600, makingChargeAmount: 680,
    discount: 0, taxableAmount: 14280, taxAmount: 428.4, itemised: true,
    refundAmount: 14708.4, refundMode: 'cash', closesInvoice: false, note: 'legacy'
}]);
writeLegacy('advances.json', [
    {
        id: 'ADV-LEGACY000001', customerPhone: '9111111111', customerName: 'Imported',
        type: 'deposit', amount: 3000, paymentMethod: 'Cash', referenceId: 'LEG-1',
        status: 'approved', source: 'counter', lockedGoldRate22K: 6800, timestamp: 1769900000000
    },
    {
        // No status field at all — a row written before the field existed. It
        // must read as approved, or every legacy customer's balance zeroes out.
        id: 'ADV-LEGACY000002', customerPhone: '9111111111', customerName: 'Imported',
        type: 'deposit', amount: 1500, paymentMethod: 'UPI', referenceId: 'LEG-2',
        timestamp: 1769950000000
    }
]);
writeLegacy('payment_orders.json', []);
writeLegacy('payment_events.json', []);

check('a dry run reports what would happen and keeps nothing', () => {
    const before = repo.invoices.countInvoices(context.tenantId);
    const result = importer.importLegacyJson({ dryRun: true, dir: LEGACY_DIR });
    // The reconciliation lines are the message, because "ok was false" alone
    // does not say WHICH measure failed to balance.
    assert.equal(result.ok, true,
        result.error || JSON.stringify(result.reconciliation && result.reconciliation.lines));
    assert.equal(result.counts.invoices, 1);
    assert.equal(result.counts.creditNotes, 1);
    assert.equal(result.counts.advanceEntries, 2);
    assert.equal(repo.invoices.countInvoices(context.tenantId), before,
        'a dry run must leave the database exactly as it found it');
});

const IMPORTED = importer.importLegacyJson({ dir: LEGACY_DIR });

check('the import reconciles on every measure', () => {
    assert.equal(IMPORTED.ok, true, JSON.stringify(IMPORTED.problems));
    for (const line of IMPORTED.reconciliation.lines) {
        assert.equal(line.matches, true,
            `${line.measure}: expected ${line.expected}, got ${line.actual}`);
    }
});

check('a status-less legacy deposit reads as approved money', () => {
    const ledger = advanceService.customerLedger('9111111111');
    // 3000 + 1500 deposited, 14708.40 never credited (it was a cash refund).
    assert.equal(ledger.balance, 4500);
});

check('the imported invoice keeps its number and its filed figures', () => {
    const sale = saleService.findSale('GOLD-009010-26');
    assert.ok(sale);
    assert.equal(sale.totalAmount, 58833.6);
    assert.equal(sale.weightGrams, 8);
    assert.equal(sale.returnedWeightGrams, 2);
});

check('the imported return became a numbered credit note that names its origin', () => {
    const returns = returnService.listReturns({ customerPhone: '9111111111' });
    assert.equal(returns.total, 1);
    assert.match(returns.results[0].id, /^CN-\d{6}-\d{2}$/);
    assert.equal(returns.results[0].originalInvoiceId, 'GOLD-009010-26');
    assert.equal(returns.results[0].refundAmount, 14708.4);
    assert.match(returns.results[0].note, /RET-LEGACY000001/,
        'the old slip number must remain findable');
});

check('a second import is a clean no-op', () => {
    const again = importer.importLegacyJson({ dir: LEGACY_DIR });
    assert.equal(again.ok, true);
    for (const [measure, value] of Object.entries(again.counts)) {
        assert.equal(value, 0, `${measure} was imported twice`);
    }
});

check('the next live invoice continues past the imported series', () => {
    const next = saleService.createSale({ purity: '22K', weightGrams: 1 }, DEPS);
    assert.notEqual(next.invoiceId, 'GOLD-009010-26');
    const sequence = Number(/-(\d+)-/.exec(next.invoiceId)[1]);
    assert.ok(sequence > 10, `next invoice was ${next.invoiceId}, which collides with imported history`);
});

check('an import that references a missing invoice refuses and writes nothing', () => {
    const brokenDir = path.join(TEMP_ROOT, 'broken');
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, 'settings.json'), '{}');
    fs.writeFileSync(path.join(brokenDir, 'returns_2026.json'), JSON.stringify([{
        id: 'RET-ORPHAN', timestamp: Date.now(), originalInvoiceId: 'GOLD-NOPE-99',
        customerName: 'X', customerPhone: '9111111111', purity: '22K', weightGrams: 1,
        goldPricePerGram: 6800, refundAmount: 100, refundMode: 'cash'
    }]));

    const before = repo.creditNotes.countCreditNotes(context.tenantId);
    const result = importer.importLegacyJson({ dir: brokenDir });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(p => p.severity === 'fatal' && /not in the sales ledger/.test(p.message)));
    assert.equal(repo.creditNotes.countCreditNotes(context.tenantId), before,
        'a fatal validation problem must import nothing at all');
});

check('a corrupt ledger file stops the import instead of importing zero rows', () => {
    const corruptDir = path.join(TEMP_ROOT, 'corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'settings.json'), '{}');
    fs.writeFileSync(path.join(corruptDir, 'advances.json'), '{ this is not json');
    refuses(() => importer.importLegacyJson({ dir: corruptDir }), /not valid JSON/);
});

check('rollback restores the database as it was before the import', () => {
    const rollbackDir = path.join(TEMP_ROOT, 'rollback-source');
    fs.mkdirSync(rollbackDir, { recursive: true });
    fs.writeFileSync(path.join(rollbackDir, 'settings.json'), '{}');
    fs.writeFileSync(path.join(rollbackDir, 'sales_2026.json'), JSON.stringify([{
        id: 'GOLD-777777-26', timestamp: 1770400000000, customerName: 'Rolled Back',
        customerPhone: '9222222222', purity: '24K', weightGrams: 1, goldPricePerGram: 7000,
        metalValue: 7000, makingChargeAmount: 0, makingChargePercent: 0, taxPercent: 0,
        taxMode: 'Exclusive', taxableAmount: 7000, taxAmount: 0, discountPercent: 0,
        discount: 0, appliedAdvance: 0, totalAmount: 7000
    }]));

    const result = importer.importLegacyJson({ dir: rollbackDir });
    assert.ok(saleService.findSale('GOLD-777777-26'), 'precondition: the import landed');

    importer.rollbackImport(result.backupPath);
    repo.resetDataStoreContext();
    assert.equal(saleService.findSale('GOLD-777777-26'), null,
        'rollback must remove what the import added');
    assert.ok(saleService.findSale('GOLD-009010-26'),
        'rollback must keep what was there before the import');
});


/* ==========================================================================
   §13 The audit trail is tamper-EVIDENT, not just append-only
   ==========================================================================
   The triggers from 001 stop the application editing history. They cannot stop
   whoever holds the .db file, because dropping a trigger is one statement — so
   every check below tampers the way that person would: with the triggers gone
   and direct SQL, then asks whether the chain notices.
   ========================================================================== */

check('every recorded event is chained to the one before it', () => {
    const ids = [];
    for (let i = 1; i <= 4; i++) {
        ids.push(repo.audit.record({
            tenantId: context.tenantId,
            action: 'CHAIN_TEST',
            entityType: 'test',
            entityId: `chain-${i}`,
            summary: `event ${i}`,
            actorLabel: 'suite'
        }));
    }
    assert.ok(ids.every(Boolean), 'every write should have returned an id');

    const rows = repo.unsafeDatabaseHandle().prepare(
        "SELECT * FROM audit_events WHERE tenant_id = ? AND action = 'CHAIN_TEST' ORDER BY chain_seq"
    ).all(context.tenantId);
    assert.equal(rows.length, 4);

    // Contiguous sequence, and each row's prev_hash is the previous row_hash.
    for (let i = 1; i < rows.length; i++) {
        assert.equal(rows[i].chain_seq, rows[i - 1].chain_seq + 1, 'chain_seq must be contiguous');
        assert.equal(rows[i].prev_hash, rows[i - 1].row_hash, 'each row must link to the one before');
    }
    assert.match(rows[0].row_hash, /^[0-9a-f]{64}$/, 'row_hash should be lowercase sha256 hex');
});

check('a clean trail verifies, and reports what the chain does not cover', () => {
    const result = repo.audit.verifyChain(context.tenantId);
    assert.equal(result.ok, true, 'an untampered chain must verify');
    assert.ok(result.checked > 0, 'the verification should have walked some rows');
    assert.equal(result.brokenAt, null);
    assert.match(result.head, /^[0-9a-f]{64}$/, 'a verified chain publishes its head hash');
    // Honesty about coverage: rows written before migration 005 are counted,
    // not silently skipped.
    assert.equal(typeof result.unchained, 'number');
});

check('editing an event after the fact is detected', () => {
    const db = repo.unsafeDatabaseHandle();
    const victim = db.prepare(
        "SELECT * FROM audit_events WHERE tenant_id = ? AND action = 'CHAIN_TEST' ORDER BY chain_seq LIMIT 1"
    ).get(context.tenantId);

    // Exactly what someone with the file would do: remove the control, then edit.
    db.exec('DROP TRIGGER trg_audit_events_immutable');
    db.prepare('UPDATE audit_events SET summary = ? WHERE id = ?')
        .run('event 1 (quietly rewritten)', victim.id);

    const result = repo.audit.verifyChain(context.tenantId);
    assert.equal(result.ok, false, 'an edited row must break verification');
    assert.equal(result.brokenAt.id, victim.id, 'the report must name the row that was edited');
    assert.match(result.brokenAt.reason, /edited/);

    // Put it back so the remaining checks run against a clean trail.
    db.prepare('UPDATE audit_events SET summary = ? WHERE id = ?').run(victim.summary, victim.id);
    assert.equal(repo.audit.verifyChain(context.tenantId).ok, true,
        'restoring the original content must restore verification');
});

check('deleting an event is detected as a gap, not silently tolerated', () => {
    const db = repo.unsafeDatabaseHandle();
    const victim = db.prepare(
        "SELECT * FROM audit_events WHERE tenant_id = ? AND action = 'CHAIN_TEST' ORDER BY chain_seq LIMIT 1 OFFSET 1"
    ).get(context.tenantId);

    db.exec('DROP TRIGGER trg_audit_events_no_delete');
    db.prepare('DELETE FROM audit_events WHERE id = ?').run(victim.id);

    const result = repo.audit.verifyChain(context.tenantId);
    assert.equal(result.ok, false, 'a removed event must break the chain');
    assert.match(result.brokenAt.reason, /removed/, 'the report should say an event is missing');

    // Restore it, hashes and all, so the chain is whole again for the export check.
    db.prepare(`
        INSERT INTO audit_events (id, tenant_id, branch_id, actor_user_id, actor_label, action,
                                  entity_type, entity_id, summary, detail_json, ip_address,
                                  occurred_at, business_date, chain_seq, prev_hash, row_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(victim.id, victim.tenant_id, victim.branch_id, victim.actor_user_id, victim.actor_label,
        victim.action, victim.entity_type, victim.entity_id, victim.summary, victim.detail_json,
        victim.ip_address, victim.occurred_at, victim.business_date, victim.chain_seq,
        victim.prev_hash, victim.row_hash);
    assert.equal(repo.audit.verifyChain(context.tenantId).ok, true);
});

check('re-hashing the whole tail hides an edit from the chain — but not from a published head', () => {
    const db = repo.unsafeDatabaseHandle();
    const before = repo.audit.verifyChain(context.tenantId);
    const publishedHead = before.head; // as it would appear in an export already sent out

    // The strongest attack available to whoever holds the file: edit a row and
    // recompute every hash after it so the chain is internally consistent again.
    const rows = db.prepare(
        'SELECT * FROM audit_events WHERE tenant_id = ? AND chain_seq IS NOT NULL ORDER BY chain_seq'
    ).all(context.tenantId);
    const target = rows.find(r => r.action === 'CHAIN_TEST');
    target.summary = 'forged';
    db.prepare('UPDATE audit_events SET summary = ? WHERE id = ?').run('forged', target.id);

    let prev = null;
    for (const row of rows) {
        if (row.chain_seq < target.chain_seq) { prev = row.row_hash; continue; }
        row.prev_hash = prev;
        const recomputed = repo.audit.hashRow(row);
        db.prepare('UPDATE audit_events SET prev_hash = ?, row_hash = ? WHERE id = ?')
            .run(prev, recomputed, row.id);
        prev = recomputed;
    }

    const after = repo.audit.verifyChain(context.tenantId);
    // The forgery IS internally consistent — this is the honest limit of a
    // self-contained chain, and the reason the export publishes its head.
    assert.equal(after.ok, true, 'a fully re-hashed chain verifies against itself');
    // ...and this is what catches it: the head no longer matches the one already
    // in somebody else's hands.
    assert.notEqual(after.head, publishedHead,
        'a re-hashed chain must not reproduce the previously published head hash');
});

check('the export carries the evidence needed to check it later', () => {
    const dump = repo.audit.exportChain(context.tenantId);
    assert.ok(Array.isArray(dump.events), 'the export carries the events');
    assert.ok(dump.events.length > 0);
    assert.equal(dump.manifest.tenantId, context.tenantId);
    assert.equal(dump.manifest.rowsExported, dump.events.length);
    assert.equal(typeof dump.manifest.chain.verified, 'boolean');
    assert.match(dump.manifest.chain.headHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof dump.manifest.chain.eventsPredatingChain, 'number');
    assert.ok(dump.manifest.howToVerify.includes('verifyAuditChain'),
        'the manifest must say how to check it');

    // A filtered export still pins the WHOLE chain: a head hash over only the
    // exported slice could be made clean by choosing the filter.
    const narrow = repo.audit.exportChain(context.tenantId, { from: Date.now() + 1_000_000 });
    assert.equal(narrow.events.length, 0, 'the range filter should have excluded everything');
    assert.equal(narrow.manifest.chain.headHash, dump.manifest.chain.headHash,
        'the head hash must describe the chain, not the slice');
});

/* ==========================================================================
   13. Business summary email — reads the ledger, not the retired JSON files
   ========================================================================== */

console.log('\n13. Reporting');

{
    const emailReporter = await import('./emailReporter.js');

    // Poison the retired JSON documents `computeSummary()` used to read
    // before the Phase-29 SQL cutover. If the fix regresses to reading them,
    // these figures leak into the totals below and the assertions fail.
    const dataDir = process.env.GOLD_POS_DATA_DIR;
    fs.writeFileSync(path.join(dataDir, 'sales_2020.json'),
        JSON.stringify([{ timestamp: 0, totalAmount: 999999 }]));
    fs.writeFileSync(path.join(dataDir, 'returns_2020.json'),
        JSON.stringify([{ timestamp: 0, refundAmount: 999999 }]));
    fs.writeFileSync(path.join(dataDir, 'advances.json'),
        JSON.stringify([{ type: 'deposit', timestamp: 0, amount: 999999, customerPhone: 'ghost' }]));

    const filter = { tenantId: context.tenantId, fromAt: 0, toAt: null };
    const invoiceTotals = repo.invoices.periodTotals(filter);
    const returnTotals = repo.creditNotes.periodTotals(filter);
    const depositTotals = repo.advances.periodTotals({ ...filter, entryType: 'deposit' });
    const liability = repo.advances.liabilitySummary(context.tenantId);

    const summary = emailReporter.computeSummary(0);

    check('the summary reads the live SQL ledger, not the poisoned JSON files', () => {
        assert.equal(summary.invoiceCount, invoiceTotals.count);
        assert.equal(summary.grossRevenue, invoiceTotals.totalAmount);
        assert.equal(summary.returnCount, returnTotals.count);
        assert.equal(summary.refundTotal, returnTotals.refundAmount);
        assert.equal(summary.depositCount, depositTotals.count);
        assert.equal(summary.depositTotal, depositTotals.depositAmount);
        assert.equal(summary.outstandingTotal, liability.outstandingTotal);
        assert.ok(summary.grossRevenue < 999999, 'a stale sales_2020.json must not leak into the total');
        assert.ok(summary.depositTotal < 999999, 'a stale advances.json must not leak into the total');
    });

    check('revenue nets the period’s refunds', () => {
        assert.equal(summary.revenue, summary.grossRevenue - summary.refundTotal);
    });
}

/* -------------------------------------------------------------------------- */

repo.closeDb();
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });

console.log(`\n✅ ${passed} repository/service/importer checks passed.\n`);
