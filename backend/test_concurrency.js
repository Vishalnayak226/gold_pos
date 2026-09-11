/**
 * ==========================================================================
 * Concurrency, crash-injection and duplicate-request suite (roadmap Phase 1).
 *
 * The roadmap's exit criterion for this phase is a sentence about behaviour,
 * not about code: "process kills at every write step cannot create an
 * unbalanced sale; 100 duplicate/concurrent submissions create one result."
 * This suite is that sentence, executed.
 *
 * WHY CHILD PROCESSES. `node:sqlite` is synchronous and Node runs one thread,
 * so nothing inside a single process can interleave two transactions — an
 * in-process "concurrency" test would prove only that a for-loop works. Real
 * contention needs real processes competing for the same database file, which
 * is also the real deployment shape: a billing counter, a backup job and the
 * nightly report scheduler are separate writers.
 *
 * WHY process.exit(). A thrown error unwinds through `inTransaction`'s catch
 * and rolls back politely, which is the easy case and already covered
 * elsewhere. `process.exit()` mid-transaction severs the connection with no
 * cleanup whatsoever — the shop counter losing power mid-sale. Recovery is
 * then SQLite's journal doing its job, which is exactly the property ADR-001
 * bought and the property the JSON ledger never had.
 *
 * GOLD_POS_DATA_DIR is set on the FIRST line — see CLAUDE.md §8.
 *
 * Native assert and node:child_process only. Zero extra dependencies.
 * ==========================================================================
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-concurrency-'));
process.env.GOLD_POS_DATA_DIR = path.join(TEMP_ROOT, 'data');
process.env.GOLD_POS_LOGS_DIR = path.join(TEMP_ROOT, 'logs');

const assert = (await import('assert')).default;
const repo = await import('./repositories/index.js');
const saleService = await import('./services/saleService.js');
const advanceService = await import('./services/advanceService.js');
const returnService = await import('./services/returnService.js');
const oldGoldService = await import('./services/oldGoldService.js');

const BACKEND_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(TEMP_ROOT, 'worker.mjs');

let passed = 0;
function check(label, fn) {
    return Promise.resolve(fn()).then(() => {
        passed++;
        console.log(`  ✅ ${label}`);
    });
}

/* --------------------------------------------------------------------------
   The worker

   Written to disk rather than passed with `node -e`, because the script has to
   survive Windows and POSIX shell quoting intact and it is long enough that
   inlining it would be its own source of bugs.
   -------------------------------------------------------------------------- */

