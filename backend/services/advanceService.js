/**
 * ==========================================================================
 * Customer advances.
 *
 * `status` is the whole point of this module: it separates money the store has
 * actually seen from a customer's unverified claim to have sent it.
 *
 *   counter entry, gateway-verified payment, return credit  → posted
 *   customer-submitted manual UPI                           → pending
 *
 * A pending row is not spendable and never counts toward a balance. It becomes
 * real only when a named approver says so, and the schema refuses to record
 * that without naming them:
 *   CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)
 *
 * That constraint is why Phase 1 pulled the identity slice forward. Approval
 * is the control the entire manual-UPI reconciliation rests on, and a control
 * whose actor is "the admin session" is not a control.
 * ==========================================================================
 */

import {
    inTransaction, advances, customers, audit, users,
    dataStoreContext, businessDate
} from '../repositories/index.js';
import { newId, logError, logTelemetry } from '../db.js';
import { ADVANCE_STATUS, toPaise, round2 } from '../../frontend/js/lib/billingMath.js';
import { DomainRefusal, isUniqueViolation } from './saleService.js';

/** Sanity ceiling for one deposit — a guard against fat-fingered extremes. */
const MAX_SANE_AMOUNT = 100000000;

/**
 * Records a deposit. The single write path for every source, so the row shape
 * and the locked-rate snapshot the Gold Appreciation calculator depends on are
 * identical whichever door the money came through.
 *
 * @param {object} input
 * @param {string} input.customerPhone
 * @param {string} [input.customerName]
 * @param {number} input.amount rupees
 * @param {string} [input.paymentMethod]
 * @param {string} [input.referenceId]
 * @param {'pending'|'approved'} [input.status]
 * @param {'counter'|'portal'|'gateway'|'return'|'import'} [input.source]
 * @param {string} [input.idempotencyKey]
 * @param {string} [input.paymentOrderId] links a gateway deposit to its order
 * @param {object} deps
 * @param {() => object} deps.getActiveGoldRates
 * @param {(phone: string) => boolean} deps.isValidPhone
 * @returns {{success: true, deposit: object}|{success: false, error: string, code?: string, status?: number}}
 */
