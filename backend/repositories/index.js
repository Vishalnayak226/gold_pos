/**
 * ==========================================================================
 * The repository seam.
 *
 * ADR-001 §3: no SQL string appears above `backend/repositories/`. This module
 * is the front door — everything above imports from here, never from a
 * repository file directly and never from `connection.js`, so the day the
 * ledger moves to PostgreSQL the change stops at this directory.
 *
 * It also owns boot: `initialiseDataStore()` runs migrations, seeds the single
 * tenant and its branch, and caches the ids every write needs. Calling it is
 * idempotent, so a fresh install and a restart take the same path.
 * ==========================================================================
 */

import { getDb, inTransaction, inTransactionNow, backupTo, checkpointAndCopy, closeDb, DB_FILE } from './connection.js';
import { runMigrations, migrationStatus } from './migrate.js';
import { ensureOrganisation, getTenant, listBranches } from './organisationRepository.js';
import { ensureBootstrapUsers, BOOTSTRAP_USERNAMES } from './userRepository.js';
import { logTelemetry } from '../db.js';

export * as invoices from './invoiceRepository.js';
export * as creditNotes from './creditNoteRepository.js';
export * as advances from './advanceRepository.js';
export * as payments from './paymentRepository.js';
export * as customers from './customerRepository.js';
export * as users from './userRepository.js';
export * as rates from './rateRepository.js';
export * as sequences from './sequenceRepository.js';
export * as audit from './auditRepository.js';
export * as auditRetention from './auditRetentionRepository.js';
export * as oldGold from './oldGoldRepository.js';
export * as goldSchemes from './goldSchemeRepository.js';
export * as inventory from './inventoryRepository.js';
export * as cashShifts from './cashShiftRepository.js';
export * as saleDrafts from './saleDraftRepository.js';
export * as organisation from './organisationRepository.js';
export * as reports from './reportRepository.js';

export { inTransaction, inTransactionNow, backupTo, checkpointAndCopy, closeDb, DB_FILE, migrationStatus };
export { businessDate, financialYear, businessDateBounds, documentNumber } from './calendar.js';

/**
 * The ids every write needs, resolved once at boot.
 * @type {{tenantId: string, branchId: string, ownerUserId: string, systemUserId: string}|null}
 */
let context = null;

/**
 * Migrates the schema, seeds the organisation, and returns the boot context.
 *
 * @param {{name?: string, gstNumber?: string, address?: string, phone?: string}} [profile]
 *        identity copied from settings.json — configuration stays JSON (§0),
 *        this only mirrors the identifying fields onto the ledger side.
 * @param {{log?: (message: string) => void}} [options]
 */
export function initialiseDataStore(profile = {}, { log = () => {} } = {}) {
    const started = Date.now();

    const result = runMigrations({ log });
    if (result.applied.length > 0) {
        logTelemetry('DATA_STORE_MIGRATED', Date.now() - started, result.applied.join(', '));
    }

    const { tenantId, branchId } = ensureOrganisation(profile);
    const { ownerUserId, systemUserId } = ensureBootstrapUsers(tenantId, branchId, {
        ownerName: profile.name ? `${profile.name} (Owner)` : 'Store Owner'
    });

    context = { tenantId, branchId, ownerUserId, systemUserId };
    return context;
}

/**
 * The boot context, initialising on first use.
 *
 * Lazy rather than required-at-import so a test suite that only wants one
 * repository does not have to remember to boot first — and so the server's own
 * explicit `initialiseDataStore()` at startup stays the documented path rather
 * than a hidden import side effect.
 */
export function dataStoreContext() {
    if (!context) initialiseDataStore();
    return context;
}

/** Drops the cached context. Tests call this between fixtures; the server does not. */
export function resetDataStoreContext() {
    context = null;
}

/**
 * Why the ledger is or is not usable, in enough detail to act on.
 *
 * `GET /api/ready` needs to distinguish "the database file will not open" from
 * "it opens but this build ships a migration nobody has applied" — the first is
 * an outage, the second is a half-finished deploy, and an operator paged at
 * 2 a.m. should not have to guess which. `isDataStoreReady()` below is the same
 * probe collapsed to a boolean, so there is one implementation, not two.
 *
 * The database check is a real query (`getTenant()` reads a row) rather than a
 * handle null-check: a handle whose file has been deleted underneath it, or
 * whose disk has filled, still looks open.
 *
 * @returns {{ok: boolean, database: string, migrations: string, detail?: string}}
 */
export function dataStoreHealth() {
    let tenant;
    try {
        tenant = getTenant();
    } catch (err) {
        return { ok: false, database: 'unreachable', migrations: 'unknown', detail: err.message };
    }
    if (!tenant) {
        return { ok: false, database: 'ok', migrations: 'unknown', detail: 'no organisation row — the store has never been initialised' };
    }

    try {
        const { pending, drifted } = migrationStatus();
        if (drifted.length > 0) {
            return {
                ok: false, database: 'ok', migrations: 'drifted',
                detail: `${drifted.length} applied migration(s) no longer match the files on disk`
            };
        }
        if (pending.length > 0) {
            return {
                ok: false, database: 'ok', migrations: 'pending',
                detail: `${pending.length} migration(s) not applied: ${pending.map(m => m.filename).join(', ')}`
            };
        }
    } catch (err) {
        return { ok: false, database: 'ok', migrations: 'unknown', detail: err.message };
    }

    return { ok: true, database: 'ok', migrations: 'current' };
}

/** Whether the schema has been migrated and an organisation exists. */
export function isDataStoreReady() {
    return dataStoreHealth().ok;
}

export { getDb as unsafeDatabaseHandle, getTenant, listBranches, BOOTSTRAP_USERNAMES };
