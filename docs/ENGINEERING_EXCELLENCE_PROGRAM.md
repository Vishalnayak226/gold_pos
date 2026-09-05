# Gold POS engineering-excellence programme

**Status:** planned 2026-09-04. No phase is “done” because a checklist says so;
each needs automated evidence, an operator journey, and a named release decision.

## Product standard

The POS must feel instant and obvious at the counter, remain correct under
retries/failures/concurrency, protect money and data by default, be understandable
to a new engineer, and change only through small, proven seams. The goal is not
to freeze software for twenty years; it is to make the trusted core so simple and
well-specified that future change is narrow, measured and safe.

## Non-negotiable invariants

1. The server, not the browser, determines money, tax, stock, permissions,
   document identity and final ledger state.
2. A financial action is complete everywhere or nowhere: document, tender,
   advance, stock movement and audit fact share one transaction.
3. Money uses integer paise and stock uses integer milligrams at persistence
   boundaries; rounding is defined once and tested.
4. Every permanent financial or privilege action is attributable, authorized,
   idempotent where retriable, and explainable from the audit trail.
5. Data changes are additive and recoverable. An update may not silently alter
   the meaning of historical records.
6. A failed dependency, slow disk, stale browser or repeated click cannot turn
   an unsuccessful action into a successful-looking one, or vice versa.

## Ordered delivery phases

### Phase A — Baseline and risk map

- Publish architecture/data-flow map, domain ownership and an explicit risk
  register for every money, stock, identity and external-payment workflow.
- Turn invariants into a traceability matrix: rule → code owner → automated
  test → counter-facing evidence → alert.
- Establish repeatable baselines for test time, boot, API p50/p95/p99, browser
  interaction latency, memory growth, bundle size and database size.

**Exit:** a future change can be evaluated against a known baseline instead of
personal memory.

### Phase B — Trusted financial and identity core

- Adversarially test sale/return/exchange/void/advance/payment/reconciliation
  flows for retry, duplicate, timeout, process kill, concurrent tills, stale
  settings and permission changes.
- Eliminate any browser-side or route-level authority that bypasses services,
  repositories, transaction boundaries or audit records.
- Make boundary units and error codes explicit and stable.

**Exit:** the financial and identity cores have executable specifications, not
only happy-path tests.

### Phase C — Architecture simplicity and contracts

- Remove duplicated business logic and establish one owner for each setting,
  financial calculation, role decision, response projection and feature flag.
- Maintain API, import/export and migration compatibility contracts; additions
  are compatible, breaking changes have a timed migration path.
- Keep modules replaceable: UI ↔ API ↔ service ↔ repository boundaries remain
  narrow; no framework or dependency is added without lifecycle ownership.

**Exit:** a new engineer can locate and safely change a business rule without
  searching the entire application.

### Phase D — Counter experience and performance

- Define performance budgets on the actual low-end counter device and target
  VPS for boot, login, scanning, lookup, preview, commit, print and tab switch.
- Make scanner, keyboard, touch, zoom, slow network, printer/scales and
  interrupted workflows first-class tests.
- Remove only measured bottlenecks; preserve the small-server/dependency budget.

**Exit:** a floor operator can complete the common sale path without waiting,
guessing or losing state.

### Phase E — Operability and lifecycle

- Prove clean-host restore, portable merchant export, canary/rollback,
  observability, alert handling, secret/key custody and low-drama upgrades.
- Maintain supported runtime/browser/crypto/dependency policies and annual
  disaster/security review routines.

**Exit:** an owner can keep the product healthy without relying on a single
developer’s memory.

### Phase F — Hostile verification and release certification

- Run mutation/property/fuzz-style tests where practical, independent security
  review, load/soak tests, physical counter acceptance and merchant/legal gates.
- No release ships with an unowned critical/high finding or unexplained
  performance regression.

**Exit:** a release is evidence-based, not confidence-based.

## Working rules

- Build in small vertical slices: one risk, its fix, automated proof, operator
  proof, documentation and a measurable before/after.
- Prefer deletion and consolidation over new abstractions. No new dependency,
  framework or infrastructure service without an explicit lifecycle case.
- Preserve current tenant data and existing user changes. A green test is
  necessary but never enough for a financial or operator-facing claim.
- `TESTING_CHECKLIST.md` §§23–24 remains the execution record; this document
  governs priority and quality decisions.
