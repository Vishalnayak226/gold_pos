/**
 * ==========================================================================
 * Lot inventory — items (catalogue metadata), lots (a distinguishable batch
 * of an item), and immutable stock movements (roadmap Phase 5.2, the
 * ungated slice — see 006_lot_inventory.sql for what is deliberately absent
 * and why: no vendor/purchase, no branch transfer, no sale integration).
 *
 * THE ONE RULE. A lot's on-hand weight is never stored — it is
 * SUM(weight_delta_mg) over that lot's movements, exactly like an advance
 * account's balance is SUM(amount_paise) over its entries. Movements are
 * append-only (enforced by trigger, not convention); the only way to correct
 * a mistake is a new movement, never an edit.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';
import { newId } from '../db.js';
import { businessDate } from './calendar.js';

function assertInTransaction(operation) {
    if (!inTransactionNow()) {
        throw new Error(`${operation}() must run inside inTransaction(): a lot and its opening movement commit together or not at all.`);
    }
}

/* --------------------------------------------------------------------------
   Items — mutable catalogue metadata, not a financial fact
   -------------------------------------------------------------------------- */

export function listItems(tenantId, { activeOnly = false } = {}) {
    const db = getDb();
    if (activeOnly) {
        return db.prepare('SELECT * FROM inventory_items WHERE tenant_id = ? AND is_active = 1 ORDER BY name')
            .all(tenantId);
    }
    return db.prepare('SELECT * FROM inventory_items WHERE tenant_id = ? ORDER BY name').all(tenantId);
}

export function getItem(tenantId, itemId) {
    return getDb().prepare('SELECT * FROM inventory_items WHERE tenant_id = ? AND id = ?').get(tenantId, itemId) || null;
}

/**
 * @param {{tenantId: string, name: string, category?: string, purity: string}} params
 * @returns {string} the new item's id
 */
export function createItem({ tenantId, name, category = null, purity }) {
    const db = getDb();
    const id = newId('ITM');
    const now = Date.now();
    db.prepare(`
        INSERT INTO inventory_items (id, tenant_id, name, category, purity, sku_code, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)
    `).run(id, tenantId, name, category, purity, now, now);
    return id;
}

/**
 * Patches name/category/purity/isActive. Metadata, not a ledger fact, so a
 * plain UPDATE is correct here — nothing about an item's description is
 * append-only.
 */
export function updateItem(tenantId, itemId, patch) {
    const db = getDb();
    const existing = getItem(tenantId, itemId);
    if (!existing) return null;

    const next = {
        name: patch.name !== undefined ? patch.name : existing.name,
        category: patch.category !== undefined ? patch.category : existing.category,
        purity: patch.purity !== undefined ? patch.purity : existing.purity,
        isActive: patch.isActive !== undefined ? (patch.isActive ? 1 : 0) : existing.is_active
    };
    db.prepare(`
        UPDATE inventory_items SET name = ?, category = ?, purity = ?, is_active = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
    `).run(next.name, next.category, next.purity, next.isActive, Date.now(), tenantId, itemId);
    return getItem(tenantId, itemId);
}

/* --------------------------------------------------------------------------
   Lots and movements
   -------------------------------------------------------------------------- */

/** SUM(weight_delta_mg) over a lot's movements. 0 for a lot with none (never happens in practice — a lot is always created with its opening movement). */
export function lotBalanceMg(lotId) {
    const row = getDb().prepare('SELECT COALESCE(SUM(weight_delta_mg), 0) AS balance FROM inventory_movements WHERE lot_id = ?').get(lotId);
    return row.balance;
}

/**
 * Opens a new lot with its first (opening_balance) movement. This is the
 * only way a lot comes into existence — mirrors ensureAccount()+insertEntry()
 * in advanceRepository.js: the child row is written here so no lot can exist
 * without the movement that explains its starting weight.
 *
 * @param {{tenantId, branchId, itemId, weightMg: number, label?: string, reason?: string, actorUserId: string, at?: number}} params
 * @returns {{lotId: string, movementId: string}}
 */
