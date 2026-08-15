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

/**
 * Resolves the `{id, name, role}` actor an admin session carries onto a `users`
 * row, creating or refreshing it, and returns that row's id.
 *
 * WHY THIS EXISTS. The operator roster is configuration — it lives in
 * `settings.json` under `operators[]`, seeded and hashed by `migratePinsToHashes()`
 * (§0), and it is not going to move into SQL. But the ledger's accountability
 * columns are foreign keys into `users`, and `advance_entries` additionally
 * carries `CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)`. Two
 * identity systems therefore have to meet somewhere, and this is the seam.
 *
 * WITHOUT IT THE APPROVAL CONTROL SILENTLY INVERTS. `advanceService` asks
 * `users.isApprover(tenantId, actorUserId)` before letting a claim post. The
 * services default `actorUserId` to `context.ownerUserId` when a route does not
 * supply one, and `owner` is an approver — so every cashier would have passed
 * the check that exists precisely to stop a cashier releasing money to
 * themselves. Mapping the real operator across is what makes the SQL control
 * enforce the same rule the JSON one did.
 *
 * THE ROW IS REFRESHED, NOT JUST CREATED. Demoting an operator from manager to
 * cashier in Settings has to reach the `approvers` view, or the demotion is
 * cosmetic and the old rights persist in the database that actually decides.
 * `username` is the operator's stable id, so a rename updates rather than
 * duplicates — and OWNER_ACTOR/SYSTEM_ACTOR land on the two bootstrap rows by
 * construction, since their ids are already 'owner' and 'system'.
 *
 * @param {string} tenantId
 * @param {string} branchId
 * @param {{id: string, name?: string, role?: string}} actor
 * @returns {string} the users.id to stamp on the ledger row
 */
export function ensureActorUser(tenantId, branchId, actor) {
    const username = String((actor && actor.id) || '').trim();
    if (!username) throw new Error('ensureActorUser() needs an actor with an id.');

    const fullName = String((actor && actor.name) || username).slice(0, 200);
    // An unrecognised role must never widen rights. 'cashier' is the floor:
    // it is outside the `approvers` view, so a corrupted or future role
    // degrades to "cannot approve" rather than to "can".
    const rawRole = String((actor && actor.role) || '').trim().toLowerCase();
    const role = ['owner', 'manager', 'cashier', 'auditor'].includes(rawRole) ? rawRole : 'cashier';

    const db = getDb();
    const existing = db.prepare('SELECT id, full_name, role, is_active FROM users WHERE tenant_id = ? AND username = ?')
        .get(tenantId, username);

    if (existing) {
        /* THE TWO BOOTSTRAP ROWS KEEP THE NAMES THE STORE PROFILE GAVE THEM.
           `owner` and `system` are seeded from settings by
           `ensureBootstrapUsers` ("HTTP Test Store (Owner)"), while the
           master-PIN session carries the generic label OWNER_ACTOR ("Store
           Owner"). Letting both write the column made the owner's display name
           flip on every sale — two sources of truth for one field, visible as a
           ledger row that changed without anything happening to it. The
           profile wins; only a real operator's name follows their roster entry. */
        const isBootstrap = username === BOOTSTRAP_USERNAMES.OWNER
            || username === BOOTSTRAP_USERNAMES.SYSTEM;
        const nextName = isBootstrap ? existing.full_name : fullName;

        // Only write when something actually moved — this runs on every
        // ledger-writing request, and an unconditional UPDATE would take the
        // write lock on every sale for no reason.
        if (existing.full_name !== nextName || existing.role !== role || existing.is_active !== 1) {
            db.prepare('UPDATE users SET full_name = ?, role = ?, is_active = 1, updated_at = ? WHERE id = ?')
                .run(nextName, role, Date.now(), existing.id);
        }
        return existing.id;
    }

    return ensureUser(db, tenantId, branchId, { username, fullName, role });
}

/**
 * Marks every user absent from the supplied operator roster inactive.
 *
 * Removing an operator from Settings must remove their approval rights, but
 * their `users` row cannot be deleted — invoices, advance entries and audit rows
 * all point at it, and an audit trail whose actor vanished is not an audit
 * trail. Deactivating drops them out of the `approvers` view while leaving every
 * historical reference intact.
 *
 * The two bootstrap identities are never touched: `system` posts webhook
 * credits and `owner` is the master-PIN identity, and neither appears in
 * `operators[]`.
 *
 * @param {string} tenantId
 * @param {string[]} activeUsernames operator ids still present in settings.json
 */
export function deactivateAbsentOperators(tenantId, activeUsernames) {
    const keep = new Set([
        BOOTSTRAP_USERNAMES.OWNER,
        BOOTSTRAP_USERNAMES.SYSTEM,
        ...(activeUsernames || []).map(name => String(name).trim()).filter(Boolean)
    ]);
    const rows = getDb().prepare('SELECT id, username FROM users WHERE tenant_id = ? AND is_active = 1')
        .all(tenantId);
    const stale = rows.filter(row => !keep.has(row.username));
    if (stale.length === 0) return 0;

    const statement = getDb().prepare('UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?');
    const now = Date.now();
    for (const row of stale) statement.run(now, row.id);
    return stale.length;
}

/**
 * The `{id, name, role}` actors behind a set of user ids, keyed by id.
 *
 * The inverse of `ensureActorUser`: `username` is the actor id an admin session
 * carries, so a ledger row's `created_by_user_id` projects back to exactly the
 * identity the desk has always read off `sale.actor` / `return.actor`.
 *
 * One query for a whole page — this is called once per list, never once per row.
 */
export function actorsByUserId(userIds) {
    const unique = [...new Set((userIds || []).filter(Boolean))];
    if (unique.length === 0) return new Map();
    const placeholders = unique.map(() => '?').join(', ');
    const rows = getDb().prepare(
        `SELECT id, username, full_name, role FROM users WHERE id IN (${placeholders})`
    ).all(...unique);
    return new Map(rows.map(row => [row.id, { id: row.username, name: row.full_name, role: row.role }]));
}

/** The single actor behind one user id, or null. */
export function actorForUserId(userId) {
    return actorsByUserId([userId]).get(userId) || null;
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