fs.writeFileSync(WORKER, `
import { pathToFileURL } from 'url';

process.env.GOLD_POS_DATA_DIR = process.env.WORKER_DATA_DIR;
process.env.GOLD_POS_LOGS_DIR = process.env.WORKER_LOGS_DIR;

const BACKEND = ${JSON.stringify(BACKEND_DIR.replace(/\\/g, '/'))};
const load = p => import(pathToFileURL(BACKEND + '/' + p).href);

const repo = await load('repositories/index.js');
const saleService = await load('services/saleService.js');
const advanceService = await load('services/advanceService.js');
const returnService = await load('services/returnService.js');
const paymentService = await load('services/paymentService.js');

const RATES = {
    price24K: 7500, price22K: 6875, price18K: 5600,
    sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
};
const DEPS = {
    getActiveGoldRates: () => RATES,
    getSettings: () => ({ goldTaxSlab: 3, taxMode: 'Exclusive', invoicePrefix: 'GOLD', invoiceSeqStart: 1 }),
    isValidPhone: phone => typeof phone === 'string' && /^\\d{10}\$/.test(phone)
};

/* Crash injection beyond the sale flow can't monkeypatch a repository
   function directly — 'export * as x from ...' produces a frozen ES module
   namespace object, so 'repo.invoices.cancelInvoice = ...' throws. Instead
   this patches the one genuinely mutable thing every repository call goes
   through: the database HANDLE returned by unsafeDatabaseHandle(), which is
   a plain node:sqlite object, not a namespace. Matching on a stable SQL
   prefix (a table name a repository already hardcodes) makes the real
   service function die exactly before that statement runs, with everything
   before it already applied inside the still-open, still-uncommitted
   transaction — precisely what a real power loss at that instant would do. */
function crashOnSql(substring) {
    const db = repo.unsafeDatabaseHandle();
    const originalPrepare = db.prepare.bind(db);
    db.prepare = function (sql) {
        if (sql.includes(substring)) process.exit(9);
        return originalPrepare(sql);
    };
}

const RETURN_CRASH_SQL = {
    'after-creditnote': 'INSERT INTO credit_note_lines',
    'after-line': 'UPDATE invoice_lines SET returned_weight_mg',
    'after-apply': 'INSERT INTO audit_events'
};
const ADVANCE_APPROVE_CRASH_SQL = {
    'after-transition-update': 'INSERT INTO advance_entry_transitions',
    'after-transition': 'INSERT INTO audit_events'
};
const PAYMENT_CREDIT_CRASH_SQL = {
    'after-entry': 'UPDATE payment_orders',
    'after-settle': 'INSERT INTO audit_events'
};

const mode = process.env.WORKER_MODE;
const arg = process.env.WORKER_ARG || '';

repo.initialiseDataStore({ name: 'Concurrency Jewellers' });

try {
    if (mode === 'sale') {
        const result = saleService.createSale({
            purity: '22K', weightGrams: 1, customerName: 'Concurrent ' + arg
        }, DEPS);
        process.stdout.write(result.ok ? 'OK ' + result.invoiceId : 'ERR ' + result.error);

    } else if (mode === 'idempotent-sale') {
        const result = saleService.createSale({
            purity: '22K', weightGrams: 1, customerName: 'Duplicate', idempotencyKey: arg
        }, DEPS);
        process.stdout.write(result.ok ? 'OK ' + result.invoiceId : 'ERR ' + result.error);

    } else if (mode === 'redeem') {
        const result = saleService.createSale({
            purity: '22K', weightGrams: 1, customerName: 'Redeemer',
            customerPhone: '9800000001', appliedAdvance: 1000
        }, DEPS);
        process.stdout.write(result.ok ? 'OK ' + result.invoiceId : 'ERR ' + result.error);

    } else if (mode === 'deposit-same-reference') {
        const result = advanceService.recordDeposit({
            customerPhone: '9800000002', customerName: 'Racer',
            amount: 500, paymentMethod: 'UPI', referenceId: arg
        }, DEPS);
        process.stdout.write(result.success ? 'OK ' + result.deposit.id : 'ERR ' + (result.code || result.error));

    } else if (mode === 'return-race') {
        // arg = the shared invoice number every racer targets.
        const result = returnService.createReturn({ invoiceId: arg, weightGrams: 1, refundMode: 'cash' }, DEPS);
        process.stdout.write(result.ok ? 'OK ' + result.returnId : 'ERR ' + (result.code || result.error));

    } else if (mode === 'void-race') {
        // arg = the shared invoice number every racer targets.
        const result = saleService.voidSale(arg, 'Concurrent void race', {});
        process.stdout.write(result.ok ? 'OK ' + result.invoiceId : 'ERR ' + (result.code || result.error));

    } else if (mode === 'exchange-race') {
        // arg = JSON {creditNoteNumber, customerPhone, appliedAdvance} shared by every racer.
        const spec = JSON.parse(arg);
        const result = saleService.createSale({
            purity: '22K', weightGrams: 1, customerPhone: spec.customerPhone, customerName: 'Exchange Racer',
            exchangeCreditNoteId: spec.creditNoteNumber, appliedAdvance: spec.appliedAdvance
        }, DEPS);
        process.stdout.write(result.ok ? 'OK ' + result.invoiceId : 'ERR ' + (result.code || result.error));

    } else if (mode.startsWith('crash-') && mode.slice('crash-'.length).startsWith('return-')) {
        /* SETUP runs to completion and commits for real (its own transaction);
           only the RETURN that follows is severed. The setup invoice number is
           printed before the crash point is armed, so a process that dies
           still leaves the parent able to find it and inspect what survived. */
        const point = mode.slice('crash-return-'.length);
        const sale = saleService.createSale({ purity: '22K', weightGrams: 1, customerName: 'CrashReturn ' + arg }, DEPS);
        if (!sale.ok) throw new Error('setup sale failed: ' + sale.error);
        process.stdout.write('SETUP ' + sale.invoiceId + '\\n');
        crashOnSql(RETURN_CRASH_SQL[point]);
        returnService.createReturn({ invoiceId: sale.invoiceId, weightGrams: 1, refundMode: 'cash' }, DEPS);
        process.stdout.write('OK survived');

    } else if (mode === 'crash-void') {
        const sale = saleService.createSale({ purity: '22K', weightGrams: 1, customerName: 'CrashVoid ' + arg }, DEPS);
        if (!sale.ok) throw new Error('setup sale failed: ' + sale.error);
        process.stdout.write('SETUP ' + sale.invoiceId + '\\n');
        crashOnSql('INSERT INTO audit_events');
        saleService.voidSale(sale.invoiceId, 'Crash test void', {});
        process.stdout.write('OK survived');

    } else if (mode.startsWith('crash-') && mode.slice('crash-'.length).startsWith('advance-approve-')) {
        const point = mode.slice('crash-advance-approve-'.length);
        const deposit = advanceService.recordDeposit({
            customerPhone: '9833333333', customerName: 'Crash Depositor',
            amount: 500, paymentMethod: 'UPI', status: 'pending', referenceId: 'CRASH-APPROVE-' + arg
        }, DEPS);
        if (!deposit.success) throw new Error('setup deposit failed: ' + (deposit.error || deposit.code));
        process.stdout.write('SETUP ' + deposit.deposit.id + '\\n');
        crashOnSql(ADVANCE_APPROVE_CRASH_SQL[point]);
        advanceService.reviewDeposit(deposit.deposit.id, 'approved', 'Crash test', DEPS);
        process.stdout.write('OK survived');

    } else if (mode.startsWith('crash-') && mode.slice('crash-'.length).startsWith('payment-credit-')) {
        const point = mode.slice('crash-payment-credit-'.length);
        const orderId = 'order_crash_' + arg;
        paymentService.recordOrder({ providerOrderId: orderId, customerPhone: '9844444444', amountPaise: 100000 });
        const order = paymentService.findOrder(orderId);
        crashOnSql(PAYMENT_CREDIT_CRASH_SQL[point]);
        paymentService.creditCapturedPayment({
            order, paymentId: 'pay_crash_' + arg, capturedPaise: order.amountPaise, source: 'checkout'
        }, { getActiveGoldRates: DEPS.getActiveGoldRates });
        process.stdout.write('OK survived');

    } else if (mode.startsWith('crash-')) {
        /* Crash injection. The transaction is opened for real, work is done for
           real, and then the process is severed at the named step with no
           unwinding of any kind. Nothing after the exit runs — no catch, no
           finally, no COMMIT. */
        const step = mode.slice('crash-'.length);
        repo.inTransaction(() => {
            const ctx = repo.dataStoreContext();
            const fy = repo.financialYear();
            const { sequenceValue } = repo.sequences.allocate({
                tenantId: ctx.tenantId, branchId: ctx.branchId,
                documentType: 'invoice', financialYear: fy, prefix: 'GOLD'
            });
            if (step === 'after-allocate') process.exit(9);

            const invoiceId = 'INV-CRASHTEST' + arg;
            repo.invoices.insertInvoice({
                id: invoiceId,
                tenantId: ctx.tenantId, branchId: ctx.branchId,
                invoiceNumber: repo.documentNumber('GOLD', sequenceValue, fy),
                financialYear: fy, sequenceValue,
                customerId: null, customerName: 'Crash', customerPhone: '',
                state: 'issued', rateSnapshotId: null, rateSource: 'auto',
                metalValuePaise: 687500, makingChargePaise: 0, discountBp: 0, discountPaise: 0,
                taxableAmountPaise: 687500, taxAmountPaise: 20625,
                appliedAdvancePaise: 0, totalAmountPaise: 708125,
                taxPercentBp: 300, taxMode: 'Exclusive', idempotencyKey: null,
                createdByUserId: ctx.ownerUserId,
                issuedAt: Date.now(), businessDate: repo.businessDate()
            });
            if (step === 'after-invoice') process.exit(9);

            repo.invoices.insertLine({
                id: 'ILN-CRASHTEST' + arg, invoiceId, lineNumber: 1,
                description: '22K gold', purity: '22K', weightMg: 1000,
                ratePaisePerG: 687500, rateSource: 'auto', metalValuePaise: 687500,
                makingChargeBp: 0, makingChargePaise: 0, discountBp: 0, discountPaise: 0,
                taxableAmountPaise: 687500, taxAmountPaise: 20625, lineTotalPaise: 708125
            });
            if (step === 'after-line') process.exit(9);

            repo.invoices.insertTender({
                id: 'TND-CRASHTEST' + arg, invoiceId, method: 'cash',
                amountPaise: 708125, reference: null, paymentOrderId: null,
                advanceEntryId: null, capturedAt: Date.now(), createdByUserId: ctx.ownerUserId
            });
            if (step === 'after-tender') process.exit(9);
        });
        process.stdout.write('OK survived');
    }
} catch (err) {
    process.stdout.write('THREW ' + err.message);
}
repo.closeDb();
`, 'utf8');