export function recordDeposit(input, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    if (!deps.isValidPhone(input.customerPhone)) {
        return { success: false, status: 400, error: 'Valid 10-digit customer phone number required' };
    }
    const amount = parseFloat(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_SANE_AMOUNT) {
        return { success: false, status: 400, error: 'Valid deposit amount required' };
    }
    if (input.customerName && String(input.customerName).length > 200) {
        return { success: false, status: 400, error: 'Customer name is too long (max 200 characters).' };
    }

    const requestedStatus = String(input.status || ADVANCE_STATUS.APPROVED).toLowerCase();
    const storedStatus = advances.toStoredStatus(requestedStatus);
    const cleanReference = String(input.referenceId || '').trim();

    /* A posted deposit must name an approver. Checked here as well as in SQL so
       the caller gets a sentence rather than a constraint violation — and so a
       future route that forgets to pass one fails in a test, loudly. */
    if (storedStatus === 'posted' && !users.isApprover(context.tenantId, actorUserId)) {
        return {
            success: false, status: 403,
            error: 'Only an owner or a manager can post a deposit directly. Submit it for approval instead.'
        };
    }

    if (input.idempotencyKey) {
        const existing = advances.findEntryByIdempotencyKey(context.tenantId, input.idempotencyKey);
        if (existing) return { success: true, duplicate: true, deposit: advances.toLegacyAdvance(existing) };
    }

    try {
        return inTransaction(() => {
            /* A payment reference identifies one real-world transfer, so it may
               appear in the ledger exactly once. Without this a customer could
               submit the same UTR on three deposits and — each looking
               individually plausible to whoever approves it — be credited three
               times for one transfer. `uq_advance_entries_reference` is the
               guarantee; this read exists to produce a sentence instead of a
               constraint error. */
            if (cleanReference) {
                const clash = advances.findEntryByAnyReference(context.tenantId, cleanReference);
                if (clash) {
                    throw new DomainRefusal(409,
                        `Reference "${cleanReference}" has already been submitted against deposit ${clash.id}. ` +
                        'Each transaction reference can only be used once.',
                        'DUPLICATE_REFERENCE');
                }
            }

            const now = Date.now();
            const customerId = customers.ensureCustomerId(
                context.tenantId, input.customerPhone, input.customerName);
            const accountId = advances.ensureAccount({
                tenantId: context.tenantId,
                customerPhone: input.customerPhone,
                customerName: input.customerName || '',
                customerId
            });

            const entryId = newId('ADV');
            advances.insertEntry({
                id: entryId,
                tenantId: context.tenantId,
                branchId: context.branchId,
                accountId,
                entryType: 'deposit',
                amountPaise: advances.signedPaise('deposit', amount),
                status: storedStatus,
                paymentMethod: advances.toStoredMethod(input.paymentMethod || 'UPI'),
                referenceId: cleanReference || null,
                source: input.source || 'counter',
                /* Snapshotted at SUBMISSION, not at approval: the customer's
                   money moved when they sent it, so the Gold Appreciation figure
                   they were shown at that moment is the one they are owed. A rate
                   move during the approval wait is the store's timing, not the
                   customer's. */
                lockedRate22kPaisePerG: Math.round(Number(deps.getActiveGoldRates().price22K) * 100),
                invoiceId: null,
                creditNoteId: null,
                reversesEntryId: null,
                idempotencyKey: input.idempotencyKey || null,
                createdByUserId: actorUserId,
                approvedByUserId: storedStatus === 'posted' ? actorUserId : null,
                approvedAt: storedStatus === 'posted' ? now : null,
                reviewNote: null,
                createdAt: now,
                businessDate: businessDate(now)
            });

            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || input.source || 'counter',
                action: storedStatus === 'posted' ? 'ADVANCE_POSTED' : 'ADVANCE_SUBMITTED',
                entityType: 'advance_entry',
                entityId: entryId,
                summary: `${round2(amount)} ${storedStatus} via ${input.paymentMethod || 'UPI'}`,
                detail: {
                    amount: round2(amount),
                    paymentMethod: input.paymentMethod || 'UPI',
                    reference: cleanReference || null,
                    source: input.source || 'counter'
                },
                ipAddress: deps.ipAddress || null,
                occurredAt: now
            });

            logTelemetry('SAVE_ADVANCE_DEPOSIT', 0,
                `Amount: ${amount}, Method: ${input.paymentMethod || 'UPI'}, Status: ${requestedStatus}`);

            return { success: true, deposit: advances.toLegacyAdvance(advances.findEntryById(entryId)) };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message, code: err.code };
        }
        if (isUniqueViolation(err)) {
            // Lost the race on the reference or the idempotency key. Same answer.
            const clash = cleanReference
                ? advances.findEntryByAnyReference(context.tenantId, cleanReference)
                : advances.findEntryByIdempotencyKey(context.tenantId, input.idempotencyKey);
            if (clash) {
                return {
                    success: false, status: 409, code: 'DUPLICATE_REFERENCE',
                    error: `Reference "${cleanReference}" has already been submitted against deposit ${clash.id}. ` +
                        'Each transaction reference can only be used once.'
                };
            }
        }
        logError('Advance deposit failed and was rolled back: ' + err.message, err.stack);
        return { success: false, status: 500, error: 'Failed to persist advance deposit. Please retry.' };
    }
}

/**
 * Approves or rejects a pending deposit.
 *
 * The UPDATE is conditional on the entry still being pending, so a
 * double-tapped Approve button credits the claim once: the second call matches
 * zero rows and is reported as "already reviewed". The schema's transition
 * trigger stands behind that, refusing `rejected → posted` outright.
 *
 * @param {string} entryId
 * @param {'approved'|'rejected'} decision
 * @param {string} note
 * @returns {{success: boolean, status?: number, error?: string, deposit?: object}}
 */
