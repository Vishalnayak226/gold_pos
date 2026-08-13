/**
 * ==========================================================================
 * Migration runner.
 *
 *   node backend/repositories/migrate.js [--status] [--dry-run]
 *
 * Applies every `migrations/NNN_name.sql` not yet recorded in
 * `schema_migrations`, in filename order, each inside its own transaction.
 * SQLite makes DDL transactional, so a migration that throws half-way leaves
 * the schema exactly as it was rather than partly upgraded.
 *
 * Two properties this deliberately has:
 *
 *   Idempotent. Running it twice applies nothing the second time. The server
 *   calls it on boot, so a tenant install upgrades itself by restarting.
 *
 *   Tamper-evident. Each applied migration's SHA-256 is stored. Editing a
 *   migration that has already run on a live database is refused loudly,
 *   because the file no longer describes what is actually on disk — the
 *   correct move is always a new migration, never an edit to an old one.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getDb, inTransaction, DB_FILE } from './connection.js';
import { logError, logTelemetry } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILENAME_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

function ensureMigrationsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            checksum    TEXT NOT NULL,
            applied_at  INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL DEFAULT 0
        ) STRICT
    `);
}

/** Every migration on disk, in application order. */
export function discoverMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];

    const found = fs.readdirSync(MIGRATIONS_DIR)
        .filter(name => name.endsWith('.sql'))
        .map(filename => {
            const match = FILENAME_PATTERN.exec(filename);
            if (!match) {
                throw new Error(
                    `Migration filename "${filename}" is not NNN_snake_case_name.sql. ` +
                    'Ordering is by the numeric prefix, so an unparseable name has no defined position.'
                );
            }
            const filepath = path.join(MIGRATIONS_DIR, filename);
            const sql = fs.readFileSync(filepath, 'utf8');
            return {
                version: Number(match[1]),
                name: match[2],
                filename,
                filepath,
                sql,
                checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
            };
        })
        .sort((a, b) => a.version - b.version);

    const seen = new Set();
    for (const migration of found) {
        if (seen.has(migration.version)) {
            throw new Error(`Two migrations share version ${migration.version}; versions must be unique.`);
        }
        seen.add(migration.version);
    }
    return found;
}

function appliedMigrations(db) {
    return db.prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
        .all();
}

/**
 * Reports what is applied, what is pending, and whether anything has drifted,
 * without changing the database.
 */
export function migrationStatus() {
    const db = getDb();
    ensureMigrationsTable(db);

    const onDisk = discoverMigrations();
    const applied = new Map(appliedMigrations(db).map(row => [row.version, row]));

    const drifted = [];
    const pending = [];
    for (const migration of onDisk) {
        const record = applied.get(migration.version);
        if (!record) {
            pending.push(migration);
        } else if (record.checksum !== migration.checksum) {
            drifted.push({ ...migration, appliedChecksum: record.checksum });
        }
    }

    const orphaned = [...applied.values()]
        .filter(row => !onDisk.some(migration => migration.version === row.version));

    return { onDisk, applied: [...applied.values()], pending, drifted, orphaned };
}

/**
 * Applies every pending migration.
 *
 * @param {{ dryRun?: boolean, log?: (message: string) => void }} [options]
 * @returns {{ applied: string[], alreadyCurrent: boolean }}
 */
export function runMigrations({ dryRun = false, log = () => {} } = {}) {
    const db = getDb();
    ensureMigrationsTable(db);

    const { pending, drifted, orphaned } = migrationStatus();

    if (drifted.length > 0) {
        const detail = drifted.map(m => `  ${m.filename} (recorded ${m.appliedChecksum.slice(0, 12)}…, on disk ${m.checksum.slice(0, 12)}…)`).join('\n');
        throw new Error(
            'Refusing to migrate: a migration that has already been applied has been edited since.\n' +
            `${detail}\n` +
            'The database on disk no longer matches the file. Revert the edit and add a new migration instead.'
        );
    }

    if (orphaned.length > 0) {
        // Not fatal: this is what a rollback to an older build looks like, and
        // refusing to boot would turn a recoverable deploy into an outage.
        logError(
            `Database has ${orphaned.length} migration(s) applied that this build does not ship: ` +
            orphaned.map(row => `${row.version}_${row.name}`).join(', ') +
            '. This build is older than the database it opened.'
        );
    }

    if (pending.length === 0) {
        log(`Schema is current (${DB_FILE}).`);
        return { applied: [], alreadyCurrent: true };
    }

    if (dryRun) {
        log(`${pending.length} migration(s) pending:`);
        for (const migration of pending) log(`  ${migration.filename}`);
        return { applied: [], alreadyCurrent: false };
    }

    const applied = [];
    for (const migration of pending) {
        const started = Date.now();
        try {
            inTransaction(db2 => {
                db2.exec(migration.sql);
                db2.prepare(
                    'INSERT INTO schema_migrations (version, name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, ?, ?)'
                ).run(migration.version, migration.name, migration.checksum, Date.now(), Date.now() - started);
            });
        } catch (err) {
            logError(`Migration ${migration.filename} failed and was rolled back: ${err.message}`, err.stack);
            throw new Error(`Migration ${migration.filename} failed: ${err.message}`);
        }

        const duration = Date.now() - started;
        applied.push(migration.filename);
        log(`  applied ${migration.filename} (${duration} ms)`);
        logTelemetry('SCHEMA_MIGRATION_APPLIED', duration, migration.filename);
    }

    return { applied, alreadyCurrent: false };
}

/* -------------------------------------------------------------------------- */

const invokedDirectly = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const args = new Set(process.argv.slice(2));
    try {
        if (args.has('--status')) {
            const { applied, pending, drifted, orphaned } = migrationStatus();
            console.log(`Database: ${DB_FILE}`);
            console.log(`Applied:  ${applied.length}`);
            for (const row of applied) console.log(`  ✔ ${String(row.version).padStart(3, '0')}_${row.name}`);
            console.log(`Pending:  ${pending.length}`);
            for (const row of pending) console.log(`  … ${row.filename}`);
            if (drifted.length) console.log(`Drifted:  ${drifted.map(m => m.filename).join(', ')}`);
            if (orphaned.length) console.log(`Orphaned: ${orphaned.map(r => `${r.version}_${r.name}`).join(', ')}`);
        } else {
            const result = runMigrations({ dryRun: args.has('--dry-run'), log: message => console.log(message) });
            if (!args.has('--dry-run') && result.applied.length > 0) {
                console.log(`\n✅ ${result.applied.length} migration(s) applied.`);
            }
        }
    } catch (err) {
        console.error(`\n❌ ${err.message}`);
        process.exit(1);
    }
}