/** Runs one worker to completion and resolves with its stdout. */
function runWorker(mode, arg = '') {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [WORKER], {
            env: {
                ...process.env,
                WORKER_MODE: mode,
                WORKER_ARG: String(arg),
                WORKER_DATA_DIR: process.env.GOLD_POS_DATA_DIR,
                WORKER_LOGS_DIR: process.env.GOLD_POS_LOGS_DIR
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        // stderr is captured, not discarded. When a worker dies before it can
        // print anything, its stderr is the only evidence of why — and a
        // concurrency failure that reports "2 of 40 failed" with no reason is
        // a test that costs more time than it saves.
        let out = '';
        let err = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    });
}

/** Runs `count` workers genuinely in parallel. */
function runWorkers(mode, count, argOf = i => i) {
    return Promise.all(Array.from({ length: count }, (_, i) => runWorker(mode, argOf(i))));
}

/** A failure report that says WHY, so a red run is diagnosable at a glance. */
function describeFailures(failures, total) {
    return `${failures.length} of ${total} workers failed:\n` + failures.map(failure =>
        `  exit ${failure.code} — ${failure.out || '(no output)'}\n` +
        `    ${(failure.err || '(no stderr)').split('\n')[0]}`
    ).join('\n');
}

/* -------------------------------------------------------------------------- */

