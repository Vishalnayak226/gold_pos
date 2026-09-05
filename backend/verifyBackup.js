#!/usr/bin/env node
/**
 * ============================================================================
 *  RESTORE VERIFICATION — proving a backup is a backup
 * ============================================================================
 *
 *   node verifyBackup.js [--backup <dir>] [--keep] [--quiet]
 *
 * Restores a snapshot into a throwaway directory and interrogates it. With no
 * --backup it picks the most recent snapshot under `backups/`, which is the
 * form the nightly job and the monthly drill both use.
 *
 * WHY THIS EXISTS.
 *
 * "We take nightly backups" is a statement about a cron job. It says nothing
 * about whether those files can be turned back into a working shop, and the
 * usual way to find out is during the outage. Every failure mode below is one
 * this codebase can actually produce:
 *
 *   - a snapshot copied while the WAL held committed transactions, so the
 *     ledger is real but missing the last hour of sales;
 *   - a snapshot from before a migration, restored onto a newer build;
 *   - a settings.json whose secrets were sealed with a key that no longer
 *     exists anywhere, making the install unopenable rather than merely stale;
 *   - a truncated or half-copied file that parses far enough to look fine.
 *
 * The last one is why this reads the ledger through SQLite's own integrity
 * check rather than checking that files exist.
 *
 * IT NEVER TOUCHES THE LIVE INSTALL. Everything happens in a temp directory
 * that is removed on the way out unless --keep is passed.
 *
 * Exit code is 0 only if every check passes, so this is usable as a scheduled
 * job and as the evidence step of the monthly restore drill
 * (docs/RUNBOOKS.md — "Monthly restore drill").
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveKey } from './secretVault.js';
import { decryptFile, ENCRYPTED_EXTENSION } from './backupCrypto.js';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
};

const quiet = has('--quiet');
const say = (line = '') => { if (!quiet) console.log(line); };

const results = [];
function record(ok, label, detail = '') {
    results.push({ ok, label, detail });
    say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ---------------------------------------------------------------------------
   Pick the snapshot
   --------------------------------------------------------------------------- */

// Same override convention as backupEngine.js's BACKUPS_DIR and alerting.js's
// backupsDirPath() — must match exactly, since this picks among what that
// module writes. Falling back to a plain process.cwd()-relative default meant
// an operator who redirects backups elsewhere had the post-backup restore
// drill silently checking the wrong (or a stale) location.
const backupsRoot = path.resolve(
    process.env.GOLD_POS_BACKUPS_DIR || process.env.GOLDPOS_BACKUPS_DIR || path.join(process.cwd(), 'backups')
);
let source = valueOf('--backup');

