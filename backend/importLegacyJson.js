/**
 * ==========================================================================
 * The JSON → SQLite importer.
 *
 *   node backend/importLegacyJson.js [--dry-run] [--rollback] [--from <dir>]
 *
 * Every tenant already has real money on disk in `backend/data/*.json`. This
 * moves it into the transactional schema, and it is written on the assumption
 * that it will be run on somebody's actual books — which sets five hard
 * requirements, all of which are the roadmap's words, not decoration:
 *
 *   DRY RUN. `--dry-run` does the entire import inside a transaction and then
 *   rolls it back, so the validation report and the reconciliation figures are
 *   produced by really writing the rows, not by guessing what would happen.
 *   A dry run that takes a different code path is not a rehearsal.
 *
 *   VALIDATION REPORT. Every row that cannot be imported is named, with the
 *   reason, and the import refuses to commit if any of them are FATAL. Rows
 *   with recoverable problems (a missing customer name, an unparseable
 *   sequence number) are imported with the fallback stated in the report.
 *
 *   COUNTS AND CHECKSUMS. Money in and money out are totalled independently on
 *   each side and compared. "Imported successfully" means the sums reconcile
 *   to the paise, not that no exception was thrown.
 *
 *   BACKUP AND ROLLBACK. The database is copied before the first write, and
 *   `--rollback` restores that copy. The import itself is one transaction, so
 *   a crash mid-way leaves nothing behind — the backup exists for the case
 *   where the import SUCCEEDED and the operator wants the previous state back.
 *
 *   REPEATABILITY. Every imported row carries `import:<legacy id>` as its
 *   idempotency key, so a second run imports nothing and reports zero. That is
 *   what makes it safe to run the dry run, fix a problem, and run again.
 *
 * THE JSON FILES ARE NEVER MODIFIED. They are the source, and they stay on
 * disk untouched as the fallback until the operator deletes them deliberately.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, newId, logError, logTelemetry } from './db.js';
import {
    inTransaction, invoices, creditNotes, advances, payments, customers,
    sequences, audit, initialiseDataStore, checkpointAndCopy, DB_FILE, closeDb
} from './repositories/index.js';
import { businessDate, financialYear, documentNumber } from './repositories/calendar.js';
import { toPaise, round2, round3, normalizeTaxMode } from '../frontend/js/lib/billingMath.js';

const SEVERITY = { FATAL: 'fatal', REPAIRED: 'repaired', SKIPPED: 'skipped' };

/**
 * Reads a ledger file, tolerating absence but not corruption.
 *
 * A missing file is a store that never used that feature. A malformed one is
 * an operator problem that must stop the import — silently importing zero rows
 * from a corrupt advances.json would look like success and lose every balance.
 */
function readLedger(dir, filename) {
    const filepath = path.join(dir, filename);
    if (!fs.existsSync(filepath)) return [];
    const raw = fs.readFileSync(filepath, 'utf8');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${filename} is not valid JSON (${err.message}). Fix or move it before importing.`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${filename} should contain an array, found ${typeof parsed}.`);
    }
    return parsed;
}

/** Every year-partitioned file for a ledger, oldest partition first. */
function readPartitions(dir, prefix) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        .sort()
        .flatMap(name => readLedger(dir, name));
}

/**
 * Collects everything the importer will read, so the report can state the
 * source before a single row is written.
 */
export function collectSource(dir = DATA_DIR) {
    const settingsPath = path.join(dir, 'settings.json');
    const settings = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        : {};

    return {
        settings,
        accounts: readLedger(dir, 'customer_auth.json'),
        sales: readPartitions(dir, 'sales_'),
        returns: readPartitions(dir, 'returns_'),
        advances: readLedger(dir, 'advances.json'),
        paymentOrders: readLedger(dir, 'payment_orders.json'),
        paymentEvents: readLedger(dir, 'payment_events.json')
    };
}

/**
 * What the JSON side says, in paise, before anything is written.
 * The other half of the reconciliation.
 */
export function sourceChecksums(source) {
    const sum = (rows, of) => rows.reduce((total, row) => total + toPaise(of(row) || 0), 0);
    const countable = row => row && row.type === 'deposit'
        ? String(row.status || 'approved').toLowerCase() !== 'pending'
            && String(row.status || 'approved').toLowerCase() !== 'rejected'
        : row && row.type === 'redeem';

    return {
        // Portal logins, not people. The `customers` table also gains a bare
        // record for every walk-in an invoice or advance points at, so the
        // count that reconciles against customer_auth.json is the one
        // restricted to accounts that can actually sign in.
        customerLogins: source.accounts.filter(account => account && account.phone && account.passwordHash).length,
        sales: source.sales.length,
        salesTotalPaise: sum(source.sales, s => s.totalAmount),
        returns: source.returns.length,
        refundTotalPaise: sum(source.returns, r => r.refundAmount),
        advanceEntries: source.advances.length,
        advanceNetPaise: source.advances.reduce((total, row) => {
            if (!countable(row)) return total;
            const magnitude = Math.abs(toPaise(row.amount || 0));
            return total + (row.type === 'redeem' ? -magnitude : magnitude);
        }, 0),
        paymentOrders: source.paymentOrders.length,
        paymentEvents: source.paymentEvents.length
    };
}