const context = repo.initialiseDataStore({ name: 'Concurrency Jewellers' });
// The handle is closed while children hold the database, then reopened on
// demand, so the parent never holds a lock a child is waiting on.
repo.closeDb();

console.log('\n🧪 Concurrency, crash injection and duplicate requests\n');

console.log('1. Concurrent writers');

await check('40 concurrent sales across processes produce 40 distinct invoice numbers', async () => {
    const results = await runWorkers('sale', 40);

    const failures = results.filter(r => !r.out.startsWith('OK'));
    assert.equal(failures.length, 0, describeFailures(failures, 40));

    const numbers = results.map(r => r.out.slice(3));
    assert.equal(new Set(numbers).size, 40,
        'two customers were handed the same invoice number — the bug this phase exists to eliminate');
});

await check('the invoice sequence has no gaps and no repeats', () => {
    const { rows } = repo.invoices.search({ tenantId: context.tenantId, limit: 200 });
    const sequences = rows.map(row => row.sequence_value).sort((a, b) => a - b);
    assert.equal(new Set(sequences).size, sequences.length, 'a sequence value was issued twice');
    for (let i = 1; i < sequences.length; i++) {
        assert.equal(sequences[i], sequences[i - 1] + 1,
            `sequence jumped from ${sequences[i - 1]} to ${sequences[i]} — a number was burned`);
    }
});

await check('every concurrently written invoice is complete, with its line', () => {
    const { rows } = repo.invoices.search({ tenantId: context.tenantId, limit: 200 });
    for (const row of rows) {
        const lines = repo.invoices.linesFor(row.id);
        assert.equal(lines.length, 1, `invoice ${row.invoice_number} committed without its line`);
        assert.equal(
            lines[0].taxable_amount_paise + lines[0].tax_amount_paise,
            row.total_amount_paise + row.applied_advance_paise,
            `invoice ${row.invoice_number} does not balance against its line`
        );
    }
});