export function openLot({ tenantId, branchId, itemId, weightMg, label = null, reason = null, actorUserId, at = Date.now() }) {
    assertInTransaction('openLot');
    if (!Number.isInteger(weightMg) || weightMg <= 0) {
        throw new Error('openLot: weightMg must be a positive integer (milligrams).');
    }
    const db = getDb();
    const lotId = newId('LOT');
    db.prepare(`
        INSERT INTO inventory_lots (id, tenant_id, branch_id, item_id, label, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(lotId, tenantId, branchId, itemId, label, actorUserId, at);

    const movementId = newId('MOV');
    db.prepare(`
        INSERT INTO inventory_movements (
            id, tenant_id, branch_id, item_id, lot_id, movement_type, weight_delta_mg, reason,
            actor_user_id, created_at, business_date
        ) VALUES (?, ?, ?, ?, ?, 'opening_balance', ?, ?, ?, ?, ?)
    `).run(movementId, tenantId, branchId, itemId, lotId, weightMg, reason, actorUserId, at, businessDate(at));

    return { lotId, movementId };
}

/**
 * Adjusts an existing lot — a physical count found more or less than the
 * book figure, breakage, or a correction. Refuses to take the lot's balance
 * negative, checked here rather than in a trigger (SQLite has no portable
 * way to assert an aggregate from a row-level trigger) — the same place
 * saleService checks an advance redemption against its balance.
 *
 * Deliberately has no `branchId` parameter: the movement's branch always
 * comes from the lot it adjusts, never from whatever branch the caller
 * currently claims to be in. Only one branch exists today so this cannot
 * yet diverge, but taking a caller-supplied branch here would be a latent
 * bug waiting for a second one.
 *
 * @param {{tenantId, lotId, weightDeltaMg: number, reason?: string, actorUserId: string, at?: number}} params
 * @returns {string} the new movement's id
 */
export function recordAdjustment({ tenantId, lotId, weightDeltaMg, reason = null, actorUserId, at = Date.now() }) {
    assertInTransaction('recordAdjustment');
    if (!Number.isInteger(weightDeltaMg) || weightDeltaMg === 0) {
        throw new Error('recordAdjustment: weightDeltaMg must be a non-zero integer (milligrams).');
    }
    const db = getDb();
    const lot = db.prepare('SELECT * FROM inventory_lots WHERE id = ? AND tenant_id = ?').get(lotId, tenantId);
    if (!lot) throw new Error(`recordAdjustment: no lot ${lotId} for this tenant.`);

    const currentBalance = lotBalanceMg(lotId);
    if (currentBalance + weightDeltaMg < 0) {
        throw new Error(`Adjustment would take lot ${lotId} negative (current ${currentBalance}mg, delta ${weightDeltaMg}mg).`);
    }

    const movementId = newId('MOV');
    db.prepare(`
        INSERT INTO inventory_movements (
            id, tenant_id, branch_id, item_id, lot_id, movement_type, weight_delta_mg, reason,
            actor_user_id, created_at, business_date
        ) VALUES (?, ?, ?, ?, ?, 'adjustment', ?, ?, ?, ?, ?)
    `).run(movementId, tenantId, lot.branch_id, lot.item_id, lotId, weightDeltaMg, reason, actorUserId, at, businessDate(at));

    return movementId;
}

/** A single lot with its current derived weight, or null. */
export function getLot(tenantId, lotId) {
    return getDb().prepare(`
        SELECT l.*, COALESCE(SUM(m.weight_delta_mg), 0) AS balance_mg
        FROM inventory_lots l
        LEFT JOIN inventory_movements m ON m.lot_id = l.id
        WHERE l.tenant_id = ? AND l.id = ?
        GROUP BY l.id
    `).get(tenantId, lotId) || null;
}

/**
 * Lots for a tenant, each with its current derived weight. Zero-balance lots
 * (fully consumed by adjustments) are included by default — call sites that
 * only want what is actually on the shelf filter on `balanceMg > 0`.
 */
export function listLots(tenantId, { branchId = null, itemId = null } = {}) {
    const db = getDb();
    const clauses = ['l.tenant_id = ?'];
    const params = [tenantId];
    if (branchId) { clauses.push('l.branch_id = ?'); params.push(branchId); }
    if (itemId) { clauses.push('l.item_id = ?'); params.push(itemId); }

    return db.prepare(`
        SELECT l.*, COALESCE(SUM(m.weight_delta_mg), 0) AS balance_mg
        FROM inventory_lots l
        LEFT JOIN inventory_movements m ON m.lot_id = l.id
        WHERE ${clauses.join(' AND ')}
        GROUP BY l.id
        ORDER BY l.created_at DESC
    `).all(...params);
}

/** Current on-hand weight per item, summed across every lot (and every branch unless one is named). */
export function itemStockSummary(tenantId, { branchId = null } = {}) {
    const db = getDb();
    // The branch filter belongs in the LEFT JOIN's ON clause, not WHERE — a
    // WHERE on the joined table's column silently turns this into an INNER
    // JOIN, which would drop an item with zero lots in that branch instead
    // of reporting it at 0.
    const lotJoin = branchId ? 'l.item_id = i.id AND l.branch_id = ?' : 'l.item_id = i.id';
    const params = branchId ? [branchId, tenantId] : [tenantId];

    return db.prepare(`
        SELECT i.id AS item_id, i.name, i.category, i.purity, i.is_active,
               COALESCE(SUM(m.weight_delta_mg), 0) AS balance_mg
        FROM inventory_items i
        LEFT JOIN inventory_lots l ON ${lotJoin}
        LEFT JOIN inventory_movements m ON m.lot_id = l.id
        WHERE i.tenant_id = ?
        GROUP BY i.id
        ORDER BY i.name
    `).all(...params);
}

const MAX_PAGE = 200;

/** Movement history, newest first, optionally scoped to a lot/item/branch. Page-limited like every other ledger listing (CLAUDE.md's pagination precedent). */
export function listMovements(tenantId, { branchId = null, itemId = null, lotId = null, limit = 50 } = {}) {
    const db = getDb();
    const clauses = ['tenant_id = ?'];
    const params = [tenantId];
    if (branchId) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (itemId) { clauses.push('item_id = ?'); params.push(itemId); }
    if (lotId) { clauses.push('lot_id = ?'); params.push(lotId); }

    const n = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), MAX_PAGE);
    params.push(n);

    return db.prepare(`
        SELECT * FROM inventory_movements
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?
    `).all(...params);
}
