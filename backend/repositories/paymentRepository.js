/**
 * ==========================================================================
 * Payment orders and webhook events.
 *
 * TWO SEPARATE JOBS, both of which the JSON version did by reading a file,
 * scanning it in JavaScript and writing it back.
 *
 * 1. ORDER INTENTS bind "what the browser asked to pay" to "what the gateway
 *    later says it paid". Razorpay's checkout HMAC covers `order_id|payment_id`
 *    and carries no amount, so without a stored intent, verification has to
 *    believe `req.body.amount` — which is how a ₹100 order gets ₹5,000
 *    credited. Verification reads the amount from here and ignores the body's.
 *
 * 2. EVENT CLAIMS make webhook delivery idempotent. Razorpay retries until it
 *    gets a 2xx, so retries are normal traffic. `uq_payment_events_provider_event`
 *    turns "have I seen this event?" from a lookup-then-insert — the same check
 *    with a race in the middle — into a constraint: the second delivery's
 *    INSERT fails, and that failure IS the answer.
 * ==========================================================================
 */

import { getDb, inTransaction, inTransactionNow } from './connection.js';
import { newId } from '../db.js';
import { fromPaise } from '../../frontend/js/lib/billingMath.js';

/** How long an unpaid intent is kept. Expiry never refuses a confirmed credit. */
export const PAYMENT_ORDER_TTL_MS = 24 * 60 * 60 * 1000;

/* --------------------------------------------------------------------------
   Orders
   -------------------------------------------------------------------------- */

/**
 * Records what an order was created for.
 *
 * @param {{tenantId: string, providerOrderId: string, customerPhone: string,
 *          amountPaise: number, currency?: string, provider?: string,
 *          customerId?: string|null, ttlMs?: number}} spec
 * @returns {object} the stored row
 */
export function createOrder({ tenantId, providerOrderId, customerPhone, amountPaise,
                              currency = 'INR', provider = 'razorpay', customerId = null,
                              ttlMs = PAYMENT_ORDER_TTL_MS }) {
    const now = Date.now();
    const id = newId('PAY');

    inTransaction(db => {
        db.prepare(`
            INSERT INTO payment_orders (id, tenant_id, provider, provider_order_id, customer_id,
                                        customer_phone, amount_paise, currency, status,
                                        created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)
        `).run(id, tenantId, provider, providerOrderId, customerId, customerPhone,
            amountPaise, currency, now, now + ttlMs);

        // Housekeeping while the write lock is already held: an expired,
        // never-paid intent has no further use, and pruning here keeps the
        // table bounded without a scheduled job. Orders that reached a terminal
        // state are kept — they are the audit trail of money that moved.
        db.prepare(`
            DELETE FROM payment_orders
             WHERE tenant_id = ? AND status = 'created' AND expires_at < ?
        `).run(tenantId, now);
    });

    return findOrder(provider, providerOrderId);
}

/** The stored intent behind a provider order id, or null. */
export function findOrder(provider, providerOrderId) {
    if (!providerOrderId) return null;
    return getDb().prepare('SELECT * FROM payment_orders WHERE provider = ? AND provider_order_id = ?')
        .get(provider, providerOrderId) || null;
}

/** The stored intent behind a provider PAYMENT id, or null. */
export function findOrderByPaymentId(provider, providerPaymentId) {
    if (!providerPaymentId) return null;
    return getDb().prepare('SELECT * FROM payment_orders WHERE provider = ? AND provider_payment_id = ?')
        .get(provider, providerPaymentId) || null;
}

/**
 * Moves an order to a terminal state, linking it to the payment and — when the
 * money was credited — to the advance entry it produced.
 *
 * The UPDATE is conditional on the order still being `created`, so the browser
 * verify call and the webhook racing each other settle it exactly once; the
 * loser is told `changed: false` and returns the first outcome instead of
 * crediting a second time.
 *
 * @returns {{changed: boolean, order: object|null}}
 */
export function settleOrder(provider, providerOrderId, status,
                            { providerPaymentId = null, advanceEntryId = null, note = null,
                              onlyIfCreated = true } = {}) {
    const run = () => {
        const guard = onlyIfCreated ? `AND status = 'created'` : '';
        const result = getDb().prepare(`
            UPDATE payment_orders
               SET status = @status,
                   provider_payment_id = COALESCE(@providerPaymentId, provider_payment_id),
                   advance_entry_id = COALESCE(@advanceEntryId, advance_entry_id),
                   note = COALESCE(@note, note),
                   settled_at = @settledAt
             WHERE provider = @provider AND provider_order_id = @providerOrderId ${guard}
        `).run({
            status, providerPaymentId, advanceEntryId, note,
            settledAt: Date.now(), provider, providerOrderId
        });
        return { changed: result.changes === 1, order: findOrder(provider, providerOrderId) };
    };

    return inTransactionNow() ? run() : inTransaction(run);
}

