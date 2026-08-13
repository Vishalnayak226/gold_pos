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
export * as organisation from './organisationRepository.js';

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

/** Whether the schema has been migrated and an organisation exists. */
export function isDataStoreReady() {
    try {
        const tenant = getTenant();
        return Boolean(tenant) && migrationStatus().pending.length === 0;
    } catch (_) {
        return false;
    }
}

export { getDb as unsafeDatabaseHandle, getTenant, listBranches, BOOTSTRAP_USERNAMES };
