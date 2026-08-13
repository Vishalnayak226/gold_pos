/**
 * ==========================================================================
 * Tenants and branches.
 *
 * Deployment is one process and one database file per tenant, so in practice
 * this table holds exactly one row. It exists anyway because `tenant_id` is on
 * every financial row: when ADR-001's revisit trigger fires and the ledger
 * moves to a shared PostgreSQL, the difference between a migration and a
 * rewrite is whether that column was there from the first insert.
 *
 * `ensureOrganisation()` is idempotent and is called on every boot, so a fresh
 * install and an upgrade take the same path.
 * ==========================================================================
 */

import { getDb, inTransaction } from './connection.js';
import { newId } from '../db.js';

/**
 * The single tenant this database belongs to, creating it on first boot.
 *
 * The name/GST come from settings.json — configuration stays JSON per the §0
 * posture, and this copies the identifying fields onto the ledger side so an
 * exported invoice is self-describing. Later edits in Settings flow through on
 * the next boot rather than rewriting history: an invoice already issued keeps
 * the header it was issued under, which is what the tenant row does NOT
 * control (invoices carry their own printed header) — this is organisation
 * identity, not invoice text.
 *
 * @param {{name?: string, gstNumber?: string, branchName?: string,
 *          address?: string, phone?: string}} [profile]
 * @returns {{tenantId: string, branchId: string}}
 */
export function ensureOrganisation(profile = {}) {
    /* READ FIRST, and only take the write lock if something is actually
       missing. This runs on every boot, and `inTransaction` opens with
       BEGIN IMMEDIATE — so without this fast path every restart acquires the
       database's write lock purely to discover that the tenant it is looking
       for has existed for months. Harmless with one process; with several
       starting at once (a redeploy, the backup job, a test fleet) they queue
       on that lock and the slowest can exceed busy_timeout and fail to boot.
       Nothing here needs to be written on the common path, so nothing is. */
    const db = getDb();
    const existingTenant = db.prepare('SELECT * FROM tenants ORDER BY created_at LIMIT 1').get();
    if (existingTenant) {
        const existingBranch = db
            .prepare('SELECT * FROM branches WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
            .get(existingTenant.id);
        const unchanged = existingBranch
            && (!profile.name || profile.name === existingTenant.name)
            && (!profile.gstNumber || profile.gstNumber === existingTenant.gst_number)
            && (!profile.address || profile.address === existingBranch.address)
            && (!profile.phone || profile.phone === existingBranch.phone);
        if (unchanged) {
            return { tenantId: existingTenant.id, branchId: existingBranch.id };
        }
    }

    return inTransaction(() => {
        const now = Date.now();
        let tenant = db.prepare('SELECT * FROM tenants ORDER BY created_at LIMIT 1').get();

        if (!tenant) {
            const id = newId('TEN');
            db.prepare(
                'INSERT INTO tenants (id, name, gst_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
            ).run(id, profile.name || 'Gold POS', profile.gstNumber || null, now, now);
            tenant = { id };
        } else if (profile.name || profile.gstNumber) {
            db.prepare(
                'UPDATE tenants SET name = COALESCE(?, name), gst_number = COALESCE(?, gst_number), updated_at = ? WHERE id = ?'
            ).run(profile.name || null, profile.gstNumber || null, now, tenant.id);
        }

        let branch = db.prepare('SELECT * FROM branches WHERE tenant_id = ? ORDER BY created_at LIMIT 1')
            .get(tenant.id);

        if (!branch) {
            const id = newId('BRN');
            db.prepare(
                'INSERT INTO branches (id, tenant_id, name, address, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(id, tenant.id, profile.branchName || 'Main Counter',
                profile.address || null, profile.phone || null, now, now);
            branch = { id };
        } else if (profile.address || profile.phone) {
            db.prepare(
                'UPDATE branches SET address = COALESCE(?, address), phone = COALESCE(?, phone), updated_at = ? WHERE id = ?'
            ).run(profile.address || null, profile.phone || null, now, branch.id);
        }

        return { tenantId: tenant.id, branchId: branch.id };
    });
}

/** The tenant row, or null on a database that has never booted. */
export function getTenant() {
    return getDb().prepare('SELECT * FROM tenants ORDER BY created_at LIMIT 1').get() || null;
}

/** Every branch of the tenant, oldest first. */
export function listBranches(tenantId) {
    return getDb().prepare('SELECT * FROM branches WHERE tenant_id = ? ORDER BY created_at').all(tenantId);
}