console.log('\n2. Concurrent redemption of one balance');

await check('a balance cannot be spent twice by racing tills', async () => {
    // ₹1,000 on the account, and ten tills each trying to redeem ₹1,000 of it.
    advanceService.recordDeposit({
        customerPhone: '9800000001', customerName: 'Redeemer',
        amount: 1000, paymentMethod: 'Cash', referenceId: 'RACE-1'
    }, {
        getActiveGoldRates: () => ({ price22K: 6875 }),
        isValidPhone: () => true
    });
    repo.closeDb();

    const results = await runWorkers('redeem', 10);
    const succeeded = results.filter(r => r.out.startsWith('OK'));

    assert.equal(succeeded.length, 1,
        `${succeeded.length} tills redeemed the same ₹1,000 balance; exactly one may`);
    assert.equal(advanceService.customerLedger('9800000001').balance, 0);
    assert.ok(advanceService.customerLedger('9800000001').balance >= 0,
        'a balance must never go negative');
});

console.log('\n3. Duplicate requests');

await check('100 concurrent submissions of one idempotency key create one invoice', async () => {
    const key = 'stress-idem-key';
    const results = await runWorkers('idempotent-sale', 100, () => key);

    const succeeded = results.filter(r => r.out.startsWith('OK'));
    assert.equal(succeeded.length, 100, 'every caller should receive an answer, not an error');

    const numbers = new Set(succeeded.map(r => r.out.slice(3)));
    assert.equal(numbers.size, 1,
        `100 duplicate submissions produced ${numbers.size} invoices: ${[...numbers].join(', ')}`);

    const invoiceNumber = [...numbers][0];
    assert.equal(saleService.listSales({ q: invoiceNumber }).total, 1,
        'exactly one invoice may exist on the ledger');
});

await check('racing deposits on one payment reference credit the customer once', async () => {
    repo.closeDb();
    const results = await runWorkers('deposit-same-reference', 20, () => 'UTR-RACE-1');

    const succeeded = results.filter(r => r.out.startsWith('OK'));
    assert.equal(succeeded.length, 1,
        `${succeeded.length} deposits were accepted for one transfer; exactly one may be`);
    assert.equal(advanceService.customerLedger('9800000002').balance, 500,
        'one ₹500 transfer must credit ₹500, however many times it was submitted');
});

console.log('\n3b. Concurrent document actions');

const PARENT_DEPS = {
    getActiveGoldRates: () => ({
        price24K: 7500, price22K: 6875, price18K: 5600,
        sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
    }),
    getSettings: () => ({ goldTaxSlab: 3, taxMode: 'Exclusive', invoicePrefix: 'GOLD', invoiceSeqStart: 1 }),
    isValidPhone: phone => typeof phone === 'string' && /^\d{10}$/.test(phone)
};

await check('two tills racing to return the same weight against one line succeed exactly once', async () => {
    const sale = saleService.createSale({
        purity: '22K', weightGrams: 1, customerName: 'Return Race Target'
    }, PARENT_DEPS);
    assert.equal(sale.ok, true, sale.error);
    repo.closeDb();

    const results = await runWorkers('return-race', 10, () => sale.invoiceId);
    const succeeded = results.filter(r => r.out.startsWith('OK'));
    assert.equal(succeeded.length, 1,
        `${succeeded.length} of 10 concurrent returns against the same 1g line succeeded; exactly one may`);

    const header = repo.invoices.findByNumber(context.tenantId, sale.invoiceId);
    assert.equal(header.state, 'returned', 'the one return that won should close the invoice');
    assert.equal(repo.creditNotes.summarizeForInvoice(header.id).count, 1,
        'ten racing return requests must leave exactly one credit note, not ten');
});

await check('two tills racing to void the same invoice succeed exactly once', async () => {
    const sale = saleService.createSale({
        purity: '22K', weightGrams: 1, customerName: 'Void Race Target'
    }, PARENT_DEPS);
    assert.equal(sale.ok, true, sale.error);
    repo.closeDb();

    const results = await runWorkers('void-race', 10, () => sale.invoiceId);
    const succeeded = results.filter(r => r.out.startsWith('OK'));
    assert.equal(succeeded.length, 1,
        `${succeeded.length} of 10 concurrent voids of the same invoice succeeded; exactly one may`);

    const header = repo.invoices.findByNumber(context.tenantId, sale.invoiceId);
    assert.equal(header.state, 'cancelled');
});

