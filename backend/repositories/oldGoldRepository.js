/**
 * ==========================================================================
 * Old-gold exchange.
 *
 * Append-only, matching audit_events/inventory_movements/cash_shifts: an
 * exchange is a physical fact — this gold was weighed, tested and credited on
 * this date — with no status workflow of its own.
 *
 * NO TAX TREATMENT LIVES HERE. Whether buying gold from a customer attracts
 * GST under reverse charge is an unresolved legal question; this repository
 * only records the weight/rate/credit facts a service computed, never a tax
 * figure it invented.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';

/** Inserts one exchange. Must run inside the caller's transaction. */
export function insertExchange(exchange) {
    assertInTransaction('insertExchange');
    getDb().prepare(`
        INSERT INTO old_gold_exchanges (
            id, tenant_id, branch_id, customer_id, advance_entry_id,
            description, declared_purity, tested_purity,
            gross_weight_mg, deduction_bp, net_weight_mg,
            rate_paise_per_g, credit_amount_paise,
            actor_user_id, created_at, business_date
        ) VALUES (
            @id, @tenantId, @branchId, @customerId, @advanceEntryId,
            @description, @declaredPurity, @testedPurity,
            @grossWeightMg, @deductionBp, @netWeightMg,
            @ratePaisePerG, @creditAmountPaise,
            @actorUserId, @createdAt, @businessDate
        )
    `).run(exchange);
    return exchange.id;
}

/** One exchange by id, or null. */
export function findById(tenantId, id) {
    return getDb().prepare('SELECT * FROM old_gold_exchanges WHERE id = ? AND tenant_id = ?')
        .get(id, tenantId) || null;
}

/** A customer's exchange history, newest first. */
export function listForCustomer(tenantId, customerId, { limit = 50 } = {}) {
    return getDb().prepare(`
        SELECT * FROM old_gold_exchanges
        WHERE tenant_id = ? AND customer_id = ?
        ORDER BY created_at DESC LIMIT ?
    `).all(tenantId, customerId, Math.min(200, Math.max(1, Math.trunc(limit) || 50)));
}

function assertInTransaction(name) {
    if (!inTransactionNow()) {
        throw new Error(`${name}() must run inside inTransaction() — an exchange and the advance credit it produces are one unit.`);
    }
}
