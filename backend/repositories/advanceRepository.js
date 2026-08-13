/**
 * ==========================================================================
 * Customer advances — append-only, and the reason a manager approval means
 * anything.
 *
 * THE ONE RULE. The financial facts of an entry are frozen at insert. A status
 * change is a new row in `advance_entry_transitions` plus a narrow UPDATE of
 * the four mutable columns, and the schema's trigger aborts anything wider —
 * including any DELETE. A balance is therefore always derivable from history,
 * and "who approved this and when" cannot be overwritten.
 *
 * SIGNED AMOUNTS. Deposits are positive, redemptions negative, so a balance is
 * `SUM(amount_paise)` over posted rows. The JSON version summed with a
 * conditional on `type`, which is the same arithmetic with one more place to
 * get the sign wrong. The legacy projection flips redemptions back to the
 * positive `amount` the UI has always shown.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';
import { newId } from '../db.js';
import { fromPaise, toPaise, ADVANCE_STATUS } from '../../frontend/js/lib/billingMath.js';

/* --------------------------------------------------------------------------
   Vocabulary translation

   The wire and the UI speak 'approved'; the schema speaks 'posted'. They are
   the same fact — money the store has actually seen — named for two different
   audiences, and the translation lives here rather than at each call site.
   -------------------------------------------------------------------------- */

export const SQL_STATUS = { PENDING: 'pending', POSTED: 'posted', REJECTED: 'rejected', REVERSED: 'reversed' };

/** Wire/UI status → stored status. */
export function toStoredStatus(status) {
    const raw = String(status || '').trim().toLowerCase();
    if (raw === ADVANCE_STATUS.PENDING) return SQL_STATUS.PENDING;
    if (raw === ADVANCE_STATUS.REJECTED) return SQL_STATUS.REJECTED;
    return SQL_STATUS.POSTED;
}

/**
 * Stored status → wire/UI status.
 *
 * `reversed` reads as `rejected` because the legacy vocabulary has only three
 * words and "not spendable, and there is a record of why" is the closest of
 * them. Nothing in this build produces a reversal yet — the reversal route is
 * a later item — so this is a projection contract, not live behaviour.
 */
export function toWireStatus(status) {
    if (status === SQL_STATUS.PENDING) return ADVANCE_STATUS.PENDING;
    if (status === SQL_STATUS.REJECTED || status === SQL_STATUS.REVERSED) return ADVANCE_STATUS.REJECTED;
    return ADVANCE_STATUS.APPROVED;
}

const METHOD_TO_STORED = new Map([
    ['cash', 'cash'], ['card', 'card'], ['upi', 'upi'], ['razorpay', 'razorpay'],
    ['bank transfer', 'bank_transfer'], ['bank_transfer', 'bank_transfer'],
    ['return credit', 'return_credit'], ['return_credit', 'return_credit'],
    ['net banking', 'bank_transfer'], ['netbanking', 'bank_transfer']
]);

const METHOD_TO_WIRE = new Map([
    ['cash', 'Cash'], ['card', 'Card'], ['upi', 'UPI'], ['razorpay', 'Razorpay'],
    ['bank_transfer', 'Bank Transfer'], ['return_credit', 'Return Credit'], ['other', 'Other']
]);

export function toStoredMethod(method) {
    return METHOD_TO_STORED.get(String(method || '').trim().toLowerCase()) || 'other';
}

export function toWireMethod(method) {
    return METHOD_TO_WIRE.get(method) || 'Other';
}

/* --------------------------------------------------------------------------
   Accounts
   -------------------------------------------------------------------------- */

/**
 * The advance account for a phone number, created on first use.
 *
 * Keyed on phone because that is what every customer ledger in this platform
 * is keyed on, and `uq_advance_accounts_phone` makes two accounts for one
 * customer impossible rather than merely unlikely.
 */