await check('two tills racing to redeem the same exchange credit note succeed exactly once', async () => {
    const phone = '9855555555';
    const original = saleService.createSale({
        purity: '22K', weightGrams: 2, customerName: 'Exchange Race Origin', customerPhone: phone
    }, PARENT_DEPS);
    assert.equal(original.ok, true, original.error);

    const filed = returnService.createReturn({
        invoiceId: original.invoiceId, weightGrams: 2, refundMode: 'exchange'
    }, PARENT_DEPS);
    assert.equal(filed.ok, true, filed.error);
    assert.ok(filed.advanceCredit && filed.advanceCredit.amount > 0, 'an exchange return must post a spendable credit');
    repo.closeDb();

    const spec = JSON.stringify({
        creditNoteNumber: filed.returnId, customerPhone: phone, appliedAdvance: filed.advanceCredit.amount
    });
    const results = await runWorkers('exchange-race', 10, () => spec);
    const succeeded = results.filter(r => r.out.startsWith('OK'));
    assert.equal(succeeded.length, 1,
        `${succeeded.length} of 10 concurrent redemptions of the same exchange credit note succeeded; exactly one may`);

    const note = repo.creditNotes.findByNumber(context.tenantId, filed.returnId);
    assert.ok(note.exchange_invoice_id, 'the winning redemption must mark the credit note spent');
});

console.log('\n4. Crash injection');

const CRASH_STEPS = ['after-allocate', 'after-invoice', 'after-line', 'after-tender'];

for (const step of CRASH_STEPS) {
    await check(`a process killed ${step.replace('-', ' ')} leaves nothing behind`, async () => {
        const before = {
            invoices: repo.invoices.countInvoices(context.tenantId),
            total: repo.invoices.sumInvoiceTotals(context.tenantId)
        };
        repo.closeDb();

        const result = await runWorker(`crash-${step}`, step);
        assert.equal(result.code, 9, 'the worker was expected to die at the injection point');

        const after = {
            invoices: repo.invoices.countInvoices(context.tenantId),
            total: repo.invoices.sumInvoiceTotals(context.tenantId)
        };
        assert.deepEqual(after, before,
            `a kill ${step} left a partial sale on the ledger`);
        assert.equal(repo.invoices.findById(`INV-CRASHTEST${step}`), null,
            'the uncommitted invoice must not be readable after recovery');
    });
}

await check('a kill mid-sale does not burn the invoice number it had taken', () => {
    const fy = repo.financialYear();
    const before = repo.sequences.peek({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: fy
    });
    const next = repo.inTransaction(() => repo.sequences.allocate({
        tenantId: context.tenantId, branchId: context.branchId,
        documentType: 'invoice', financialYear: fy, prefix: 'GOLD'
    }));
    assert.equal(next.sequenceValue, before.next_value,
        'the number the crashed sale allocated must be reissued, not skipped');
});

