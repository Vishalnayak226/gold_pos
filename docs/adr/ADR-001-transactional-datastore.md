# ADR-001 — Transactional datastore for the financial ledger

- **Status:** **Accepted 2026-08-11** — Option B, SQLite bridge behind repository interfaces
- **Date:** 2026-08-11
- **Decides:** `PRODUCTION_READINESS_ROADMAP.md` §8 owner decision 2, and Phase 1 checklist item 1
- **Supersedes on approval:** the "flat JSON files, no SQL, no ORM, no DB server" clause of `CLAUDE.md` §0

---

## 1. Context

Every domain currently persists as a flat JSON document under `backend/data/`, read and written
through `backend/db.js`. Eight files exist on a live install: `advances`, `customer_auth`,
`license`, `payment_events`, `payment_orders`, `rates`, `sales_<year>`, `settings`.

That layer is better than its reputation. `writeJSON()` is atomic via temp-file + rename with a
retry on Windows lock contention; `writeJSONTransaction()` commits a related set of documents as
one crash-recoverable unit with a journal replayed on boot; `newId()` is CSPRNG-backed. Phase 0
hardened it considerably.

What it structurally cannot give us is what Phase 1 exists to buy:

| Phase 1 requirement | Why JSON cannot satisfy it |
|---|---|
| Unique constraints (invoice scope, provider IDs, references, idempotency keys) | Enforced only by hand-written scans at each write path; correctness depends on nobody forgetting |
| One ACID transaction per sale | `writeJSONTransaction()` is all-or-nothing across *files*, but has no isolation — a reader mid-commit sees a torn view |
| Pagination and filtering everywhere | Every read is a full-file `JSON.parse`; a three-year ledger is parsed in full to render one page |
| Append-only advances with reserved funds | Requires row-level state transitions and locking, not whole-document rewrites |
| Concurrency + crash-injection tests | Current safety rests on Node's run-to-completion serializing handlers — true for one process, and only while no handler ever awaits |

That last row is the load-bearing one. The single-writer guarantee is an emergent property of the
current code shape, not an enforced invariant. One `await` added to a route handler in the middle
of a read-modify-write silently reintroduces lost updates, and no test would catch it.

### Inputs that narrow this decision

Two facts materially shrink the problem versus the roadmap's original framing:

1. **No SKU concept** (owner, 2026-08-11). The entire Catalogue domain from roadmap §4 —
   products, variants, lots, barcodes, stock movements, counts, transfers — is out of scope.
   That was the most relational and most write-concurrent part of the target schema. What remains
   is bullion-weight billing: rates, invoices/lines, tenders, payments, advances, identity, audit.
