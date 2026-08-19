/**
 * ==========================================================================
 * Gateway payments.
 *
 * The HTTP conversation with Razorpay stays in the route — signatures, TLS
 * calls, mock credentials. What lives here is everything that touches the
 * ledger: recording what an order was FOR, and turning a confirmed capture
 * into credit exactly once.
 *
 * TWO CALLERS RACE BY DESIGN. The browser calls /api/payment/verify after
 * checkout; Razorpay calls /api/payment/webhook server-to-server. The webhook
 * frequently lands first, and the browser path does not run at all if the
 * customer closes the tab on the success screen — which is precisely why the
 * webhook exists. So `creditCapturedPayment()` is the one routine that turns a
 * capture into credit, and it is safe to call twice: the gateway payment id is
 * the deposit's reference, and `uq_advance_entries_reference` refuses the
 * second one at the database rather than in a check that can be raced.
 * ==========================================================================
 */

import {
    inTransaction, advances, payments, audit, customers,
    dataStoreContext, businessDate
} from '../repositories/index.js';
import { newId, logError, logTelemetry } from '../db.js';
import { raiseAlert } from '../alerting.js';
import { fromPaise } from '../../frontend/js/lib/billingMath.js';
import { DomainRefusal, isUniqueViolation } from './saleService.js';

export const PROVIDER = { RAZORPAY: 'razorpay', MOCK: 'mock' };

/**
 * Records what an order was created for, before its id reaches the browser.
 *
 * An order the customer can pay but that the store has no record of is
 * unverifiable — the customer ends up out of pocket with nothing to show for
 * it — so the route treats a failure here as a reason not to hand the id over.
 *
 * @returns {boolean} whether the intent was persisted
 */
export function recordOrder({ providerOrderId, customerPhone, amountPaise, currency = 'INR',
                              provider = PROVIDER.RAZORPAY }) {
    const context = dataStoreContext();
    try {
        const customerId = customers.ensureCustomerId(context.tenantId, customerPhone);
        payments.createOrder({
            tenantId: context.tenantId,
            providerOrderId,
            customerPhone,
            customerId,
            amountPaise,
            currency,
            provider
        });
        return true;
    } catch (err) {
        logError(`Could not record payment order ${providerOrderId}: ${err.message}`, err.stack);
        return false;
    }
}

/** The stored intent behind an order id, in the legacy wire shape, or null. */
export function findOrder(providerOrderId, provider = PROVIDER.RAZORPAY) {
    const stored = payments.findOrder(provider, providerOrderId)
        || payments.findOrder(PROVIDER.MOCK, providerOrderId);
    return stored ? { ...payments.toLegacyOrder(stored), provider: stored.provider } : null;
}

/** Moves an order to a terminal state without crediting anything. */
export function settleOrder(providerOrderId, status, { paymentId = null, note = null,
                                                       provider = PROVIDER.RAZORPAY } = {}) {
    const stored = payments.findOrder(provider, providerOrderId)
        || payments.findOrder(PROVIDER.MOCK, providerOrderId);
    if (!stored) return;
    payments.settleOrder(stored.provider, providerOrderId, status, {
        providerPaymentId: paymentId, note, onlyIfCreated: false
    });
}

/**
 * Turns a confirmed capture into ledger credit, exactly once.
 *
 * @param {object} args
 * @param {object} args.order          the stored intent, as returned by findOrder()
 * @param {string} args.paymentId      the gateway's payment id — the idempotency key
 * @param {number} args.capturedPaise  what the gateway says it actually took
 * @param {'checkout'|'webhook'} args.source
 * @param {object} deps
 * @returns {{ok: true, duplicate?: boolean, deposit: object|null}
 *         |{ok: false, status: number, error: string}}
 */
