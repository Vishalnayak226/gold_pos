/**
 * ==========================================================================
 * Customers and their portal sessions.
 *
 * `customerAuth.js` funnels every read and write through exactly two private
 * functions, `readAccounts()` and `writeAccounts()`. That choke point is what
 * makes this cut-over a two-function change instead of a rewrite of 600 lines
 * of scrypt, lockout and reset-token logic — so this module deliberately
 * speaks the SAME account shape that customer_auth.json held, and translates
 * to columns on the way in and out.
 *
 *   { phone, name, email, passwordHash, salt, mustChangePassword,
 *     notifyEmail, notifyPush, resetTokenHash, resetExpires, resetAttempts,
 *     failedAttempts, lockedUntil, sessions: [{tokenHash, createdAt}],
 *     createdAt, updatedAt }
 *
 * Nothing above this file knows the shape changed, which is the point of the
 * seam ADR-001 §3 asks for.
 *
 * ROWS ARE NEVER DELETED HERE. `saveAccounts()` takes the whole set and
 * upserts it, but does not remove customers missing from the array: invoices,
 * credit notes and advance accounts hold foreign keys onto this table, and a
 * caller passing a filtered array (nobody does today) must not be able to
 * silently orphan a ledger. Deactivation, when Phase 2 needs it, is a flag.
 * ==========================================================================
 */

import { getDb, inTransaction } from './connection.js';
import { newId, logError } from '../db.js';

/** Session lifetime, mirrored from customerAuth.js so expiry is stored. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function toAccount(row, sessions) {
    return {
        phone: row.phone,
        name: row.full_name || '',
        email: row.email || '',
        passwordHash: row.password_hash || null,
        salt: row.password_salt || null,
        mustChangePassword: row.must_change_password === 1,
        notifyEmail: row.notify_email === 1,
        notifyPush: row.notify_push === 1,
        resetTokenHash: row.reset_token_hash || null,
        resetExpires: row.reset_expires_at || 0,
        resetAttempts: row.reset_attempts || 0,
        failedAttempts: row.failed_attempts || 0,
        lockedUntil: row.locked_until_at || 0,
        sessions,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

/** Every account, with live sessions attached, in creation order. */
export function loadAccounts(tenantId) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM customers WHERE tenant_id = ? ORDER BY created_at').all(tenantId);
    if (rows.length === 0) return [];

    const sessions = db.prepare(`
        SELECT customer_id, token_hash, issued_at
          FROM customer_sessions
         WHERE revoked_at IS NULL AND expires_at > ?
         ORDER BY issued_at
    `).all(Date.now());

    const byCustomer = new Map();
    for (const session of sessions) {
        if (!byCustomer.has(session.customer_id)) byCustomer.set(session.customer_id, []);
        byCustomer.get(session.customer_id).push({
            tokenHash: session.token_hash,
            createdAt: session.issued_at
        });
    }

    return rows.map(row => toAccount(row, byCustomer.get(row.id) || []));
}

/**
 * Persists the whole account set as one transaction — the same all-or-nothing
 * guarantee `writeJSON` gave by writing a single file, now without the
 * rewrite-the-world cost being load-bearing.
 *
 * @returns {boolean} false on failure, matching writeAccounts()'s contract so
 *                    customerAuth.js's existing error handling still applies.
 */
export function saveAccounts(tenantId, accounts) {
    try {
        inTransaction(db => {
            for (const account of accounts || []) {
                if (!account || !account.phone) continue;
                const customerId = upsertCustomer(db, tenantId, account);
                replaceSessions(db, customerId, account.sessions || []);
            }
        });
        return true;
    } catch (err) {
        // Surfaced by the caller, which already logs and refuses the operation.
        logError(`Failed to persist customer accounts: ${err.message}`, err.stack);
        return false;
    }
}