export function reviewDeposit(entryId, decision, note, deps = {}) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;
    const toStatus = advances.toStoredStatus(decision);

    if (toStatus !== 'posted' && toStatus !== 'rejected') {
        return { success: false, status: 400, error: 'A review decision must be either approve or reject.' };
    }
    if (toStatus === 'posted' && !users.isApprover(context.tenantId, actorUserId)) {
        return { success: false, status: 403, error: 'Only an owner or a manager can approve a deposit.' };
    }

    try {
        return inTransaction(() => {
            const existing = advances.findEntryById(entryId);
            if (!existing || existing.entry_type !== 'deposit') {
                throw new DomainRefusal(404, 'No such deposit in the advances ledger.');
            }
            if (existing.status !== 'pending') {
                throw new DomainRefusal(409,
                    `Deposit ${entryId} is already ${advances.toWireStatus(existing.status)} and cannot be reviewed again.`);
            }

            const now = Date.now();
            const cleanNote = String(note || '').trim().slice(0, 300);
            const { changed, entry } = advances.transition(entryId, {
                fromStatus: 'pending',
                toStatus,
                actorUserId,
                note: cleanNote,
                at: now
            });

            if (!changed) {
                throw new DomainRefusal(409,
                    `Deposit ${entryId} is already ${advances.toWireStatus(entry ? entry.status : 'posted')} and cannot be reviewed again.`);
            }

            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'counter',
                action: toStatus === 'posted' ? 'ADVANCE_APPROVED' : 'ADVANCE_REJECTED',
                entityType: 'advance_entry',
                entityId: entryId,
                summary: `${advances.toWireStatus(toStatus)}: ${cleanNote || 'no note'}`,
                detail: { decision: advances.toWireStatus(toStatus), note: cleanNote },
                ipAddress: deps.ipAddress || null,
                occurredAt: now
            });

            logTelemetry('REVIEW_ADVANCE_DEPOSIT', 0,
                `Deposit: ${entryId}, Decision: ${decision}, Amount: ${Math.abs(entry.amount_paise) / 100}`);

            return { success: true, deposit: advances.toLegacyAdvance(entry) };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message };
        }
        logError('Advance review failed and was rolled back: ' + err.message, err.stack);
        return { success: false, status: 500, error: 'Failed to save the review. Please retry.' };
    }
}

/**
 * One customer's balance and a page of their ledger.
 *
 * The balance is a SQL aggregate over EVERY posted row, not over the page —
 * paginating a list must never quietly paginate the arithmetic.
 */
export function customerLedger(phone, { limit = 50, offset = 0 } = {}) {
    const context = dataStoreContext();
    const summary = advances.summaryForPhone(context.tenantId, phone);
    const { rows, total } = advances.historyForPhone({
        tenantId: context.tenantId, customerPhone: phone, limit, offset
    });

    return {
        phone,
        balance: summary.balance,
        pendingTotal: summary.pendingTotal,
        pendingCount: summary.pendingCount,
        history: advances.toLegacyAdvances(rows),
        total,
        limit: Math.max(1, Math.trunc(Number(limit) || 50)),
        offset: Math.max(0, Math.trunc(Number(offset) || 0))
    };
}

/** A page of the whole ledger, newest first. */
export function listLedger({ limit = 50, offset = 0, status = null } = {}) {
    const context = dataStoreContext();
    const { rows, total } = advances.search({
        tenantId: context.tenantId,
        status: status ? advances.toStoredStatus(status) : null,
        limit, offset
    });
    return {
        results: advances.toLegacyAdvances(rows),
        total,
        limit: Math.max(1, Math.trunc(Number(limit) || 50)),
        offset: Math.max(0, Math.trunc(Number(offset) || 0))
    };
}

/** The counter's approval queue, oldest first. */
export function listPending({ limit = 50, offset = 0 } = {}) {
    const context = dataStoreContext();
    const { rows, total } = advances.listPending({ tenantId: context.tenantId, limit, offset });
    return {
        results: advances.toLegacyAdvances(rows),
        total,
        limit: Math.max(1, Math.trunc(Number(limit) || 50)),
        offset: Math.max(0, Math.trunc(Number(offset) || 0))
    };
}

/** Whether any store history exists for a phone — used by portal registration. */
export function phoneHasStoreHistory(phone) {
    const context = dataStoreContext();
    return Boolean(advances.findAccountByPhone(context.tenantId, phone));
}

export { MAX_SANE_AMOUNT };