/** A page of a customer's orders, newest first. */
export function ordersForCustomer({ tenantId, customerPhone, limit = 50, offset = 0 }) {
    const db = getDb();
    const total = db.prepare(
        'SELECT COUNT(*) AS n FROM payment_orders WHERE tenant_id = ? AND customer_phone = ?'
    ).get(tenantId, customerPhone).n;
    const rows = db.prepare(`
        SELECT * FROM payment_orders WHERE tenant_id = ? AND customer_phone = ?
        ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(tenantId, customerPhone, clampLimit(limit), Math.max(0, Math.trunc(offset) || 0));
    return { rows, total };
}

export function countOrders(tenantId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM payment_orders WHERE tenant_id = ?').get(tenantId).n;
}

/** An order in the shape `payment_orders.json` held. */
export function toLegacyOrder(order) {
    if (!order) return null;
    return {
        orderId: order.provider_order_id,
        customerPhone: order.customer_phone,
        amountPaise: order.amount_paise,
        amount: fromPaise(order.amount_paise),
        currency: order.currency,
        status: order.status,
        createdAt: order.created_at,
        expiresAt: order.expires_at,
        ...(order.provider_payment_id ? { paymentId: order.provider_payment_id } : {}),
        ...(order.advance_entry_id ? { depositId: order.advance_entry_id } : {}),
        ...(order.note ? { note: order.note } : {}),
        ...(order.settled_at ? { settledAt: order.settled_at } : {})
    };
}

/* --------------------------------------------------------------------------
   Webhook events
   -------------------------------------------------------------------------- */

/**
 * Claims a gateway event id, reporting whether it had already been claimed.
 *
 * The duplicate detection is the INSERT failing against
 * `uq_payment_events_provider_event`, not a preceding SELECT. That distinction
 * is the entire point: two concurrent retries of the same delivery both pass a
 * SELECT and both credit; only one can win a unique index.
 *
 * @returns {{alreadySeen: boolean, previous: object|null, id: string|null}}
 */
export function claimEvent({ provider = 'razorpay', providerEventId, eventType,
                             providerOrderId = null, providerPaymentId = null,
                             amountPaise = null, payloadDigest = null }) {
    const id = newId('EVT');
    try {
        const insert = () => getDb().prepare(`
            INSERT INTO payment_events (id, provider, provider_event_id, event_type,
                                        provider_order_id, provider_payment_id, amount_paise,
                                        payload_digest, outcome, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
        `).run(id, provider, providerEventId, eventType, providerOrderId,
            providerPaymentId, amountPaise, payloadDigest, Date.now());

        if (inTransactionNow()) insert(); else inTransaction(insert);
        return { alreadySeen: false, previous: null, id };
    } catch (err) {
        const previous = findEvent(provider, providerEventId);
        if (previous) return { alreadySeen: true, previous, id: previous.id };
        // Not a uniqueness collision — a real failure the caller must not treat
        // as "already handled", or a delivery would be silently dropped.
        throw err;
    }
}

/** Records how a claimed event was ultimately handled. */
export function recordEventOutcome(eventId, outcome) {
    const run = () => getDb().prepare('UPDATE payment_events SET outcome = ? WHERE id = ?')
        .run(outcome, eventId);
    if (inTransactionNow()) run(); else inTransaction(run);
}

/**
 * Releases a claim so the gateway's retry can be processed properly.
 *
 * Used when the handler failed AFTER claiming — the delivery has not actually
 * been applied, and leaving the claim in place would make every retry look
 * like a duplicate and silently drop real money.
 */
export function releaseEvent(provider, providerEventId) {
    const run = () => getDb().prepare(
        'DELETE FROM payment_events WHERE provider = ? AND provider_event_id = ?'
    ).run(provider, providerEventId);
    if (inTransactionNow()) run(); else inTransaction(run);
}

export function findEvent(provider, providerEventId) {
    return getDb().prepare('SELECT * FROM payment_events WHERE provider = ? AND provider_event_id = ?')
        .get(provider, providerEventId) || null;
}

export function countEvents() {
    return getDb().prepare('SELECT COUNT(*) AS n FROM payment_events').get().n;
}

/* -------------------------------------------------------------------------- */

const MAX_PAGE = 200;

function clampLimit(limit) {
    const n = Math.trunc(Number(limit) || 50);
    if (n < 1) return 1;
    return Math.min(MAX_PAGE, n);
}