/**
 * Imports every legacy ledger.
 *
 * @param {{dryRun?: boolean, dir?: string, log?: (message: string) => void}} [options]
 * @returns {{ok: boolean, dryRun: boolean, problems: object[], counts: object,
 *            reconciliation: object, backupPath: string|null}}
 */
export function importLegacyJson({ dryRun = false, dir = DATA_DIR, log = () => {} } = {}) {
    const source = collectSource(dir);
    const expected = sourceChecksums(source);
    const problems = [];
    const note = (severity, entity, id, message) =>
        problems.push({ severity, entity, id: id || '(no id)', message });

    const context = initialiseDataStore({
        name: source.settings.companyName,
        gstNumber: source.settings.gstNumber,
        address: source.settings.address,
        phone: source.settings.phone
    }, { log });

    log(`Source: ${dir}`);
    log(`  customer logins ${expected.customerLogins}, sales ${expected.sales}, returns ${expected.returns}, ` +
        `advances ${expected.advanceEntries}, payment orders ${expected.paymentOrders}, events ${expected.paymentEvents}`);

    // Copied BEFORE the first write. The import is one transaction so a failure
    // rolls itself back; this backup is for the operator who wants the previous
    // state back after a SUCCESSFUL import.
    let backupPath = null;
    if (!dryRun) {
        backupPath = path.join(dir, `pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
        try {
            // Checkpointed, not merely copied — a plain file copy of a WAL
            // database omits everything committed since the last checkpoint.
            checkpointAndCopy(backupPath);
            log(`Backup: ${backupPath}`);
        } catch (err) {
            throw new Error(`Refusing to import without a backup: ${err.message}`);
        }
    }

    const counts = {
        customers: 0, invoices: 0, invoiceLines: 0, creditNotes: 0, creditNoteLines: 0,
        advanceEntries: 0, paymentOrders: 0, paymentEvents: 0,
        skipped: 0
    };

    /* ONE TRANSACTION FOR THE WHOLE IMPORT. A half-imported ledger is worse
       than an un-imported one: the operator cannot tell which half is real, and
       the reconciliation figures would be meaningless. A dry run throws at the
       end to unwind exactly the same work. */
    class DryRunComplete extends Error {}

    let result;
    try {
        result = inTransaction(() => {
            const invoiceIdByNumber = new Map();
            const creditNoteIdByLegacyId = new Map();
            const entryIdByLegacyId = new Map();

            importCustomers(source, context, counts, note);
            importInvoices(source, context, counts, note, invoiceIdByNumber);
            importReturns(source, context, counts, note, invoiceIdByNumber, creditNoteIdByLegacyId);
            importAdvances(source, context, counts, note, invoiceIdByNumber, creditNoteIdByLegacyId, entryIdByLegacyId);
            linkCreditNoteCredits(source, context, creditNoteIdByLegacyId, entryIdByLegacyId);
            importPaymentOrders(source, context, counts, note, entryIdByLegacyId);
            importPaymentEvents(source, context, counts, note);
            recoverSequences(context, source);

            const fatal = problems.filter(problem => problem.severity === SEVERITY.FATAL);
            if (fatal.length > 0) {
                throw new Error(
                    `${fatal.length} row(s) could not be imported. Nothing was written. ` +
                    'Fix the rows listed in the report and run again.'
                );
            }

            const reconciliation = reconcile(context, expected, source);
            if (!dryRun) {
                audit.record({
                    tenantId: context.tenantId,
                    branchId: context.branchId,
                    actorUserId: context.systemUserId,
                    actorLabel: 'importer',
                    action: 'LEGACY_JSON_IMPORTED',
                    entityType: 'tenant',
                    entityId: context.tenantId,
                    summary: `Imported ${counts.invoices} invoices, ${counts.creditNotes} credit notes, ${counts.advanceEntries} advance entries`,
                    detail: { counts, reconciliation, source: dir }
                });
            }

            if (dryRun) {
                const rehearsal = new DryRunComplete('dry run');
                rehearsal.payload = { counts, reconciliation };
                throw rehearsal;
            }
            return { counts, reconciliation };
        });
    } catch (err) {
        if (err instanceof DryRunComplete) {
            result = err.payload;
            log('Dry run complete — every row above was written and then rolled back.');
        } else {
            logError(`Legacy JSON import failed and was rolled back: ${err.message}`, err.stack);
            return {
                ok: false,
                dryRun,
                error: err.message,
                problems,
                counts,
                reconciliation: null,
                backupPath
            };
        }
    }

    const balanced = result.reconciliation.balanced;
    if (!dryRun) {
        logTelemetry('LEGACY_JSON_IMPORTED', 0,
            `invoices: ${counts.invoices}, credit notes: ${counts.creditNotes}, advances: ${counts.advanceEntries}`);
    }

    return {
        ok: balanced,
        dryRun,
        problems,
        counts: result.counts,
        reconciliation: result.reconciliation,
        backupPath
    };
}

/* --------------------------------------------------------------------------
   Per-ledger importers

   Each one is idempotent through a natural key, so a second run is a no-op
   rather than a duplicate. That is what makes "rehearse, fix, re-run" safe.
   -------------------------------------------------------------------------- */

function importCustomers(source, context, counts, note) {
    for (const account of source.accounts) {
        if (!account || !account.phone) {
            note(SEVERITY.SKIPPED, 'customer', null, 'Account has no phone number; skipped.');
            counts.skipped += 1;
            continue;
        }
        if (customers.findByPhone(context.tenantId, account.phone)) continue;
        counts.customers += 1;
    }
    // Written through the same saveAccounts() the auth module uses, so the
    // password-hash and session translation lives in exactly one place.
    const usable = source.accounts.filter(account => account && account.phone);
    if (usable.length > 0 && !customers.saveAccounts(context.tenantId, usable)) {
        // saveAccounts() swallows its own failure to satisfy the auth module's
        // boolean contract. Inside the import that silence is unacceptable —
        // credential material failing to land must stop the whole run.
        note(SEVERITY.FATAL, 'customer', null,
            'Customer accounts could not be written; see error.log for the underlying failure.');
    }
}

function importInvoices(source, context, counts, note, invoiceIdByNumber) {
    // Oldest first, so sequence recovery below sees them in issue order.
    const rows = [...source.sales].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (const sale of rows) {
        if (!sale || !sale.id) {
            note(SEVERITY.SKIPPED, 'sale', null, 'Sale row has no id; skipped.');
            counts.skipped += 1;
            continue;
        }

        const existing = invoices.findByNumber(context.tenantId, sale.id);
        if (existing) {
            invoiceIdByNumber.set(sale.id, existing.id);
            continue;
        }

        const issuedAt = Number(sale.timestamp) || Date.now();
        const fy = financialYear(issuedAt);
        const sequenceValue = parseSequence(sale.id);
        if (sequenceValue === null) {
            note(SEVERITY.REPAIRED, 'sale', sale.id,
                'Invoice number does not follow PREFIX-NNNNNN-YY; a synthetic sequence slot was allocated instead.');
        }

        /* THE ITEMS, from whichever shape this record was filed in.
           A sale filed after multi-line landed carries `lines[]`; one filed
           before it carries only the flat rollup, which is exactly a one-line
           cart. Normalising here means the validation and the insert below have
           a single path — and it is what lets a MIXED invoice import at all.
           Read off the rollup, a mixed cart looks like a fatal record: its
           `purity` is the string 'MIXED' and its `goldPricePerGram` is 0,
           because those are the honest answers when the lines disagree (§0).
           Both would have been rejected as corrupt. */
        const sourceLines = Array.isArray(sale.lines) && sale.lines.length > 0
            ? sale.lines
            : [{
                lineNumber: 1,
                description: '',
                purity: sale.purity,
                weightGrams: sale.weightGrams,
                goldPricePerGram: sale.goldPricePerGram,
                goldRateSource: sale.goldRateSource,
                makingChargePercent: sale.makingChargePercent,
                grossMakingCharge: sale.makingChargeAmount,
                grossMetalValue: sale.metalValue,
                discountPercent: sale.discountPercent,
                discountAmount: sale.discount,
                taxableAmount: sale.taxableAmount,
                taxAmount: sale.taxAmount,
                lineTotal: round2(Number(sale.totalAmount || 0) + Number(sale.appliedAdvance || 0))
            }];

        const preparedLines = [];
        let lineFault = null;
        for (const [index, line] of sourceLines.entries()) {
            const weightGrams = Number(line.weightGrams) || 0;
            const rate = Number(line.goldPricePerGram) || 0;
            if (weightGrams <= 0 || rate <= 0) {
                lineFault = `Line ${index + 1}: weight (${line.weightGrams}) and rate (${line.goldPricePerGram}) `
                    + 'must both be positive; the schema refuses a zero-weight or zero-rate line.';
                break;
            }
            const linePurity = ['24K', '22K', '18K'].includes(line.purity) ? line.purity : null;
            if (!linePurity) {
                lineFault = `Line ${index + 1}: unknown purity "${line.purity}".`;
                break;
            }
            preparedLines.push({ raw: line, index, weightGrams, rate, purity: linePurity });
        }
        if (lineFault) {
            note(SEVERITY.FATAL, 'sale', sale.id, lineFault);
            continue;
        }

        const invoiceId = newId('INV');
        const resolvedSequence = sequenceValue !== null
            ? sequenceValue
            : nextFreeSequence(context, fy);
        const customerPhone = sale.customerPhone || '';
        const customerId = customerPhone
            ? customers.ensureCustomerId(context.tenantId, customerPhone, sale.customerName)
            : null;

        invoices.insertInvoice({
            id: invoiceId,
            tenantId: context.tenantId,
            branchId: context.branchId,
            invoiceNumber: sale.id,
            financialYear: fy,
            sequenceValue: resolvedSequence,
            customerId,
            customerName: sale.customerName || 'Cash Sale',
            customerPhone,
            state: 'issued',
            rateSnapshotId: null,
            rateSource: sale.goldRateSource || 'auto',
            metalValuePaise: toPaise(sale.metalValue || 0),
            makingChargePaise: toPaise(sale.makingChargeAmount || 0),
            discountBp: Math.round((Number(sale.discountPercent) || 0) * 100),
            discountPaise: toPaise(sale.discount || 0),
            taxableAmountPaise: toPaise(sale.taxableAmount || 0),
            taxAmountPaise: toPaise(sale.taxAmount || 0),
            appliedAdvancePaise: toPaise(sale.appliedAdvance || 0),
            totalAmountPaise: toPaise(sale.totalAmount || 0),
            taxPercentBp: Math.round((Number(sale.taxPercent) || 0) * 100),
            taxMode: normalizeTaxMode(sale.taxMode),
            idempotencyKey: `import:sale:${sale.id}`,
            createdByUserId: context.systemUserId,
            issuedAt,
            businessDate: businessDate(issuedAt)
        });

        for (const prepared of preparedLines) {
            const line = prepared.raw;
            /* The GROSS figures, matching what the sale service files. A record
               written before multi-line has only the rollup's gross values;
               one written after carries `grossMetalValue`/`grossMakingCharge`
               beside the net-of-tax restatements, and the gross pair is what
               belongs in these columns. */
            const grossMetal = Number(line.grossMetalValue ?? line.metalValue) || 0;
            const grossMaking = Number(line.grossMakingCharge ?? line.makingChargeAmount) || 0;
            invoices.insertLine({
                id: newId('ILN'),
                invoiceId,
                lineNumber: Number(line.lineNumber) || prepared.index + 1,
                description: String(line.description || `${prepared.purity} gold`).slice(0, 120),
                purity: prepared.purity,
                weightMg: Math.round(prepared.weightGrams * 1000),
                ratePaisePerG: Math.round(prepared.rate * 100),
                rateSource: line.goldRateSource || sale.goldRateSource || 'auto',
                metalValuePaise: toPaise(grossMetal),
                makingChargeBp: Math.round((Number(line.makingChargePercent) || 0) * 100),
                makingChargePaise: toPaise(grossMaking),
                discountBp: Math.round((Number(line.discountPercent) || 0) * 100),
                discountPaise: toPaise(Number(line.discountAmount ?? sale.discount) || 0),
                taxableAmountPaise: toPaise(Number(line.taxableAmount) || 0),
                taxAmountPaise: toPaise(Number(line.taxAmount) || 0),
                lineTotalPaise: toPaise(Number(line.lineTotal) || 0)
            });
            counts.invoiceLines += 1;
        }

        /* HOW IT WAS PAID. Absent on every invoice filed before tenders
           existed, which is why this is conditional rather than defaulted — an
           invented 'cash' tender would be a fact about the customer nobody
           recorded. */
        if (Array.isArray(sale.tenders)) {
            for (const tender of sale.tenders) {
                const amountPaise = toPaise(Number(tender && tender.amount) || 0);
                if (amountPaise <= 0) continue;
                invoices.insertTender({
                    id: newId('TND'),
                    invoiceId,
                    method: tender.method,
                    amountPaise,
                    reference: tender.reference || null,
                    paymentOrderId: null,
                    advanceEntryId: null,
                    capturedAt: issuedAt,
                    createdByUserId: context.systemUserId
                });
                counts.tenders = (counts.tenders || 0) + 1;
            }
        }

        invoiceIdByNumber.set(sale.id, invoiceId);
        counts.invoices += 1;
    }
}

function importReturns(source, context, counts, note, invoiceIdByNumber, creditNoteIdByLegacyId) {
    const rows = [...source.returns].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (const record of rows) {
        if (!record || !record.id) {
            note(SEVERITY.SKIPPED, 'return', null, 'Return row has no id; skipped.');
            counts.skipped += 1;
            continue;
        }

        const existing = creditNotes.findByIdempotencyKey(context.tenantId, `import:return:${record.id}`);
        if (existing) {
            creditNoteIdByLegacyId.set(record.id, existing.id);
            continue;
        }

        const invoiceId = invoiceIdByNumber.get(record.originalInvoiceId)
            || (invoices.findByNumber(context.tenantId, record.originalInvoiceId) || {}).id;
        if (!invoiceId) {
            note(SEVERITY.FATAL, 'return', record.id,
                `References invoice ${record.originalInvoiceId}, which is not in the sales ledger. A credit note cannot exist without the invoice it reverses.`);
            continue;
        }

        const issuedAt = Number(record.timestamp) || Date.now();
        const fy = financialYear(issuedAt);
        const creditNoteId = newId('CRN');
        const sequenceValue = sequences.allocate({
            tenantId: context.tenantId,
            branchId: context.branchId,
            documentType: 'credit_note',
            financialYear: fy,
            prefix: 'CN'
        }).sequenceValue;

        /* The legacy id (RET-…) was random; a GST credit note is a numbered
           document. The imported note therefore gets a proper sequential number
           and keeps the old id in its note field, so a customer holding the old
           slip can still be matched to it. */
        const creditNoteNumber = documentNumber('CN', sequenceValue, fy);
        const legacyNote = String(record.note || '').trim();
        const weightGrams = Number(record.weightGrams) || 0;
        const rate = Number(record.goldPricePerGram) || 0;
        if (weightGrams <= 0 || rate <= 0) {
            note(SEVERITY.FATAL, 'return', record.id,
                `Weight (${record.weightGrams}) and rate (${record.goldPricePerGram}) must both be positive.`);
            continue;
        }

        creditNotes.insertCreditNote({
            id: creditNoteId,
            tenantId: context.tenantId,
            branchId: context.branchId,
            creditNoteNumber,
            financialYear: fy,
            sequenceValue,
            invoiceId,
            customerId: record.customerPhone
                ? customers.ensureCustomerId(context.tenantId, record.customerPhone, record.customerName)
                : null,
            customerName: record.customerName || 'Cash Sale',
            customerPhone: record.customerPhone || '',
            refundMode: ['cash', 'gold', 'card', 'upi'].includes(record.refundMode) ? record.refundMode : 'cash',
            refundAmountPaise: toPaise(record.refundAmount || 0),
            closesInvoice: record.closesInvoice ? 1 : 0,
            advanceEntryId: null,
            itemised: record.itemised === false ? 0 : 1,
            note: [legacyNote, `(imported as ${record.id})`].filter(Boolean).join(' ').slice(0, 300),
            idempotencyKey: `import:return:${record.id}`,
            createdByUserId: context.systemUserId,
            issuedAt,
            businessDate: businessDate(issuedAt)
        });

        const invoiceLines = invoices.linesFor(invoiceId);
        const originalLine = invoiceLines[0];
        if (!originalLine) {
            note(SEVERITY.FATAL, 'return', record.id, `Invoice ${record.originalInvoiceId} has no line to return against.`);
            continue;
        }

        const itemised = record.itemised !== false;
        creditNotes.insertCreditNoteLine({
            id: newId('CLN'),
            creditNoteId,
            invoiceLineId: originalLine.id,
            lineNumber: 1,
            purity: ['24K', '22K', '18K'].includes(record.purity) ? record.purity : originalLine.purity,
            weightMg: Math.round(weightGrams * 1000),
            ratePaisePerG: Math.round(rate * 100),
            metalValuePaise: itemised ? toPaise(record.metalValue || 0) : 0,
            makingChargePaise: itemised ? toPaise(record.makingChargeAmount || 0) : 0,
            discountPaise: itemised ? toPaise(record.discount || 0) : 0,
            taxableAmountPaise: itemised ? toPaise(record.taxableAmount || 0) : 0,
            taxAmountPaise: itemised ? toPaise(record.taxAmount || 0) : 0,
            refundAmountPaise: toPaise(record.refundAmount || 0)
        });

        // The running counter, and the invoice state the counter implies.
        invoices.applyReturnToLine(originalLine.id, Math.round(weightGrams * 1000));
        invoices.setState(invoiceId, record.closesInvoice ? 'returned' : 'partially_returned');

        creditNoteIdByLegacyId.set(record.id, creditNoteId);
        counts.creditNotes += 1;
        counts.creditNoteLines += 1;
    }
}

function importAdvances(source, context, counts, note, invoiceIdByNumber, creditNoteIdByLegacyId, entryIdByLegacyId) {
    const rows = [...source.advances].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (const row of rows) {
        if (!row || !row.id || !row.customerPhone) {
            note(SEVERITY.SKIPPED, 'advance', row && row.id, 'Advance row has no id or no customer phone; skipped.');
            counts.skipped += 1;
            continue;
        }

        const key = `import:advance:${row.id}`;
        const existing = advances.findEntryByIdempotencyKey(context.tenantId, key);
        if (existing) {
            entryIdByLegacyId.set(row.id, existing.id);
            continue;
        }

        const amount = Math.abs(Number(row.amount) || 0);
        if (!(amount > 0)) {
            note(SEVERITY.FATAL, 'advance', row.id, `Amount ${row.amount} is not a positive number.`);
            continue;
        }

        const entryType = row.type === 'redeem' ? 'redeem' : 'deposit';
        // A missing status reads as approved, and that default is load-bearing:
        // every row already on disk predates the field, and each one is money
        // the store genuinely took. Defaulting the other way would zero every
        // existing customer's balance the moment this shipped.
        const storedStatus = entryType === 'redeem'
            ? 'posted'
            : advances.toStoredStatus(row.status || 'approved');

        const createdAt = Number(row.timestamp) || Date.now();
        const customerId = customers.ensureCustomerId(context.tenantId, row.customerPhone, row.customerName);
        const accountId = advances.ensureAccount({
            tenantId: context.tenantId,
            customerPhone: row.customerPhone,
            customerName: row.customerName || '',
            customerId
        });

        const reference = String(row.referenceId || '').trim();
        if (reference && storedStatus !== 'rejected') {
            const clash = advances.findEntryByAnyReference(context.tenantId, reference);
            if (clash) {
                note(SEVERITY.REPAIRED, 'advance', row.id,
                    `Reference "${reference}" is already claimed by ${clash.id}; imported without the reference so the row is not lost. Reconcile the pair by hand.`);
            }
        }
        const referenceIsFree = reference && !advances.findEntryByAnyReference(context.tenantId, reference);

        const entryId = newId('ADV');
        advances.insertEntry({
            id: entryId,
            tenantId: context.tenantId,
            branchId: context.branchId,
            accountId,
            entryType,
            amountPaise: advances.signedPaise(entryType, amount),
            status: storedStatus,
            paymentMethod: advances.toStoredMethod(row.paymentMethod || (entryType === 'redeem' ? 'other' : 'UPI')),
            referenceId: referenceIsFree ? reference : null,
            source: ['counter', 'portal', 'gateway', 'return', 'import'].includes(row.source)
                ? row.source
                : 'import',
            lockedRate22kPaisePerG: row.lockedGoldRate22K ? toPaise(row.lockedGoldRate22K) : null,
            invoiceId: row.invoiceId ? invoiceIdByNumber.get(row.invoiceId)
                || (invoices.findByNumber(context.tenantId, row.invoiceId) || {}).id || null : null,
            creditNoteId: row.returnId ? creditNoteIdByLegacyId.get(row.returnId) || null : null,
            reversesEntryId: null,
            idempotencyKey: key,
            createdByUserId: context.systemUserId,
            // A posted entry must name an approver. Historic rows were approved
            // by whoever was at the counter, and the JSON never recorded who —
            // so the automated identity stands in, and the audit trail says
            // plainly that this is an imported approval rather than a fresh one.
            approvedByUserId: storedStatus === 'posted' ? context.systemUserId : null,
            approvedAt: storedStatus === 'posted' ? (Number(row.reviewedAt) || createdAt) : null,
            reviewNote: row.reviewNote ? String(row.reviewNote).slice(0, 300) : null,
            createdAt,
            businessDate: businessDate(createdAt)
        });

        entryIdByLegacyId.set(row.id, entryId);
        counts.advanceEntries += 1;
    }
}

/** Points each imported gold-refund credit note at the entry it credited. */
function linkCreditNoteCredits(source, context, creditNoteIdByLegacyId, entryIdByLegacyId) {
    for (const record of source.returns) {
        if (!record || !record.advanceCreditId) continue;
        const creditNoteId = creditNoteIdByLegacyId.get(record.id);
        const entryId = entryIdByLegacyId.get(record.advanceCreditId);
        if (creditNoteId && entryId) creditNotes.attachAdvanceEntry(creditNoteId, entryId);
    }
}

function importPaymentOrders(source, context, counts, note, entryIdByLegacyId) {
    for (const order of source.paymentOrders) {
        if (!order || !order.orderId) {
            note(SEVERITY.SKIPPED, 'payment order', null, 'Order row has no orderId; skipped.');
            counts.skipped += 1;
            continue;
        }
        const provider = String(order.orderId).startsWith('order_mock_') ? 'mock' : 'razorpay';
        if (payments.findOrder(provider, order.orderId)) continue;

        const amountPaise = Number.isInteger(order.amountPaise) ? order.amountPaise : toPaise(order.amount || 0);
        if (!(amountPaise > 0)) {
            note(SEVERITY.SKIPPED, 'payment order', order.orderId,
                'Order has no usable amount; skipped (an order intent is short-lived and carries no ledger value).');
            counts.skipped += 1;
            continue;
        }

        payments.createOrder({
            tenantId: context.tenantId,
            provider,
            providerOrderId: order.orderId,
            customerPhone: order.customerPhone || '',
            customerId: order.customerPhone
                ? customers.ensureCustomerId(context.tenantId, order.customerPhone)
                : null,
            amountPaise,
            currency: order.currency || 'INR',
            ttlMs: Math.max(0, (Number(order.expiresAt) || 0) - (Number(order.createdAt) || Date.now()))
        });

        if (order.status && order.status !== 'created') {
            payments.settleOrder(provider, order.orderId, order.status, {
                providerPaymentId: order.paymentId || null,
                advanceEntryId: order.depositId ? entryIdByLegacyId.get(order.depositId) || null : null,
                note: order.note || null,
                onlyIfCreated: false
            });
        }
        counts.paymentOrders += 1;
    }
}

function importPaymentEvents(source, context, counts, note) {
    for (const event of source.paymentEvents) {
        if (!event || !event.eventId) {
            note(SEVERITY.SKIPPED, 'payment event', null, 'Event row has no eventId; skipped.');
            counts.skipped += 1;
            continue;
        }
        if (payments.findEvent('razorpay', event.eventId)) continue;
        payments.claimEvent({
            provider: 'razorpay',
            providerEventId: event.eventId,
            eventType: event.eventType || 'unknown'
        });
        counts.paymentEvents += 1;
    }
}

/**
 * Raises every sequence floor past the highest number actually imported.
 *
 * Without this the first live invoice after an import would collide with an
 * imported one — the single most damaging thing an importer can get wrong,
 * because the collision surfaces as a crashed sale at the counter rather than
 * as a message in a report nobody is reading by then.
 *
 * TWO RESERVATIONS PER INVOICE, and the second is the subtle one.
 *
 * The legacy numbering stamped the CALENDAR year on every invoice, while the
 * series here resets per FINANCIAL year (see documentNumber()). So an imported
 * `GOLD-000010-26` issued in February 2026 belongs, truthfully, to FY 2025-26
 * — that is what its `financial_year` column says, and reporting depends on it
 * saying so. But its printed suffix is `-26`, which under the live scheme is
 * the suffix of FY 2026-27. Reserving only against the truthful year leaves
 * the live FY 2026-27 series free to reach sequence 10 and render a number a
 * customer is already holding.
 *
 * So the number's own suffix is honoured as well: the floor is raised in the
 * financial year the PRINTED number implies, in addition to the one the
 * timestamp implies. Reporting stays correct, and a repeat becomes
 * unrepresentable rather than merely unlikely.
 *
 * Caught by test_repositories.js §12.
 */
function recoverSequences(context, source) {
    const invoicePrefix = source.settings.invoicePrefix || 'GOLD';

    for (const row of invoices.highestSequences(context.tenantId)) {
        sequences.reserveUpTo({
            tenantId: context.tenantId,
            branchId: row.branch_id,
            documentType: 'invoice',
            financialYear: row.financial_year,
            prefix: invoicePrefix,
            throughValue: row.highest
        });
    }

    // The series each imported NUMBER implies, which need not be the series
    // its timestamp implies.
    const impliedFloors = new Map();
    for (const sale of source.sales) {
        const parsed = parseNumber(sale && sale.id);
        if (!parsed) continue;
        const fy = financialYearFromSuffix(parsed.suffix);
        impliedFloors.set(fy, Math.max(impliedFloors.get(fy) || 0, parsed.sequence));
    }
    for (const [fy, highest] of impliedFloors) {
        sequences.reserveUpTo({
            tenantId: context.tenantId,
            branchId: context.branchId,
            documentType: 'invoice',
            financialYear: fy,
            prefix: invoicePrefix,
            throughValue: highest
        });
    }
    for (const row of creditNotes.highestSequences(context.tenantId)) {
        sequences.reserveUpTo({
            tenantId: context.tenantId,
            branchId: row.branch_id,
            documentType: 'credit_note',
            financialYear: row.financial_year,
            prefix: 'CN',
            throughValue: row.highest
        });
    }
}

/**
 * Compares what the JSON said against what the import actually landed.
 *
 * This is the difference between "the import did not throw" and "the import is
 * correct". Only an exact match on every line is a pass.
 *
 * SCOPED TO THE IMPORT, not to the table. Every imported row carries an
 * `import:*` idempotency key, and each measure counts only those. Reconciling
 * against whole-table totals would be correct exactly once — into a database
 * that has never held anything else — and would report a failure that is not
 * one on every subsequent run. An operator who is shown a spurious FAIL learns
 * to ignore the report, which is worse than not printing it.
 *
 * Payment orders and events are matched by their own provider ids for the same
 * reason: they have no idempotency key, but they do have a natural one.
 */
function reconcile(context, expected, source) {
    const saleRollup = invoices.summariseByKeyPrefix(context.tenantId, 'import:sale:');
    const returnRollup = creditNotes.summariseByKeyPrefix(context.tenantId, 'import:return:');
    const advanceRollup = advances.summariseByKeyPrefix(context.tenantId, 'import:advance:');

    const importedLogins = source.accounts.filter(account =>
        account && account.phone && account.passwordHash
        && (customers.findByPhone(context.tenantId, account.phone) || {}).password_hash
    ).length;

    const importedOrders = source.paymentOrders.filter(order => {
        if (!order || !order.orderId) return false;
        const provider = String(order.orderId).startsWith('order_mock_') ? 'mock' : 'razorpay';
        return Boolean(payments.findOrder(provider, order.orderId));
    }).length;

    const importedEvents = source.paymentEvents.filter(event =>
        event && event.eventId && payments.findEvent('razorpay', event.eventId)
    ).length;

    const actual = {
        customerLogins: importedLogins,
        sales: saleRollup.count,
        salesTotalPaise: saleRollup.total_paise,
        returns: returnRollup.count,
        refundTotalPaise: returnRollup.total_paise,
        advanceEntries: advanceRollup.count,
        advanceNetPaise: advanceRollup.net_paise,
        paymentOrders: importedOrders,
        paymentEvents: importedEvents
    };

    const lines = Object.keys(expected).map(key => ({
        measure: key,
        expected: expected[key],
        actual: actual[key],
        matches: expected[key] === actual[key]
    }));

    return { lines, balanced: lines.every(line => line.matches), expected, actual };
}

/* -------------------------------------------------------------------------- */

/** The slot and year suffix inside `PREFIX-NNNNNN-YY`, or null. */
function parseNumber(documentNumberText) {
    const match = /-(\d+)-(\d{2})$/.exec(String(documentNumberText || ''));
    return match ? { sequence: Number(match[1]), suffix: match[2] } : null;
}

/** The numeric slot inside `PREFIX-NNNNNN-YY`, or null if it is not that shape. */
function parseSequence(invoiceNumber) {
    const parsed = parseNumber(invoiceNumber);
    return parsed ? parsed.sequence : null;
}

/**
 * The financial year a two-digit document suffix denotes under the live
 * numbering scheme: '26' → '2026-27'. The inverse of documentNumber()'s
 * suffix derivation, and it must stay that way — if one changes, so does the
 * other, or imported and live numbers can collide again.
 */
function financialYearFromSuffix(suffix) {
    const openingYear = 2000 + Number(suffix);
    return `${openingYear}-${String((openingYear + 1) % 100).padStart(2, '0')}`;
}

/** A free sequence slot for an invoice whose number cannot be parsed. */
function nextFreeSequence(context, fy) {
    const current = sequences.peek({
        tenantId: context.tenantId,
        branchId: context.branchId,
        documentType: 'invoice',
        financialYear: fy
    });
    const floor = current ? current.next_value : 1;
    const highest = invoices.highestSequences(context.tenantId)
        .filter(row => row.financial_year === fy)
        .reduce((max, row) => Math.max(max, row.highest), 0);
    return Math.max(floor, highest + 1, 1);
}

/**
 * Restores the database from a pre-import backup.
 * Deliberately explicit and deliberately loud: this discards everything
 * written since the backup was taken, including any live trading.
 */
export function rollbackImport(backupPath, { log = () => {} } = {}) {
    if (!fs.existsSync(backupPath)) {
        throw new Error(`No backup at ${backupPath}.`);
    }
    closeDb();
    // The WAL and shared-memory sidecars describe the file being replaced. Left
    // in place they would be applied on top of the restored copy and undo the
    // restore — the classic "the rollback did nothing" failure.
    for (const sidecar of ['-wal', '-shm']) {
        const file = DB_FILE + sidecar;
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.copyFileSync(backupPath, DB_FILE);
    log(`Restored ${DB_FILE} from ${backupPath}.`);
    return true;
}

/** Human-readable report for the CLI and for the operator's records. */
export function formatReport(result) {
    const lines = [];
    lines.push('');
    lines.push(result.dryRun ? '=== DRY RUN (nothing was kept) ===' : '=== IMPORT ===');

    if (result.error) {
        lines.push(`FAILED: ${result.error}`);
    }

    lines.push('');
    lines.push('Rows written:');
    for (const [key, value] of Object.entries(result.counts)) {
        lines.push(`  ${key.padEnd(16)} ${value}`);
    }

    if (result.reconciliation) {
        lines.push('');
        lines.push('Reconciliation (JSON → SQLite):');
        for (const line of result.reconciliation.lines) {
            const mark = line.matches ? 'ok  ' : 'FAIL';
            lines.push(`  ${mark} ${line.measure.padEnd(18)} expected ${line.expected}, actual ${line.actual}`);
        }
    }

    if (result.problems.length > 0) {
        lines.push('');
        lines.push(`Validation report (${result.problems.length}):`);
        for (const problem of result.problems) {
            lines.push(`  [${problem.severity}] ${problem.entity} ${problem.id}: ${problem.message}`);
        }
    } else {
        lines.push('');
        lines.push('Validation report: no problems found.');
    }

    if (result.backupPath) {
        lines.push('');
        lines.push(`Backup taken before writing: ${result.backupPath}`);
        lines.push(`Roll back with: node backend/importLegacyJson.js --rollback "${result.backupPath}"`);
    }

    lines.push('');
    lines.push(result.ok
        ? (result.dryRun ? 'Dry run reconciles. Re-run without --dry-run to commit.' : 'Import complete and reconciled.')
        : 'Import did NOT reconcile. Nothing was committed unless stated above.');

    return lines.join('\n');
}

/* -------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const args = process.argv.slice(2);
    const flag = name => args.includes(name);
    const value = name => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };

    try {
        if (flag('--rollback')) {
            const backupPath = value('--rollback');
            if (!backupPath) throw new Error('--rollback needs the path of the backup to restore.');
            rollbackImport(backupPath, { log: message => console.log(message) });
            console.log('\nRolled back.');
        } else {
            const result = importLegacyJson({
                dryRun: flag('--dry-run'),
                dir: value('--from') || DATA_DIR,
                log: message => console.log(message)
            });
            console.log(formatReport(result));
            if (!result.ok) process.exit(1);
        }
    } catch (err) {
        console.error(`\n${err.message}`);
        process.exit(1);
    }
}
