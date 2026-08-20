/**
 * ==========================================================================
 * Sale drafts — quotes and holds (roadmap Phase 5.3). See
 * 009_sale_drafts.sql for why this is the one table this session's phases
 * added that is NOT append-only: nothing here is money yet.
 *
 * The cart is opaque JSON to this repository — it is priced by the Billing
 * Desk at save time and re-priced there again at resume time, never by
 * anything in backend/. This repository only ever stores and returns the
 * blob a caller gave it.
 * ==========================================================================
 */

import { getDb } from './connection.js';
import { newId } from '../db.js';
import { businessDate } from './calendar.js';

export function getDraft(tenantId, draftId) {
    return getDb().prepare('SELECT * FROM sale_drafts WHERE tenant_id = ? AND id = ?').get(tenantId, draftId) || null;
}

const MAX_PAGE = 200;

export function listDrafts(tenantId, { branchId = null, kind = null, status = 'open', limit = 100 } = {}) {
    const db = getDb();
    const clauses = ['tenant_id = ?'];
    const params = [tenantId];
    if (branchId) { clauses.push('branch_id = ?'); params.push(branchId); }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (status) { clauses.push('status = ?'); params.push(status); }

    const n = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), MAX_PAGE);
    params.push(n);

    return db.prepare(`
        SELECT * FROM sale_drafts WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?
    `).all(...params);
}

/**
 * @param {{tenantId, branchId, kind: 'quote'|'hold', customerName?, customerPhone?, cart: any[], discountBp?: number, note?, validUntil?, actorUserId, at?: number}} params
 * @returns {string} the new draft's id
 */
export function createDraft({
    tenantId, branchId, kind, customerName = '', customerPhone = '', cart,
    discountBp = 0, note = null, validUntil = null, actorUserId, at = Date.now()
}) {
    if (kind !== 'quote' && kind !== 'hold') {
        throw new Error(`createDraft: kind must be 'quote' or 'hold', got '${kind}'.`);
    }
    if (!Array.isArray(cart) || cart.length === 0) {
        throw new Error('createDraft: cart must be a non-empty array.');
    }

    const db = getDb();
    const id = newId(kind === 'quote' ? 'QTE' : 'HLD');
    db.prepare(`
        INSERT INTO sale_drafts (
            id, tenant_id, branch_id, kind, status, customer_name, customer_phone, cart_json,
            discount_bp, note, valid_until, created_by_user_id, created_at, updated_at, business_date
        ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, branchId, kind, customerName, customerPhone, JSON.stringify(cart),
        discountBp, note, validUntil, actorUserId, at, at, businessDate(at));
    return id;
}

/** Patches an OPEN draft's cart/customer/discount/note — refused once resumed or discarded, matching the Billing Desk's own "an editable draft or a filed fact, never both" rule for invoices. */
export function updateDraft(tenantId, draftId, patch, at = Date.now()) {
    const draft = getDraft(tenantId, draftId);
    if (!draft) return null;
    if (draft.status !== 'open') {
        throw new Error(`updateDraft: draft ${draftId} is ${draft.status}, not open — it cannot be edited.`);
    }

    const next = {
        customerName: patch.customerName !== undefined ? patch.customerName : draft.customer_name,
        customerPhone: patch.customerPhone !== undefined ? patch.customerPhone : draft.customer_phone,
        cartJson: patch.cart !== undefined ? JSON.stringify(patch.cart) : draft.cart_json,
        discountBp: patch.discountBp !== undefined ? patch.discountBp : draft.discount_bp,
        note: patch.note !== undefined ? patch.note : draft.note,
        validUntil: patch.validUntil !== undefined ? patch.validUntil : draft.valid_until
    };
    getDb().prepare(`
        UPDATE sale_drafts SET customer_name = ?, customer_phone = ?, cart_json = ?, discount_bp = ?,
            note = ?, valid_until = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
    `).run(next.customerName, next.customerPhone, next.cartJson, next.discountBp, next.note, next.validUntil, at, tenantId, draftId);
    return getDraft(tenantId, draftId);
}

function transition(tenantId, draftId, { toStatus, actorUserId, at }) {
    const draft = getDraft(tenantId, draftId);
    if (!draft) throw new Error(`No draft ${draftId} for this tenant.`);
    if (draft.status !== 'open') {
        throw new Error(`Draft ${draftId} is already ${draft.status}.`);
    }
    const db = getDb();
    if (toStatus === 'resumed') {
        db.prepare('UPDATE sale_drafts SET status = ?, resumed_at = ?, resumed_by_user_id = ?, updated_at = ? WHERE id = ?')
            .run('resumed', at, actorUserId, at, draftId);
    } else {
        db.prepare('UPDATE sale_drafts SET status = ?, discarded_at = ?, discarded_by_user_id = ?, updated_at = ? WHERE id = ?')
            .run('discarded', at, actorUserId, at, draftId);
    }
    return getDraft(tenantId, draftId);
}

/** Marks a draft resumed — loaded back into an active cart for completion. Terminal: a resumed draft is not editable again, the same way a filed invoice is not. */
export function resumeDraft(tenantId, draftId, actorUserId, at = Date.now()) {
    return transition(tenantId, draftId, { toStatus: 'resumed', actorUserId, at });
}

/** Marks a draft discarded — abandoned without ever being resumed. */
export function discardDraft(tenantId, draftId, actorUserId, at = Date.now()) {
    return transition(tenantId, draftId, { toStatus: 'discarded', actorUserId, at });
}