export function ensureAccount({ tenantId, customerPhone, customerName = '', customerId = null }) {
    assertInTransaction('ensureAccount');
    const db = getDb();
    const existing = db.prepare('SELECT * FROM advance_accounts WHERE tenant_id = ? AND customer_phone = ?')
        .get(tenantId, customerPhone);

    const now = Date.now();
    if (existing) {
        // A later deposit under a fuller name updates the label; it never
        // touches an entry, which is frozen.
        if (customerName && customerName !== existing.customer_name) {
            db.prepare('UPDATE advance_accounts SET customer_name = ?, updated_at = ? WHERE id = ?')
                .run(customerName, now, existing.id);
        }
        if (customerId && !existing.customer_id) {
            db.prepare('UPDATE advance_accounts SET customer_id = ?, updated_at = ? WHERE id = ?')
                .run(customerId, now, existing.id);
        }
        return existing.id;
    }

    const id = newId('ACC');
    db.prepare(`
        INSERT INTO advance_accounts (id, tenant_id, customer_id, customer_phone, customer_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, customerId, customerPhone, customerName || 'Regular Customer', now, now);
    return id;
}

export function findAccountByPhone(tenantId, customerPhone) {
    return getDb().prepare('SELECT * FROM advance_accounts WHERE tenant_id = ? AND customer_phone = ?')
        .get(tenantId, customerPhone) || null;
}

/* --------------------------------------------------------------------------
   Entries
   -------------------------------------------------------------------------- */

/**
 * Appends an entry and its opening transition.
 *
 * The transition row is written here rather than by the caller so that no
 * entry can exist without the history that explains it — the pairing is the
 * audit trail, and leaving it to discipline is how half of them go missing.
 *
 * @param {object} entry all money already in paise, `amountPaise` already signed
 */
export function insertEntry(entry) {
    assertInTransaction('insertEntry');
    const db = getDb();

    db.prepare(`
        INSERT INTO advance_entries (
            id, tenant_id, branch_id, account_id, entry_type, amount_paise, status,
            payment_method, reference_id, source, locked_rate_22k_paise_per_g,
            invoice_id, credit_note_id, reverses_entry_id, idempotency_key,
            created_by_user_id, approved_by_user_id, approved_at, review_note,
            created_at, business_date
        ) VALUES (
            @id, @tenantId, @branchId, @accountId, @entryType, @amountPaise, @status,
            @paymentMethod, @referenceId, @source, @lockedRate22kPaisePerG,
            @invoiceId, @creditNoteId, @reversesEntryId, @idempotencyKey,
            @createdByUserId, @approvedByUserId, @approvedAt, @reviewNote,
            @createdAt, @businessDate
        )
    `).run(entry);

    db.prepare(`
        INSERT INTO advance_entry_transitions (id, entry_id, from_status, to_status, actor_user_id, note, occurred_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(newId('ATR'), entry.id, entry.status,
        entry.approvedByUserId || entry.createdByUserId || null,
        entry.reviewNote || null, entry.createdAt);

    return entry.id;
}

/**
 * Moves an entry to a new status, recording who did it and why.
 *
 * The UPDATE is conditional on the CURRENT status, which is what makes a
 * double-tapped Approve button harmless: the second one matches zero rows and
 * is reported as "already reviewed" rather than crediting the claim twice. The
 * schema's transition trigger is the second line of defence behind it.
 *
 * @returns {{changed: boolean, entry: object|null}}
 */
export function transition(entryId, { fromStatus, toStatus, actorUserId = null, note = null, at = Date.now() }) {
    assertInTransaction('transition');
    const db = getDb();

    /* Only a posting stamps the approver columns, so only a posting may bind
       those parameters: node:sqlite rejects a named parameter the statement
       does not reference, and passing them unconditionally made every
       REJECTION throw — leaving the claim pending while the caller was told
       the review had been saved. The parameter set must track the SQL. */
    const posting = toStatus === SQL_STATUS.POSTED;
    const params = { entryId, fromStatus, toStatus, note };
    if (posting) {
        params.actorUserId = actorUserId;
        params.at = at;
    }

    const result = db.prepare(`
        UPDATE advance_entries
           SET status = @toStatus, review_note = @note
               ${posting ? ', approved_by_user_id = @actorUserId, approved_at = @at' : ''}
         WHERE id = @entryId AND status = @fromStatus
    `).run(params);

    if (result.changes !== 1) return { changed: false, entry: findEntryById(entryId) };

    db.prepare(`
        INSERT INTO advance_entry_transitions (id, entry_id, from_status, to_status, actor_user_id, note, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId('ATR'), entryId, fromStatus, toStatus, actorUserId, note, at);

    return { changed: true, entry: findEntryById(entryId) };
}

export function findEntryById(entryId) {
    return getDb().prepare('SELECT * FROM advance_entries WHERE id = ?').get(entryId) || null;
}

/** Several entries at once — the batched read a list page needs. */
export function findEntriesByIds(entryIds) {
    if (!entryIds || entryIds.length === 0) return [];
    const placeholders = entryIds.map(() => '?').join(', ');
    return getDb().prepare(`SELECT * FROM advance_entries WHERE id IN (${placeholders})`).all(...entryIds);
}

export function findEntryByIdempotencyKey(tenantId, key) {
    if (!key) return null;
    return getDb().prepare('SELECT * FROM advance_entries WHERE tenant_id = ? AND idempotency_key = ?')
        .get(tenantId, key) || null;
}

/**
 * An existing entry that already claims this payment reference.
 *
 * A reference identifies one real-world transfer, so it may appear once. This
 * read is the friendly error; `uq_advance_entries_reference` is the guarantee,
 * and a racing duplicate that slips past the read still fails its INSERT.
 * Rejected claims are excluded — a reference typed wrongly and rejected must
 * be usable again.
 */
export function findEntryByReference(tenantId, paymentMethod, referenceId) {
    const clean = String(referenceId || '').trim();
    if (!clean) return null;
    return getDb().prepare(`
        SELECT * FROM advance_entries
         WHERE tenant_id = ? AND payment_method = ? AND LOWER(reference_id) = LOWER(?)
           AND status <> 'rejected'
         LIMIT 1
    `).get(tenantId, toStoredMethod(paymentMethod), clean) || null;
}

/** Any entry claiming this reference on any method — the wider duplicate check. */
export function findEntryByAnyReference(tenantId, referenceId) {
    const clean = String(referenceId || '').trim();
    if (!clean) return null;
    return getDb().prepare(`
        SELECT * FROM advance_entries
         WHERE tenant_id = ? AND LOWER(reference_id) = LOWER(?) AND status <> 'rejected'
         LIMIT 1
    `).get(tenantId, clean) || null;
}

/* --------------------------------------------------------------------------
   Balances and lists
   -------------------------------------------------------------------------- */

/**
 * Spendable balance and the awaiting-approval figures shown beside it.
 *
 * Floored at zero for the same reason computeAdvanceBalance() floors: a
 * negative advance balance is not a debt this system tracks, and letting one
 * through would silently discount the customer's next bill.
 */
export function summaryForAccount(accountId) {
    if (!accountId) return { balance: 0, pendingTotal: 0, pendingCount: 0, balancePaise: 0 };

    const db = getDb();
    const posted = db.prepare(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total FROM advance_entries WHERE account_id = ? AND status = 'posted'`
    ).get(accountId).total;

    const pending = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(amount_paise), 0) AS total
          FROM advance_entries WHERE account_id = ? AND status = 'pending' AND entry_type = 'deposit'
    `).get(accountId);

    const balancePaise = Math.max(0, posted);
    return {
        balancePaise,
        balance: fromPaise(balancePaise),
        pendingTotal: fromPaise(pending.total),
        pendingCount: pending.count
    };
}

/** Balance and pending figures for a phone number. */
export function summaryForPhone(tenantId, customerPhone) {
    const account = findAccountByPhone(tenantId, customerPhone);
    return account
        ? { accountId: account.id, ...summaryForAccount(account.id) }
        : { accountId: null, balance: 0, balancePaise: 0, pendingTotal: 0, pendingCount: 0 };
}

/**
 * A page of one customer's entries, newest first.
 * @returns {{rows: object[], total: number}}
 */
export function historyForPhone({ tenantId, customerPhone, limit = 50, offset = 0 }) {
    const account = findAccountByPhone(tenantId, customerPhone);
    if (!account) return { rows: [], total: 0 };

    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) AS n FROM advance_entries WHERE account_id = ?').get(account.id).n;
    const rows = db.prepare(`
        SELECT * FROM advance_entries WHERE account_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
    `).all(account.id, clampLimit(limit), Math.max(0, Math.trunc(offset) || 0));

    return { rows, total };
}

/**
 * A page of the whole ledger, newest first, optionally narrowed by status.
 * @returns {{rows: object[], total: number}}
 */
export function search({ tenantId, status = null, entryType = null, limit = 50, offset = 0 }) {
    // Filters only — see the note in invoiceRepository.search().
    const where = ['tenant_id = @tenantId'];
    const params = { tenantId };
    if (status) { where.push('status = @status'); params.status = status; }
    if (entryType) { where.push('entry_type = @entryType'); params.entryType = entryType; }

    const whereSql = where.join(' AND ');
    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS n FROM advance_entries WHERE ${whereSql}`).get(params).n;
    const rows = db.prepare(`
        SELECT * FROM advance_entries WHERE ${whereSql}
        ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: clampLimit(limit), offset: Math.max(0, Math.trunc(offset) || 0) });

    return { rows, total };
}

/**
 * The counter's approval queue — oldest first, so nobody's money sits at the
 * bottom of a stack indefinitely.
 */
export function listPending({ tenantId, limit = 50, offset = 0 }) {
    const db = getDb();
    const total = db.prepare(
        `SELECT COUNT(*) AS n FROM advance_entries WHERE tenant_id = ? AND status = 'pending' AND entry_type = 'deposit'`
    ).get(tenantId).n;
    const rows = db.prepare(`
        SELECT * FROM advance_entries
         WHERE tenant_id = ? AND status = 'pending' AND entry_type = 'deposit'
         ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?
    `).all(tenantId, clampLimit(limit), Math.max(0, Math.trunc(offset) || 0));

    return { rows, total };
}

export function countEntries(tenantId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM advance_entries WHERE tenant_id = ?').get(tenantId).n;
}

/** Net posted value across the tenant, in paise. */
export function sumPosted(tenantId) {
    return getDb().prepare(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total FROM advance_entries WHERE tenant_id = ? AND status = 'posted'`
    ).get(tenantId).total;
}

