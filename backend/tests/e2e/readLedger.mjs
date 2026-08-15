/**
 * ==========================================================================
 * Reads one ledger collection out of a test tenant's database and prints it
 * to stdout as JSON, in the same wire shape the routes serve.
 *
 * WHY THIS EXISTS. Phase 29 (2026-08-15) moved the ledger into SQLite. A
 * seeded install still has `sales_2026.json`, `advances.json` and the rest on
 * disk — they are the importer's source on first boot — but nothing writes
 * them again. A spec reading one of those files was therefore asserting
 * against the SEED rather than against what the journey had just done, which
 * is precisely how 23 of the 43 journeys failed after the cut-over. They did
 * not fail loudly either: a stale file parses fine, so the assertion compared
 * two real-looking numbers and reported an arithmetic bug that did not exist.
 *
 * WHY A CHILD PROCESS. `connection.js` resolves `DB_FILE` from `DATA_DIR` once
 * at import and ESM caches the module, so a Playwright worker that ran two
 * tests would stay pinned to the FIRST test's database — and every later
 * assertion would silently read the wrong tenant. A fresh process per read has
 * no such memory. This is the same trap CLAUDE.md §8 documents for the Node
 * suites, arriving from a different direction; the fixture gives each test its
 * own `GOLD_POS_DATA_DIR`, and only a new process can honour that.
 *
 * WHY IT PROJECTS THROUGH THE REPOSITORIES. Re-deriving the legacy wire shape
 * here would be a second way to answer "what does a filed sale look like"
 * (§1, never a parallel third way), and it would drift from the routes the
 * moment either side changed. The service/repository helpers the routes
 * themselves call are the one way.
 * ==========================================================================
 */

const [, , dataDir, collection, argument = ''] = process.argv;

if (!dataDir || !collection) {
    console.error('usage: readLedger.mjs <dataDir> <collection> [argument]');
    process.exit(2);
}

/* Set BEFORE the first import that can reach db.js. A STATIC import here would
   already be too late — ESM hoists every `import` above this line (CLAUDE.md
   §8), which is why every import below is dynamic. */
process.env.GOLD_POS_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';

const repo = await import('../../repositories/index.js');
const saleService = await import('../../services/saleService.js');
const returnService = await import('../../services/returnService.js');

const { tenantId } = repo.dataStoreContext();

// Comfortably above anything a journey files, so a spec never has to reason
// about paging to answer "is it in the ledger".
const LIMIT = 500;

/* Everything the ledger holds UP TO NOW, newest first.
 *
 * The upper bound is not decoration. `seed.js` deliberately builds a second
 * trading year — `sales_2027.json` exists alongside `sales_2026.json` — so the
 * ledger contains rows dated after today. Ordered by `issued_at DESC` those
 * future rows sort to the front, and "the newest row" stops meaning "the row
 * this journey just filed": a spec asking for [0] got a seeded 2027 invoice
 * belonging to a seeded customer. Bounding the read at the current instant
 * makes the two the same thing again, without a spec having to know that the
 * seed spans two years. */
const toAt = Date.now();

const readers = {
    sales: () => saleService.projectSalesPage(
        repo.invoices.search({ tenantId, toAt, limit: LIMIT, offset: 0 }).rows
    ),
    returns: () => returnService.listReturns({ toAt, limit: LIMIT, offset: 0 }).results,
    advances: () => repo.advances.toLegacyAdvances(
        repo.advances.search({ tenantId, toAt, limit: LIMIT, offset: 0 }).rows
    ),
    // The full stored record, not publicAccountView() — a spec asserting that
    // a counter-issued account gained an email has to be able to see it.
    customerAccounts: () => repo.customers.loadAccounts(tenantId),
    paymentOrders: () => repo.payments.ordersForCustomer({
        tenantId, customerPhone: argument, limit: LIMIT, offset: 0
    }).rows.map(repo.payments.toLegacyOrder)
};

const reader = readers[collection];
if (!reader) {
    console.error(`unknown collection "${collection}" — expected one of: ${Object.keys(readers).join(', ')}`);
    process.exit(2);
}

process.stdout.write(JSON.stringify(reader()));

// Windows refuses to unlink a file with an open handle, and the fixture removes
// this tenant's directory the moment the test ends (CLAUDE.md §8).
repo.closeDb();