await check('the database is still fully usable after four hard kills', () => {
    const result = saleService.createSale({
        purity: '22K', weightGrams: 1, customerName: 'After The Crashes'
    }, {
        getActiveGoldRates: () => ({
            price24K: 7500, price22K: 6875, price18K: 5600,
            sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
        }),
        getSettings: () => ({ goldTaxSlab: 3, taxMode: 'Exclusive', invoicePrefix: 'GOLD', invoiceSeqStart: 1 })
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sale.totalAmount, 7081.25);
});

console.log('\n4b. Crash injection beyond the sale flow');

/** Runs a crash worker, asserts it actually died at the injection point, and
    hands the setup identifier it printed just before arming the crash to a
    verifier — the setup half committed for real, so the parent can look it
    up after the crashed process exits. */
async function crashSurvivesAndRolledBack(mode, arg, verify) {
    const result = await runWorker(mode, arg);
    assert.equal(result.code, 9,
        `worker for ${mode} was expected to die at the injection point:\n${result.out || '(no output)'}\n${result.err || '(no stderr)'}`);
    const setupMatch = result.out.match(/^SETUP (\S+)/);
    assert.ok(setupMatch, `expected a SETUP line before the crash for ${mode}, got: ${result.out || '(no output)'}`);
    verify(setupMatch[1]);
}

for (const point of ['after-creditnote', 'after-line', 'after-apply']) {
    await check(`a return killed ${point.replace('-', ' ')} leaves the invoice untouched`, async () => {
        await crashSurvivesAndRolledBack(`crash-return-${point}`, point, invoiceNumber => {
            const header = repo.invoices.findByNumber(context.tenantId, invoiceNumber);
            assert.ok(header, 'the setup sale must have survived — it committed before the crash');
            assert.equal(header.state, 'issued',
                `a return killed ${point.replace('-', ' ')} must not leave the invoice as returned`);
            const lines = repo.invoices.linesFor(header.id);
            assert.equal(lines[0].returned_weight_mg, 0,
                'a killed return must not leave a partial returned-weight counter');
            const summary = repo.creditNotes.summarizeForInvoice(header.id);
            assert.equal(summary.count, 0, 'a killed return must leave no orphaned credit note');
        });
    });
}

await check('a void killed just before its audit record leaves the invoice issued', async () => {
    await crashSurvivesAndRolledBack('crash-void', 'v1', invoiceNumber => {
        const header = repo.invoices.findByNumber(context.tenantId, invoiceNumber);
        assert.ok(header, 'the setup sale must have survived — it committed before the crash');
        assert.equal(header.state, 'issued',
            'a void killed before its audit record must not leave the invoice cancelled with no trail of it');
    });
});

for (const point of ['after-transition-update', 'after-transition']) {
    await check(`an advance approval killed ${point.replace(/-/g, ' ')} leaves the deposit pending`, async () => {
        await crashSurvivesAndRolledBack(`crash-advance-approve-${point}`, point, entryId => {
            const entry = repo.advances.findEntryById(entryId);
            assert.ok(entry, 'the setup deposit must have survived — it committed before the crash');
            assert.equal(entry.status, 'pending',
                `an approval killed ${point.replace(/-/g, ' ')} must leave the deposit pending, not posted`);
            // insertEntry() already wrote one NULL->pending row at setup — a
            // killed approval must add no SECOND (pending->posted) row to it.
            assert.equal(repo.advances.transitionsFor(entryId).length, 1,
                "a killed approval must leave no additional transition-history row beyond the deposit's own creation");
        });
    });
}

for (const point of ['after-entry', 'after-settle']) {
    await check(`a payment credit killed ${point.replace('-', ' ')} does not credit the customer`, async () => {
        const result = await runWorker(`crash-payment-credit-${point}`, point);
        assert.equal(result.code, 9,
            `worker was expected to die at the injection point:\n${result.out || '(no output)'}\n${result.err || '(no stderr)'}`);
        const order = repo.payments.findOrder('razorpay', 'order_crash_' + point);
        assert.ok(order, 'the setup order must have survived — recordOrder commits before the crash');
        assert.notEqual(order.status, 'paid',
            `a payment credit killed ${point.replace('-', ' ')} must not leave the order marked paid`);
    });
}

await check('the customer touched only by killed payment credits has no balance', () => {
    assert.equal(advanceService.customerLedger('9844444444').balance, 0,
        'every payment-credit crash above must have rolled back completely — nothing should have posted');
});

console.log('\n5. Migrations');

await check('the migration runner is idempotent', () => {
    const status = repo.migrationStatus();
    assert.equal(status.pending.length, 0);
    assert.equal(status.drifted.length, 0);
    assert.ok(status.applied.length >= 3, 'all three migrations should be recorded');
});

await check('every migration on disk is recorded with its checksum', () => {
    const status = repo.migrationStatus();
    for (const applied of status.applied) {
        assert.match(applied.checksum, /^[0-9a-f]{64}$/, 'a migration must record a SHA-256');
        assert.ok(applied.applied_at > 0);
    }
});

await check('an edited already-applied migration is refused by name', () => {
    // Simulated by corrupting the RECORDED checksum rather than the file on
    // disk: editing a real migration would break every other suite in the
    // repository, and the property under test is that the two disagreeing is
    // what raises the alarm.
    const db = repo.unsafeDatabaseHandle();
    const original = db.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get().checksum;
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();

    const status = repo.migrationStatus();
    assert.equal(status.drifted.length, 1);
    assert.equal(status.drifted[0].version, 1);

    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(original);
    assert.equal(repo.migrationStatus().drifted.length, 0, 'restoring the checksum clears the alarm');
});

await check('a database carrying a migration this build does not ship still opens', () => {
    // What a rollback to an older build looks like. Refusing to boot would turn
    // a recoverable deploy into an outage, so it is logged, not fatal.
    const db = repo.unsafeDatabaseHandle();
    db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, ?, 0)'
    ).run(9999, 'from_the_future', 'x'.repeat(64), Date.now());

    const status = repo.migrationStatus();
    assert.equal(status.orphaned.length, 1);
    assert.equal(status.orphaned[0].version, 9999);

    db.prepare('DELETE FROM schema_migrations WHERE version = 9999').run();
});

