/**
 * ==========================================================================
 * SQLite connection management — the single place a database handle is opened.
 *
 * ADR-001 chose SQLite via the stdlib `node:sqlite` over PostgreSQL, on the
 * condition that no SQL leaks above `backend/repositories/`. This module and
 * the repositories beside it are the only code permitted to hold a handle.
 *
 * One database file per tenant, mirroring the one-process-per-tenant
 * deployment in deploy/README.md. `GOLD_POS_DATA_DIR` still selects the
 * directory, so every test suite keeps its existing isolation for free.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, logError, logTelemetry } from '../db.js';

export const DB_FILE = path.join(DATA_DIR, 'gold-pos.db');

/** @type {DatabaseSync|null} */
let handle = null;

/**
 * PRAGMAs, and why each one is not optional here.
 *
 *   journal_mode = WAL      Readers never block the writer and vice versa. The
 *                           reporting screens read while the desk is billing.
 *   foreign_keys = ON       SQLite defaults this OFF, per connection. Every
 *                           referential guarantee in the schema is inert
 *                           without it, so it is set before anything runs.
 *   busy_timeout = 5000     A second writer waits rather than instantly
 *                           throwing SQLITE_BUSY. Backup and the nightly
 *                           report job are exactly that second writer.
 *   synchronous = FULL      NORMAL can lose the last transaction on power
 *                           loss. This is a money ledger on a shop counter
 *                           where someone will pull the plug; the write-rate
 *                           cost is irrelevant at POS volumes.
 *   trusted_schema = OFF    Refuses to run schema-embedded code. Defence in
 *                           depth against a tampered database file.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * ORDER MATTERS, and `busy_timeout` MUST come first.
 *
 * Switching a database into WAL takes a brief EXCLUSIVE lock. If a second
 * process opens the file during that window and has no busy timeout set yet,
 * its `journal_mode = WAL` fails instantly with SQLITE_BUSY — and because that
 * happens during open, the handle is never usable and the process dies before
 * it has done anything. Setting the timeout first means the second process
 * waits for the first to finish instead.
 *
 * That is not a theoretical ordering nicety: it is a redeploy where the new
 * process starts before the old one has exited, a `npm run migrate` run by
 * hand while the counter is billing, or the backup job opening on the hour.
 * Caught by test_concurrency.js, which failed roughly one run in three until
 * the timeout moved to the top of this list.
 */
const PRAGMAS = [
    `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`,
    'PRAGMA journal_mode = WAL',
    'PRAGMA foreign_keys = ON',
    'PRAGMA synchronous = FULL',
    'PRAGMA trusted_schema = OFF'
];

/**
 * Opens (once) and returns the process-wide database handle.
 * @returns {DatabaseSync}
 */
export function getDb() {
    if (handle) return handle;

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    try {
        // `timeout` applies the busy handler from the moment the file is
        // opened, covering the lock acquisition that happens before any PRAGMA
        // of ours can run. Passed through a capability check because it is a
        // newer node:sqlite option and this must not become the reason an
        // older Node cannot boot — the PRAGMA below is the floor either way.
        try {
            handle = new DatabaseSync(DB_FILE, { timeout: BUSY_TIMEOUT_MS });
        } catch (optionErr) {
            if (!/timeout/i.test(String(optionErr.message))) throw optionErr;
            handle = new DatabaseSync(DB_FILE);
        }
        for (const pragma of PRAGMAS) handle.exec(pragma);
    } catch (err) {
        logError(`Could not open the SQLite database at ${DB_FILE}: ${err.message}`, err.stack);
        throw err;
    }

    return handle;
}

/**
 * Runs `fn` inside one transaction, committing on return and rolling back on
 * any throw. **This is the only correct way to write more than one row.**
 *
 * Nesting is handled with SAVEPOINT so that a service composed of two smaller
 * services still commits as one unit — the caller nearest the route decides
 * the transaction boundary, and the inner ones join it rather than committing
 * early. Without this, "one ACID transaction per sale" quietly becomes four.
 *
 * @template T
 * @param {(db: DatabaseSync) => T} fn
 * @returns {T}
 */
let depth = 0;
export function inTransaction(fn) {
    const db = getDb();
    const isOutermost = depth === 0;
    const savepoint = `sp_${depth}`;

    db.exec(isOutermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    depth += 1;

    try {
        const result = fn(db);
        depth -= 1;
        db.exec(isOutermost ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
    } catch (err) {
        depth -= 1;
        try {
            db.exec(isOutermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
            if (!isOutermost) db.exec(`RELEASE ${savepoint}`);
        } catch (rollbackErr) {
            logError(`Rollback failed after a transaction error: ${rollbackErr.message}`, rollbackErr.stack);
        }
        throw err;
    }
}

/**
 * True while a transaction is open. Repositories assert on this rather than
 * trusting callers, so a multi-row write outside a transaction fails loudly in
 * tests instead of silently half-committing in production.
 */
export function inTransactionNow() {
    return depth > 0;
}

/**
 * Online, crash-consistent copy of the live database — safe to call while the
 * desk is billing, unlike a plain file copy of a WAL database, which can
 * capture a torn page set.
 *
 * `backupEngine.js` keeps working precisely because the target is one file.
 * @param {string} destination
 */
export async function backupTo(destination) {
    const db = getDb();
    const started = Date.now();
    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await db.backup(destination);
    logTelemetry('SQLITE_BACKUP', Date.now() - started, path.basename(destination));
    return destination;
}

/**
 * Synchronous, complete copy of the database to `destination`.
 *
 * WHY THE CHECKPOINT IS NOT OPTIONAL. In WAL mode a committed transaction can
 * live entirely in `gold-pos.db-wal` until SQLite checkpoints it back. A plain
 * `copyFileSync` of the main file therefore captures the database as of the
 * last checkpoint, silently omitting everything committed since — a backup
 * that looks fine, restores cleanly, and is missing the most recent trading.
 * `wal_checkpoint(TRUNCATE)` folds the log back into the main file and empties
 * it, after which the single-file copy is complete.
 *
 * Use this where a synchronous copy is required (the importer's pre-write
 * safety net). `backupTo()` above is the online, non-blocking equivalent for
 * callers that can await and that must not block a billing counter.
 *
 * Caught by test_repositories.js §12 — the rollback restored a database that
 * was missing rows imported moments earlier.
 *
 * @param {string} destination
 */
export function checkpointAndCopy(destination) {
    const db = getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

    const dir = path.dirname(destination);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(DB_FILE, destination);
    return destination;
}

/** Closes the handle. Tests call this between fixtures; the server does not. */
export function closeDb() {
    if (!handle) return;
    try {
        handle.close();
    } catch (err) {
        logError(`Failed to close the SQLite database: ${err.message}`, err.stack);
    } finally {
        handle = null;
        depth = 0;
    }
}