/**
 * Count of entries, and net POSTED value among them, for one idempotency-key
 * prefix — the importer's reconciliation scope. The count covers every entry
 * imported; the net covers only the posted ones, because a pending claim is
 * not yet money and must not appear in a balance figure on either side.
 */
export function summariseByKeyPrefix(tenantId, prefix) {
    return getDb().prepare(`
        SELECT COUNT(*) AS count,
               COALESCE(SUM(CASE WHEN status = 'posted' THEN amount_paise ELSE 0 END), 0) AS net_paise
          FROM advance_entries WHERE tenant_id = ? AND idempotency_key LIKE ? || '%'
    `).get(tenantId, prefix);
}

/** The transition history of one entry, oldest first. */
export function transitionsFor(entryId) {
    return getDb().prepare(
        'SELECT * FROM advance_entry_transitions WHERE entry_id = ? ORDER BY occurred_at, rowid'
    ).all(entryId);
}

/* --------------------------------------------------------------------------
   The legacy projection
   -------------------------------------------------------------------------- */

/**
 * An entry in the exact shape `advances.json` held.
 *
 * `amount` comes back POSITIVE for both types, because that is what the ledger
 * screens, the customer portal and `summarizeAdvanceLedger()` have always
 * consumed — the sign lives in `type`, and flipping it on the wire now would
 * silently double every redemption in the browser's own arithmetic.
 *
 * @param {object} entry
 * @param {{account?: object, invoiceNumber?: string|null,
 *          creditNoteNumber?: string|null, reviewedAt?: number|null}} [context]
 */