console.log('\n6. Configuration drift');

/* docs/INVARIANT_MATRIX.md documents a real window: createSale()/recordExchange()
   both read getSettings()/getActiveGoldRates() BEFORE their transaction opens,
   deliberately, so every line on one invoice prices off one snapshot instead of
   a mid-invoice settings/rate change landing between line 2 and line 3 (the
   comment at saleService.js:254-256). That guarantee depends entirely on each
   dep being called exactly once per request — if a future change moved either
   read inside the line loop, a settings/rate change mid-request could silently
   price different lines of the SAME invoice differently. These checks are a
   regression guard for exactly that, not a real concurrent-process race:
   nothing here needs a child process, since the property under test is "how
   many times does this function call its own deps", which is observable in
   one process with a call-counting spy. */

await check('a multi-line sale reads settings and gold rates exactly once, never per line', () => {
    let settingsCalls = 0, ratesCalls = 0;
    const deps = {
        getSettings: () => {
            settingsCalls++;
            return { goldTaxSlab: 3, taxMode: 'Exclusive', invoicePrefix: 'GOLD', invoiceSeqStart: 1 };
        },
        getActiveGoldRates: () => {
            ratesCalls++;
            return {
                price24K: 7500, price22K: 6875, price18K: 5600,
                sources: { price24K: 'auto', price22K: 'auto', price18K: 'auto' }
            };
        }
    };
    const result = saleService.createSale({
        customerName: 'Drift Guard',
        lines: [
            { purity: '22K', weightGrams: 1 },
            { purity: '18K', weightGrams: 1 },
            { purity: '24K', weightGrams: 1 }
        ]
    }, deps);
    assert.equal(result.ok, true, result.error);
    assert.equal(settingsCalls, 1,
        'a settings change mid-request must not be able to bill different lines of one invoice under different settings');
    assert.equal(ratesCalls, 1,
        'a rate change mid-request must not be able to price different lines of one invoice at different rates');
});

await check('an old-gold exchange reads settings and gold rates exactly once', () => {
    let settingsCalls = 0, ratesCalls = 0;
    const deps = {
        getSettings: () => {
            settingsCalls++;
            return { oldGoldExchangeEnabled: true, oldGoldDeductionPercent: 5 };
        },
        getActiveGoldRates: () => {
            ratesCalls++;
            return { price24K: 7500, price22K: 6875, price18K: 5600 };
        },
        isValidPhone: phone => typeof phone === 'string' && /^\d{10}$/.test(phone),
        actorUserId: context.ownerUserId
    };
    const result = oldGoldService.recordExchange({
        customerPhone: '9866666666', declaredPurity: '22K', testedPurity: '22K', grossWeightGrams: 2
    }, deps);
    assert.equal(result.success, true, result.error);
    assert.equal(settingsCalls, 1, 'an exchange must read settings once, not re-check mid-transaction');
    assert.equal(ratesCalls, 1, 'an exchange must read the gold rate once, not re-check mid-transaction');
});

/* -------------------------------------------------------------------------- */

repo.closeDb();
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });

console.log(`\n✅ ${passed} concurrency/crash/duplicate checks passed.\n`);