2. **Deployment is one Node process per tenant** (`deploy/README.md` — "Per-Tenant Cloud
   Instance"): each tenant runs its own process with its own data directory, behind Nginx, with
   several tenants optionally sharing one VPS. There is no multi-writer topology today, and no
   multi-branch requirement until roadmap Phase 7.

---

## 2. Options considered

### Option A — PostgreSQL now (the roadmap's original recommendation)

- **For:** the eventual destination for shared-SaaS and multi-branch; mature operational tooling
  (PITR, replication, managed hosting); real row locks across processes; `tenant_id`/`branch_id`
  partitioning ready on day one.
- **Against:** adds a server process to provision, monitor, back up, patch and restore on every
  VPS — infrastructure the project does not yet have anywhere (no VPS or domain provisioned as of
  2026-07-17). Adds a driver dependency, breaking the §0 budget. Makes the existing
  `backupEngine.js` file-copy strategy obsolete and requires replacing it in the same phase.
  Buys concurrent multi-writer capability that no current deployment topology uses.

### Option B — SQLite via `node:sqlite`, behind repository interfaces (recommended)

- **For:** full ACID with WAL, unique/foreign-key constraints, indexed pagination, real
  transactions with isolation — every Phase 1 exit criterion. Maps exactly onto the existing
  one-process-per-tenant model: one `.db` file replaces one `data/` directory. **Zero new
  dependency** — `node:sqlite` is in the Node standard library (verified stable and present in the
  installed runtime, exporting `DatabaseSync`, `StatementSync`, `Session`, `backup`). Keeps
  `backupEngine.js` working: a single file is still a file copy, and `sqlite.backup()` makes it
  online-safe. Migration is a local-file operation, so the importer's dry-run and rollback are
  cheap to rehearse.
- **Against:** one writer at a time per database (irrelevant today — that is already the
  architecture, and WAL keeps readers non-blocking). Weaker native types (no native `DECIMAL`;
  handled by storing money as integer paise, which roadmap §4 already mandates and
  `billingMath.js` already does). Not the multi-branch destination. Requires raising the Node
  engine floor from `>=20` to `>=24` for a flag-free stable `node:sqlite`.

### Option C — stay on JSON, harden further

Rejected. The gaps in §1 are structural, not fixable by more careful JSON code. Continuing would
mean hand-rolling an index layer, a constraint layer and a lock manager — i.e. writing a bad
database rather than using a good one, which is a much larger permanent liability than either
option above.

---

## 3. Recommendation

**Option B — SQLite via `node:sqlite`, behind repository interfaces, with PostgreSQL as the
documented destination.**

The roadmap already sanctions this as its "fast-pilot alternative," on the condition that it be
time-boxed and sit behind repository interfaces. Both conditions are met by construction, because
*"split route handlers, domain services and repositories"* is Phase 1 item 4 regardless of which
engine is chosen. The repository seam is being built either way; choosing SQLite first therefore
costs close to nothing if Postgres later becomes necessary — the swap is one implementation of an
interface that already exists, not a rewrite.

Choosing Postgres first, by contrast, front-loads infrastructure the project cannot exercise yet:
there is no VPS to install it on, and the CI gate has never run. Adding an unprovisioned database
server to an unprovisioned deployment target means Phase 1 cannot be verified end-to-end at all.

### Trigger to revisit — the time box

This is a bridge, not a destination. Migrate to PostgreSQL when **any** of these becomes true:

- a second concurrent writer against one tenant's data (a worker process, a scheduled job that
  writes, or a second app instance);
- multi-branch within a single tenant (roadmap Phase 5+);
- shared multi-tenant SaaS on one database rather than per-tenant instances;
- a tenant ledger where SQLite read performance stops meeting the pagination targets under
  realistic data volumes.

Until then the seam stays honest: no SQLite-specific SQL leaks above the repository layer, and the
migration test suite runs against the interface, not the implementation.

### Consequences if approved

- `CLAUDE.md` §0 is amended: the data store clause changes from "flat JSON files, no SQL" to
  "SQLite via `node:sqlite`, accessed only through `backend/repositories/`". The dependency budget
  is **unchanged** — no new runtime package.
- `backend/package.json` engines floor moves `>=20.0.0` → `>=24.0.0`; all four workflows move to
  Node 24.
- `backend/db.js` keeps `logError`/`logTelemetry`/`newId` and loses the JSON read/write/transaction
  helpers once the last caller is migrated (per `CLAUDE.md` §1, "delete before you add").
- The JSON importer (Phase 1 item 3) reads the legacy `data/*.json` and is the only code permitted
  to know the old shapes.

---

## 4. Decision

- [x] **Approved as recommended (Option B — SQLite bridge via `node:sqlite`, behind repository interfaces)**
- [ ] ~~Approved as Option A — PostgreSQL now~~
- [ ] ~~Rejected / needs rework~~

**Approved by:** owner  **Date:** 2026-08-11

Approved together with the companion call that the manual-UPI approver is a **distinct named role,
with the minimal identity slice pulled forward into Phase 1** — so `approved_by_user_id` exists on
the advance row from the first schema rather than arriving as a second migration after Phase 2's
full RBAC. See Phase 0's manual-UPI item and Phase 2 item 1.

PostgreSQL remains the destination. The revisit triggers in §3 are the contract; when one fires,
this ADR is superseded rather than amended.
