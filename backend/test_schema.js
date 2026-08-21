/**
 * ==========================================================================
 * Transactional schema suite (ADR-001, roadmap Phase 1).
 *
 * Two things are under test, and the second is the one that matters:
 *
 *   1. The migration runner applies, is idempotent, and detects drift.
 *   2. Every constraint the roadmap asks for actually REFUSES the bad write.
 *
 * A schema is not evidence. A rejected INSERT is. So each invariant below is
 * asserted by attempting the violation and requiring a throw — the same
 * duplicate-invoice, double-credit and edited-ledger cases that the JSON layer
 * could only guard by convention.
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

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-schema-'));
process.env.GOLD_POS_DATA_DIR = path.join(TEMP_ROOT, 'data');
process.env.GOLD_POS_LOGS_DIR = path.join(TEMP_ROOT, 'logs');

const assert = (await import('assert')).default;
const { getDb, inTransaction, closeDb, DB_FILE } = await import('./repositories/connection.js');
const { runMigrations, migrationStatus, discoverMigrations, findDestructivePatterns, checkMigrationSafety } = await import('./repositories/migrate.js');

let passed = 0;
function check(label, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${label}`);
}

/** Asserts that `fn` throws, and that the message matches `pattern`. */
function refuses(fn, pattern) {
    let threw = null;
    try {
        fn();
    } catch (err) {
        threw = err;
    }
    assert.ok(threw, 'expected the database to refuse this write, but it succeeded');
    if (pattern) {
        assert.match(threw.message, pattern,
            `refusal message was "${threw.message}", expected to match ${pattern}`);
    }
    return threw;
}

const NOW = Date.UTC(2026, 7, 11, 9, 0, 0);
const TODAY = '2026-08-11';

console.log('======================================================================');
console.log('TRANSACTIONAL SCHEMA');
console.log('======================================================================');

/* --------------------------------------------------------------------------
   1. The migration runner
   -------------------------------------------------------------------------- */

check('migrations are discovered in numeric order with parseable names', () => {
    const found = discoverMigrations();
    assert.ok(found.length >= 1, 'expected at least one migration on disk');
    const versions = found.map(m => m.version);
    assert.deepStrictEqual(versions, [...versions].sort((a, b) => a - b));
    assert.strictEqual(found[0].version, 1);
});

check('a fresh database reports every migration pending', () => {
    const status = migrationStatus();
    assert.strictEqual(status.applied.length, 0);
    assert.ok(status.pending.length >= 1);
    assert.strictEqual(status.drifted.length, 0);
});

check('--dry-run reports without applying anything', () => {
    const result = runMigrations({ dryRun: true });
    assert.deepStrictEqual(result.applied, []);
    assert.strictEqual(migrationStatus().applied.length, 0);
});

check('migrations apply and create every expected table', () => {
    const result = runMigrations();
    assert.ok(result.applied.length >= 1, 'expected at least one migration to be applied');

    const tables = new Set(getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(row => row.name));

    for (const expected of [
        'tenants', 'branches', 'users', 'user_sessions', 'customers', 'customer_sessions',
        'rate_snapshots', 'document_sequences', 'invoices', 'invoice_lines', 'tenders',
        'credit_notes', 'credit_note_lines', 'advance_accounts', 'advance_entries',
        'advance_entry_transitions', 'payment_orders', 'payment_events', 'audit_events',
        'schema_migrations'
    ]) {
        assert.ok(tables.has(expected), `table ${expected} was not created`);
    }
});

check('re-running applies nothing (idempotent)', () => {
    const result = runMigrations();
    assert.deepStrictEqual(result.applied, []);
    assert.strictEqual(result.alreadyCurrent, true);
});

check('an edited already-applied migration is refused, naming the file', () => {
    const db = getDb();
    const original = db.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get();
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered');
    const err = refuses(() => runMigrations(), /already been applied has been edited/);
    assert.match(err.message, /001_initial_schema\.sql/);
    db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run(original.checksum);
});

check('the migration safety gate is clean against every migration actually on disk', () => {
    // The gate CI runs (`npm run migrate:check-safety`) — proves the real
    // files in migrations/ stay additive, not just the fixture strings below.
    assert.deepStrictEqual(checkMigrationSafety().violations, []);
});

check('the migration safety gate flags a dropped table, column, or rename', () => {
    assert.strictEqual(findDestructivePatterns('CREATE TABLE foo (id TEXT)').length, 0);
    assert.strictEqual(findDestructivePatterns('ALTER TABLE foo ADD COLUMN bar TEXT').length, 0);
    assert.strictEqual(findDestructivePatterns('DROP INDEX uq_foo').length, 0, 'dropping an index is not destructive to data');

    assert.strictEqual(findDestructivePatterns('DROP TABLE foo').length, 1);
    assert.strictEqual(findDestructivePatterns('ALTER TABLE foo DROP COLUMN bar').length, 1);
    assert.strictEqual(findDestructivePatterns('ALTER TABLE foo RENAME COLUMN bar TO baz').length, 1);
    assert.strictEqual(findDestructivePatterns('ALTER TABLE foo RENAME TO bar').length, 1);
});

