/**
 * ==========================================================================
 * Named staff.
 *
 * Phase 2 owns real logins, RBAC and MFA. What Phase 1 needs from this table
 * is narrower and non-negotiable: `advance_entries` carries
 * `CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)`, so no money
 * claim can be posted anonymously — which means an approver row must exist
 * from the first insert, not from Phase 2 onward.
 *
 * This build authenticates one admin identity (a PIN, in adminAuth.js), so
 * exactly two bootstrap rows are seeded and both are marked with
 * `must_change_password = 1`:
 *
 *   owner   — the admin desk. Every admin-gated route posts as this user until
 *             Phase 2 replaces the PIN with per-cashier logins, at which point
 *             the desk supplies a real user id and this row becomes the
 *             shop owner's own account.
 *   system  — automation with no human at the keyboard: gateway-verified
 *             payments, the nightly jobs, the JSON importer. Separated from
 *             `owner` so an audit can tell "a person approved this" from "a
 *             signature verified and the machine posted it", which is exactly
 *             the distinction the manual-UPI control exists to make.
 *
 * Neither row has a password hash, so neither can be logged into. They are
 * accountability anchors, not credentials.
 * ==========================================================================
 */

import { getDb, inTransaction } from './connection.js';
import { newId } from '../db.js';

export const BOOTSTRAP_USERNAMES = { OWNER: 'owner', SYSTEM: 'system' };

/**
 * Seeds the two bootstrap identities if absent and returns their ids.
 * Idempotent — called on every boot.
 *
 * @param {string} tenantId
 * @param {string} branchId
 * @param {{ownerName?: string}} [profile]
 * @returns {{ownerUserId: string, systemUserId: string}}
 */
export function ensureBootstrapUsers(tenantId, branchId, profile = {}) {
    // Read first — see the note in ensureOrganisation(). Both rows exist on
    // every boot after the first, and discovering that must not cost the
    // database's write lock.
    const db = getDb();
    const existing = db.prepare(
        'SELECT username, id FROM users WHERE tenant_id = ? AND username IN (?, ?)'
    ).all(tenantId, BOOTSTRAP_USERNAMES.OWNER, BOOTSTRAP_USERNAMES.SYSTEM);

    if (existing.length === 2) {
        const byUsername = new Map(existing.map(row => [row.username, row.id]));
        return {
            ownerUserId: byUsername.get(BOOTSTRAP_USERNAMES.OWNER),
            systemUserId: byUsername.get(BOOTSTRAP_USERNAMES.SYSTEM)
        };
    }

    return inTransaction(db2 => ({
        ownerUserId: ensureUser(db2, tenantId, branchId, {
            username: BOOTSTRAP_USERNAMES.OWNER,
            fullName: profile.ownerName || 'Store Owner',
            role: 'owner'
        }),
        systemUserId: ensureUser(db2, tenantId, branchId, {
            username: BOOTSTRAP_USERNAMES.SYSTEM,
            fullName: 'Automated Process',
            role: 'owner'
        })
    }));
}

function ensureUser(db, tenantId, branchId, { username, fullName, role }) {
    const existing = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND username = ?')
        .get(tenantId, username);
    if (existing) return existing.id;

    const id = newId('USR');
    const now = Date.now();
    db.prepare(`
        INSERT INTO users (id, tenant_id, branch_id, full_name, username, role,
                           must_change_password, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(id, tenantId, branchId, fullName, username, role, now, now);
    return id;
}

/** One user by id, or null. */
export function findUserById(userId) {
    if (!userId) return null;
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) || null;
}

/** One user by username within a tenant, or null. */
export function findUserByUsername(tenantId, username) {
    return getDb().prepare('SELECT * FROM users WHERE tenant_id = ? AND username = ?')
        .get(tenantId, username) || null;
}

/**
 * Everyone entitled to approve a money claim — read through the `approvers`
 * view rather than by re-stating the role list, so the rule lives in exactly
 * one place (the schema) and a future role cannot gain approval rights by
 * being forgotten in a WHERE clause here.
 */
export function listApprovers(tenantId) {
    return getDb().prepare('SELECT * FROM approvers WHERE tenant_id = ? ORDER BY full_name').all(tenantId);
}

/** Whether this user may approve a money claim right now. */
export function isApprover(tenantId, userId) {
    if (!userId) return false;
    return Boolean(
        getDb().prepare('SELECT 1 FROM approvers WHERE tenant_id = ? AND id = ?').get(tenantId, userId)
    );
}
