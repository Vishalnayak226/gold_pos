/**
 * ==========================================================================
 * Cash shifts — open with a float, close with a count, and a variance
 * (roadmap Phase 5.3). See 008_cash_shifts.sql for the schema and why this
 * was blocked until split tenders existed.
 *
 * "Expected cash" is never stored until close — it is always computed fresh
 * from the ledger over the shift's own time window: opening float, plus
 * every cash tender and cash advance deposit while the shift was open,
 * minus every cash refund in the same window. Closing just freezes that
 * computation at the moment of closing, exactly like an advance balance is
 * SUM(amount_paise) rather than a maintained counter.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';
import { newId } from '../db.js';
import { businessDate } from './calendar.js';

function assertInTransaction(operation) {
    if (!inTransactionNow()) {
        throw new Error(`${operation}() must run inside inTransaction(): a shift transition is one atomic write.`);
    }
}

/** The three ledger components of expected cash, for a branch over [fromAt, toAt]. */
function cashComponents(tenantId, branchId, fromAt, toAt) {
    const db = getDb();

    const cashTenders = db.prepare(`
        SELECT COALESCE(SUM(t.amount_paise), 0) AS total
        FROM tenders t JOIN invoices i ON i.id = t.invoice_id
        WHERE i.tenant_id = ? AND i.branch_id = ? AND t.method = 'cash'
          AND t.captured_at >= ? AND t.captured_at <= ?
    `).get(tenantId, branchId, fromAt, toAt).total;

    const cashRefunds = db.prepare(`
        SELECT COALESCE(SUM(refund_amount_paise), 0) AS total
        FROM credit_notes
        WHERE tenant_id = ? AND branch_id = ? AND refund_mode = 'cash'
          AND issued_at >= ? AND issued_at <= ?
    `).get(tenantId, branchId, fromAt, toAt).total;

    const cashDeposits = db.prepare(`
        SELECT COALESCE(SUM(amount_paise), 0) AS total
        FROM advance_entries
        WHERE tenant_id = ? AND branch_id = ? AND payment_method = 'cash'
          AND entry_type = 'deposit' AND status = 'posted'
          AND created_at >= ? AND created_at <= ?
    `).get(tenantId, branchId, fromAt, toAt).total;

    return { cashTenders, cashRefunds, cashDeposits };
}

/** Expected cash for a shift as of `asOfAt` (defaults to now) — usable both as a live preview on an open shift and to freeze the figure at close. */
export function expectedCashAsOf(shift, asOfAt = Date.now()) {
    const { cashTenders, cashRefunds, cashDeposits } = cashComponents(shift.tenant_id, shift.branch_id, shift.opened_at, asOfAt);
    return {
        expectedPaise: shift.opening_float_paise + cashTenders + cashDeposits - cashRefunds,
        cashTenders, cashRefunds, cashDeposits
    };
}

export function getOpenShift(tenantId, branchId) {
    return getDb().prepare(`SELECT * FROM cash_shifts WHERE tenant_id = ? AND branch_id = ? AND status = 'open'`)
        .get(tenantId, branchId) || null;
}

export function getShift(tenantId, shiftId) {
    return getDb().prepare('SELECT * FROM cash_shifts WHERE tenant_id = ? AND id = ?').get(tenantId, shiftId) || null;
}

const MAX_PAGE = 200;

export function listShifts(tenantId, { branchId = null, limit = 50 } = {}) {
    const db = getDb();
    const clauses = ['tenant_id = ?'];
    const params = [tenantId];
    if (branchId) { clauses.push('branch_id = ?'); params.push(branchId); }

    const n = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), MAX_PAGE);
    params.push(n);

    return db.prepare(`
        SELECT * FROM cash_shifts WHERE ${clauses.join(' AND ')} ORDER BY opened_at DESC LIMIT ?
    `).all(...params);
}

/**
 * @param {{tenantId, branchId, openingFloatPaise: number, openingNote?: string, actorUserId: string, at?: number}} params
 * @returns {string} the new shift's id
 */
export function openShift({ tenantId, branchId, openingFloatPaise, openingNote = null, actorUserId, at = Date.now() }) {
    assertInTransaction('openShift');
    if (!Number.isInteger(openingFloatPaise) || openingFloatPaise < 0) {
        throw new Error('openShift: openingFloatPaise must be a non-negative integer (paise).');
    }
    if (getOpenShift(tenantId, branchId)) {
        throw new Error('A shift is already open for this branch. Close it before opening another.');
    }

    const db = getDb();
    const id = newId('SHIFT');
    db.prepare(`
        INSERT INTO cash_shifts (id, tenant_id, branch_id, status, opening_float_paise, opened_by_user_id, opened_at, opening_note, business_date)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `).run(id, tenantId, branchId, openingFloatPaise, actorUserId, at, openingNote, businessDate(at));
    return id;
}

/**
 * Freezes expected cash as of `at`, records what was actually counted, and
 * closes the shift. The variance is counted minus expected — positive means
 * the drawer had more than the ledger predicted, negative means less.
 *
 * @param {{tenantId, shiftId, countedCashPaise: number, closingNote?: string, actorUserId: string, at?: number}} params
 * @returns {{expectedPaise: number, variancePaise: number}}
 */
export function closeShift({ tenantId, shiftId, countedCashPaise, closingNote = null, actorUserId, at = Date.now() }) {
    assertInTransaction('closeShift');
    if (!Number.isInteger(countedCashPaise) || countedCashPaise < 0) {
        throw new Error('closeShift: countedCashPaise must be a non-negative integer (paise).');
    }
    const shift = getShift(tenantId, shiftId);
    if (!shift) throw new Error(`closeShift: no shift ${shiftId} for this tenant.`);
    if (shift.status !== 'open') throw new Error(`closeShift: shift ${shiftId} is already closed.`);

    const { expectedPaise } = expectedCashAsOf(shift, at);
    const variancePaise = countedCashPaise - expectedPaise;

    getDb().prepare(`
        UPDATE cash_shifts SET
            status = 'closed', counted_cash_paise = ?, expected_cash_paise = ?, variance_paise = ?,
            closed_by_user_id = ?, closed_at = ?, closing_note = ?
        WHERE id = ?
    `).run(countedCashPaise, expectedPaise, variancePaise, actorUserId, at, closingNote, shiftId);

    return { expectedPaise, variancePaise };
}