export function toLegacyAdvance(entry, context = {}) {
    if (!entry) return null;
    const db = getDb();
    const account = context.account !== undefined
        ? context.account
        : db.prepare('SELECT * FROM advance_accounts WHERE id = ?').get(entry.account_id) || null;

    const invoiceNumber = context.invoiceNumber !== undefined
        ? context.invoiceNumber
        : (entry.invoice_id
            ? (db.prepare('SELECT invoice_number FROM invoices WHERE id = ?').get(entry.invoice_id) || {}).invoice_number || null
            : null);

    const creditNoteNumber = context.creditNoteNumber !== undefined
        ? context.creditNoteNumber
        : (entry.credit_note_id
            ? (db.prepare('SELECT credit_note_number FROM credit_notes WHERE id = ?').get(entry.credit_note_id) || {}).credit_note_number || null
            : null);

    // `reviewedAt` covers approval AND rejection, so it is the last transition
    // out of pending rather than `approved_at`, which is only set on approval.
    const reviewedAt = context.reviewedAt !== undefined
        ? context.reviewedAt
        : (entry.status === SQL_STATUS.PENDING
            ? null
            : (db.prepare(`
                SELECT occurred_at FROM advance_entry_transitions
                 WHERE entry_id = ? AND from_status = 'pending'
                 ORDER BY occurred_at DESC LIMIT 1
              `).get(entry.id) || {}).occurred_at || entry.approved_at || null);

    return {
        id: entry.id,
        customerPhone: account ? account.customer_phone : '',
        customerName: account ? account.customer_name : 'Regular Customer',
        type: entry.entry_type === 'redeem' ? 'redeem' : 'deposit',
        amount: fromPaise(Math.abs(entry.amount_paise)),
        paymentMethod: toWireMethod(entry.payment_method),
        referenceId: entry.reference_id || '',
        status: toWireStatus(entry.status),
        source: entry.source,
        ...(invoiceNumber ? { invoiceId: invoiceNumber } : {}),
        ...(creditNoteNumber ? { returnId: creditNoteNumber } : {}),
        lockedGoldRate22K: entry.locked_rate_22k_paise_per_g
            ? fromPaise(entry.locked_rate_22k_paise_per_g)
            : null,
        timestamp: entry.created_at,
        ...(reviewedAt ? { reviewedAt } : {}),
        ...(entry.review_note ? { reviewNote: entry.review_note } : {})
    };
}