export function creditCapturedPayment({ order, paymentId, capturedPaise, source }, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.systemUserId;
    const expectedPaise = order.amountPaise;

    /* Exact integer comparison. A capture that does not match the order we
       created is never credited on a guess in either direction: crediting the
       larger figure would let a tampered checkout mint balance, and crediting
       the smaller would quietly short a customer who really did pay more. */
    if (!Number.isInteger(capturedPaise) || capturedPaise !== expectedPaise) {
        logError(
            `Razorpay payment ${paymentId} was captured for ${capturedPaise} paise but order ` +
            `${order.orderId} was created for ${expectedPaise} paise. Refusing to credit; manual reconciliation required.`
        );
        logTelemetry('PAYMENT_AMOUNT_MISMATCH', 0,
            `Order: ${order.orderId}, captured: ${capturedPaise}, expected: ${expectedPaise}`);
        raiseAlert({
            code: 'PAYMENT_AMOUNT_MISMATCH',
            severity: 'critical',
            message: `Razorpay payment ${paymentId} was captured for ${capturedPaise} paise but order ${order.orderId} expected ${expectedPaise}. Refused to credit; manual reconciliation required.`,
            details: { paymentId, orderId: order.orderId, capturedPaise, expectedPaise }
        });
        settleOrder(order.orderId, 'mismatched', {
            paymentId,
            note: `captured ${capturedPaise} paise against an expected ${expectedPaise}`,
            provider: order.provider
        });
        audit.record({
            tenantId: context.tenantId,
            actorUserId,
            actorLabel: source,
            action: 'PAYMENT_AMOUNT_MISMATCH',
            entityType: 'payment_order',
            entityId: order.orderId,
            summary: `Captured ${capturedPaise} against an expected ${expectedPaise}`,
            detail: { paymentId, capturedPaise, expectedPaise, source }
        });
        return {
            ok: false,
            status: 409,
            error: 'The captured amount does not match this payment order. Please contact the store with your payment ID: ' + paymentId
        };
    }

    const existingByReference = advances.findEntryByReference(context.tenantId, 'razorpay', paymentId);
    if (existingByReference) {
        logTelemetry('PAYMENT_CREDIT_DUPLICATE', 0, `PayId: ${paymentId}, via: ${source}`);
        return { ok: true, duplicate: true, deposit: advances.toLegacyAdvance(existingByReference) };
    }

    try {
        return inTransaction(() => {
            const now = Date.now();
            const customerId = customers.ensureCustomerId(context.tenantId, order.customerPhone);
            const accountId = advances.ensureAccount({
                tenantId: context.tenantId,
                customerPhone: order.customerPhone,
                customerName: deps.customerName || '',
                customerId
            });

            const entryId = newId('ADV');
            advances.insertEntry({
                id: entryId,
                tenantId: context.tenantId,
                branchId: context.branchId,
                accountId,
                entryType: 'deposit',
                amountPaise: expectedPaise,
                // Signature-verified and capture-confirmed: this is money the
                // store has actually received, so it posts without a human step.
                // The approver of record is the automated identity, which is
                // exactly the distinction the audit trail needs to preserve.
                status: 'posted',
                paymentMethod: 'razorpay',
                referenceId: paymentId,
                source: 'gateway',
                lockedRate22kPaisePerG: deps.getActiveGoldRates
                    ? Math.round(Number(deps.getActiveGoldRates().price22K) * 100)
                    : null,
                invoiceId: null,
                creditNoteId: null,
                reversesEntryId: null,
                idempotencyKey: `razorpay:${paymentId}`,
                createdByUserId: actorUserId,
                approvedByUserId: actorUserId,
                approvedAt: now,
                reviewNote: null,
                createdAt: now,
                businessDate: businessDate(now)
            });

            payments.settleOrder(order.provider || PROVIDER.RAZORPAY, order.orderId, 'paid', {
                providerPaymentId: paymentId,
                advanceEntryId: entryId,
                onlyIfCreated: false
            });

            audit.record({
                tenantId: context.tenantId,
                actorUserId,
                actorLabel: source,
                action: 'PAYMENT_CREDITED',
                entityType: 'advance_entry',
                entityId: entryId,
                summary: `${fromPaise(expectedPaise)} credited from ${paymentId} via ${source}`,
                detail: { paymentId, orderId: order.orderId, amountPaise: expectedPaise, source },
                occurredAt: now
            });

            logTelemetry('PAYMENT_CREDITED', 0, `PayId: ${paymentId}, via: ${source}`);
            return { ok: true, deposit: advances.toLegacyAdvance(advances.findEntryById(entryId)) };
        });
    } catch (err) {
        if (isUniqueViolation(err)) {
            // The other path won the race. Same outcome, one credit.
            const existing = advances.findEntryByReference(context.tenantId, 'razorpay', paymentId);
            logTelemetry('PAYMENT_CREDIT_DUPLICATE', 0, `PayId: ${paymentId}, via: ${source}`);
            return { ok: true, duplicate: true, deposit: existing ? advances.toLegacyAdvance(existing) : null };
        }
        // The money has already left the customer's account at this point, so
        // this is a reconciliation incident, not a retryable error.
        logError(
            `CRITICAL: Razorpay payment ${paymentId} was captured but the advance deposit failed to persist — ` +
            `customer ${order.customerPhone} paid but has no ledger credit. Manual reconciliation required. ${err.message}`,
            err.stack
        );
        raiseAlert({
            code: 'PAYMENT_CREDIT_PERSIST_FAILED',
            severity: 'critical',
            message: `Razorpay payment ${paymentId} was captured but the advance deposit failed to persist: ${err.message}. Customer paid but has no ledger credit.`,
            details: { paymentId, orderId: order.orderId }
        });
        return {
            ok: false,
            status: 500,
            error: 'Your payment was received but could not be credited automatically. Please contact the store with your payment ID: ' + paymentId
        };
    }
}

/**
 * Claims a webhook delivery, reporting whether it had already been claimed.
 *
 * The duplicate answer comes from a unique index rejecting the INSERT, not
 * from a preceding SELECT — two concurrent retries of the same delivery both
 * pass a SELECT, and only one can win a constraint.
 */
export function claimWebhookEvent(eventId, eventType, extra = {}) {
    return payments.claimEvent({
        provider: PROVIDER.RAZORPAY,
        providerEventId: eventId,
        eventType,
        providerOrderId: extra.orderId || null,
        providerPaymentId: extra.paymentId || null,
        amountPaise: Number.isInteger(extra.amountPaise) ? extra.amountPaise : null,
        payloadDigest: extra.payloadDigest || null
    });
}

/**
 * Releases a claim so the gateway's retry is processed properly.
 * Used when the handler failed AFTER claiming — the delivery was not applied,
 * and leaving the claim would make every retry look like a duplicate and
 * silently drop real money.
 */
export function releaseWebhookEvent(eventId) {
    payments.releaseEvent(PROVIDER.RAZORPAY, eventId);
}

/** Records how a claimed delivery was ultimately handled. */
export function recordWebhookOutcome(eventId, outcome) {
    const event = payments.findEvent(PROVIDER.RAZORPAY, eventId);
    if (event) payments.recordEventOutcome(event.id, outcome);
}

export { DomainRefusal };
