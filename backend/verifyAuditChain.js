#!/usr/bin/env node
/**
 * ============================================================================
 *  AUDIT CHAIN VERIFICATION
 * ============================================================================
 *
 *   node verifyAuditChain.js [--data-dir <dir>] [--expect-head <sha256hex>]
 *
 * Walks the tenant's audit chain, recomputes every hash, and reports the first
 * place the trail disagrees with itself. Exits non-zero when it does, so it can
 * be run from a scheduled job or a restore drill and actually fail something.
 *
 * WHY --expect-head IS THE FLAG THAT MATTERS.
 *
 * Running this alone answers "is the chain internally consistent?", and a chain
 * that lives in the same file as the data can always be made consistent by
 * whoever holds that file: edit a row, recompute every hash after it, done.
 *
 * `--expect-head` answers the question that actually matters in a dispute:
 * "is this the same history as the copy taken on the 3rd?" Take the `headHash`
 * from an export made earlier — one that has left the building — and pass it
 * here. A re-hashed chain cannot reproduce it.
 *
 * The workflow this is built for is in docs/RUNBOOKS.md — "Proving the audit
 * trail has not been altered".
 */

import path from 'path';

const args = process.argv.slice(2);
const valueOf = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
};

const dataDir = valueOf('--data-dir') || process.env.GOLD_POS_DATA_DIR;
if (dataDir) process.env.GOLD_POS_DATA_DIR = path.resolve(dataDir);

/* Dynamic, and after the env assignment above: db.js resolves DATA_DIR once at
   import and ESM caches the module, so a static import here would pin this tool
   to whatever directory it was started from (CLAUDE.md §8). */
const repo = await import('./repositories/index.js');

try {
    const context = repo.dataStoreContext();
    const result = repo.audit.verifyChain(context.tenantId);
    const expected = valueOf('--expect-head');

    console.log('\n  Audit chain verification');
    console.log('  ' + '-'.repeat(62));
    console.log(`  Data directory        : ${process.env.GOLD_POS_DATA_DIR || '(default)'}`);
    console.log(`  Events in chain       : ${result.checked}`);
    console.log(`  Events predating chain: ${result.unchained}${result.unchained > 0 ? '  (not covered — written before migration 005)' : ''}`);
    console.log(`  Internally consistent : ${result.ok ? 'YES' : 'NO'}`);
    console.log(`  Head hash             : ${result.head || '(none)'}`);

    let failed = false;

    if (!result.ok) {
        failed = true;
        console.log('\n  BROKEN AT');
        console.log(`    chain_seq : ${result.brokenAt.chainSeq}`);
        console.log(`    event id  : ${result.brokenAt.id}`);
        console.log(`    reason    : ${result.brokenAt.reason}`);
    }

    if (expected) {
        const matches = expected.trim().toLowerCase() === String(result.head).toLowerCase();
        console.log(`\n  Expected head         : ${expected.trim()}`);
        console.log(`  Matches published head: ${matches ? 'YES' : 'NO'}`);
        if (!matches) {
            failed = true;
            console.log(
                '\n  The chain does not match the head hash you supplied. Either this is a\n' +
                '  different install, the export you took it from is newer or older than this\n' +
                '  database, or the trail has been rewritten since that export was made.'
            );
        }
    } else if (result.ok) {
        console.log(
            '\n  NOTE: this checked the chain against ITSELF only. That cannot detect an\n' +
            '  edit where every following hash was recomputed too. Re-run with\n' +
            '  --expect-head <hash from an earlier export> to close that gap.'
        );
    }

    console.log('');
    process.exitCode = failed ? 1 : 0;
} catch (error) {
    console.error(`\n  ERROR: ${error.message}\n`);
    process.exitCode = 1;
} finally {
    try { repo.closeDb(); } catch { /* nothing opened */ }
}