/**
 * Projects a page of entries without one lookup per row.
 * Same output as mapping `toLegacyAdvance` over the array, minus the N+1.
 */
export function toLegacyAdvances(entries) {
    if (!entries || entries.length === 0) return [];
    const db = getDb();

    const accountIds = [...new Set(entries.map(e => e.account_id).filter(Boolean))];
    const accounts = new Map(
        (accountIds.length
            ? db.prepare(`SELECT * FROM advance_accounts WHERE id IN (${accountIds.map(() => '?').join(', ')})`).all(...accountIds)
            : []
        ).map(row => [row.id, row])
    );

    const invoiceIds = [...new Set(entries.map(e => e.invoice_id).filter(Boolean))];
    const invoices = new Map(
        (invoiceIds.length
            ? db.prepare(`SELECT id, invoice_number FROM invoices WHERE id IN (${invoiceIds.map(() => '?').join(', ')})`).all(...invoiceIds)
            : []
        ).map(row => [row.id, row.invoice_number])
    );

    const noteIds = [...new Set(entries.map(e => e.credit_note_id).filter(Boolean))];
    const notes = new Map(
        (noteIds.length
            ? db.prepare(`SELECT id, credit_note_number FROM credit_notes WHERE id IN (${noteIds.map(() => '?').join(', ')})`).all(...noteIds)
            : []
        ).map(row => [row.id, row.credit_note_number])
    );

    const reviewedIds = entries.filter(e => e.status !== SQL_STATUS.PENDING).map(e => e.id);
    const reviewed = new Map();
    if (reviewedIds.length) {
        const rows = db.prepare(`
            SELECT entry_id, MAX(occurred_at) AS occurred_at
              FROM advance_entry_transitions
             WHERE from_status = 'pending' AND entry_id IN (${reviewedIds.map(() => '?').join(', ')})
             GROUP BY entry_id
        `).all(...reviewedIds);
        for (const row of rows) reviewed.set(row.entry_id, row.occurred_at);
    }

    return entries.map(entry => toLegacyAdvance(entry, {
        account: accounts.get(entry.account_id) || null,
        invoiceNumber: entry.invoice_id ? invoices.get(entry.invoice_id) || null : null,
        creditNoteNumber: entry.credit_note_id ? notes.get(entry.credit_note_id) || null : null,
        reviewedAt: entry.status === SQL_STATUS.PENDING
            ? null
            : reviewed.get(entry.id) || entry.approved_at || null
    }));
}

/* -------------------------------------------------------------------------- */

/** Rupees → signed paise for an entry type. Deposits add, redemptions subtract. */
export function signedPaise(entryType, amountRupees) {
    const magnitude = Math.abs(toPaise(amountRupees));
    return entryType === 'redeem' ? -magnitude : magnitude;
}

const MAX_PAGE = 200;

function clampLimit(limit) {
    const n = Math.trunc(Number(limit) || 50);
    if (n < 1) return 1;
    return Math.min(MAX_PAGE, n);
}

function assertInTransaction(operation) {
    if (!inTransactionNow()) {
        throw new Error(`${operation}() must run inside inTransaction(): an advance entry and its transition commit together or not at all.`);
    }
}