if (!source) {
    if (!fs.existsSync(backupsRoot)) {
        console.error(`\n  ERROR: no backups directory at ${backupsRoot}, and no --backup given.\n`);
        process.exit(1);
    }
    const snapshots = fs.readdirSync(backupsRoot)
        .filter(name => name.startsWith('backup_'))
        .map(name => ({ name, at: fs.statSync(path.join(backupsRoot, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    if (snapshots.length === 0) {
        console.error(`\n  ERROR: ${backupsRoot} holds no backup_* snapshots yet.\n`);
        process.exit(1);
    }
    source = path.join(backupsRoot, snapshots[0].name);
}

if (!fs.existsSync(source)) {
    console.error(`\n  ERROR: no such snapshot: ${source}\n`);
    process.exit(1);
}

const restoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-restore-'));
const restoreData = path.join(restoreRoot, 'data');
fs.mkdirSync(restoreData, { recursive: true });
const BACKUP_MANIFEST_FILE = 'backup_manifest.json';

say('\n  Restore verification');
say('  ' + '-'.repeat(64));
say(`  Snapshot   : ${source}`);
say(`  Restored to: ${restoreData}`);
say('');

/* ---------------------------------------------------------------------------
   Restore, then interrogate
   --------------------------------------------------------------------------- */

let repo = null;
try {
    const entries = fs.readdirSync(source);
    // Whole-archive encryption (backupCrypto.js) writes every file as
    // `<name>.enc`; decrypt those back to their original name here. A file
    // with no `.enc` suffix is copied as-is, which is what keeps a
    // pre-encryption snapshot still sitting on disk restoring exactly as it
    // did before (CLAUDE.md §1 — additive, backward-compatible).
    let vaultKey = null;
    let decryptError = null;
    for (const name of entries) {
        const from = path.join(source, name);
        if (!fs.statSync(from).isFile()) continue;
        if (name.endsWith(ENCRYPTED_EXTENSION)) {
            const originalName = name.slice(0, -ENCRYPTED_EXTENSION.length);
            try {
                if (!vaultKey) ({ key: vaultKey } = resolveKey(restoreData));
                decryptFile(from, path.join(restoreData, originalName), vaultKey, originalName);
            } catch (err) {
                decryptError = decryptError || err;
            }
        } else {
            fs.copyFileSync(from, path.join(restoreData, name));
        }
    }
    record(entries.length > 0, 'the snapshot contains files', `${entries.length} copied`);

    const wasEncrypted = entries.some(n => n.endsWith(ENCRYPTED_EXTENSION));
    if (wasEncrypted) {
        record(!decryptError, 'the encrypted archive decrypts with the current key',
            decryptError ? decryptError.message : 'every .enc file opened cleanly');
    }

    const restoredEntries = fs.readdirSync(restoreData);
    const manifestFile = path.join(restoreData, BACKUP_MANIFEST_FILE);
    let backupManifest = null;
    if (fs.existsSync(manifestFile)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
            const valid = manifest.formatVersion === 1
                && typeof manifest.createdAt === 'string'
                && typeof manifest.application?.version === 'string'
                && manifest.ledger?.engine === 'sqlite'
                && Array.isArray(manifest.migrations);
            record(valid, 'the backup self-description is valid', valid
                ? `format ${manifest.formatVersion}, app ${manifest.application.version}, ${manifest.migrations.length} migrations`
                : 'backup_manifest.json has an unsupported or incomplete shape');
            if (valid) backupManifest = manifest;
        } catch (error) {
            record(false, 'the backup self-description is readable', error.message);
        }
    } else {
        // Snapshots created before the manifest feature remain restorable.
        say('  ℹ backup self-description absent (legacy snapshot accepted)');
    }
    const dbName = restoredEntries.find(n => n.endsWith('.db'));
    record(Boolean(dbName), 'the snapshot contains the SQLite ledger',
        dbName || 'NO .db FILE — this snapshot cannot restore a ledger');
    if (!dbName) throw new Error('no ledger in snapshot');
    if (backupManifest) {
        record(backupManifest.ledger.filename === dbName,
            'the backup self-description names the restored ledger',
            backupManifest.ledger.filename === dbName
                ? dbName
                : `manifest: ${backupManifest.ledger.filename}, restored: ${dbName}`);
    }

    /* Point the data layer at the restored copy BEFORE importing it: db.js
       resolves DATA_DIR once at import and ESM caches the module, so a static
       import would pin this tool to the live directory (CLAUDE.md §8). */
    process.env.GOLD_POS_DATA_DIR = restoreData;
    process.env.GOLD_POS_LOGS_DIR = path.join(restoreRoot, 'logs');
    process.env.GOLD_POS_DISABLE_BOOTSTRAP = '1';
    repo = await import('./repositories/index.js');

    const db = repo.unsafeDatabaseHandle();

    // 1. Structural integrity. A half-copied or truncated file can still open
    //    and still answer simple queries; this is what actually catches it.
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityOk = String(integrity.integrity_check || '').toLowerCase() === 'ok';
    record(integrityOk, 'the restored ledger passes SQLite integrity_check',
        integrityOk ? '' : String(integrity.integrity_check));

    // 2. Migration state. A snapshot from before a migration restored onto a
    //    newer build is the quiet failure — it opens, it reads, and it is
    //    missing columns the running code expects.
    const status = repo.migrationStatus();
    const pending = Array.isArray(status && status.pending) ? status.pending : [];
    record(pending.length === 0, 'the restored ledger is fully migrated',
        pending.length === 0
            ? `${(status.applied || []).length} applied`
            : `PENDING: ${pending.join(', ')} — restore onto this build would migrate on first boot`);

    // 3. The books are actually there. An empty-but-valid database is a
    //    successful restore of nothing.
    const counts = {
        invoices: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
        invoiceLines: db.prepare('SELECT COUNT(*) n FROM invoice_lines').get().n,
        advanceEntries: db.prepare('SELECT COUNT(*) n FROM advance_entries').get().n,
        auditEvents: db.prepare('SELECT COUNT(*) n FROM audit_events').get().n
    };
    record(counts.invoices > 0 || counts.advanceEntries > 0,
        'the restored ledger holds business records',
        Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', '));

    // 4. Per-line figures still sum to their header. The invariant the money
    //    tests assert on a live database, re-asserted on the restored one —
    //    this is what separates "the file copied" from "the books survived".
    /* The allocation invariant, as CLAUDE.md §0 states it: each line carries its
       allocated share of the taxable value and the GST, and those shares sum
       exactly to the header. Checked against taxable and tax rather than the
       header total, because `total_amount_paise` has the redeemed advance taken
       off it and so is deliberately NOT the sum of the lines. */
    const drift = db.prepare(`
        SELECT i.invoice_number,
               i.taxable_amount_paise AS hdr_taxable,
               i.tax_amount_paise     AS hdr_tax,
               SUM(l.taxable_amount_paise) AS line_taxable,
               SUM(l.tax_amount_paise)     AS line_tax
          FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
      GROUP BY i.id
        HAVING line_taxable <> hdr_taxable OR line_tax <> hdr_tax
         LIMIT 5
    `).all();
    record(drift.length === 0, 'every restored invoice still sums to its own lines',
        drift.length === 0
            ? ''
            : `${drift.length} invoice(s) drifted, e.g. ${drift[0].invoice_number} ` +
              `(header ${drift[0].hdr_taxable}+${drift[0].hdr_tax}, lines ${drift[0].line_taxable}+${drift[0].line_tax})`);

    // 5. The audit chain survived the copy.
    const context = repo.dataStoreContext();
    const chain = repo.audit.verifyChain(context.tenantId);
    record(chain.ok, 'the restored audit chain verifies',
        chain.ok
            ? `head ${String(chain.head).slice(0, 16)}…, ${chain.checked} event(s)`
            : `broken at chain_seq ${chain.brokenAt.chainSeq}: ${chain.brokenAt.reason}`);

    // 6. Can the restored settings actually be OPENED? This is the check that
    //    distinguishes a usable restore from a locked one: the snapshot holds
    //    ciphertext and never the key, by design, so a restore on a host
    //    without GOLD_POS_SECRET_KEY yields an install nobody can log into.
    const settingsFile = path.join(restoreData, 'settings.json');
    if (!fs.existsSync(settingsFile)) {
        record(false, 'the snapshot contains settings.json', 'MISSING — the install would boot with defaults');
    } else {
        const { readSettings } = await import('./settingsStore.js');
        try {
            const restored = readSettings(restoreData);
            const sealedOnDisk = /encv1\$/.test(fs.readFileSync(settingsFile, 'utf8'));
            record(true, 'the restored settings decrypt with the current key',
                sealedOnDisk ? 'secrets were encrypted at rest and opened cleanly' : 'settings are still plaintext (pre-vault snapshot)');
            record(Boolean(restored.companyName), 'the restored settings carry the store identity',
                restored.companyName || 'no companyName');
        } catch (error) {
            record(false, 'the restored settings decrypt with the current key',
                `${error.message.split('.')[0]} — this snapshot needs the key it was sealed with`);
        }
    }
} catch (error) {
    record(false, 'restore completed without throwing', error.message);
} finally {
    try { if (repo) repo.closeDb(); } catch { /* never opened */ }
    if (has('--keep')) {
        say(`\n  --keep: restored copy left at ${restoreRoot}`);
    } else {
        /* Close before removing: Windows refuses to unlink a file with an open
           handle, and the resulting EPERM would replace the real result above. */
        try { fs.rmSync(restoreRoot, { recursive: true, force: true }); } catch (err) {
            say(`\n  [cleanup] could not remove ${restoreRoot}: ${err.message}`);
        }
    }
}

const failed = results.filter(r => !r.ok);
say('');
say('  ' + '-'.repeat(64));
if (failed.length === 0) {
    say(`  RESTORE VERIFIED — ${results.length} checks passed.`);
    say('  This snapshot can be turned back into a working install.');
} else {
    // Failure detail is printed even under --quiet: quiet mode exists to keep
    // a clean-pass cron log short, not to hide the one thing a monthly restore
    // drill exists to surface. A silent, undiagnosable failure here is worse
    // than a noisy one.
    console.error(`  RESTORE NOT VERIFIED — ${failed.length} of ${results.length} checks failed:`);
    for (const f of failed) console.error(`    - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
}
say('');

process.exitCode = failed.length === 0 ? 0 : 1;