check('the migration safety gate ignores destructive words inside SQL comments', () => {
    assert.strictEqual(findDestructivePatterns('-- do not DROP TABLE foo by hand, see runbook\nCREATE TABLE foo (id TEXT)').length, 0);
});

check('WAL, foreign keys and full durability are actually on', () => {
    const db = getDb();
    assert.strictEqual(String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), 'wal');
    assert.strictEqual(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.strictEqual(db.prepare('PRAGMA synchronous').get().synchronous, 2); // 2 = FULL
});

/* --------------------------------------------------------------------------
   Fixture — one tenant, one branch, one manager, one cashier, one customer
   -------------------------------------------------------------------------- */

const db = getDb();

inTransaction(() => {
    db.prepare('INSERT INTO tenants (id, name, gst_number, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('T1', 'Test Jewellers', '29AATEST1234F1Z', NOW, NOW);
    db.prepare('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)')
        .run('B1', 'T1', 'Main Counter', NOW, NOW);

    const insertUser = db.prepare(
        'INSERT INTO users (id, tenant_id, branch_id, full_name, username, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
    );
    insertUser.run('U-MGR', 'T1', 'B1', 'Manager Meena', 'meena', 'manager', NOW, NOW);
    insertUser.run('U-CSH', 'T1', 'B1', 'Cashier Kiran', 'kiran', 'cashier', NOW, NOW);
    insertUser.run('U-AUD', 'T1', 'B1', 'Auditor Anand', 'anand', 'auditor', NOW, NOW);

    db.prepare('INSERT INTO customers (id, tenant_id, phone, full_name, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('C1', 'T1', '9000000001', 'Aarti Deshmukh', NOW, NOW);
    db.prepare('INSERT INTO advance_accounts (id, tenant_id, customer_id, customer_phone, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run('AA1', 'T1', 'C1', '9000000001', 'Aarti Deshmukh', NOW, NOW);
    // A second account exists purely so the append-only test can attempt a
    // REAL reassignment. Updating a column to the value it already holds is
    // not a change, and the trigger is right not to fire on it.
    db.prepare('INSERT INTO advance_accounts (id, tenant_id, customer_phone, customer_name, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('AA2', 'T1', '9000000002', 'Rohan Iyer', NOW, NOW);

    db.prepare(`INSERT INTO rate_snapshots
        (id, tenant_id, source, price_24k_paise_per_g, price_22k_paise_per_g, price_18k_paise_per_g, captured_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run('RS1', 'T1', 'manual', 750000, 687500, 562500, NOW);

    db.prepare('INSERT INTO document_sequences (tenant_id, branch_id, document_type, financial_year, prefix, next_value) VALUES (?,?,?,?,?,?)')
        .run('T1', 'B1', 'invoice', '2026-27', 'INV', 1);
});

/**
 * Builds the INSERT from the row object's own keys.
 *
 * A hand-written column list silently DROPS any override naming a column the
 * list forgot, so the test then asserts against a row it did not actually
 * write — it passes or fails for the wrong reason. Deriving the columns from
 * the data makes that impossible.
 */
function insertRow(table, row) {
    const columns = Object.keys(row);
    const placeholders = columns.map(() => '?').join(',');
    return db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`)
        .run(...columns.map(column => row[column]));
}

function insertInvoice(overrides = {}) {
    return insertRow('invoices', {
        id: 'INV-1', tenant_id: 'T1', branch_id: 'B1', invoice_number: 'INV-000001-26',
        financial_year: '2026-27', sequence_value: 1, customer_name: 'Aarti Deshmukh',
        customer_phone: '9000000001', metal_value_paise: 5843750, taxable_amount_paise: 6428125,
        tax_amount_paise: 192844, total_amount_paise: 6620969, issued_at: NOW,
        business_date: TODAY, idempotency_key: null, state: 'issued', ...overrides
    });
}

/* --------------------------------------------------------------------------
   2. Invoice constraints
   -------------------------------------------------------------------------- */

check('a well-formed invoice inserts', () => {
    insertInvoice();
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, 1);
});

check('a duplicate invoice number is refused', () => {
    refuses(() => insertInvoice({ id: 'INV-2', sequence_value: 2 }), /UNIQUE|constraint/i);
});

check('a duplicate financial-year sequence slot is refused', () => {
    refuses(() => insertInvoice({ id: 'INV-3', invoice_number: 'INV-000009-26' }), /UNIQUE|constraint/i);
});

check('two invoices may both omit an idempotency key, but not share one', () => {
    insertInvoice({ id: 'INV-4', invoice_number: 'INV-000004-26', sequence_value: 4 });
    insertInvoice({ id: 'INV-5', invoice_number: 'INV-000005-26', sequence_value: 5, idempotency_key: 'req-abc' });
    refuses(
        () => insertInvoice({ id: 'INV-6', invoice_number: 'INV-000006-26', sequence_value: 6, idempotency_key: 'req-abc' }),
        /UNIQUE|constraint/i
    );
});

check('an unknown invoice state is refused', () => {
    refuses(
        () => insertInvoice({ id: 'INV-7', invoice_number: 'INV-000007-26', sequence_value: 7, state: 'shipped' }),
        /CHECK|constraint/i
    );
});

check('a negative total is refused', () => {
    refuses(
        () => insertInvoice({ id: 'INV-8', invoice_number: 'INV-000008-26', sequence_value: 8, total_amount_paise: -1 }),
        /CHECK|constraint/i
    );
});

check('an invoice defaults to pending delivery, and an unknown delivery status is refused', () => {
    insertInvoice({ id: 'INV-8B', invoice_number: 'INV-00000FB-26', sequence_value: 108 });
    assert.strictEqual(db.prepare("SELECT delivery_status FROM invoices WHERE id = 'INV-8B'").get().delivery_status, 'pending');

    refuses(
        () => insertInvoice({ id: 'INV-8C', invoice_number: 'INV-00000FC-26', sequence_value: 109, delivery_status: 'shipped' }),
        /CHECK|constraint/i
    );
});

check('an invoice line cannot report more returned weight than it sold', () => {
    db.prepare(`INSERT INTO invoice_lines
        (id, invoice_id, line_number, purity, weight_mg, rate_paise_per_g, metal_value_paise,
         taxable_amount_paise, line_total_paise)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('IL1', 'INV-1', 1, '22K', 8500, 687500, 5843750, 5843750, 6019062);

    refuses(
        () => db.prepare('UPDATE invoice_lines SET returned_weight_mg = ? WHERE id = ?').run(9000, 'IL1'),
        /CHECK|constraint/i
    );
    db.prepare('UPDATE invoice_lines SET returned_weight_mg = ? WHERE id = ?').run(3500, 'IL1');
});

check('an invoice line with an unsupported purity is refused', () => {
    refuses(() => db.prepare(`INSERT INTO invoice_lines
        (id, invoice_id, line_number, purity, weight_mg, rate_paise_per_g, metal_value_paise,
         taxable_amount_paise, line_total_paise) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('IL2', 'INV-1', 2, '14K', 1000, 687500, 100, 100, 100), /CHECK|constraint/i);
});

check('a line cannot reference an invoice that does not exist', () => {
    refuses(() => db.prepare(`INSERT INTO invoice_lines
        (id, invoice_id, line_number, purity, weight_mg, rate_paise_per_g, metal_value_paise,
         taxable_amount_paise, line_total_paise) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run('IL3', 'INV-NOPE', 1, '22K', 1000, 687500, 100, 100, 100), /FOREIGN KEY|constraint/i);
});

check('a duplicate tender reference on the same method is refused', () => {
    db.prepare('INSERT INTO tenders (id, invoice_id, method, amount_paise, reference, captured_at) VALUES (?,?,?,?,?,?)')
        .run('TN1', 'INV-1', 'upi', 6620969, 'UTR-XYZ-1', NOW);
    refuses(
        () => db.prepare('INSERT INTO tenders (id, invoice_id, method, amount_paise, reference, captured_at) VALUES (?,?,?,?,?,?)')
            .run('TN2', 'INV-4', 'upi', 100, 'UTR-XYZ-1', NOW),
        /UNIQUE|constraint/i
    );
});

check('cash tenders without a reference do not collide with each other', () => {
    db.prepare('INSERT INTO tenders (id, invoice_id, method, amount_paise, captured_at) VALUES (?,?,?,?,?)')
        .run('TN3', 'INV-4', 'cash', 500, NOW);
    db.prepare('INSERT INTO tenders (id, invoice_id, method, amount_paise, captured_at) VALUES (?,?,?,?,?)')
        .run('TN4', 'INV-5', 'cash', 700, NOW);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM tenders WHERE method = 'cash'").get().c, 2);
});

/* --------------------------------------------------------------------------
   3. Advances — append-only, approver-bound, duplicate-proof
   -------------------------------------------------------------------------- */

function insertAdvance(overrides = {}) {
    return insertRow('advance_entries', {
        id: 'ADV-1', tenant_id: 'T1', branch_id: 'B1', account_id: 'AA1', entry_type: 'deposit',
        amount_paise: 2500000, status: 'pending', payment_method: 'upi', reference_id: 'UTR-A-1',
        source: 'portal', created_at: NOW, business_date: TODAY, approved_by_user_id: null,
        idempotency_key: null, reverses_entry_id: null, ...overrides
    });
}

check('a pending manual-UPI claim inserts without an approver', () => {
    insertAdvance();
    const row = db.prepare('SELECT status, approved_by_user_id FROM advance_entries WHERE id = ?').get('ADV-1');
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.approved_by_user_id, null);
});

check('a posted entry WITHOUT a named approver is refused — the reconciliation control', () => {
    refuses(
        () => insertAdvance({ id: 'ADV-2', reference_id: 'UTR-A-2', status: 'posted' }),
        /CHECK|constraint/i
    );
});

check('a posted entry WITH a named approver is accepted', () => {
    insertAdvance({ id: 'ADV-3', reference_id: 'UTR-A-3', status: 'posted', approved_by_user_id: 'U-MGR' });
    assert.strictEqual(
        db.prepare('SELECT approved_by_user_id a FROM advance_entries WHERE id = ?').get('ADV-3').a,
        'U-MGR'
    );
});

check('a duplicate UPI reference is refused at the database, not just in JS', () => {
    refuses(() => insertAdvance({ id: 'ADV-4', reference_id: 'UTR-A-1' }), /UNIQUE|constraint/i);
});

check('the same reference under a different method is allowed', () => {
    insertAdvance({ id: 'ADV-5', reference_id: 'UTR-A-1', payment_method: 'bank_transfer' });
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM advance_entries WHERE reference_id = 'UTR-A-1'").get().c, 2);
});

check('a deposit must be positive and a redemption must be negative', () => {
    refuses(() => insertAdvance({ id: 'ADV-6', reference_id: 'UTR-A-6', amount_paise: -100 }), /CHECK|constraint/i);
    refuses(() => insertAdvance({ id: 'ADV-7', reference_id: 'UTR-A-7', entry_type: 'redeem', amount_paise: 100 }), /CHECK|constraint/i);
    refuses(() => insertAdvance({ id: 'ADV-8', reference_id: 'UTR-A-8', amount_paise: 0 }), /CHECK|constraint/i);
});

check('a redemption inserts with a negative amount, so balance is a plain SUM', () => {
    insertAdvance({
        id: 'ADV-RED', reference_id: null, entry_type: 'redeem', amount_paise: -2000000,
        status: 'posted', approved_by_user_id: 'U-CSH', payment_method: 'other', source: 'counter'
    });
    const balance = db.prepare(
        "SELECT COALESCE(SUM(amount_paise), 0) b FROM advance_entries WHERE account_id = ? AND status = 'posted'"
    ).get('AA1').b;
    // ADV-3 posted +25,00,000 and ADV-RED posted -20,00,000. The pending
    // ADV-1 must not count — that is the whole point of the pending claim.
    assert.strictEqual(balance, 500000);
});

check('editing the amount of an existing entry is refused — append-only', () => {
    refuses(
        () => db.prepare('UPDATE advance_entries SET amount_paise = ? WHERE id = ?').run(9999999, 'ADV-3'),
        /append-only/
    );
});

check('editing the reference or the payer of an existing entry is refused', () => {
    refuses(() => db.prepare('UPDATE advance_entries SET reference_id = ? WHERE id = ?').run('UTR-NEW', 'ADV-3'), /append-only/);
    refuses(() => db.prepare('UPDATE advance_entries SET account_id = ? WHERE id = ?').run('AA2', 'ADV-3'), /append-only/);
});

check('deleting a ledger entry is refused outright', () => {
    refuses(() => db.prepare('DELETE FROM advance_entries WHERE id = ?').run('ADV-1'), /append-only/);
});

check('pending -> posted is allowed and records the approver', () => {
    db.prepare('UPDATE advance_entries SET status = ?, approved_by_user_id = ?, approved_at = ? WHERE id = ?')
        .run('posted', 'U-MGR', NOW, 'ADV-1');
    const row = db.prepare('SELECT status, approved_by_user_id FROM advance_entries WHERE id = ?').get('ADV-1');
    assert.strictEqual(row.status, 'posted');
    assert.strictEqual(row.approved_by_user_id, 'U-MGR');
});

check('posted -> pending is refused (an approval cannot be un-rung)', () => {
    refuses(() => db.prepare('UPDATE advance_entries SET status = ? WHERE id = ?').run('pending', 'ADV-1'),
        /illegal advance entry status transition/);
});

check('a rejected claim cannot later be flipped to posted', () => {
    insertAdvance({ id: 'ADV-REJ', reference_id: 'UTR-REJ', status: 'pending' });
    db.prepare('UPDATE advance_entries SET status = ?, review_note = ? WHERE id = ?')
        .run('rejected', 'No matching transfer in the bank statement.', 'ADV-REJ');
    refuses(
        () => db.prepare('UPDATE advance_entries SET status = ?, approved_by_user_id = ? WHERE id = ?')
            .run('posted', 'U-MGR', 'ADV-REJ'),
        /illegal advance entry status transition/
    );
});

check('an entry can be reversed at most once', () => {
    insertAdvance({
        id: 'ADV-REV1', reference_id: null, entry_type: 'reversal', amount_paise: -100,
        status: 'posted', approved_by_user_id: 'U-MGR', reverses_entry_id: 'ADV-3',
        payment_method: 'other', source: 'counter'
    });
    refuses(() => insertAdvance({
        id: 'ADV-REV2', reference_id: null, entry_type: 'reversal', amount_paise: -100,
        status: 'posted', approved_by_user_id: 'U-MGR', reverses_entry_id: 'ADV-3',
        payment_method: 'other', source: 'counter'
    }), /UNIQUE|constraint/i);
});

check('the approvers view exposes only active owners and managers', () => {
    const rows = db.prepare('SELECT id FROM approvers ORDER BY id').all().map(r => r.id);
    assert.deepStrictEqual(rows, ['U-MGR'], 'cashier and auditor must not appear as approvers');
});

/* --------------------------------------------------------------------------
   4. Payments — the double-credit guards
   -------------------------------------------------------------------------- */

check('a duplicate provider order id is refused', () => {
    db.prepare(`INSERT INTO payment_orders
        (id, tenant_id, provider_order_id, customer_phone, amount_paise, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?)`).run('PO1', 'T1', 'order_abc', '9000000001', 1000000, NOW, NOW + 86400000);
    refuses(() => db.prepare(`INSERT INTO payment_orders
        (id, tenant_id, provider_order_id, customer_phone, amount_paise, created_at, expires_at)
        VALUES (?,?,?,?,?,?,?)`).run('PO2', 'T1', 'order_abc', '9000000001', 1000000, NOW, NOW + 86400000),
        /UNIQUE|constraint/i);
});

check('a replayed webhook event id is refused — the retry cannot credit twice', () => {
    db.prepare('INSERT INTO payment_events (id, provider_event_id, event_type, received_at) VALUES (?,?,?,?)')
        .run('PE1', 'evt_123', 'payment.captured', NOW);
    refuses(() => db.prepare('INSERT INTO payment_events (id, provider_event_id, event_type, received_at) VALUES (?,?,?,?)')
        .run('PE2', 'evt_123', 'payment.captured', NOW), /UNIQUE|constraint/i);
});

check('a different event id for the same payment is still accepted', () => {
    db.prepare('INSERT INTO payment_events (id, provider_event_id, event_type, provider_payment_id, received_at) VALUES (?,?,?,?,?)')
        .run('PE3', 'evt_456', 'payment.captured', 'pay_1', NOW);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM payment_events').get().c, 2);
});

/* --------------------------------------------------------------------------
   4b. Lot inventory (Phase 5.2) — the CHECK constraints, exercised via raw
   SQL rather than through inventoryRepository.js. The repository's own
   openLot() refuses a non-positive weight before a query is ever issued, so
   a test that only calls the repository would prove the JS guard works and
   never actually exercise the DB CHECK behind it — the backstop that still
   matters if a future write path skips the repository.
   -------------------------------------------------------------------------- */

db.prepare(`INSERT INTO inventory_items (id, tenant_id, name, purity, is_active, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run('ITM1', 'T1', 'Test Chain', '22K', 1, NOW, NOW);
db.prepare(`INSERT INTO inventory_lots (id, tenant_id, branch_id, item_id, created_by_user_id, created_at)
    VALUES (?,?,?,?,?,?)`).run('LOT1', 'T1', 'B1', 'ITM1', 'U-MGR', NOW);

check('a movement with a zero weight delta is refused', () => {
    refuses(() => db.prepare(`INSERT INTO inventory_movements
        (id, tenant_id, branch_id, item_id, lot_id, movement_type, weight_delta_mg, actor_user_id, created_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('MOV1', 'T1', 'B1', 'ITM1', 'LOT1', 'adjustment', 0, 'U-MGR', NOW, TODAY),
        /CHECK|constraint/i);
});

check('an opening_balance movement with a non-positive weight is refused', () => {
    refuses(() => db.prepare(`INSERT INTO inventory_movements
        (id, tenant_id, branch_id, item_id, lot_id, movement_type, weight_delta_mg, actor_user_id, created_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('MOV2', 'T1', 'B1', 'ITM1', 'LOT1', 'opening_balance', -500, 'U-MGR', NOW, TODAY),
        /CHECK|constraint/i);
});

check('an unrecognised movement_type is refused', () => {
    refuses(() => db.prepare(`INSERT INTO inventory_movements
        (id, tenant_id, branch_id, item_id, lot_id, movement_type, weight_delta_mg, actor_user_id, created_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('MOV3', 'T1', 'B1', 'ITM1', 'LOT1', 'purchase', 1000, 'U-MGR', NOW, TODAY),
        /CHECK|constraint/i);
});

check('a valid adjustment movement is accepted, and cannot then be edited or deleted', () => {
    db.prepare(`INSERT INTO inventory_movements
        (id, tenant_id, branch_id, item_id, lot_id, movement_type, weight_delta_mg, actor_user_id, created_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('MOV4', 'T1', 'B1', 'ITM1', 'LOT1', 'opening_balance', 25000, 'U-MGR', NOW, TODAY);

    refuses(() => db.prepare('UPDATE inventory_movements SET weight_delta_mg = 1 WHERE id = ?').run('MOV4'), /append-only/);
    refuses(() => db.prepare('DELETE FROM inventory_movements WHERE id = ?').run('MOV4'), /append-only/);
});

/* --------------------------------------------------------------------------
   4c. SKU catalogue mechanics (Phase 5.1) — the CHECK constraints and the
   hallmark/HUID unique index, exercised via raw SQL for the same reason as
   4b above: inventoryRepository.js's own guards (assertWeightsConsistent)
   would otherwise be the only thing ever exercising these, and they are not
   what is meant to be the backstop.
   -------------------------------------------------------------------------- */

check('a negative gross weight on an inventory item is refused', () => {
    refuses(() => db.prepare('UPDATE inventory_items SET gross_weight_mg = -100 WHERE id = ?').run('ITM1'),
        /CHECK|constraint/i);
});

check('a negative stone value on an inventory item is refused', () => {
    refuses(() => db.prepare('UPDATE inventory_items SET stone_value_paise = -1 WHERE id = ?').run('ITM1'),
        /CHECK|constraint/i);
});

check('a NULL gross/net/stone weight is accepted — an item is not forced to carry catalogue detail', () => {
    db.prepare('UPDATE inventory_items SET hsn_code = ? WHERE id = ?').run('7113', 'ITM1');
    assert.strictEqual(db.prepare("SELECT hsn_code FROM inventory_items WHERE id = 'ITM1'").get().hsn_code, '7113');
});

check('two lots sharing the same hallmark HUID within a tenant are refused', () => {
    db.prepare(`INSERT INTO inventory_lots (id, tenant_id, branch_id, item_id, created_by_user_id, created_at, hallmark_huid)
        VALUES (?,?,?,?,?,?,?)`).run('LOT-HUID-1', 'T1', 'B1', 'ITM1', 'U-MGR', NOW, 'HUID-DUP');
    refuses(() => db.prepare(`INSERT INTO inventory_lots (id, tenant_id, branch_id, item_id, created_by_user_id, created_at, hallmark_huid)
        VALUES (?,?,?,?,?,?,?)`).run('LOT-HUID-2', 'T1', 'B1', 'ITM1', 'U-MGR', NOW, 'HUID-DUP'),
        /UNIQUE|constraint/i);
});

check('the HUID uniqueness is scoped per tenant — a second tenant may use the same code', () => {
    db.prepare('INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('T2', 'Second Tenant', NOW, NOW);
    db.prepare('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)').run('B2', 'T2', 'Main', NOW, NOW);
    db.prepare(`INSERT INTO inventory_items (id, tenant_id, name, purity, is_active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`).run('ITM-T2', 'T2', 'Other Tenant Item', '22K', 1, NOW, NOW);
    db.prepare(`INSERT INTO inventory_lots (id, tenant_id, branch_id, item_id, created_by_user_id, created_at, hallmark_huid)
        VALUES (?,?,?,?,?,?,?)`).run('LOT-T2-HUID', 'T2', 'B2', 'ITM-T2', 'U-MGR', NOW, 'HUID-DUP');
    assert.strictEqual(db.prepare("SELECT hallmark_huid FROM inventory_lots WHERE id = 'LOT-T2-HUID'").get().hallmark_huid, 'HUID-DUP');
});

/* --------------------------------------------------------------------------
   5. Audit is genuinely immutable
   -------------------------------------------------------------------------- */

check('an audit event can be written but never altered or deleted', () => {
    db.prepare(`INSERT INTO audit_events
        (id, tenant_id, actor_user_id, actor_label, action, entity_type, entity_id, summary, occurred_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run('AE1', 'T1', 'U-MGR', 'meena', 'advance.approved', 'advance_entry', 'ADV-1',
            'Approved a manual UPI claim of ₹25,000', NOW, TODAY);

    refuses(() => db.prepare('UPDATE audit_events SET summary = ? WHERE id = ?').run('nothing to see', 'AE1'), /append-only/);
    refuses(() => db.prepare('DELETE FROM audit_events WHERE id = ?').run('AE1'), /append-only/);
});

/* --------------------------------------------------------------------------
   5b. Audit retention checkpoints (Phase 37) — the archive-then-prune record.
   This table has no append-only trigger of its own (each prune run writes
   exactly one row and nothing ever revisits it), so what matters here is
   just the ordinary CHECK constraint and that a row can be written at all.
   -------------------------------------------------------------------------- */

check('a retention checkpoint can be recorded', () => {
    db.prepare(`INSERT INTO audit_retention_checkpoints
        (id, tenant_id, pruned_through_chain_seq, pruned_through_occurred_at, checkpoint_hash, rows_pruned, created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run('ARC1', 'T1', 5, NOW, 'a'.repeat(64), 5, NOW);
    assert.strictEqual(db.prepare("SELECT rows_pruned FROM audit_retention_checkpoints WHERE id = 'ARC1'").get().rows_pruned, 5);
});

check('a negative rows_pruned is refused', () => {
    refuses(() => db.prepare(`INSERT INTO audit_retention_checkpoints
        (id, tenant_id, pruned_through_chain_seq, pruned_through_occurred_at, checkpoint_hash, rows_pruned, created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run('ARC2', 'T1', 6, NOW, 'b'.repeat(64), -1, NOW),
        /CHECK|constraint/i);
});

/* --------------------------------------------------------------------------
   5c. Cash shifts (Phase 5.3) — one open shift per branch, and a closed
   shift is terminal. Exercised via raw SQL, the same reasoning as 4b: the
   repository's own guards (getOpenShift/status checks) would otherwise be
   the only thing tested, leaving the DB triggers behind them unexercised.
   -------------------------------------------------------------------------- */

db.prepare(`INSERT INTO cash_shifts (id, tenant_id, branch_id, status, opening_float_paise, opened_by_user_id, opened_at, business_date)
    VALUES (?,?,?,?,?,?,?,?)`).run('SHIFT1', 'T1', 'B1', 'open', 500000, 'U-MGR', NOW, TODAY);

check('a second open shift on the same branch is refused', () => {
    refuses(() => db.prepare(`INSERT INTO cash_shifts (id, tenant_id, branch_id, status, opening_float_paise, opened_by_user_id, opened_at, business_date)
        VALUES (?,?,?,?,?,?,?,?)`).run('SHIFT2', 'T1', 'B1', 'open', 100000, 'U-MGR', NOW, TODAY),
        /UNIQUE|constraint/i);
});

check('the opening float cannot be rewritten after the fact', () => {
    refuses(() => db.prepare('UPDATE cash_shifts SET opening_float_paise = 999 WHERE id = ?').run('SHIFT1'),
        /opening facts cannot be changed/);
});

check('a shift cannot be closed without a count, an approver and a variance all at once', () => {
    refuses(() => db.prepare('UPDATE cash_shifts SET status = ? WHERE id = ?').run('closed', 'SHIFT1'),
        /CHECK|constraint/i);
});

check('closing a shift properly, then editing or reopening it, is refused', () => {
    db.prepare(`UPDATE cash_shifts SET status='closed', counted_cash_paise=?, expected_cash_paise=?, variance_paise=?, closed_by_user_id=?, closed_at=? WHERE id=?`)
        .run(500000, 500000, 0, 'U-MGR', NOW, 'SHIFT1');

    refuses(() => db.prepare('UPDATE cash_shifts SET status = ? WHERE id = ?').run('open', 'SHIFT1'),
        /cannot be reopened or edited/);
    refuses(() => db.prepare('UPDATE cash_shifts SET closing_note = ? WHERE id = ?').run('edited after close', 'SHIFT1'),
        /cannot be reopened or edited/);
    refuses(() => db.prepare('DELETE FROM cash_shifts WHERE id = ?').run('SHIFT1'), /append-only/);
});

check('a new shift can open on the branch once the old one is closed', () => {
    db.prepare(`INSERT INTO cash_shifts (id, tenant_id, branch_id, status, opening_float_paise, opened_by_user_id, opened_at, business_date)
        VALUES (?,?,?,?,?,?,?,?)`).run('SHIFT3', 'T1', 'B1', 'open', 500000, 'U-MGR', NOW, TODAY);
    assert.strictEqual(db.prepare("SELECT status FROM cash_shifts WHERE id = 'SHIFT3'").get().status, 'open');
});

/* --------------------------------------------------------------------------
   5d. Sale drafts — quotes and holds (Phase 5.3). Unlike 4b/5c above, this
   table is NOT append-only — a draft is mutable scratch state, not a
   financial record (see 009_sale_drafts.sql). What matters here is the
   CHECK constraints: a bad kind/status/cart is refused at the database
   layer, not just by the repository's own guards.
   -------------------------------------------------------------------------- */

check('kind must be quote or hold', () => {
    refuses(() => db.prepare(`INSERT INTO sale_drafts (id, tenant_id, branch_id, kind, customer_name, customer_phone, cart_json, created_by_user_id, created_at, updated_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('SD1', 'T1', 'B1', 'layaway', '', '', '[{"weightGrams":5}]', 'U-MGR', NOW, NOW, TODAY),
        /CHECK|constraint/i);
});

check('cart_json must actually be valid JSON', () => {
    refuses(() => db.prepare(`INSERT INTO sale_drafts (id, tenant_id, branch_id, kind, customer_name, customer_phone, cart_json, created_by_user_id, created_at, updated_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('SD2', 'T1', 'B1', 'hold', '', '', 'not json at all', 'U-MGR', NOW, NOW, TODAY),
        /CHECK|constraint/i);
});

check('a valid draft can be written, updated freely, and defaults to open', () => {
    db.prepare(`INSERT INTO sale_drafts (id, tenant_id, branch_id, kind, customer_name, customer_phone, cart_json, created_by_user_id, created_at, updated_at, business_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run('SD3', 'T1', 'B1', 'quote', 'Asha Rao', '9876543210', '[{"weightGrams":5,"purity":"22K"}]', 'U-MGR', NOW, NOW, TODAY);
    const row = db.prepare("SELECT status, kind FROM sale_drafts WHERE id = 'SD3'").get();
    assert.strictEqual(row.status, 'open');
    assert.strictEqual(row.kind, 'quote');

    // Fully mutable — no immutability trigger exists for this table.
    db.prepare("UPDATE sale_drafts SET cart_json = '[{\"weightGrams\":8,\"purity\":\"22K\"}]' WHERE id = 'SD3'").run();
    const updatedCart = JSON.parse(db.prepare("SELECT cart_json FROM sale_drafts WHERE id = 'SD3'").get().cart_json);
    assert.strictEqual(updatedCart[0].weightGrams, 8, 'a draft is scratch state — an ordinary UPDATE must just work');
});

/* --------------------------------------------------------------------------
   6. Transactions — the whole reason for the migration
   -------------------------------------------------------------------------- */

check('a throw mid-transaction rolls back every write in it', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
    refuses(() => inTransaction(() => {
        insertInvoice({ id: 'INV-TX', invoice_number: 'INV-000099-26', sequence_value: 99 });
        throw new Error('simulated failure after the invoice row was written');
    }), /simulated failure/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, before);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM invoices WHERE id = 'INV-TX'").get().c, 0);
});

check('a constraint violation deep in a transaction rolls back the earlier writes too', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
    refuses(() => inTransaction(() => {
        insertInvoice({ id: 'INV-TX2', invoice_number: 'INV-000098-26', sequence_value: 98 });
        // Duplicate invoice number — the exact race the JSON sequence bug hit.
        insertInvoice({ id: 'INV-TX3', invoice_number: 'INV-000098-26', sequence_value: 97 });
    }), /UNIQUE|constraint/i);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, before);
});

check('a nested transaction joins the outer one and commits as a single unit', () => {
    const before = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
    refuses(() => inTransaction(() => {
        insertInvoice({ id: 'INV-N1', invoice_number: 'INV-000091-26', sequence_value: 91 });
        inTransaction(() => {
            insertInvoice({ id: 'INV-N2', invoice_number: 'INV-000092-26', sequence_value: 92 });
        });
        throw new Error('outer failure after the inner block returned');
    }), /outer failure/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM invoices').get().c, before,
        'the inner block must NOT have committed independently of the outer one');
});

check('a successful nested transaction commits both levels', () => {
    inTransaction(() => {
        insertInvoice({ id: 'INV-N3', invoice_number: 'INV-000093-26', sequence_value: 93 });
        inTransaction(() => {
            insertInvoice({ id: 'INV-N4', invoice_number: 'INV-000094-26', sequence_value: 94 });
        });
    });
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM invoices WHERE id IN ('INV-N3','INV-N4')").get().c, 2);
});

check('invoice-number allocation cannot hand the same slot to two sales', () => {
    const allocate = () => inTransaction(db2 => {
        const row = db2.prepare(`UPDATE document_sequences SET next_value = next_value + 1
            WHERE tenant_id = ? AND branch_id = ? AND document_type = ? AND financial_year = ?
            RETURNING next_value - 1 AS allocated`).get('T1', 'B1', 'invoice', '2026-27');
        return row.allocated;
    });
    const first = allocate();
    const second = allocate();
    const third = allocate();
    assert.deepStrictEqual([second - first, third - second], [1, 1]);
    assert.strictEqual(new Set([first, second, third]).size, 3, 'allocation handed out a duplicate slot');
});

/* --------------------------------------------------------------------------
   7. The database file is where it should be, and nowhere near backend/data
   -------------------------------------------------------------------------- */

check('this suite wrote only into its own temp directory', () => {
    assert.ok(DB_FILE.startsWith(TEMP_ROOT),
        `suite wrote to ${DB_FILE}, which is outside its temp root ${TEMP_ROOT}`);
    assert.ok(fs.existsSync(DB_FILE));
});

closeDb();
fs.rmSync(TEMP_ROOT, { recursive: true, force: true });

console.log('======================================================================');
console.log(`✅ TRANSACTIONAL SCHEMA SUITE PASSED (${passed} checks)`);
console.log('======================================================================');