function upsertCustomer(db, tenantId, account) {
    const now = Date.now();
    const existing = db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND phone = ?')
        .get(tenantId, account.phone);

    const values = [
        String(account.name || '').slice(0, 200),
        account.email ? String(account.email).slice(0, 200) : null,
        account.passwordHash || null,
        account.salt || null,
        account.mustChangePassword ? 1 : 0,
        account.notifyEmail === false ? 0 : 1,
        account.notifyPush ? 1 : 0,
        account.resetTokenHash || null,
        Math.trunc(Number(account.resetExpires) || 0),
        Math.trunc(Number(account.resetAttempts) || 0),
        Math.trunc(Number(account.failedAttempts) || 0),
        Math.trunc(Number(account.lockedUntil) || 0),
        Math.trunc(Number(account.updatedAt) || now)
    ];

    if (existing) {
        db.prepare(`
            UPDATE customers
               SET full_name = ?, email = ?, password_hash = ?, password_salt = ?,
                   must_change_password = ?, notify_email = ?, notify_push = ?,
                   reset_token_hash = ?, reset_expires_at = ?, reset_attempts = ?,
                   failed_attempts = ?, locked_until_at = ?, updated_at = ?
             WHERE id = ?
        `).run(...values, existing.id);
        return existing.id;
    }

    const id = newId('CUS');
    db.prepare(`
        INSERT INTO customers (id, tenant_id, phone, full_name, email, password_hash, password_salt,
                               must_change_password, notify_email, notify_push, reset_token_hash,
                               reset_expires_at, reset_attempts, failed_attempts, locked_until_at,
                               created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, tenantId, account.phone, values[0], values[1], values[2], values[3],
        values[4], values[5], values[6], values[7], values[8], values[9], values[10], values[11],
        Math.trunc(Number(account.createdAt) || now), values[12]
    );
    return id;
}

/**
 * Makes the stored session set match the account's array exactly.
 *
 * Revocation is a hard delete rather than a `revoked_at` stamp because
 * customerAuth.js's contract is "the array IS the live set" — a logout drops
 * the entry, and a password change empties it. Keeping tombstones would grow
 * without bound and change what "5 sessions per account" means.
 */
function replaceSessions(db, customerId, sessions) {
    const wanted = new Map();
    for (const session of sessions) {
        if (session && session.tokenHash) wanted.set(session.tokenHash, session);
    }

    const existing = db.prepare('SELECT id, token_hash FROM customer_sessions WHERE customer_id = ?')
        .all(customerId);

    for (const row of existing) {
        if (!wanted.has(row.token_hash)) {
            db.prepare('DELETE FROM customer_sessions WHERE id = ?').run(row.id);
        } else {
            wanted.delete(row.token_hash);
        }
    }

    for (const session of wanted.values()) {
        const issuedAt = Math.trunc(Number(session.createdAt) || Date.now());
        db.prepare(`
            INSERT INTO customer_sessions (id, customer_id, token_hash, issued_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(newId('CSS'), customerId, session.tokenHash, issuedAt, issuedAt + SESSION_TTL_MS);
    }
}

/**
 * The customer id for a phone number, creating a bare (login-less) record if
 * none exists. A walk-in who has never used the portal still needs a row for
 * an invoice or an advance account to point at.
 */
export function ensureCustomerId(tenantId, phone, name = '') {
    if (!phone) return null;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND phone = ?').get(tenantId, phone);
    if (existing) return existing.id;

    const id = newId('CUS');
    const now = Date.now();
    db.prepare(`
        INSERT INTO customers (id, tenant_id, phone, full_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, phone, String(name || '').slice(0, 200) || 'Customer', now, now);
    return id;
}

/** One customer row by phone, or null. */
export function findByPhone(tenantId, phone) {
    return getDb().prepare('SELECT * FROM customers WHERE tenant_id = ? AND phone = ?')
        .get(tenantId, phone) || null;
}

/** How many customer records exist, including walk-ins with no portal login. */
export function countCustomers(tenantId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?').get(tenantId).n;
}

/**
 * How many customers can actually sign in to the portal.
 *
 * This — not `countCustomers()` — is what reconciles against
 * `customer_auth.json`, because that file held logins while this table also
 * holds a bare record for every walk-in an invoice or an advance points at. A
 * reconciliation line that compares the two is guaranteed to fail on any store
 * with a single cash customer, and would train the operator to ignore it.
 */
export function countCustomersWithLogin(tenantId) {
    return getDb().prepare(
        'SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ? AND password_hash IS NOT NULL'
    ).get(tenantId).n;
}
