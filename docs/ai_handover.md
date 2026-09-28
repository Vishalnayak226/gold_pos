# AI Handover: Gold Business POS (SaaS Platform)

This document contains key architectural details, non-negotiable design guidelines, and developer context for the completed **Gold Business POS** SaaS platform. Any incoming AI agent or developer must strictly adhere to these instructions.

> **Fresh session: read §0 only.** The rest of this file is ~5k tokens of reference you almost
> never need up front. Standing rules live in root `CLAUDE.md` (auto-loaded); the reasoning
> behind them lives in `docs/FOUNDATION.md`.

---

## 0. Version Control & Handover Status

*Keep this section current whenever a unit of work finishes. Absolute dates only.*

- **2026-09-28 (later): closed the two items the entry directly below left open —
  `TESTING_CHECKLIST.md` §22c (off-site backup destination) and §22d (management
  report definitions).** Full detail: `docs/LEDGER.md` (new 2026-09-28 entry above
  the one referenced below). Summary: both modules were already correctly built;
  the gap was purely that their specific claims had never been asserted anywhere.
  **§22c**: new `backend/tests/e2e/backup-settings.spec.js` (2 tests) drives the
  real Settings → Backup & Email UI — enable off-site copy, Create Backup Now,
  verify the manifest/SHA-256 on disk and that a stale dated folder gets pruned;
  then simulates an unavailable destination (replaced with a plain file — a real,
  portable filesystem failure, no OS permission trick needed), confirming the
  local backup still succeeds while the status line shows "OFF-SITE COPY FAILED",
  and that the very next run recovers once restored. **§22d**: four new
  `backend/test_repositories.js` §22 checks — Settlement's voided-tender/
  advance-exclusion handling, all three Reconciliation exception kinds
  (`invoice_tender_mismatch`, `voided_tender`, `gateway_advance_mismatch`, none
  previously exercised), Profitability's uncosted-line handling (`null` cost, not
  an invented margin, measurably lower blended coverage), and Ageing's
  positive-balance-only listing with `costValuePaise: null` for an uncosted lot.
  No defect found in either module — recorded as confirmation, not "nothing to
  do." **Verified:** `cd backend && npm test` all suites green, exit 0
  (`test_repositories.js` now 159 checks, up from 155); `npx playwright test
  backup-settings.spec.js` 2/2; full `npx playwright test --project=desktop-
  chromium` 133/133 (was 131), no regression. **Uncommitted, on top of the prior
  entry's own list:** `backend/test_repositories.js` (further modified),
  `backend/tests/e2e/backup-settings.spec.js` (new),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **§22a–d are now all closed.**
  Module 23 (POS 360° remediation) and the rest of Modules 20–26 still carry open
  items needing real infrastructure or a product call (§7's "no VPS provisioned"
  chief among them), so no Phase is archivable yet — same bar the entry below
  already established.

- **2026-09-28: fixed the two production-blocking bugs the 2026-09-27 entry below
  flagged but did not investigate, then closed `TESTING_CHECKLIST.md` §22a/22b
  (which surfaced a third real bug along the way).** Full detail and evidence:
  `docs/LEDGER.md` 2026-09-28 entry. Summary for a fast read:
  **(1) The real `backend/data/` ledger now boots.** The migration-checksum
  drift the last entry found-but-didn't-fix was git's `core.autocrlf=true`
  rewriting all 17 migration files' line endings on this Windows checkout —
  confirmed by hashing the on-disk files with CRLF normalized to LF and
  matching every one against the real `schema_migrations` table (read-only
  check, no data touched). Fixed in `backend/repositories/migrate.js`
  (normalize before hashing) plus a new root `.gitattributes` pinning
  `backend/repositories/migrations/*.sql` to `eol=lf` so this can't recur.
  **(2) The nightly `BACKUP_VERIFY_FAILED` alert was structurally incapable of
  ever passing** in keyfile mode (the only mode this project currently runs
  in — no VPS/env-var deployment exists yet, §7): `backend/verifyBackup.js`
  resolved its decryption key from the empty throwaway restore directory
  instead of the real data directory the backup was actually sealed under.
  Fixed to match `backupEngine.js`'s own `resolveKey(DATA_DIR)` convention.
  **(3) `docs/API_COMPATIBILITY.md` promised a `VOID_AFTER_RETURN` code that
  could never actually fire** — a generic state guard in
  `saleService.js#voidSale` always pre-empted it. Fixed by checking prior
  returns first. **§22a/22b now `[x]`**: the UI-observable half was already
  covered by the existing `inventory-billing-operations.spec.js`; the
  domain-code half (the three bugs' regression coverage) is three new checks
  in `test_repositories.js` §22, using their own dedicated lot fixture rather
  than the section's shared one (a first draft reused the shared lot and
  silently drifted a later, unrelated ageing-report assertion — caught by the
  full suite, not assumed safe). §22c/§22d remain open (real off-site
  directory needed; Settlement-report specifics not yet asserted anywhere).
  **Verified:** `cd backend && npm test` 12/12 suites green (`test_repositories.js`
  now 155 checks); `npx playwright test inventory-billing-operations.spec.js
  reprint-desk.spec.js return-desk.spec.js` 21/21 (re-run, not assumed, since
  the void-ordering change touches money-path control flow — CLAUDE.md §8);
  `node verifyBackup.js` against today's real backup — 12/12 PASS (was 1/4);
  real server boot smoke-tested against `backend/data/`, `GET /api/health`
  200, shut down cleanly with nothing left listening on :5000.
  **Uncommitted, on top of everything else already listed below:**
  `backend/repositories/migrate.js` (modified), `backend/verifyBackup.js`
  (modified), `backend/services/saleService.js` (modified),
  `backend/test_repositories.js` (modified), `.gitattributes` (new),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **No Phase is currently
  archivable**: Phase 19 still needs a real VPS run (§7 — none provisioned),
  and the live Modules 20/21/22c/22d/23–26 in `TESTING_CHECKLIST.md` still
  carry open, unchecked items, so `docs/archive/`'s "every item verified,
  nothing outstanding" bar isn't met yet — checked `docs/archive/README.md`'s
  own current-state note before concluding this, not assumed.

- **2026-09-27: installable PWA added for the customer portal (`customer.html`
  only)** — manifest, service worker with an offline fallback, iOS home-screen
  meta tags, and a hand-rolled stdlib-only PNG icon generator
  (`backend/generate-icons.js`) — as a lighter-weight, store-independent
  alternative to the Capacitor/Play Store track in `mobile/` for that one
  page. `mobile/` and the Android/Play Store docs (`PROJECT_PLAN.md` §5.11,
  `GO_LIVE_CHECKLIST.md` Track E) are deliberately untouched — this adds a
  second option, it does not replace that track. Full design rationale
  (service-worker scope pinned to `/customer.html`, `navigate`-only fetch
  interception so it can't fight `server.js`'s `?v=ASSET_VERSION` caching or
  mask a real API/money response, no `skipWaiting()`/`clients.claim()` so a
  deploy can't hot-swap the worker mid-payment) is in `docs/LEDGER.md`'s
  2026-09-27 entry. **Zero `backend/server.js` changes** — its existing
  static-file serving already headers every new file safely.
  **New `backend/tests/e2e/customer-pwa.spec.js`** (4 checks), wired into
  both Playwright projects. **Verified:** `cd backend && npm test` (9
  suites) green; `npx playwright test customer-pwa.spec.js
  customer-portal.spec.js customer-master.spec.js` 38/38 green on both
  viewport projects; the three customer-portal `visual-regression.spec.js`
  screenshots re-run clean (no visual diff from the head-only tag changes).
  **Found, not fixed — flag for the next session**: the real
  `backend/data/` ledger currently **fails to boot** (`node
  backend/server.js` / `Restart_Server.bat`) — `initialiseLedger()`'s
  migration-safety check reports all 17 on-disk migration files no longer
  match their recorded checksums. Not caused by this unit of work (no
  migration file touched here) and not investigated further — it touches
  protected real tenant data and looks like fallout from other concurrent
  work already in progress on this branch (see the large pre-existing
  modified-file list this branch already carries). Confirm before assuming
  the dev server just works. **Uncommitted, on top of everything else
  already listed below:** `backend/generate-icons.js` (new),
  `backend/tests/e2e/customer-pwa.spec.js` (new), `frontend/manifest.json`
  (new), `frontend/offline.html` (new), `frontend/service-worker.js` (new),
  `frontend/js/pwaRegister.js` (new), `frontend/icons/*.png` (new),
  `backend/package.json` (modified), `backend/playwright.config.js`
  (modified), `frontend/customer.html` (modified),
  `docs/{LEDGER,TESTING_CHECKLIST,ai_handover}.md` (modified).

- **2026-09-26: closed the last two open items in `TESTING_CHECKLIST.md`'s Module 3
  micro-checklist** (the discount-toggle button, line ~234, and the no-advance-history
  phone, line ~241) — found while answering "build the next two open items" by walking
  the checklist in document order rather than the §25 macro backlog, which is fully
  closed of anything buildable (see 2026-09-24 entries below). **Real bug found and
  fixed first**: `SettingsManager.js`'s Billing-settings save handler refreshed
  `window.reportsDesk`/`window.schemeDesk` after a save but never `window.billingDesk`
  — so a changed default discount, tax slab, tax mode, wastage or old-gold setting never
  reached the Billing Desk without a page reload, since `billingDesk.fetchSettings()`
  otherwise only runs once, at login (`app.js`). Fixed by adding the same refresh to
  that save callback. Guard proven: the new non-zero-default-discount test failed with
  the toggle hidden (its exact pre-fix state) before the fix, passed after it.
  **`billing-desk-preview.spec.js`** gained three tests: the seeded 0%-default hidden
  state, the non-zero-default Remove/Apply round-trip, and a phone outside the seed
  fixture's range never showing the Apply Advance box (asserted only after the real
  `GET /api/advances/lookup` response, not before). **Verified:** that spec 6/6; full
  `npx playwright test` (both projects) 138/139 — the one failure
  (`visual-regression.spec.js`, untouched by this change) reproduced clean 3/3 in
  isolation immediately after, matching the same long-run contention signature already
  on record in `docs/LEDGER.md`'s 2026-09-22 entry. Backend `npm test` unaffected by
  construction (frontend-only change). **Uncommitted, on top of everything else already
  listed below:** `frontend/js/components/SettingsManager.js` (modified),
  `backend/tests/e2e/billing-desk-preview.spec.js` (was already untracked; extended),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`.

- **2026-09-24 (second unit): the two remaining performance-backlog items
  that needed no VPS/hardware/product decision — `backend/benchmark.js`
  gained return/void/stock/payment/mixed-till workloads, and a new
  `backend/perfTrace.js` gives the browser-side counter-responsiveness
  trace `TESTING_CHECKLIST.md` §24d item 3 asked for.** Everything else
  left in §24d/§25c genuinely needs real target hardware/VPS or a product
  call, so this is now the honest ceiling on what's buildable there without
  either. **Benchmark**: new serial return/void/stock-adjust/advance-deposit
  scenarios (each against its own disposable invoice/lot) plus a
  `measureMixedTill()` scenario — several concurrent tills each running
  sale→sale→return→void→advance-deposit against the same ledger, latency
  bucketed per operation kind. Full run: return p95 26.16 ms, void p95
  28.05 ms, stock-adjust p95 23.25 ms, advance-deposit p95 31.62 ms;
  mixed-till (5×5, 125 ops) sustained 69.4 ops/s, per-kind p95 89.7–144.9 ms.
  Extracted the shared server-boot logic and `percentile`/`rounded` helpers
  into new `backend/benchmarkHarness.js` first, so the new browser tool
  could reuse them instead of duplicating a second boot mechanism (CLAUDE.md
  §1). **perfTrace.js** (new, `npm run perf-trace`): drives a real headless
  Chromium tab via `@playwright/test` (the one exempt devDependency — no
  new dependency) through shift-like cycles: tab transitions, a barcode
  scan (real server round trip), a hand-corrected weight (pure client-side
  recalculation + invoice-preview re-render), plus a per-cycle Chromium
  JS-heap sample as a memory-growth proxy. Found and fixed two real bugs in
  the tool itself while proving it stable across multiple cycles, not
  shipped broken on the second cycle: a "wait for text to change" check
  that hangs forever once a not-found SKU lookup repeats its own generic
  final message (fixed to wait past the lookup's own synchronous "Looking
  up…" placeholder instead), and a weight value that cycled mod 7 and so
  repeated an earlier cycle's exact total text (fixed to a value unique
  across the whole run). Smoke run (19 cycles, ~18s): recalculation p95
  8.45 ms, preview re-render p95 16.31 ms, barcode round trip p95 53.38 ms,
  tab transitions p95 117–196 ms, heap grew ~777 KB over 19 cycles (not
  diagnostic alone — needs the real multi-hour run). Full evidence in both
  cases: `docs/PERFORMANCE_BENCHMARK.md`. **Deliberately not run**: the real
  `--minutes 480` eight-hour soak and anything on real low-end-counter
  hardware — both need to be started deliberately by whoever has that
  hardware, not by this session on a dev laptop.
  **Verified:** `cd backend && npm test` green (680/680, 12 suites, exit 0)
  before and after (neither new tool is wired into it). Brain map needed a
  full `node docs/brain/build-brain.mjs` re-extraction this time, not just
  `--skip-graph` — these are real new source files, not doc/map edits — before:
  2 unclaimed (`benchmarkHarness.js`, `perfTrace.js`); after: `241 files, 19
  regions, coverage 100.0%`. **Uncommitted, on top of everything else
  already listed below:** `backend/benchmark.js` (modified),
  `backend/benchmarkHarness.js` (new), `backend/perfTrace.js` (new),
  `backend/package.json` (modified), `docs/PERFORMANCE_BENCHMARK.md`
  (modified), `docs/brain/brain.map.json` (modified),
  `docs/brain/{BRAIN.md,brain.html}` (regenerated),
  `docs/{TESTING_CHECKLIST,ai_handover,LEDGER}.md`. **Remaining performance
  work — none of it started this session:** target-hardware/VPS budgets, a
  representative production-scale (thousands-of-invoices) tenant, slow-
  network/provider-delay and disk-pressure simulation, the real hardware
  certification (§25c item 3), and the real eight-hour soak.

- **2026-09-24 (first unit): closed the two remaining code-buildable items in
  `TESTING_CHECKLIST.md` §25a (audit defect and test-system integrity) —
  QA-001 verified fixed, and `docs/brain/brain.map.json` now claims every
  file.** Both were genuinely open (`[~]`/`[ ]`) and needed no product
  decision or external infrastructure, unlike the rest of §25c/§25d.
  **QA-001:** the fix described in the checklist's own "planned approach"
  note was already present in the uncommitted `backend/test_security.js` —
  its `finally` block awaits `shutdown(server, ...)` before removing the
  temp dir and monkeypatches `console.warn`/`console.error` to fail loudly
  on a post-cleanup `[LogWriter]` message. This session's contribution was
  verification, not authorship: ran `node test_security.js` three times in
  isolation (10/10 checks, exit 0, zero `[LogWriter]`/`ENOENT` lines every
  run) and the full `cd backend && npm test` (680 checks, all 12 suites,
  exit 0), then marked the item `[x]` with that evidence recorded inline.
  **Brain map:** `node docs/brain/build-brain.mjs --check --skip-graph`
  reported 19 unclaimed files (6 backend modules — `auditRetention.js`,
  `backupCrypto.js`, `benchmark.js`, `domainCodes.js`, `logWriter.js`,
  `pitr.js` — plus 9 operating docs and 4 extracted frontend scripts, all
  built in earlier uncommitted sessions and never mapped). Read each file's
  own header comment (and grepped which HTML page actually loads the
  frontend scripts, rather than guessing by name) and added each as an
  explicit glob to whichever existing region already owns that role — no
  new region, no explicit file list, per `docs/brain/README.md`'s own rule.
  Full mapping and reasoning: `docs/TESTING_CHECKLIST.md` §25a. Redraw now
  reports `239 files, 19 regions, coverage 100.0%`, exit 0.
  **Verified:** `cd backend && npm test` green (680/680, 12 suites, exit 0);
  `node docs/brain/build-brain.mjs --check --skip-graph` exit 0, 100%
  coverage; no source file added/moved/deleted, so the cheaper map-only
  redraw was correct and a full `graphify update .` re-extraction was not
  needed. **Uncommitted, on top of everything else already listed below:**
  `docs/brain/brain.map.json` (modified — the 8 match-array edits),
  `docs/brain/BRAIN.md` and `docs/brain/brain.html` (regenerated),
  `docs/{TESTING_CHECKLIST,ai_handover,LEDGER}.md`. **Remaining §25
  work — none of it started this session:** §25c's hardware/VPS/soak items
  (need real infrastructure or a store manager) and all of §25d (product
  decisions for the owner).

- **2026-09-22: whole-app maturity programme — the two remaining Phase 3
  code-buildable items closed (TESTING_CHECKLIST.md §25b items 2 and 3);
  item 4 given a runnable protocol but not executed (needs a real human).**
  **Item 2:** every `<button>` across `frontend/index.html`,
  `frontend/customer.html` and `frontend/js/app.js` now has an explicit
  `type="button"` (33 found — `frontend/js/components/*.js` already did
  this everywhere, so the 2026-09-18 audit's "32" was these three files
  only). The app's one icon-only control and its unlabelled sibling tender
  inputs got `aria-label`; all 7 `.input-error-msg` spans got
  `aria-live="polite"` + `aria-describedby` on their field. The
  `.form-control:focus` outline replacement was 10%-opacity, effectively
  invisible — now uses `--color-accent`, a token that existed with the
  comment "gentle focus" but was never wired to anything. Keyboard order
  and dialog Escape/focus-return needed no work (verified, not redone).
  **Item 3:** new `backend/tests/e2e/visual-regression.spec.js`, 18
  `toHaveScreenshot` baselines for the six named screens, no new dependency.
  Two real flakiness sources were found and fixed rather than shipped
  flaky — a live timestamp in the return credit note's footer, and
  Google-Fonts load-timing antialiasing noise (`document.fonts.ready` wait
  + `maxDiffPixelRatio: 0.02` in `playwright.config.js`) — stable across 5
  runs after the fixes, flaky before them. **Item 4:** added
  `docs/USABILITY_SESSION_PROTOCOL.md`, a runnable script for the six named
  session types with a defect-logging template; the checklist item stays
  unchecked, since writing the script doesn't run it. **Verified:** full
  `npx playwright test` 136/136 (118 pre-existing + 18 new) across two
  clean full-suite runs; one incidental flake in `customer-master.spec.js`
  (a file untouched this session) reproduced as a clean pass in isolation —
  that run's 1.1h wall time against a normal ~10min points at contention
  from the several other concurrent sessions active on this machine during
  this work, not a regression. `cd backend && npm test` (12 suites) green
  throughout. Full detail: `docs/LEDGER.md` 2026-09-22 entry,
  `docs/TESTING_CHECKLIST.md` §25b items 2–3 (now `[x]`), item 4's note.
  **Uncommitted, on top of everything else already listed below:**
  `frontend/index.html`, `frontend/customer.html`, `frontend/js/app.js`,
  `frontend/js/adminAlertOverride.js`, `frontend/js/customerAlertOverride.js`
  (all modified), `frontend/js/components/BillingDesk.js` (modified, on top
  of whatever this file already carried), `frontend/css/app.css` (modified,
  on top of whatever this file already carried), `backend/playwright.config.js`
  (modified), `backend/package.json` (modified, on top of whatever this file
  already carried), `backend/tests/e2e/visual-regression.spec.js` (new, plus
  its `-snapshots/` baseline PNGs), `docs/USABILITY_SESSION_PROTOCOL.md`
  (new), `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **Remaining Phase
  3 work:** item 4's actual sessions (needs a store manager, a screen-reader
  user, a real scanner/touch device — none of which this session has), plus
  the already-open §25c performance/infrastructure items, none of which this
  unit touched.

- **2026-09-19: whole-app maturity programme, Phase 3 unit 7 — Diagnostics gets its first
  dedicated browser journey (5 tests), a real bug found and fixed first, and this closes the
  full module list from the 2026-09-18 audit.** All three action buttons showed a bare
  "failed: 403" for a manager/cashier denied by the owner-only diagnostics gate, with no
  indication of what that meant. Fixed to name the real reason for the 403 case specifically;
  proved by temporarily reverting and confirming the test reproduced the bare status code. New
  `backend/tests/e2e/diagnostics.spec.js` covers the denied case, all three successful pulls
  (real content asserted, not placeholders), and that repeated pulls append rather than
  replace the console log. Noted (not fixed, out of scope): a `#toggle-debug-btn` wiring block
  in `app.js` references an element no longer in `index.html` — harmless dead code, already a
  no-op via its own guard.
  **Phase 3's module list is now fully closed**: Cash Shifts, Quotes & Holds, Customer Master,
  Gold Schemes, Audit Trail, Management Reports and Diagnostics all have dedicated browser
  journeys — 41 new checks across 7 spec files, six of seven surfacing a real,
  previously-unknown bug (only Cash Shifts and Quotes & Holds were clean passes). Settings
  sub-sections were deliberately left to a concurrent session already covering them same-day.
  **Verified:** targeted spec 5/5 ×3 (incl. regression-guard proof); full `npx playwright test`
  117/118 (the `advances-manager.spec.js` flake first seen under Gold Schemes recurred again,
  confirmed intermittent/pre-existing across 4 full-suite runs this batch); full backend
  `npm test` (12 suites) green. `git diff --check` clean. Full detail: `docs/LEDGER.md`
  2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25b (now `[x]`). **Uncommitted, on top of
  everything else already listed below:** `frontend/js/app.js` (modified),
  `backend/tests/e2e/diagnostics.spec.js` (new), `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`.
  **Next Phase 3 work still open**: semantic-HTML/accessibility pass (§25b item 2), visual
  regression baselines (§25b item 3), and manual usability sessions (§25b item 4) — none of
  these were started; the module-journey item was the only one worked in this batch.

- **2026-09-19: whole-app maturity programme, Phase 3 unit 6 — Management Reports' coverage gap
  closed (5 new tests), deliberately not duplicating a concurrent session's same-day work; no
  defect found this time.** Before writing anything, checked `ReportsDesk.js`'s own header
  comment (references "Module 22") and found a concurrent session had already covered
  Profitability, Ageing, and a real local-vs-UTC date-default bug inside
  `inventory-billing-operations.spec.js`. Scoped this unit to the actual gap instead: new
  `backend/tests/e2e/management-reports.spec.js` covers the Settlement report (a real cash sale,
  exact known total), the Reconciliation report (0 exceptions for a clean sale), the
  invalid-date-range error path, the ageing-report's date-input-disabling behaviour, and the
  hidden-by-default state. All 5 passed on the first real run — this module's engineering was
  already solid going in. **Verified:** targeted spec 5/5 ×2; full `npx playwright test`
  112/113 (the already-documented `advances-manager.spec.js` flake recurred, confirming it is
  intermittent/timing-dependent and unrelated to any unit in this batch); full backend
  `npm test` (12 suites) green. `git diff --check` clean. Full detail: `docs/LEDGER.md`
  2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25b. **Uncommitted, on top of everything else
  already listed below:** `backend/tests/e2e/management-reports.spec.js` (new),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **Remaining Phase 3 module: Diagnostics.**

- **2026-09-19: whole-app maturity programme, Phase 3 unit 5 — Audit Trail gets its first
  dedicated browser journey (5 tests); two real bugs found and fixed first, including two of
  four entity-type filters that have silently returned zero rows since the screen was built.**
  Bug 1: the 403 permission-denied path showed `requireApprover`'s server message verbatim
  ("Approving a deposit needs a manager or the owner...", written for a different call site),
  telling a cashier viewing the audit trail they were trying to approve a deposit. Fixed to
  always use the screen's own accurate message. Bug 2: the "Advances"/"Payments" filter options
  carried values (`advance`/`payment`) that never match any real audit row's actual
  `entity_type` (`advance_entry`/`payment_order` — confirmed by grepping every
  `audit.record()` call in `backend/services/`); `auditRepository.search()` does an exact
  match, so selecting either option always returned zero rows. Fixed both values; proved by
  temporarily reverting and confirming the test reproduced the exact zero-rows bug. New
  `backend/tests/e2e/audit-trail.spec.js`: the permission-denied case, a filter-matches-nothing
  state, a cross-module check (a Cash Shift open/close appears with correct actor/variance),
  the entity-type fix, and reload persistence. **Verified:** targeted spec 5/5 ×3 (incl.
  regression-guard proof); full `npx playwright test` 108/108 (the previously-flagged
  `advances-manager.spec.js` flake did not reproduce this run — timing-dependent, not fixed by
  this unit, still documented for its owner); full backend `npm test` (12 suites) green.
  `git diff --check` clean. Full detail: `docs/LEDGER.md` 2026-09-19 entry,
  `docs/TESTING_CHECKLIST.md` §25b. **Uncommitted, on top of everything else already listed
  below:** `frontend/js/components/AuditTrail.js` (modified),
  `backend/tests/e2e/audit-trail.spec.js` (new), `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`.
  **Remaining Phase 3 modules still open:** Management Reports, Diagnostics.

- **2026-09-19: whole-app maturity programme, Phase 3 unit 4 — Gold Schemes gets its first
  dedicated browser journey (7 tests); the Management-Reports activation-refresh bug fixed
  2026-09-03 had never been carried over to this sibling module.** `goldSchemeEnabled` saves
  through the same Billing-settings handler as `managementReportsEnabled`, but only the latter
  triggered its desk's refresh after save — enabling Gold Schemes left the nav button hidden
  until a manual reload. Fixed; proved by temporarily reverting and confirming the test
  reproduced the exact bug. New `backend/tests/e2e/gold-schemes.spec.js`: default-hidden state,
  the activation fix, enrollment validation, installment payment validation, close-early
  (native confirm, payout to advance balance), mark-defaulted (native confirm, status-only),
  and reload persistence.
  **Unrelated defect found and deliberately NOT fixed** (out of scope, in a concurrent
  session's active file): `advances-manager.spec.js`'s "View expands.../Hide collapses" test
  now fails consistently (3/3 in isolation) — a Playwright strict-mode violation, 5 "View"
  buttons instead of 1. Root cause: `AdvancesManager.js`'s search is debounced 250ms and the
  test doesn't wait for it to settle before asserting a single row, racing the post-deposit
  unfiltered refresh against the debounced filtered one. Confirmed via `git diff` this
  session's only pending `AdvancesManager.js` change is an unrelated text fix — this is
  pre-existing, not introduced here. **Whoever owns `backend/tests/e2e/advances-manager.spec.js`
  next should add an explicit wait for the debounced search to settle** (e.g. assert the row
  count narrows to 1, or await the search request) before the View/Hide sequence.
  **Verified:** targeted spec 7/7 ×3 (incl. regression-guard proof); full `npx playwright test`
  102/103 (the one failure is the unrelated flake above); full backend `npm test` (12 suites)
  green. `git diff --check` clean. Full detail: `docs/LEDGER.md` 2026-09-19 entry,
  `docs/TESTING_CHECKLIST.md` §25b. **Uncommitted, on top of everything else already listed
  below:** `frontend/js/components/SettingsManager.js` (modified),
  `backend/tests/e2e/gold-schemes.spec.js` (new),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **Remaining Phase 3 modules still open:**
  Audit Trail, Management Reports, Diagnostics.

- **2026-09-19 (session resumed/finalized 2026-09-22 after an interruption): whole-app
  maturity programme, Phase 3 unit 3 — Customer Master gets its first dedicated browser
  journey (6 tests), plus a real permission/UX bug found and fixed first.**
  `GET /api/customer-accounts` is owner/manager-only server-side, but the nav tab has no
  role-gating and `refresh()` silently turned a 403 into an empty array — a cashier saw a
  false "No customer on record yet" instead of a permission message. Fixed
  `CustomerAccountsManager.js` to distinguish the cases; proved the guard by temporarily
  reverting it, confirming the test reproduced the exact pre-fix bug, then restoring the
  real fix (diffed identical). New `backend/tests/e2e/customer-master.spec.js`: the
  permission-denied case, issue-login validation, issuing a fresh login, the reissue/
  reset-password native-confirm flow, editing with validation, and owner-only anonymise.
  **A prior background verification run (full Playwright + full backend suite) was
  interrupted by a session boundary and could not be trusted, so both were re-run fresh
  in this session before finalizing.** **Verified:** targeted spec 6/6 ×2 plus the
  regression-guard proof; full `npx playwright test` 96/96 (90 baseline + 6 new); full
  `cd backend && npm test` (12 suites) green. `git diff --check` clean. Full detail:
  `docs/LEDGER.md` 2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25b. **Uncommitted, on
  top of everything else already listed below:**
  `frontend/js/components/CustomerAccountsManager.js` (modified),
  `backend/tests/e2e/customer-master.spec.js` (new),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **Remaining Phase 3 modules still
  open:** Gold Schemes, Audit Trail, Management Reports, Diagnostics.

- **2026-09-19: whole-app maturity programme, Phase 3 unit 2 — Quotes & Holds gets its first
  dedicated browser journey (7 tests), zero prior e2e coverage.** New
  `backend/tests/e2e/quotes-holds.spec.js`: empty state, client-side refusal on an empty cart,
  saving a HOLD/QUOTE (form reset, correct list entry, kind filter actually narrows), Resume
  (cart restored into the banked `#cart-list`, removed from the open list), Discard's native
  `confirm()` both declined and accepted (first spec in this tree to drive `page.on('dialog')`
  — checked this is consistent with every other destructive confirm in the app, not unique to
  this screen), and reload persistence. Same no-permission-denied-state situation as Cash
  Shifts (`/api/sale-drafts*` has no role restriction). One test-authoring mistake self-caught:
  the first Resume assertion checked the wrong element (`#gold-weight`, the next-line entry
  field, not the banked cart) — fixed in the test. **Verified:** targeted spec 7/7 ×2; full
  `npx playwright test` (both projects) 90/90 (83 baseline + 6 Cash Shifts + 7 this unit) — no
  regression against concurrent work. Full detail: `docs/LEDGER.md` 2026-09-19 entry,
  `docs/TESTING_CHECKLIST.md` §25b. **Uncommitted, on top of everything else already listed
  below:** `backend/tests/e2e/quotes-holds.spec.js` (new),
  `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`. **Remaining Phase 3 modules still open:**
  Customer Master, Gold Schemes, Audit Trail, Management Reports, Diagnostics.

- **2026-09-19: whole-app maturity programme, Phase 3 unit 1 — Cash Shifts gets its first
  dedicated browser journey (6 tests), zero prior e2e coverage.** New
  `backend/tests/e2e/cash-shifts.spec.js`: empty state, client-side validation on open/close,
  the full open→breakdown→close→variance→history flow, reload persistence (proves server- not
  client-state), and a genuine two-terminal race via a second `page` surfacing the real
  `CASH_SHIFT_ALREADY_OPEN` refusal. Documented (not skipped) that this module has no
  permission-denied state — every route is role-unrestricted `requireAdminSession`. Picked Cash
  Shifts first specifically to avoid colliding with concurrent sessions already covering
  Settings sub-sections/Dashboard/Advances in this same tree today. **Verified:** targeted spec
  6/6 twice; full `npx playwright test` (both projects) 83/83 — no regression against the
  concurrent work. Full detail: `docs/LEDGER.md` 2026-09-19 entry, `docs/TESTING_CHECKLIST.md`
  §25b. **Uncommitted, on top of everything else already listed below:**
  `backend/tests/e2e/cash-shifts.spec.js` (new), `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`.
  **Remaining Phase 3 modules still open:** Quotes & Holds, Customer Master, Gold Schemes, Audit
  Trail, Management Reports, Diagnostics (Settings sub-sections appear to be actively covered by
  a concurrent session — check `backend/tests/e2e/` for new specs before starting one, to avoid
  duplicating work).

- **2026-09-19: whole-app maturity programme, Phase 2 unit 4 (partial) — a real automated
  alert-delivery drill, and a second instance of the QA-001 log-writer-teardown-race bug found
  and fixed in `test_alerting.js` along the way.** No existing test ever configured
  `alertEmail`/`smtp` far enough for a real send to be attempted — the email-delivery half of
  `raiseAlert()` had zero coverage. New `backend/test_alerting.js` §8 (3 checks, 19→22 total)
  boots a minimal fake SMTP server in-process and proves a real send happens with the correct
  subject/recipient/body, that the cooldown blocks a second real connection (not just the return
  flag), and that an unreachable SMTP host fails soft. **Found while building it:**
  `test_alerting.js`'s own teardown had the exact QA-001 bug (closed the db and removed its temp
  directory before draining the log writer) — fixed with the same `drainLogWriter()`-first
  pattern. New `docs/RUNBOOKS.md` §15 documents both the automated coverage and a manual
  real-tenant drill procedure. **Explicit open decision, not attempted without authorization**:
  disposable-VPS deployment/rollback drill needs real cloud credentials and spends real money —
  see the decision question below. A real restore drill against this machine's actual encrypted
  backups was attempted and correctly failed (no real vault key here, by design — must not seek
  it); the isolated/synthetic version already passes in `test_suite.js`, unaffected.
  **Verified:** `npm run test:alerting` × 3, `npm test` × 2, all clean. `git diff --check` clean.
  Full detail: `docs/LEDGER.md` 2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25c.
  **Uncommitted, on top of everything else already listed below:** `backend/test_alerting.js`
  (modified), `docs/RUNBOOKS.md` (modified), `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`.

  **Decision asked and answered 2026-09-19:** whether to authorize provisioning a real, throwaway
  cloud VPS to drill deployment/DNS/TLS/rollback end-to-end (per `docs/TESTING_CHECKLIST.md`
  §25c). User chose **"skip for now"** — left as an explicit open checklist item, no cloud
  credentials sought or used, nothing provisioned. Re-ask only if the user wants to revisit this
  before a paid/public launch (§25c itself already gates that).

- **2026-09-19: whole-app maturity programme, Phase 2 units 2–3 — `mobile/` gets a committed
  lockfile (closing a critical/high `tar` vulnerability chain), CI dependency/SBOM coverage, and
  a repeatable Android build/device-test runbook.** `mobile/` had no lockfile, so `npm audit` had
  never run against it. Generating one surfaced a real finding: `@capacitor/{core,android,cli}
  @^6.0.0` resolved to a `tar` version with several critical/high archive-extraction advisories,
  unfixable within the 6.x line. Bumped to `^7.0.0` (not the latest `8.x` — smaller, lower-risk
  migration; no `android/` project has ever existed here to re-migrate either way). `npm audit`
  now 0 vulnerabilities. `.github/workflows/daily-checks.yml`'s `dependency-audit`/`sbom` job
  matrices now include `mobile`; also wired the previous unit's `licensing_server` test suite
  into the `integration-tests` job (it existed but was not yet in CI). New `docs/RUNBOOKS.md`
  §14: a numbered Android build/device-test procedure with its own drill-log table. **What
  remains genuinely unproven**: this sandbox has no Android SDK, so `cap add android`, a real
  Gradle build, and any device test are still unrun — checklist item marked PARTIAL, not done.
  **Verified:** `npm ci`/`npm install` clean, `npm audit`/`--audit-level=high` — 0 vulnerabilities,
  `npx cap --version`/`sync` clean, `npm sbom` generates 92 components; `licensing_server`'s
  `npm ci && npm test` (36/36) re-confirmed matching the new CI job exactly. `git diff --check`
  clean. Full detail: `docs/LEDGER.md` 2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25a.
  **Uncommitted, on top of everything else already listed below:** `mobile/package.json`
  (modified), `mobile/package-lock.json` (new), `mobile/README.md` (modified),
  `.github/workflows/daily-checks.yml` (modified), `docs/RUNBOOKS.md` (modified).

- **2026-09-19: whole-app maturity programme, Phase 2 unit 1 — `licensing_server/` gets its
  first behavioural test suite, and a real stack-trace-leak bug found and fixed along the way.**
  The service hardcoded its data/keys directories to `licensing_server/{data,keys}` and called
  `app.listen()` at import time with no override, so it was not testable in isolation before
  this. Added `GOLD_POS_LICENSING_DATA_DIR`/`GOLD_POS_LICENSING_KEYS_DIR` env overrides (default
  unchanged) and an exported `startServer(port, host)` gated behind
  `GOLD_POS_DISABLE_BOOTSTRAP` — same convention `backend/server.js` already uses. **Real bug:**
  no terminal error-handling middleware existed, so a malformed JSON body (or any thrown error)
  fell through to Express's default handler and rendered a **full stack trace** — absolute
  filesystem paths, `node_modules` internals — into the client response outside
  `NODE_ENV=production`. Reproduced live with curl before fixing; fixed by porting
  `backend/server.js`'s exact safe-error-handler pattern plus a JSON 404 for unmatched `/api/*`
  routes. New `licensing_server/test_licensing.js` (36 checks, real HTTP, isolated temp dirs, no
  mocks) covers entitlement semantics, signature validity (license-verify and release-manifest,
  including tamper detection), issue/suspend/renew/revoke, release-publish validation, the only
  rollback lever this API has (documented an explicit gap: no true delete/rollback endpoint
  exists), malformed/oversized bodies, both rate limiters (with the `/api/health` exemption
  proved under a tripped general limiter), the admin brute-force lockout, and tenant isolation.
  **Verified:** `node test_licensing.js` × 4, all exit 0, 36/36 every time; `npm run
  audit:security` (licensing_server) — 0 vulnerabilities; `node --check` clean; `git diff
  --check` clean; production boot path smoke-tested unchanged. Full detail: `docs/LEDGER.md`
  2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25a. **Uncommitted, on top of everything else
  already listed below:** `licensing_server/{server,package}.json` (server.js modified in
  place), `licensing_server/test_licensing.js` (new), `docs/{TESTING_CHECKLIST,LEDGER,
  ai_handover}.md`. **Concurrent-session activity continues**: a "tenth pass" Module 6 entry
  (gold pricing override bug) landed in `docs/LEDGER.md` between this pass's first and second
  doc edits — not investigated or touched by this pass, see its own entry immediately below.

- **2026-09-19: closed Module 6 ("Settings → Gold Pricing & Overrides") — found and fixed a
  serious mispricing bug with zero prior test coverage.** `priceEngine.js`'s
  `getActiveGoldRates()` (read by every price-dependent service: sales, returns, advances,
  old-gold exchange, payment credit, gold schemes) decided an override was active purely from
  stored prices being `> 0`, never checking `override.active` — so the Settings "Enable manual
  overrides" checkbox was cosmetic and unchecking it never actually returned pricing to auto.
  No test in the tree had ever imported `priceEngine.js` before this. Fixed the gate; added a
  direct unit test (`test_suite.js` Test 16) and a live UI test
  (`backend/tests/e2e/gold-pricing.spec.js`, 2 tests). "Sync Price Now" left open — needs real
  internet to Yahoo Finance, which this project's suites deliberately avoid depending on.
  **Verified:** `node test_suite.js`, `npx playwright test tests/e2e/gold-pricing.spec.js` (2/2),
  full `npm test` (all twelve suites) and full `npx playwright test` (both projects), all green,
  exit code 0. Full detail: `docs/LEDGER.md` 2026-09-19 (tenth pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/priceEngine.js`, `backend/test_suite.js`,
  `backend/tests/e2e/gold-pricing.spec.js` (new).

- **2026-09-19: whole-app maturity programme, Phase 1 unit 1 — QA-001 fixed.**
  `backend/test_security.js`'s `finally` block now awaits `shutdown(server, reason)` (the
  real production graceful-shutdown path — drains the async log writer, then closes the
  ledger) before removing its temp directory, instead of a bare `server.close()`. Added a
  regression guard that monkeypatches `console.warn`/`console.error` around the cleanup step
  and throws (fails the suite) on any post-cleanup `[LogWriter]` message, plus an assertion
  that `getLogWriterStats()` shows zero queued/in-flight entries right after the drain.
  **Proved the guard catches the old bug**, not just that the happy path is quiet: temporarily
  reverted to the bare `server.close()`, re-ran, reproduced the exact pre-fix `ENOENT` on
  `blackbox.log`/`telemetry.log`, and confirmed the new guard threw
  `QA-001 regression: log writer wrote after cleanup: ...` (exit 1); restored the real fix,
  diffed byte-identical to the verified version, re-tested. **Verified:** `npm run
  test:security` × 6 (3 before + 3 after the regression-guard proof), all exit 0, zero
  `[LogWriter]` lines. `cd backend && npm test` (all 12 suites) × 2, both exit 0 — every suite
  green including the security suite's 10 checks; the only `[LogWriter]` lines in either full
  run are `test_alerting.js`'s own deliberate fault-injection checks, unrelated to QA-001.
  `git diff --check` clean. Full detail: `docs/LEDGER.md` 2026-09-19 entry,
  `docs/TESTING_CHECKLIST.md` §25a. **Uncommitted, on top of everything else already listed
  below:** `backend/test_security.js` (modified in place; was already untracked from a prior
  session), `docs/{TESTING_CHECKLIST,LEDGER,ai_handover}.md`.
  **Concurrent-session risk confirmed live during this unit:** `git status` showed
  `backend/priceEngine.js` and `backend/test_suite.js` newly modified and a new untracked
  `_module6_block.txt` appear mid-session, none of which this pass touched or investigated.
  Multiple other Claude sessions on this machine are named `web-pos-*`/`lumiapos-*` and at
  least two were `busy` when checked (`ListAgents`) — treat any file this pass did not list as
  someone else's in-progress work, not stale state.

- **2026-09-18: independent whole-app quality audit completed (audit only; no product source
  changed).** Read `docs/WHOLE_APP_QUALITY_AUDIT_2026-09-18.md` before describing the app as
  launch-ready. It contains repeated test evidence, persona/module coverage, UI and accessibility
  gaps, lightweight-server constraints, legal/operations questions, SaaS decisions and a P0/P1/P2
  build queue in `docs/TESTING_CHECKLIST.md` §25. Evidence includes two clean full backend runs,
  security/migration/dependency/benchmark repetitions, and browser snapshots of 67/67 then 71/71;
  browser inventory changed between those snapshots, so neither is same-revision flake proof.
  **Confirmed QA-001 remains open:** `backend/test_security.js` deletes its temp directory before
  its asynchronous log writer is drained, producing post-pass `ENOENT` warnings. Fix the test to
  await the production graceful-shutdown path and fail on a post-cleanup writer warning. Do not
  treat a green local suite as proof of payment, hardware, native mobile, production hosting,
  legal compliance, penetration-test readiness or shared-tenancy SaaS isolation.

- **2026-09-18: closed Module 5 ("Settings → Store Profile") — zero prior e2e coverage, and a
  real, currently-shipping bug found and fixed.** New `backend/tests/e2e/store-profile.spec.js`
  (4 tests) plus a tiny fixture PNG cover field editing, logo upload/clear against the Billing
  Desk invoice, and the Admin PIN's masking/preservation/change guarantees. Real bug:
  `SettingsManager.js` used `null` for both "untouched" and "explicitly cleared" on the logo field,
  so Clear-Logo-then-Save has never actually cleared a logo — fixed with the same null-keep/
  empty-clear convention already used for masked credential fields elsewhere in the file. One
  stale checklist line corrected (the PIN box shows a placeholder, not literal `••••••••`).
  **Verified:** `npx playwright test tests/e2e/store-profile.spec.js` (4/4), full `npm test` (all
  twelve suites) and full `npx playwright test` (both projects), all green, exit code 0.
  **A concurrent session/process is running its own whole-app quality audit against this same tree
  today** — noticed via a `docs/TESTING_CHECKLIST.md` §25 section and new
  `docs/WHOLE_APP_QUALITY_AUDIT_2026-09-18.md` this pass did not create, plus a hand-edit to
  `docs/brain/brain.map.json`. Not investigated or merged into this pass's work — flagged to the
  user. Full detail: `docs/LEDGER.md` 2026-09-18 (ninth pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `frontend/js/components/SettingsManager.js`,
  `backend/tests/e2e/store-profile.spec.js` (new), `backend/tests/e2e/fixtures/tiny-logo.png`
  (new).

- **2026-09-18: closed Module 4 ("Customer Advances tab") — zero prior e2e coverage, and a real
  bug found and fixed in the exact item being verified.** New
  `backend/tests/e2e/advances-manager.spec.js` (5 tests) covers the manual-deposit form and its
  validation, the live search filter, the per-customer View/Hide drill-down, and a full
  Billing-Desk-to-Advances-tab round trip. Real bug: the drill-down's entry line
  (`AdvancesManager.js`) picked `e.paymentMethod || 'Invoice <id>'` — but `saleService.js`
  hardcodes `paymentMethod: 'other'` on every redemption row (a schema placeholder), so the truthy
  `'other'` always won and a "Redeemed at Billing" line never showed which invoice consumed the
  credit, on any redemption, ever. Fixed by making the choice type-aware (deposits show payment
  method; redemptions show the invoice id first). **Verified:** `npx playwright test
  tests/e2e/advances-manager.spec.js` (5/5), full `npm test` (all twelve suites) and full `npx
  playwright test` (both projects), all green, exit code 0. Full detail: `docs/LEDGER.md`
  2026-09-18 (eighth pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `frontend/js/components/AdvancesManager.js`,
  `backend/tests/e2e/advances-manager.spec.js` (new).

- **2026-09-18: closed Module 3b ("Returns & Refunds tab").** Thirteen of fourteen items were
  already fully covered by the existing `return-desk.spec.js`/`test_billing_math.js` — cited, not
  rebuilt. One real, entirely untested gap closed: the empty-search refusal (Reprint Desk's
  identical guard already had a test; Returns didn't) — added to `return-desk.spec.js`. One item
  left open: the pre-Phase-20 legacy-invoice return path has its pricing rule already unit-proven
  (`test_billing_math.js`'s `SALE_LEGACY` fixture) but no live UI test, same unbuilt-fixture-hook
  gap as Module 3a's identical item — left open together with it. **Verified:** `npx playwright
  test tests/e2e/return-desk.spec.js` (8/8, up from 7), full `npm test` (all twelve suites) and
  full `npx playwright test` (both projects), all green, exit code 0. Full detail: `docs/LEDGER.md`
  2026-09-18.
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/tests/e2e/return-desk.spec.js`.

- **2026-09-17 (sixth pass, same day): closed Module 3a ("Reprint Invoice tab").** Six of eight
  items were already fully covered by the existing `reprint-desk.spec.js` (just cited); two real,
  entirely untested gaps closed with new tests added to that same file — name-fragment customer
  search, and the date-range filter plus its backwards-range refusal (`server.js`'s `parseLedgerQuery`
  error had zero test coverage anywhere). One item left honestly open: the pre-Phase-20
  legacy-invoice print path needs a hand-built legacy-shaped DB row the e2e harness has no hook
  for yet — noted as a `test_repositories.js`-level task for later, not forced into this pass.
  **Verified:** `npx playwright test tests/e2e/reprint-desk.spec.js` (8/8, up from 6), full `npm
  test` (all twelve suites) and full `npx playwright test` (both projects), all green, exit code 0.
  Full detail: `docs/LEDGER.md` 2026-09-17 (sixth pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/tests/e2e/reprint-desk.spec.js`.

- **2026-09-17 (fifth pass, same day): closed Module 3 ("Billing Desk tab") — a second real
  production bug found and fixed.** `BillingDesk.js`'s `updateGoldRateDisplay()` was fully wired
  to the purity-change handler and to init, but its two target DOM elements
  (`#current-gold-rate-22k`, `#rate-type-badge`) did not exist in the rendered template — a
  permanent silent no-op, no rate/g display or Auto/Manual badge ever shown, for any purity.
  Restored both elements. New `backend/tests/e2e/billing-desk-preview.spec.js` (3 tests) covers
  this plus two other real gaps: the empty-invoice guard's actual current message (the checklist's
  old "Please enter a valid gold weight." text predates the multi-line cart) and the form/preview
  reset after a successful save. Most of the module needed no new work — `[math automated]` items
  are `test_billing_math.js`'s own territory, `[e2e automated]` items were already covered by
  `cashier-billing.spec.js`/`reprint-desk.spec.js`, and "Dashboard reflects new sale" was closed by
  the Module 2 pass above. Two items left honestly open rather than checked on adjacent coverage:
  the Discount toggle's Remove/Apply BUTTON and the "no Apply Advance box with no balance" negative
  case both have zero dedicated e2e assertions. **Verified:** `npx playwright test
  tests/e2e/billing-desk-preview.spec.js` (3/3), full `npm test` (all twelve suites) and full
  `npx playwright test` (both projects), all green, exit code 0. Full detail: `docs/LEDGER.md`
  2026-09-17 (fifth pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `frontend/js/components/BillingDesk.js`,
  `backend/tests/e2e/billing-desk-preview.spec.js` (new).

- **2026-09-17 (fourth pass, same day): closed Module 2 ("Dashboard tab") — and found a real
  production bug while verifying it.** New `backend/tests/e2e/dashboard.spec.js` (3 tests) proved
  a real gap: `Dashboard.js`'s `renderRecentTransactions()` called `describeSaleGoods()` without
  ever importing it, throwing on the first render with any sale to show — silently swallowed by a
  bare `console.error`, so on any store with at least one invoice (i.e. every real store past day
  one) the Recent Transactions list, the Recent Advance Deposits list, AND the "Updated `<time>`"
  text all stayed frozen forever, from one missing import. Fixed with a one-line addition to the
  existing `billingMath.js` import (`ReprintDesk.js`/`ReturnDesk.js` already had it right). Also
  corrected one stale checklist line: the "Purity Mix — Lifetime Revenue Share" bar it described
  does not exist in `Dashboard.js` at all — a past performance refactor removed client-side ledger
  summation and this bar went with it; marked struck-through with the reasoning recorded rather
  than reimplemented. **Verified:** `npx playwright test tests/e2e/dashboard.spec.js` (3/3),
  full `npm test` (all twelve suites) and full `npx playwright test` (both projects), all green,
  exit code 0. Full detail: `docs/LEDGER.md` 2026-09-17 (fourth pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `frontend/js/components/Dashboard.js`,
  `backend/tests/e2e/dashboard.spec.js` (new).

- **2026-09-17 (third pass, same day): moved into the manual-QA-modules half of
  `TESTING_CHECKLIST.md` — closed §0's server-start/lock-screen items and all five Module 1
  ("Admin Login & Session") items with real Playwright coverage.** New
  `backend/tests/e2e/admin-login.spec.js` (5 tests) drives the real lock-screen PIN pad in a real
  browser: wrong PIN → inline error, stays locked; correct PIN → Dashboard + sidebar visible, PIN
  field cleared; 5+ wrong PINs → lockout that also blocks the correct PIN, with the real "Too many
  failed PIN attempts" message; Logout → lock screen, survives a reload (server session actually
  invalidated); an authenticated session survives a reload. Backend HTTP-level coverage of this
  boundary already existed (`test_routes.js`, `test_suite.js` Test 6) but never proved the form
  itself, per CLAUDE.md §8. One stale checklist line fixed along the way: "Incorrect Admin PIN
  alert" described a `window.alert()` flow that no longer exists — current behaviour is an inline
  `#admin-login-error` message, corrected in the doc. **Verified:** `npx playwright test
  tests/e2e/admin-login.spec.js` (5/5), full `npx playwright test` (53/53, up from 48), full `npm
  test` (all twelve suites), all green, exit code 0; `docs/brain/build-brain.mjs` re-run (new file
  auto-claimed by its region's existing glob, no map edit needed). Full detail: `docs/LEDGER.md`
  2026-09-17 (third pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/tests/e2e/admin-login.spec.js` (new),
  `docs/brain/{BRAIN.md,brain.html}`.

- **2026-09-17 (second pass, same day): closed the three `TESTING_CHECKLIST.md` §24b slices the
  first pass below deliberately left open** — authentication-semantics contract test, crash
  injection for the two newest workflows, and a keyboard/scanner/touch/focus-order/contrast audit.
  (1) **Authentication-semantics contract**: added cookie-attribute assertions
  (`HttpOnly`/`SameSite=Lax`/no `Secure` over plain HTTP) and a safe-method-needs-no-CSRF check to
  `test_routes.js` (admin) and `test_http.js` (customer) — deliberately not re-testing CSRF
  rejection itself, since `test_security.js` (2026-09-16) already owns that contract. (2)
  **Crash injection**: added three real-child-process kills in `test_concurrency.js` for
  `stockService.adjustLot` and `reconciliationService.openShift`/`closeShift`, same
  kill-before-the-audit-insert shape as the existing return/void/advance-approval tests. (3)
  **UI durability audit** (delegated to a subagent per CLAUDE.md §5, diff verified before
  accepting): found and fixed two real gaps — `adminAlertOverride.js`/`customerAlertOverride.js`'s
  hand-rolled `#custom-alert-box` never focused its OK button, ignored Escape, and didn't trap Tab
  or return focus to the trigger on close (the one non-native dialog in the app, so every
  admin/customer message funnels through it); and `.btn-danger:hover` (`app.css`) dropped contrast
  to ~3.4:1 (below the 4.5:1 AA floor), fixed by swapping Red 300 for Red 100. Scanner/touch/focus
  paths inside `BillingDesk.js`/`InventoryManager.js`'s own forms were already sound — nothing to
  fix there. **Deliberately still left open**: the same two §24b bullets as the pass below (counter
  performance budget on target hardware/VPS; canary rollout/observability/rollback) — still no
  hardware or deployed infrastructure to test against (§7). **Verified:** `node test_routes.js`
  (33/33, up from 29), `node test_http.js` (139/139, up from 138), `node test_concurrency.js`
  (36/36, up from 33), a new Playwright test in `inventory-billing-operations.spec.js` plus
  re-runs of `customer-portal.spec.js` (24/24, desktop + 390px) and
  `reprint-desk`/`return-desk`/`cashier-billing` specs (20/20), and full `npm test` (all twelve
  suites) — all green, exit code 0. Full detail: `docs/LEDGER.md` 2026-09-17 (second pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/test_routes.js`, `backend/test_concurrency.js`,
  `backend/test_http.js`, `frontend/js/{adminAlertOverride,customerAlertOverride}.js`,
  `frontend/css/app.css`, `backend/tests/e2e/inventory-billing-operations.spec.js`.

- **2026-09-17: four `TESTING_CHECKLIST.md` §24b ("whole-app future-proofing") items advanced, one
  concrete slice each — these are continuous standing policies, not one-shot checkboxes, so none
  was marked `[x]`.** (1) **Pagination/filter-bounds contract bug found and fixed**: `server.js`'s
  `parseLedgerQuery` clamped a client's `limit` to 500 while every ledger repository
  (`advanceRepository`/`invoiceRepository`/`creditNoteRepository`) independently clamps the real
  SQL query to 200 — `GET /api/sales`/`/api/returns`/`/api/advances` echoed the looser 500-based
  value, so a client requesting `?limit=300` saw `"limit":300` while `results.length` was silently
  capped at 200, breaking `offset += page.limit` pagination. `LEDGER_PAGE_MAX` lowered to 200 to
  match; each repository's `clampLimit()` exported and reused in `advanceService`/`saleService`/
  `returnService`, which had the identical bug in their own echoed `limit`. (2) **Dependency
  lifecycle review**: new `docs/DEPENDENCY_REVIEW.md` (required-fields template + a filled entry
  for all 9 current runtime deps and the one exempt devDependency); found CLAUDE.md §0's
  "the 3 in `licensing_server/`" was stale — it has always had 2 (`dotenv`, `express`) — and fixed
  it there too. (3) **Concurrency races added for the two newest workflows**:
  `stockService.adjustLot` and `reconciliationService.openShift` (built 2026-09-16, one entry
  below) were the only workflows with no race coverage in `test_concurrency.js`; added a
  10-way negative-balance stock-adjustment race and a 10-way cash-shift double-open race,
  mirroring the existing return/void/exchange race pattern. (4) **A real missing confirmation,
  found and fixed**: every destructive action in `frontend/js/components/` has a `confirm()`
  except `InventoryManager.js`'s stock-adjustment form, which posted directly with no
  confirmation — the one destructive action with no undo in the UI at all. Added one naming the
  item and signed delta. **Deliberately left open**: the other two §24b bullets (counter
  performance budget on target hardware/VPS; canary rollout/observability dashboard/rollback
  tree) need real hardware/infrastructure that does not exist yet (§7) — not faked against a dev
  laptop. **Verified:** `node test_http.js` (138/138), `node test_concurrency.js` (33/33), a new
  Playwright test in `inventory-billing-operations.spec.js`, and full `npm test` (all twelve
  suites), all green, exit code 0. Full detail: `docs/LEDGER.md` 2026-09-17.
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/server.js`,
  `backend/repositories/{advanceRepository,invoiceRepository,creditNoteRepository}.js`,
  `backend/services/{advanceService,saleService,returnService}.js`, `backend/test_http.js`,
  `backend/test_concurrency.js`, `backend/tests/e2e/inventory-billing-operations.spec.js`,
  `frontend/js/components/InventoryManager.js`, `docs/DEPENDENCY_REVIEW.md` (new), `CLAUDE.md`.

- **2026-09-16 (third pass): closed the log-writer-alert, asset-caching and SKU/customer-lookup-race
  `TESTING_CHECKLIST.md` items, added `backend/test_security.js`, and fixed a real double-boot bug
  the asset-caching test surfaced.** The bug: `server.js`'s `versionedHtml()` stamped the
  `<script type="module" src="js/app.js">` entry tag with `?v=ASSET_VERSION`, but every component
  imports shared helpers back from that same file via a bare `'../app.js'` specifier — two URLs for
  one ES module, so the browser fetched and executed `app.js` TWICE per page load, silently
  double-registering every component and double-firing every click handler admin-desk-wide. Found
  via a new Playwright spec that finally clicked Billing Desk's "Add Item" button and got a false
  "Enter a weight" alert on a successful add — nothing had exercised that non-idempotent click
  before. Fixed by excluding `<script type="module">` tags from the version stamp; this also fixed
  an unrelated-looking pre-existing failure in the management-reports e2e journey (same cause).
  Also added `checkLogWriterHealth()` (`alerting.js`) so a full/unwritable log destination reaches
  the one alert choke point instead of only a console; added the SKU-lookup race e2e spec (the
  customer-phone one already existed); and fixed one real XSS gap in `SettingsManager.js`'s license
  block (unescaped `innerHTML`, found while investigating the new security suite's XSS-sink
  category). `test_security.js` is wired into `npm test`, which `daily-checks.yml` already runs on
  every pull request. **Verified:** `node test_alerting.js` (19/19), `node test_http.js` (137/137),
  `node test_security.js` (10/10), full `npm test` (all twelve suites) and full `npx playwright
  test` (46/46), all green, exit code 0. Full detail: `docs/LEDGER.md` 2026-09-16 (third pass).
  **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this pass, on top
  of everything already listed below: `backend/alerting.js`, `backend/test_security.js` (new),
  `backend/package.json`, `backend/tests/e2e/inventory-billing-operations.spec.js`,
  `frontend/js/components/SettingsManager.js`.

- **2026-09-16 (second pass): closed the last three named-but-untested domain codes
  (`DUPLICATE_REFERENCE`, `PAYMENT_AMOUNT_MISMATCH`, `PAYMENT_CREDIT_PERSIST_FAILED`) and locked
  in stock adjustment's documented resubmission behaviour with a test.** No production code
  changed — `test_http.js` only. `DUPLICATE_REFERENCE` and `PAYMENT_AMOUNT_MISMATCH` are asserted
  at the real HTTP boundary (a duplicate `/api/advances` reference; a signed `/api/payment/verify`
  checkout whose local Razorpay double reports a mismatched captured amount, reusing the "Gateway
  await gap" fixture). `PAYMENT_CREDIT_PERSIST_FAILED` is **not reachable through HTTP at all** —
  `payment_orders`/`advance_accounts` both make `customer_phone` `NOT NULL`, so no real checkout
  can ever put `creditCapturedPayment()` into a state that fails to persist — asserted instead by
  calling that service function directly with a hand-built order carrying `customerPhone: null`,
  which trips the real constraint. Stock adjustment's "resubmission creates a second movement,
  arguably correct but never tested either way" line is now an actual test, unchanged behaviour.
  **Verified:** `node test_http.js` alone (136/136, up from 132) and full `npm test` (all eleven
  suites), both green, exit code 0. Full detail: `docs/LEDGER.md` 2026-09-16.

- **2026-09-16 (first pass): closed `docs/INVARIANT_MATRIX.md`'s last two named gaps — stock
  adjustment and day reconciliation now have an owning service layer, and stock adjustment's
  refusals carry a `DOMAIN_CODE`.** New `backend/services/stockService.js` (`openLot`,
  `adjustLot`) and `backend/services/reconciliationService.js` (`openShift`, `closeShift`) sit
  between their four `server.js` routes and
  `inventoryRepository.js`/`cashShiftRepository.js`, mirroring the existing `oldGoldService.js`
  shape (pre-check → `DomainRefusal` inside `inTransaction` → caught and returned as
  `{success:false,status,error,code}`). New codes: `STOCK_ITEM_NOT_FOUND`, `STOCK_LOT_NOT_FOUND`,
  `STOCK_ADJUSTMENT_ZERO`, `STOCK_ADJUSTMENT_NEGATIVE`, `CASH_SHIFT_ALREADY_OPEN`,
  `CASH_SHIFT_NOT_FOUND`, `CASH_SHIFT_ALREADY_CLOSED`. Stock adjustment also gained an
  `audit.record()` call (day reconciliation's was already there from 2026-09-13).
  **Deliberately not done: no new approver gate on either workflow** — that stays the one real
  open product decision `INVARIANT_MATRIX.md` names, not something this structural pass should
  guess at. `TESTING_CHECKLIST.md`'s "every permanent record has an owning service" item is now
  checked off. **Verified:** `node test_http.js` alone (132/132, three new checks) and full
  `npm test` (all eleven suites), both green, exit code 0. Full detail: `docs/LEDGER.md`
  2026-09-16. **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of both
  passes above: `backend/services/{stockService,reconciliationService}.js` (new),
  `backend/{server,domainCodes,test_http,test_concurrency}.js`,
  `docs/{INVARIANT_MATRIX,TESTING_CHECKLIST,LEDGER,ai_handover}.md` — the last four plus
  `test_concurrency.js` carry over uncommitted from the 2026-09-13 session below, unrelated to
  either pass.

- **2026-09-13: `docs/INVARIANT_MATRIX.md` brought current, and the one real gap it surfaced closed.** The matrix (last verified 2026-09-09) was found stale — the Phase 2.1/2.2/2.3/2.4 adversarial tests it named as missing had already landed 2026-09-11 (`b943b0d`) but the doc was never updated to say so. Re-verified every "known gap" line against current source and tests; all but one were already closed. The one real gap: `test_repositories.js` only proved webhook replay/claim sequentially in one process, never under genuinely concurrent delivery of the same event id (the actual retry-storm scenario). Added a 20-way real-child-process race to `test_concurrency.js` (§3, "20 concurrent deliveries of the same webhook event id credit the customer exactly once") — same pattern as the existing return/void/exchange races, since an in-process test would only prove the JS logic runs, not that SQLite's unique constraint actually serializes racing processes. `docs/TESTING_CHECKLIST.md` §24c's invariant-matrix and adversarial-tests items are now both checked off, each citing the specific test that closes it. Two real gaps remain and are intentionally NOT closed: stock adjustment and day reconciliation have no owning service layer (a design decision, not a test gap) — see the matrix's cross-cutting findings. **Verified:** `node test_concurrency.js` alone (31/31) and full `npm test` (all eleven suites) both green, exit code 0. Nothing uncommitted beyond this session's own changes: `backend/test_concurrency.js`, `docs/{INVARIANT_MATRIX,TESTING_CHECKLIST,LEDGER,ai_handover}.md`.

- **2026-09-11: fixed an indefinite hang in `test_http.js`'s "Gateway await gap" check before committing/deploying phase-21.** Root cause: the check signed its expected Razorpay HMAC with the stale module-level `initialSettings.razorpayKeySecret`; an earlier check in the same file rotates the store's live secret and never rotates it back, so the server correctly rejected the signature and returned before ever reaching the gateway call the check was waiting to observe — and `await gatewayReached` had no timeout, so it hung forever instead of failing. Confirmed for real, not theoretically: two independent `npm test` runs (one from an unrelated concurrent session, started ~19h earlier) were both found stuck at the exact same line. Fixed by tracking the live secret in a `currentRazorpayKeySecret` variable kept in sync by the rotation check, and by bounding `gatewayReached` with a 5s timeout that fails loudly instead of hanging. Full detail: `docs/LEDGER.md` 2026-09-11. **Verified:** `node test_http.js` alone and full `npm test` (all eleven suites) both green, exit code 0. No production code changed — `backend/server.js` only had temporary diagnostic logging added and removed during the investigation; `git diff` on it is unchanged from before this entry. This was found while preparing to commit and deploy the branch below to `main` — do not skip a real `npm test` run before that merge on the strength of this fix alone; it was one specific hang, not a general clean bill of health beyond what the suite covers.

- **2026-09-07: benchmark now measures a seeded, authenticated workload.** `backend/benchmark.js` keeps its original empty-tenant health/static scenarios (unchanged, still run first), then signs in as the tenant owner, files a seeded merchant dataset via real `POST /api/sales` calls, and measures authenticated checkout (serial + 5-till concurrent)/lookup/paged-ledger against that populated tenant. `API_RATE_MAX` is raised for the spawned child so the harness's own volume doesn't trip the abuse throttle it isn't testing. `docs/TESTING_CHECKLIST.md` §24d's seeded-benchmark item is updated but left unchecked — target-hardware/VPS budgets and a return/void/mixed-concurrency workload are still open, see `docs/PERFORMANCE_BENCHMARK.md`. Full `npm test` green throughout. **Uncommitted on `phase-21-payment-verification-and-production-guard`**: everything listed in the domain-refusal entry immediately below, plus `backend/benchmark.js` and `docs/PERFORMANCE_BENCHMARK.md`.

- **2026-09-07: domain-refusal code registry finished — advance, exchange, payment and the remaining return/sale refusals now carry a stable `code`.** `backend/domainCodes.js` grew from 3 covered workflows (refund/MFA, stock, void) to also name every refusal in `saleService.js`, `returnService.js`, `advanceService.js`, `paymentService.js` and `oldGoldService.js`. `error` keeps its existing prose everywhere except `/api/returns`' pre-existing `APPROVER_REQUIRED`/`MFA_REQUIRED` shape, which was already the bare code and stays that way — a route-level swap that briefly and incorrectly generalized to the new codes during this change was caught by a failing test (`RETURN_PRICING_REFUSED` appearing in `error` where prose was expected) and scoped back down to just those two codes. `TESTING_CHECKLIST.md`'s domain-refusal gate is now checked off. Full `npm test` green (nine suites); HTTP suite grew 125→127. **Uncommitted on `phase-21-payment-verification-and-production-guard`** as of this entry: `backend/domainCodes.js`, `backend/server.js`, `backend/services/{saleService,returnService,advanceService,paymentService,oldGoldService}.js`, `backend/test_http.js`, plus the pre-existing uncommitted `docs/{GO_LIVE_CHECKLIST,LEDGER,TESTING_CHECKLIST,ai_handover}.md` and new `docs/GO_LIVE_RUNBOOK.md` from before this session started. Next queued: seeded-merchant `backend/benchmark.js` workload, the invariant traceability matrix, then adversarial tests (config drift, concurrent/duplicate actions, process interruption, permission changes mid-flight, malformed legacy records, post-restore replay) — none started yet.

- **2026-09-06: owner-readable go-live route added; public paid launch remains NO-GO.** Start external launch work with `docs/GO_LIVE_RUNBOOK.md`, not a server command or Play Store listing. It orders Demo → managed pilot → public launch and names the evidence required for legal/tax/privacy, production host/security/access, payments, clean-host recovery, exact-counter hardware/training, real-world performance, independent security testing, whole-day rehearsal, and pilot reconciliation. `docs/GO_LIVE_CHECKLIST.md` is now explicitly the detailed external-account/evidence record, while `docs/TESTING_CHECKLIST.md` §§23–24 remains the release-gate evidence. No product code, deployment, or release approval changed; do not claim public/paid launch readiness until the runbook’s Step 13 record is signed after a successful pilot.

- **2026-09-06: Play Store status is explicitly NOT published.** `docs/GO_LIVE_CHECKLIST.md` Track E is now the permanent, plain-language Android-release checklist. `mobile/` remains a single-tenant Capacitor wrapper for `customer.html`, not a cashier POS app; no Android project, signed AAB, Play Console listing, closed test or production approval exists. Do not claim Android/Play Store availability. The next owner action is E1 scope confirmation, then privacy/Data Safety/account-deletion work and an organization Play Console account before an Android build.

- **2026-09-05: engineering-excellence implementation has begun with a stable domain-refusal seam and clean-instance performance evidence.** `backend/domainCodes.js` owns the first contract-1 registry: refund approval/MFA, stock insufficiency and the complete void lifecycle. `POST /api/sales`, sale void and returns now add `code` when a service produces one without changing legacy `error` semantics. In particular, refund approval keeps `error: "APPROVER_REQUIRED"` for existing clients and now also has `code: "APPROVER_REQUIRED"` plus human `message`; do not make a browser or integration parse prose to decide a financial/authorization outcome. `docs/API_COMPATIBILITY.md` is authoritative on this gradual transition. `backend/benchmark.js` is a dependency-free real-server loopback baseline, and `docs/PERFORMANCE_BENCHMARK.md` states its limits. Full baseline passed locally (health p95 16.79 ms serial / 47.25 ms at 25-way); this is not a checkout, low-end-device or VPS claim. Repository/service 150/150, HTTP 125/125 and full backend tests are green. Continue with the seeded/authenticated workload and invariant matrix rather than marking broader §24b/§24d gates complete.

- **2026-09-04: Engineering-excellence programme planned (historical planning record).** Read `docs/ENGINEERING_EXCELLENCE_PROGRAM.md` before selecting the next hardening slice. It fixes the priority order: executable invariants and trusted core first, architecture simplicity second, counter speed/UX third, lifecycle and hostile verification last. Treat `TESTING_CHECKLIST.md` §§23–24 as the evidence ledger; never claim the programme complete from documentation alone.

- **2026-09-04: whole-app future-proofing programme started with API compatibility.** All responses now include `X-Gold-POS-API-Version: 1`; health includes `apiVersion: "1"`. Preserve public request/response/error/auth/pagination/webhook/money semantics within a contract generation; use the documented breaking-change process in `docs/API_COMPATIBILITY.md` for any exception. `TESTING_CHECKLIST.md` §24b is the broader ongoing product standard. HTTP suite: 125/125 green. This is a foundation, not a claim that the whole twenty-year programme is finished.

- **2026-09-04: recovery archives are now self-describing, still encrypted.** `backupEngine.js` writes `backup_manifest.json` before whole-archive AES-GCM encryption: format version, timestamp, app/Node version, SQLite filename and migration inventory/checksums only. `verifyBackup.js` validates it when present and confirms it names the restored ledger; legacy snapshots without it still restore. Integration Test 15 creates a real encrypted backup and proves the manifest/restore path. `TESTING_CHECKLIST.md` §24 is the durability standard; do not call the product “20-year ready” until its clean-host restore, export, lifecycle, key-custody and annual-drill gates have real evidence.

- **2026-09-03: POS 360° performance/security implementation pass completed locally; do not treat this as production approval.** Added `backend/logWriter.js`: bounded async diagnostic logging, shutdown drain, metrics, retry backoff and rotation. It intentionally does not relax synchronous financial/immutable writes. `BillingDesk` now discards an aborted/stale advance lookup; Management Reports refresh after login and after an owner enables them in Settings. New threat model: `docs/THREAT_MODEL.md`; executable gates: `docs/TESTING_CHECKLIST.md` §23. Backend and licensing locks override transitive `qs` to 6.16.0 and both `audit:security` scripts are clean. **Verification:** backend `npm test` green; HTTP 125/125; Playwright desktop suite 33/33 after fixing report activation (the prior full viewport pass found this one defect at 43/44). Still open and not code-substitutable: CA/BIS/privacy/payment onboarding, deployment/host evidence, device certification, recovery drill and independent penetration test. See newest `docs/LEDGER.md` entry.

- **2026-09-02: `app.luminapos.in` brought fully up and license-activated for real (Track A8/§9
  bootstrap flow), one code bug and one self-inflicted ops mistake found and fixed along the way.**
  `GOLD_POS_SECRET_KEY` generated and set (was entirely missing — provision-pipeline.sh doesn't
  auto-generate this one, by design, since losing an auto-generated master key nobody saw would be
  catastrophic). Temporary `gold-pos-bootstrap` PM2 process (`NODE_ENV=development`, per
  `deploy/README.md` §9 step 2) used to reach the admin UI while the real process still refuses to
  bind on the three expected blockers (demo Razorpay creds, no webhook secret, default PIN).
  **Found: `backend/licenseChecker.js` resolved its public-key path from `process.cwd()` instead
  of `__dirname`** — every sibling key-reading file already used the correct pattern; fixed,
  committed, pushed (`bfb32d2`). **Found: a raw `git reset --hard` during the 2026-09-01 session
  (instead of `deploy/remote-deploy.sh`) had silently reverted `licensing_server/keys/
  license_public.pem` back to its git-tracked placeholder**, so the real signing key and the
  public key being checked against had quietly diverged — rebuilt both from their private keys
  and re-synced every copy. **Lesson for next time: always use `deploy/remote-deploy.sh` to sync a
  checkout on this VPS, never a raw `git reset --hard`** — the script restores the signing-key
  overlay automatically, a bare reset does not. Verified end to end:
  `POST /api/license/activate {"licenseKey":"DEMO-KEY-12345"}` against `https://app.luminapos.in`
  now returns `"success":true`. Full detail: `docs/LEDGER.md` 2026-09-02.
  **Still open:** Razorpay test keys + webhook secret + admin PIN change — user has the values,
  needs to enter them in Settings; then tear down `gold-pos-bootstrap` and restart the real
  `gold-pos-live` via `deploy/remote-deploy.sh`.
- **2026-09-01: first real VPS provisioning run — `docs/GO_LIVE_CHECKLIST.md` Track A5 done
  against `luminapos.in` (DigitalOcean, `--profile minimal`), closing security-audit L2 for real.**
  `https://license.luminapos.in/api/health` answers over real DNS/TLS/Nginx/ufw, verified by curl
  from outside the VPS. `app.luminapos.in` correctly 502s (Track C/A8 — real Razorpay/PIN/rate
  config — not done, not this session's scope). Found and fixed a real bug along the way, not
  specific to this box: `deploy/ecosystem.base.cjs`'s PM2 `cwd` didn't match where
  `provision-pipeline.sh` writes each app's `.env`, so `dotenv/config`'s default `process.cwd()`
  lookup silently found nothing on either app — `licensing-live` was running the placeholder
  `ADMIN_SECRET` until this was fixed via `DOTENV_CONFIG_PATH` in the one shared ecosystem-config
  choke point. **This fix is committed locally but not yet pushed — see below.** Also fixed: a
  PowerShell `-N '""'` quoting bug that left both local deploy SSH keys (`luminapos_admin`,
  `gold_pos_ci`) encrypted with an unintended literal-`""` passphrase, silently breaking
  unattended use; repaired in place, no regeneration needed. Full detail: `docs/LEDGER.md`
  2026-09-01 (second row), `docs/GO_LIVE_CHECKLIST.md` A0–A5, A7.
  **Since resolved, same session:** `deploy/ecosystem.base.cjs` committed and pushed (`1ca9738`),
  both VPS checkouts `git reset --hard` to match and restarted from the clean tree. **A6 also
  done**, via `gh` CLI (repo is public, already authenticated as owner) rather than the manual UI:
  `VPS_HOST`/`VPS_USER`/`VPS_SSH_KEY` secrets, `PIPELINE_DOMAIN` variable, `production` environment
  with `Vishalnayak226` as sole required reviewer — all confirmed via `gh secret list`/
  `gh variable list`/the environment API response.
  **Still open:** A7's CI-driven verification (push to `main`, watch `cd-live.yml` pause for
  approval — the infra-reachability half is already proven manually, see above); A8/Track C (real
  Razorpay/PIN/rate-provider config to actually bring `app.luminapos.in` up).
- **2026-09-01: security-audit follow-up (L1, L3, L2 closed) committed and
  merged to `main`, plus two pre-existing `npm test` failures fixed.** Security work:
  `backend/cryptoHelper.js`/`backend/blackBoxLogger.js` now refuse to auto-generate a fresh RSA
  keypair in production when the shipped public key is missing (L1); a warning comment at
  `app.set('trust proxy', 'loopback')` in `backend/server.js` documents why it must not be widened
  before H1 is fully hardened (L3); new `deploy/verify-nginx-proxy.sh` proves
  `deploy/nginx.conf.template`'s proxy_pass/header forwarding without needing a live VPS — L2
  itself stays OPEN, DNS/TLS/firewall genuinely need real infrastructure (CLAUDE.md §7). Test
  fixes (found while verifying the tree before merging to `main` — neither is a regression from
  this session's own changes): `test_http.js`'s management-reports check wasn't re-enabling the
  setting an earlier test had reset in cleanup; `test_suite.js`'s backup-encryption restore drill
  was snapshotting a completely empty ledger, now seeds one fixture deposit first;
  `verifyBackup.js --quiet` no longer swallows its own failure summary. Full detail:
  `docs/LEDGER.md` 2026-09-01 row, `docs/SECURITY_AUDIT.md` L1/L2/L3 sections.
  **`cd backend && npm test` — 618 checks, green, exit 0, all nine suites.** Working tree clean;
  `main` and this branch are even.
- **Security audit remediation (C1–C5, H1–H8) — committed `aaa4af3`, 2026-08-24.** Full detail in
  `docs/LEDGER.md` and `docs/SECURITY_AUDIT.md` (each finding's own section says what closed it,
  or why it wasn't addressed — M1, M3-M5 still open by design). The #1 finding was architectural:
  `POST /api/settings` was gated only by session auth, so any signed-in cashier could rewrite the
  whole settings document, including adding themselves as `owner`.
- **Phase 44 was completed 2026-08-24 and committed from the shared working tree on 2026-08-25.** Migration 016,
  billing-linked sale/return/void lot movements, SKU auto-fill, return exchange, same-day void,
  the verified filesystem off-site backup destination, and four explicitly-defined management
  reports are described in the newest `docs/LEDGER.md` row. Full `npm test` is green across all
  nine suites; migration safety is 16/16; `npm audit` reports 0 vulnerabilities; Playwright is
  44/44 green, including the new catalogue→sale→exchange→void→reports browser journey. The report
  definitions are operational, not statutory, and still need merchant/accountant acceptance.
  Off-site copy still needs a real remote mount and recovery
  drill; whole-archive encryption is not implemented.
- **Concurrent work is present; do not stage it as Phase 44.** Another session changed
  `backend/adminAuth.js`, `frontend/customer.html`, `licensing_server/package-lock.json`,
  `licensing_server/package.json`, `licensing_server/server.js`, and added `frontend/js/adminAlertOverride.js`,
  `frontend/js/customer-app.js` and `frontend/js/customerAlertOverride.js` while this phase was
  being built. `docs/SECURITY_AUDIT.md` is also an untracked user file. None was removed,
  rewritten or intentionally included in Phase 44. The shared PIN-hardening change raised new PINs
  to 6–8 digits; stale four-digit fixtures in `test_http.js`/`test_suite.js` were updated so the
  combined tree could be verified.
- **Latest commit: `37591f7` — "Phase 43: customer master and accounting exports"** (2026-08-21),
  on branch **`phase-21-payment-verification-and-production-guard`**, **8 commits ahead of
  `origin/phase-21-payment-verification-and-production-guard`, not pushed.** The working tree is
  CLEAN as of 2026-08-22 — verified with `git status` immediately before writing this entry.
- **What the 8 commits are.** A single prior session's work — six flagged-off Phase 41 units
  (audit retention, wastage, PITR, old-gold exchange, an incident-response runbook draft, gold
  savings schemes) plus two neighbouring phases built concurrently in the same tree by other
  sessions (Phase 42: SKU catalogue metadata; Phase 43: customer master + accounting exports) —
  had accumulated **uncommitted** across many turns, entangled in shared files (`server.js`,
  `repositories/index.js`, `defaultSettings.js`, `test_schema.js`, `test_repositories.js`,
  `test_billing_math.js`, `test_http.js`, `billingMath.js`, `BillingDesk.js`,
  `SettingsManager.js`, `invoiceRepository.js`, `index.html`, both roadmap docs). Committing "all
  of it" as one lump would have buried eight independent, individually-flagged, individually-
  tested units in a single diff nobody could review or revert piece by piece. Reconstructed each
  as its own commit instead — "HEAD + only that unit's lines" for every shared file, built up
  commit by commit in the same order the file additions actually landed in — matching this repo's
  existing one-phase-per-commit convention and its own `docs/LEDGER.md` (which already carried one
  row per unit): `365a5ef` audit retention → `69bf564` SKU catalogue → `b76c89f` gold schemes →
  `21d6fd5` incident runbook → `04ade46` old-gold exchange → `fb1ec60` PITR → `1ce17a6` wastage →
  `37591f7` customer master. Full detail on each: `docs/LEDGER.md`, one row per phase/unit, same
  order.
  **All five money/behaviour-changing modules ship flagged off by default** —
  `auditRetentionEnabled`, `wastageEnabled`, `pitrEnabled`, `oldGoldExchangeEnabled`,
  `goldSchemeEnabled` are every one `false` out of the box, so this branch is byte-for-byte
  unaffected until a tenant opts in. The incident-response runbook (unit 5) is a draft, not a
  toggle. **Still explicitly open, by design**: the real audit/PII retention period, GST/RCM
  treatment on buying gold from a customer, the incident runbook's containment-authority and
  CERT-In/DPDP notification questions, and gold savings schemes' full legal/CA review — none of
  these units manufactures the sign-off it was blocked on.
  **Verification after the split**: `cd backend && npm test` — 9/9 suites, exit 0, on the fully
  reassembled tree (billing math, schema, repositories, concurrency, suite, routes, HTTP,
  production guard, alerting all green). Each commit was also syntax-checked
  (`node --check`) and, where practical, verified standalone against the money-math and schema
  suites before being folded into the next. `npm run test:e2e` was **not** re-run this pass —
  nothing here is new work, only a re-commit of already-tested code, and the prior session's own
  LEDGER rows already record full e2e passes for the units that touched a form.
  **Byte-for-byte fidelity**: the reassembled working tree was diffed file-by-file against a
  snapshot of the original (all-at-once) working tree taken before the split began; every file
  matched exactly except two trivial prose reflows inside doc comments, fixed to match. No code
  was rewritten in the process, only redistributed across commits.
- **Phase 33 (2026-08-17) — the request boundary.** `backend/rateLimit.js` (one bounded keyed
  counter; blanket 600/min per IP on `/api/*` with the probes and the Razorpay webhook exempt, plus
  named limits on registration, password reset, deposit claims, payment orders and the expensive
  admin operations) and `backend/validation.js` (`validateSettingsPatch()`'s engine lifted out —
  `validateBody()` now shape-checks the credential surface, and the settings validator is a
  two-line caller over the same code). **Fixed a real leak:** both credential lockouts used plain
  Maps that only shed an entry on a *successful* login, so one request per new IP grew them
  without bound. **No new dependency.**
- **Phase 32 (2026-08-16) — the operational boundary.** `GET /api/ready` (readiness) split from
  `GET /api/health` (liveness, dependency-free on purpose); graceful SIGTERM/SIGINT drain that
  flips readiness to 503 *before* closing the listener and closes the ledger *last*; one
  `X-Request-Id` per request, reused from an inbound header only when it matches
  `[A-Za-z0-9._-]{1,64}` because the value reaches a log file; structured fields on
  `logTelemetry()`/`logError()`; and **the first terminal error handler this app has had** — until
  now an unhandled throw reached Express's default handler, which renders the stack trace into the
  response body outside `NODE_ENV=production`. `kill_timeout: 15000` in both PM2 configs is
  load-bearing (PM2's 1600ms default would SIGKILL mid-drain). The three `cd-*.yml` smoke tests
  poll `/api/ready` instead of sleeping 3s. **Not covered:** signal delivery itself — Windows
  cannot emulate it, so the drain is tested by calling `shutdown()` directly.
- **Phase 30 (2026-08-16) — the e2e journeys caught up with the ledger.** 23 of the 43 Playwright
  journeys were failing after the Phase 29 cut-over, because every spec still asserted against the
  retired JSON ledger — files the importer reads once on first boot and nothing writes again. They
  were therefore comparing each journey's work against the frozen seed, and doing it *quietly*:
  stale JSON parses fine, so the failures looked like arithmetic bugs. Specs read SQLite through a
  new `readLedger()` fixture helper now. **43/43 green.** See `docs/LEDGER.md` Phase 30.
  - **Phase 29 (2026-08-15) — the ledger is SQLite now.** `server.js` reaches persistence only
    through `repositories/` and `services/`; every ledger `readJSON`/`writeJSON` call site is
    gone, and so are the ~500 lines of read-modify-write around them. `settings.json` and
    `license.json` stay JSON on purpose (§0). Also touched: `db.js` (ledger seeds retired),
    `customerAuth.js` (two storage functions), `importLegacyJson.js` (multi-line + tenders),
    migration `004`, and five repositories/two services for the multi-line widening.
  - **Phase 28 (2026-08-13)** — six files, all reviewed:
  - `backend/defaultSettings.js` — new `SETTINGS_FIELD_RULES` + `validateSettingsPatch()`;
    `SUPPORTED_GOLD_PROVIDERS` moved above them (it is referenced at module-evaluation time).
  - `backend/server.js` — calls the validator at the top of `POST /api/settings` and merges its
    canonicalised values; invoice-prefix/sequence and GST-slab reads in `POST /api/sales` now
    coerce and repair a poisoned settings.json instead of propagating it.
  - `frontend/js/lib/billingMath.js` — advance and per-line values floored at zero.
  - `frontend/js/components/SettingsManager.js` — 18 unescaped/uncoerced form fields fixed.
  - `backend/test_billing_math.js` (+5 checks), `backend/test_http.js` (+7 checks).
  - Plus `CLAUDE.md` §0/§8 and `docs/LEDGER.md`.
- **`npm test` is green across all eight suites — 443 checks, exit 0** (145 + 43 + 82 + 16 + 10 +
  28 + 103 + 16). Re-verified 2026-08-17 after Phase 33. **Playwright is green too — 43/43, 2.4m,
  re-run 2026-08-17 on the Phase 33 tree**, after it caught the sign-in bug below. One-off setup if
  the binary is missing: `cd backend && npm install && npx playwright install chromium`.
  - **⚠️ READ THIS BEFORE TRUSTING A GREEN `npm test`.** On 2026-08-17 all eight suites passed
    while **every admin sign-in was broken**: a Phase 33 body schema refused `totpCode: ""`, and
    the HTTP suites post only `{pin}` where a browser posts every field its form owns. Playwright
    caught it; nothing else did. `test_http.js` now carries a check that posts the browser's exact
    login shape, but the general rule stands — **run `npm run test:e2e` before calling anything
    that touches a request body, a form or an auth path done** (`CLAUDE.md` §8).
- **What the hardening pass established, and what it did NOT find.** The transactional core held
  under every attack: concurrent sales produced unique invoice numbers with no lost writes,
  concurrent returns refunded exactly once, concurrent advance redemption double-spent nothing,
  no prototype pollution, no path traversal, no IDOR or privilege escalation across the
  customer/admin/cashier boundaries, payment and webhook signatures fail closed. **Every defect
  found was above that core** — in settings type-handling, in the money module's tolerance of
  negative inputs, and in Settings-screen escaping. Treat the concurrency and auth boundaries as
  genuinely covered; do not re-derive them.
- **Phases 24–27 are in `82d8b3e`.** `npm test` was green (403 checks) immediately before it.
  - **Phase 24** — ADR-001 plus the transactional-schema foundation: `docs/adr/`,
    `backend/repositories/{connection,migrate}.js`, `migrations/001_initial_schema.sql`,
    `backend/test_schema.js`. Node floor moved to 24.
  - **Phase 25** — multi-line invoices and the four audit gaps: `lines[]` alongside the flat
    rollup, read through `saleLines()` in `frontend/js/lib/billingMath.js`.
  - **Phase 26** — the SQLite seam below the routes: `backend/repositories/` (all SQL),
    `backend/services/` (sale, return, advance, payment), `backend/importLegacyJson.js`,
    `test_repositories.js`, `test_concurrency.js`.
  - **Phase 27** — scrypt-hashed PINs, TOTP enrolment with recovery codes, session revocation,
    secret masking on `GET /api/settings` and the support export.
- **✅ THE ROUTE CUT-OVER IS DONE (Phase 29, 2026-08-15).** The seam is live, not dormant.
  **It was not the one-for-one mapping this section used to predict**, and the difference is worth
  knowing before trusting any similar estimate: Phase 26 built the repositories when an invoice
  held one gold item, while Phase 25 had already taught the Billing Desk to file multi-line carts.
  So the seam was *behind* the routes on the invoice path — `toLegacySale()` flattened to
  `lines[0]` and emitted no `lines[]`/`tenders[]`/`actor`, `createSale()` took one item,
  `returnService` refunded against `lines[0]`, and the importer rejected a MIXED invoice outright.
  Widening it was a prerequisite, and it is most of what Phase 29 actually was. Advances, payments
  and customer accounts *were* one-for-one, as predicted.
  - **A security bug the cut-over would have introduced, caught before it landed.** Operators live
    in `settings.json` while the ledger's accountability columns are foreign keys into `users`,
    which held two bootstrap rows. The services default `actorUserId` to the owner, and
    `advanceService` gates posting on `users.isApprover()` — where `owner` passes. Every cashier
    would have passed the approver check that exists to stop a cashier releasing money to
    themselves. Closed by `users.ensureActorUser()`, which maps the session's actor onto a real
    `users` row and keeps role/active state in step with the roster.
  - **Per-line sums equal the header** — asserted in `test_concurrency.js` ("every concurrently
    written invoice is complete, with its line") and structurally in `saleService`, which derives
    both from one `computeInvoiceTotals()` call.
  - **Tender sum = total is enforced whenever the caller supplies tenders — and the Billing Desk
    now always does** (landed 2026-08-12), so the assertion is live on every desk sale rather than
    theoretical. The desk defaults to a single cash row tracking the total, sends it *without* an
    amount so the server's own total wins over a stale browser one, and sends explicit amounts once
    the cashier splits. Tenders stay **optional on the API** because every invoice already on disk
    has none and must stay readable — an absent tender means unknown, not zero, and a speculative
    "cash" row for the balance would record a fact about how the customer paid that nobody
    established. Covered by `test_http.js` §"Tenders".
  - **`customerAuth.js` moved on its two storage functions alone**, exactly as predicted —
    `customerRepository.loadAccounts`/`saveAccounts` already spoke the legacy account shape, so
    the twenty-odd call sites above them are untouched. The ledger seeds in
    `db.js#initDatabaseFiles` are retired: `readJSON(file, default)` WRITES its default, so
    leaving them would recreate empty ledger files on every boot that look like an intact ledger
    and would be imported as one.
  - **First boot after this migrates a tenant automatically.** `initialiseLedger()` in
    `server.js` runs migrations, seeds the organisation, and — only when the database is empty
    and legacy JSON exists — runs `importLegacyJson` once, loudly, taking a checkpointed backup
    first. **The JSON files are left exactly where they are**, as the rollback path. Verified
    against a copy of this tenant's own `backend/data`: 4 invoices, 4 advance entries, 1 payment
    order, reconciled `ok` on all nine measures. **This repo's own `backend/data/` has NOT been
    cut over** — it still holds only JSON, and will migrate on the next `Restart_Server.bat`.
- **Two owner decisions were taken on 2026-08-11 and are now binding:** ADR-001 accepted as the
  **SQLite bridge** (not PostgreSQL — `docs/adr/ADR-001-transactional-datastore.md` has the
  argument and the four revisit triggers), and the manual-UPI approver is a **distinct named
  role**, with the identity slice pulled forward into Phase 1. Also: **there is no SKU concept** —
  roadmap §4's whole Catalogue domain is struck.
- **The data store migration is COMPLETE for every ledger domain.** Invoices, lines, tenders,
  credit notes, advances, payment orders/events and customer accounts are all SQL. What remains
  JSON is configuration only — `settings.json`, `license.json`, `rates.json` — and stays that
  way by design. Do not add a new JSON ledger document or a new
  `readJSON`/`writeJSON` caller; see CLAUDE.md §0. `settings.json` and `license.json` are
  configuration, not ledger, and stay JSON deliberately.
- **Node floor is now 24**, not 20 — `node:sqlite` is only stable and flag-free from 24.
- **`backend/data/` is clean.** An early run of the new `test_suite.js` Test 7 wrote a synthetic
  `9000000123 / Reset Tester` account into `customer_auth.json` before the data-directory
  redirect was fixed; the row was removed on 2026-08-09 with the user's confirmation (CLAUDE.md
  §6), after verifying no other data file referenced it. The cause is fixed — see the §8 note
  about setting `GOLD_POS_DATA_DIR` before anything imports `db.js`.
- **Run `cd backend && npm install` after checking out `main`.** Two reasons now: the Phase 21
  nodemailer `^9.0.5` / node-cron `^4.6.0` bumps, and the new `@playwright/test` **devDependency**.
  Runtime deps are unchanged. Playwright additionally needs `npx playwright install chromium`
  (one-off, ~130 MB) before `npm run test:e2e` will run; `npm test` does not need it.
- **Branches:** `origin/main`, `origin/develop` and `origin/staging` are ALL still at `e4999bc`
  (Phase 19). The local branch is **10 commits ahead** and nothing has ever been pushed past
  Phase 19. **This is why the CI gate has never executed** — not the missing deploy target. The
  trigger was fixed on 2026-08-11 (`daily-checks.yml` now also runs on `pull_request` against any
  branch), but a green run still needs the branch pushed and a PR opened.
- **Servers:** not running (start with `Restart_Server.bat` → :5000; licensing server → :6060). The
  Phase 25 verification used a throwaway tenant on :5099 via `GOLD_POS_DATA_DIR`; it was stopped and
  its directory deleted. Note `GOLD_POS_DISABLE_BOOTSTRAP=1` suppresses the listener entirely — set
  it only for suites that own their own listener.
- **Concurrent-session risk:** normal — the tree is clean as of 2026-08-13, so there is no longer
  another session's half-finished work sitting in it. Still run `git status`/`git diff` and stage
  only files you reviewed — never `git add -A`.
- **Last unit of work:** **Phase 27 — the four security gaps Phase 25 left open** (2026-08-13,
  committed in `82d8b3e`). Full detail in `docs/LEDGER.md`; the four in one line each:
  1. **PINs are scrypt hashes**, master and per-operator, in the same format `customerAuth.js` uses
     for customer passwords. An existing tenant migrates on its next boot with nobody retyping
     anything. **One tenant-wide `authSalt`** because a PIN-only login has no username to look a
     per-user salt up by; that makes duplicate-PIN detection exact, and duplicates were already
     forbidden. Salt and hashes are masked from `GET /api/settings` and the support export.
  2. **Session revocation.** Deactivate, remove, re-PIN or demote an operator and their live
     sessions end in the same request. An owner/manager can list every live sign-in and end one;
     the listing carries opaque handles, never tokens.
  3. **Privileged MFA.** Per-operator TOTP (RFC 6238, `node:crypto`, no new dependency) with ten
     single-use hashed recovery codes. Enrolment requires a live code. `requireMfaForApprovers`
     makes releasing money need a session that passed the factor — which the shared master PIN
     cannot do, by design.
  4. **Refund approval threshold.** `refundApprovalThreshold` refuses a refund at or above it
     unless an owner/manager authorises, checked against the server's own priced amount. 0 = off,
     the default.
  - **⚠️ RULE THAT CAME OUT OF A REAL MISTAKE:** a **static** `import` of anything reaching `db.js`
    at the top of a test suite pins that suite to the real `backend/data`, because ESM hoists
    imports above the `process.env.GOLD_POS_DATA_DIR = …` lines. It happened here — `test_http.js`
    booted against the live tenant and migrated its `settings.json`. The file was repaired (snapshot
    in the session scratchpad; it now differs from `backups/backup_2026-08-10` only by three
    additive defaults) and both HTTP suites now use a dynamic `await import()` after the env is set.
    `test_routes.js` also unsets the vars afterwards, because `GOLD_POS_DATA_DIR` outranks the
    `GOLDPOS_DATA_DIR` its child spawn passes. A full `npm test` is verified byte-for-byte not to
    touch `backend/data`. See CLAUDE.md §8.
  - **Also fixed:** `DEFAULT_SETTINGS` must never hold a credential. It held `adminPin: "1234"`,
    and because that template is merged over a tenant's settings on every boot, the plaintext was
    re-added right after the migration deleted it. Defaults are now *seeded* by
    `migratePinsToHashes()`, never merged.
  - **Tests: 403 checks** (140 + 43 + 71 + 16 + 9 + 28 + 80 + 16) and 43 Playwright journeys, all
    green. New: `test_suite.js` Test 8 (PIN hashing/migration) and Test 9 (**TOTP against the
    published RFC 6238 vectors** — the only check that proves a real authenticator app will work).
  - **Still open here:** a 4-digit PIN keyspace does not survive file theft whatever the KDF (the UI
    allows 8; the copy asks for 6+); Razorpay/SMTP secrets are still plaintext on disk because those
    must be *presented* to a third party, not verified; there is no append-only audit trail yet
    (`audit_events` exists and `server.js` does not write it); and there is no dual control — one
    manager can still both authorise and take a large refund.

- **Previous unit of work:** **Phase 25 — the four audit gaps** (2026-08-12, uncommitted). Full detail
  in `docs/LEDGER.md`; the four in one line each:
  1. **Actor identity.** Named operators with per-person PINs and the four schema roles live in
     Settings → Staff & Roles. The PIN identifies as well as authenticates; `requireAdminSession`
     attaches `req.actor` at the single choke point, and the sale, refund, advance redemption,
     counter deposit and deposit approval all name a person. `requireApprover` gates deposit
     approve/reject to owner/manager. A store with no operators still works on the master PIN,
     resolving to the `owner` bootstrap identity.
  2. **Multi-line invoices.** `lines[]` on the request and the record, with per-line figures
     **allocated** out of the header in integer paise — so a one-line invoice prices to the identical
     paise as before and the printed rows always sum to the total. Read every stored sale through
     `saleLines()`; the flat rollup is retained so pre-multi-line readers keep working.
  3. **Tenders.** `tenders[]` on the sale, validated in paise to sum exactly to the amount payable
     after any advance. Empty means "not recorded", never "paid nothing".
  4. **Bounded ledger reads.** `/api/sales`, `/api/returns`, `/api/advances` now page, with the
     aggregates the screens were summing moved server-side. New `/api/advances/customers` rolls
     balances up per customer.
  - **Next obvious steps:** the SQL cutover can now map `actor` → `created_by_user_id`,
    `reviewedBy` → `approved_by_user_id`, `lines[]` → `invoice_lines` and `tenders[]` → `tenders`
    one-for-one, since all four were built to the schema's own vocabulary.
  - The three security items this phase deferred (hashed PINs, session revocation, MFA) and the
    refund threshold it named as the obvious next control were all done in **Phase 27** above.

- **Previous unit of work:** **Phase 23 — Returns & Refunds** (2026-08-11, uncommitted, on top of
  Phase 22 below).
  - **New Return Desk tab** (`frontend/js/components/ReturnDesk.js`) and a new year-partitioned
    ledger `returns_YYYY.json`, filed under the year the **refund** happened, not the invoice's
    year. Routes: `POST /api/returns`, `GET /api/returns` (both admin-gated) and the
    session-scoped `GET /api/customer/returns` (read-only — there is deliberately no customer
    way to raise one).
  - **The refund is priced by the original invoice, never by today.** `computeReturnRefund()` in
    `billingMath.js` rebuilds it from the stored sale's own rate/making/discount/slab/mode through
    the same `computeInvoiceTotals()` that priced the sale. The browser previews with it; the
    route re-runs it authoritatively and files *its* answer.
  - **The refunded gross is `totalAmount + appliedAdvance`.** An advance spent on the original
    bill was the customer's own money, so it is part of the value owed back — re-crediting it
    separately would pay the same rupees out twice.
  - **Partial returns by weight, cumulative.** State is *derived* from the returns ledger
    (`summarizeInvoiceReturns` / `withReturnState`); the sale record is never rewritten, so a
    reprint still reproduces the original. The closing return is trued up to the exact unrefunded
    remainder, so refunds against one invoice always sum to its filed gross to the paise.
  - **Two modes.** `cash` writes only the return row. `gold` also credits the advance ledger as an
    approved deposit with a locked 22K rate, in the **same** `writeJSONTransaction` — extracted
    `buildAdvanceDepositRow()` so a refund credit and a counter deposit are one row shape.
  - **Mobile:** `customer.html` history merges cash refunds as their own rows and relabels gold
    refunds as `RETURN CREDIT` against their invoice. A gold refund appears **once** (the credit
    row that moved the balance), never twice.
  - **Also netted through:** the email summary report subtracts refunds from revenue, and the
    Level-2 diagnostics export bundles `returns_*.json`.
  - **Verified:** `npm test` → **5/5 green, 216 checks** (114 billing / integration / 27 route /
    44 HTTP / 16 guard); `npm run test:e2e` → **43/43** (31 desktop + 12 mobile). `npm run seed`
    ships 3 returns (2 cash, 1 gold credit). Brain redrawn — 106 files, 100% coverage.
- **Previous unit of work:** **Phase 22 — self-service password reset, 10-digit customer number,
  tax-base proof, Reprint Desk** (2026-08-09, uncommitted, on top of the Phase 0 work below).
  - **Customer password reset no longer needs the counter.** The "Forgot password?" pane always
    opens (it used to `alert()` and refuse when the tenant had no SMTP), self-registration
    requires an email, the portal's landing tab prompts an email-less customer to add one, and
    `issue-login` returns `hasEmail` so the counter screen can tell the cashier to ask for it.
    Settings' SMTP block now states whether customer self-service reset is live.
  - **`test_suite.js` Test 7** covers the reset-code lifecycle, which had *no* coverage despite
    Test 5's comment claiming otherwise. It also fixes the suite writing into the real
    `backend/data/` — `db.js` resolves `DATA_DIR` at import and ESM caches it, so the env
    redirect has to happen at the top of the file, not inside a test.
  - **Billing Desk rejects a 1–9 digit customer number** before POSTing, reading the value off
    the input rather than off `this.customerPhone` (autofill/paste never fire `input`).
  - **Tax on metal + making was already correct** in `computeInvoiceTotals()` and is unchanged;
    `test_billing_math.js` group 11 (8 checks) now proves it in isolation in both modes. Invoice
    line relabelled `Taxable Value (Metal + Making)`.
  - **New Reprint Desk** — `GET /api/sales/lookup` + `frontend/js/components/ReprintDesk.js`,
    nav tab between Billing Desk and Customer Advances. Prints the **stored** record stamped
    `DUPLICATE — REPRINT`, never re-priced against today's settings. Pre-Phase-20 records show
    their tax lines as *not recorded* rather than ₹0.00.
  - **`PRINT INVOICE` had been printing a blank page.** The print stylesheet hid
    `.tab-panel:not(#tab-billing)`, and `#tab-billing` matches nothing (the panel is
    `#sales-tab`), so it hid the sheet it meant to show. Now keyed off `.tab-panel.active`.
  - **Verified:** `npm test` → **5/5 suites green** (91 billing + integration incl. Test 7 +
    27 route + 25 HTTP + 16 guard); `npm run test:e2e` → **30/30** (21 desktop + 9 mobile),
    including new `reprint-desk.spec.js`.
- **Earlier unit of work:** **Production-readiness Phase 0 remediation** (2026-08-09, uncommitted).
  Closes seven roadmap items in `PRODUCTION_READINESS_ROADMAP.md` §5 Phase 0:
  - **Razorpay webhook + capture confirmation.** `POST /api/payment/webhook` (HMAC over the raw
    body, event-id idempotency, out-of-order tolerant, licence-gate exempt), and
    `/api/payment/verify` now asks the gateway whether the payment was actually *captured* for
    the order's exact amount instead of treating a valid signature as proof of payment.
  - **Server-authoritative rate, metal value and time.** `/api/sales` derives the rate from
    `getActiveGoldRates()` and the metal value from weight × rate; the `...req.body` spread is
    gone, replaced by an explicit allowlist, so a client can no longer backdate an invoice or
    inject ledger fields.
  - **Fail-closed production startup.** `backend/productionGuard.js` — the process exits 1 rather
    than booting with demo keys, the default PIN, a mock rate provider, no webhook secret, no
    https public URL, or a `NODE_ENV`/`ENV_NAME` mismatch.
  - **Strong IDs and paise.** `newId()` in `db.js` (CSPRNG) replaces `Math.random()` ledger ids;
    payment orders persist `amountPaise`, `currency`, `status` and `expiresAt`.
  - **Seeded dev/test data.** `backend/seed.js` (`npm run seed`) — deterministic, synthetic,
    refuses to write over `backend/data/`.
  - **Playwright journeys.** `backend/tests/e2e/` — cashier + customer, desktop and 390px mobile.
  - Two new settings keys reach existing tenants through the usual `getDefaultSettings()` merge:
    `razorpayWebhookSecret` (redacted, write-only) and `publicUrl`. Both have Settings UI.
  - **Verified:** `cd backend && npm test` → 83 billing + 6 integration + 27 route + 25 HTTP +
    16 guard = **157 checks green**; `npm run test:e2e` → **16/16 green** across both viewports.
    `backend/data/` untouched throughout (every suite uses a temp directory).
  Detail in `docs/LEDGER.md`; manual steps in `docs/TESTING_CHECKLIST.md`.
- **Next session should start with:** committing the Phase 0 and Phase 22 work above (branch
  first — CLAUDE.md §6 — then `git add` only reviewed files; consider two commits, since the two
  units are independent). After that the remaining Phase 0 items are
  `npm ci` in the CI gates and converting manual UPI to a *manager*-reconciled claim (it is
  already a pending claim, but any admin can approve it). `main` is also overdue its first push:
  `origin/main` is 8 commits behind. Scheme phases 20.2–20.5 remain blocked on the seven product
  decisions in `SCHEME_MODULE_PLAN.md` §7, and the deploy pipeline remains blocked on a domain
  and VPS.

---

## 1. Directory Structure Layout

The standard project folder hierarchy is organized as follows:

```
├── backend/                       # Client POS Express Backend Application
│   ├── keys/                      # Public keys folder
│   │   ├── developer_public.pem   # Developer public key for Level 2 exports
│   │   ├── license_public.pem     # Central licensing authority public key
│   │   └── release_public.pem     # Release-signing public key (verifies updateEngine.js downloads) — §7
│   ├── extensions/                # Tenant customization surface — never touched by an update. §6
│   │   ├── index.js                #   loader/hook-dispatcher (core file, IS updated by patches)
│   │   └── *.extension.js          #   tenant drop-ins (NOT touched by patches) — see README.md
│   ├── data/                      # Atomic JSON databases
│   │   ├── settings.json          # GST tax rates, overrides, Razorpay credentials
│   │   ├── license.json           # Local licensing status cache (also holds pendingRelease/lastAppliedRelease — §7)
│   │   ├── advances.json          # Customer advances credits ledger
│   │   └── sales_YYYY.json        # Partitioned annual transaction databases
│   ├── logs/                      # Error and telemetry flat logs
│   ├── backups/                   # Dated rolling database snapshots (7-day retention)
│   ├── _rollback/, _staging/      # updateEngine.js scratch dirs (pre-apply snapshot / download+extract) — §7
│   ├── db.js                      # Atomic file writers, logTelemetry, and logError
│   ├── priceEngine.js             # Yahoo Finance XAU sync cron and overrides manager
│   ├── cryptoHelper.js            # RSA-4096 / AES-256-GCM diagnostics export envelope
│   ├── licenseChecker.js          # RSA verification and 7-day grace checks
│   ├── backupEngine.js            # Daily backups cron scheduler and pruner
│   ├── updateEngine.js            # Signed release verification, tiered auto/manual apply, rollback — §7
│   ├── server.js                  # Main API router routing payments, sales, and analytics
│   └── test_suite.js              # Assert-driven system integration test suite
│
├── frontend/                      # Client POS Frontend Application
│   ├── css/
│   │   └── app.css                # PDF print-ledger vanilla style rules (100vh lock)
│   ├── js/
│   │   ├── components/
│   │   │   └── BillingDesk.js     # Cashier checkout, bi-directional rounding, looked-up advances
│   │   ├── extensions/index.js    # Tenant frontend customization surface, never touched by an update — §6
│   │   ├── app.js                 # Navigation controller and boot licensing checker
│   │   └── qrGenerator.js         # Offline canvas UPI QR code drawer
│   ├── index.html                 # POS cashier central single-page interface
│   └── customer.html              # Customer mobile portal (Razorpay payments and ledger lists)
│
├── licensing_server/              # Central SaaS Licensing Microservice (Serverless ready)
│   ├── keys/
│   │   ├── license_private.pem    # Central RSA private key for signing activation tokens
│   │   ├── license_public.pem     # Backup public key file
│   │   └── release_private.pem    # Release-signing private key — signs every published release manifest. §7
│   ├── data/
│   │   ├── licenses.json          # Central tenant licenses database
│   │   └── config.json            # latestVersion + full signed release registry — §7
│   ├── server.js                  # Express licensing endpoints and admin HTML dashboard (incl. "Publish Release")
│   └── README.md                  # Deploy guide (Cloudflare Workers / Vercel KV)
│
├── developer_doomsday_keys/       # Scratch directory (Developer-only offline keys)
│   └── developer_private.pem      # RSA private key used to decrypt Level 2 exports
│
├── .github/workflows/             # daily-checks.yml (detection-only, never deploys — §7) +
│                                   # cd-dev.yml/cd-sandbox.yml/cd-live.yml (owner's internal
│                                   # Dev->Sandbox->Live pipeline, SSH+PM2, Live gated on manual
│                                   # approval — deploy/README.md §8, PROJECT_PLAN.md §5.14)
├── dist/                          # Generated clean production build assets folder
├── release_pipeline.js            # Root bundle release script generating release zip files
├── Restart_Server.bat             # Kills anything on port 5000, then relaunches backend/server.js
├── CHANGELOG.md                   # Semver history + release-channel policy — §7
└── docs/                          # Documentation (this file, PROJECT_PLAN.md, BRD.md, LEDGER.md, credentials.md,
                                    # THIRD_PARTY_DEVELOPER_GUIDE.md)
```

---

## 2. Core Security & Licensing Flows

### A. Asymmetric Licensing Handshake
1. The Central Licensing Server holds a secure RSA-2048 Private Key (`license_private.pem`).
2. When the POS client requests license validation (`POST /api/license/verify`), the server compiles a state payload (including expiry dates, suspended/active states, and fingerprints) and signs it with the Private Key.
3. The client receives the payload and its signature. It cryptographically verifies the signature against the local `license_public.pem` key. This prevents client bypasses via local `hosts` redirects.
4. **Internet Grace Period:** If the licensing server is unreachable, the client checks `license.json`'s `lastHandshakeTime`. The system is permitted to run for a **7-day offline grace period** before closing the cashier gate.

### B. Two-Tier Diagnostics
*   **Level 1 (Telemetry):** Technical profiles (latencies, errors, memory) contain zero customer details. Accessible in plain text by developers at `/api/diagnostics/telemetry`.
*   **Level 2 (Database Export):** Sensitive JSON databases are bundled on request, encrypted with an ephemeral AES-256 key, and packaged into an envelope where the AES key is encrypted using the Developer's RSA-4096 Public Key. Decryptable only offline by the developer's private key (`developer_private.pem`).
*   `backend/data/customer_auth.json` is deliberately **not** in the Level-2 bundle. A support export should never carry credential material off a tenant's machine, even encrypted. If you extend the bundle, keep it out.

### C. Two Session Systems, Deliberately Different (added 2026-08-08)
Both issue an opaque bearer token checked by an Express middleware; they differ where the two audiences differ.

| | Admin / cashier (`adminAuth.js`) | Customer (`customerAuth.js`) |
|---|---|---|
| Credential | One shared PIN from `settings.adminPin` | Per-account password, scrypt-hashed (`scrypt$N$r$p$hex` + separate salt) |
| Sessions | In memory, 12h, lost on restart | Persisted as SHA-256 hashes on the account record, 30 days, max 5 devices, survive a restart |
| Lockout | Per-IP, in memory | Per-account (persisted, survives a restart) **and** per-IP (in memory, against stuffing) |
| Middleware | `requireAdminSession` | `requireCustomerSession`; `requireEstablishedCustomer` additionally blocks a counter-issued temporary password from doing anything but changing itself |

The rule that matters: **every `/api/customer/*` handler reads the phone from `req.customerPhone`, which the middleware sets from the session.** Never from `req.body` or `req.query`. Routes that legitimately name an arbitrary customer's phone (`GET /api/advances/lookup`, `POST /api/advances`) are admin-gated instead, because that is a cashier action.

An existing customer cannot self-register: `POST /api/customer/register` refuses a number that already has store history (`409 CLAIM_REQUIRES_STORE`) and the store issues the login at the counter via `POST /api/customer-accounts/issue-login`. Without an SMS gateway, that is what stops a stranger claiming someone else's ledger. When an SMS provider is chosen, OTP verification replaces this restriction rather than layering on top of it.

---

## 3. Key Billing Math & Precision Rounding
*   **Gold Weight multiplication:**
    $$\text{Base Metal Value} = \text{Gold Weight (g)} \times \text{Purity Price (per gram)}$$
*   **Making Charge Bi-directional binding:**
    *   Percentage shifts (between `1` and `100`%):
        $$\text{Flat Charge} = \text{Math.round}(\text{Base Value} \times \text{Percentage} / 100 \times 100) / 100$$
    *   Flat currency charge shifts:
        $$\text{Percentage} = \text{Math.round}(\text{Flat Charge} / \text{Base Value} \times 100 \times 100) / 100$$
    *   This bi-directional synchronization is reactively bound on keyup/change listeners inside [BillingDesk.js](file:///c:/Users/ABCD/Documents/Antigravity%20Projects/Web%20POS/frontend/js/components/BillingDesk.js).

---

## 4. Operational Commands & Maintenance

### A. Running the POS Client
1. Navigate to `backend/` and boot the service:
   ```bash
   cd backend
   node server.js
   ```
   Or, from the project root, double-click/run `Restart_Server.bat` — it kills any process already bound to port 5000 before launching a fresh `node backend/server.js`, which is the safest way to restart after code changes.
2. The POS desk interface will run at `http://localhost:5000` (serves `frontend/` statically). Admin terminal is at `/`, customer portal at `/customer.html`.

### B. Running the Central Licensing Server
1. Navigate to `licensing_server/` and start the server:
   ```bash
   cd licensing_server
   node server.js
   ```
2. Dashboard runs at `http://localhost:6060` (moved off :6000 on 2026-07-13 — that port is on the WHATWG Fetch forbidden-port list and silently broke `backend/licenseChecker.js`'s fetch()-based handshake). Authenticate using the admin token from `ADMIN_SECRET` (see `licensing_server/.env.example`; local dev falls back to a default — see `docs/credentials.md`, not committed).

### C. Running Integration Tests
Verify all pricing formulas, rounding math, grace calculations, and RSA envelopes by executing the assert test suite:
```bash
cd backend
node test_suite.js
```

### D. Packaging a Platform Release
Execute the release pipeline script to compile clean assets into a distributable archive:
```bash
node release_pipeline.js
```
The output zip file is created at `gold_pos_release.zip`.

### E. Publishing a Release to the Tiered Update Engine
After packaging (§D above), host the zip somewhere reachable by tenants
(e.g. attach it to a GitHub Release, or any URL `fetch()` can download from),
compute its SHA-256, then publish it via the licensing server dashboard
(`http://localhost:6060` → "Publish Release" form) or directly:
```bash
curl -X POST http://localhost:6060/api/admin/releases \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"version":"1.1.1","channel":"patch","changelog":"...","downloadUrl":"https://...","sha256":"..."}'
```
`channel` is `security` (auto-applies to every tenant on their next daily
check), `feature`, or `patch` (both surface as a manual "Apply Update Now"
banner). Full mechanism in §7 below.

### F. The Owner's Internal Dev/Sandbox/Live Pipeline
Separate from the per-tenant release process above — see
`deploy/README.md` §8 for the full runbook. Short version: push to
`develop`/`staging`/`main` on GitHub triggers `cd-dev.yml`/`cd-sandbox.yml`/
`cd-live.yml`, each of which runs the test+audit gate, then deploys over SSH
via `deploy/remote-deploy.sh` and smoke-tests `GET /api/health`. Live
requires a manual approval click (GitHub Environment protection). Not yet
exercised end-to-end as of 2026-07-17 — no VPS/domain provisioned yet.

---

## 5. Frontend Implementation Notes & Gotchas

Details that aren't obvious from reading the API/architecture alone — merged in from an earlier parallel handover doc, verified against current source.

### A. Customer Portal (`customer.html`)
*   **Authentication (Phase 20.1, 2026-08-08):** phone + password, not phone alone. Three views swap in the same container — `#auth-view` (Sign In / Create Account / Forgot panes), `#force-change-view` (a counter-issued temporary password cannot reach any data until it is replaced), and `#portal-view`. The session token lives in `localStorage` and every call goes through the local `customerFetch()` helper, which attaches the bearer and drops back to sign-in on a 401 — the customer-side counterpart of `adminFetch()` in `app.js`. Server side: `backend/customerAuth.js`, routes under `/api/customer/*`.
*   **Layout:** 100vh mobile-app layout with a fixed bottom tab bar (Profile, Deposit, History, Account). `body` is locked (`overflow: hidden`); only the inner `#portal-view` scrolls, to prevent layout clipping on mobile browsers.
*   **Gold Appreciation Calculator (Profile tab):** shows how much a customer's cash deposits have appreciated. On deposit, the backend snapshots that day's `lockedGoldRate22K` onto the advance record (see `getActiveGoldRates().price22K` in `POST /api/advances` and `POST /api/payment/verify`, `backend/server.js`). On profile view, the frontend fetches the *live* 22K rate and computes `Current Worth = (Deposit / Locked Rate) * Live Rate`.
*   **UI Alerts:** the global `window.alert` is overridden with a custom blurry modal overlay (success icon, etc.) instead of the native browser popup.
*   **Testing tip:** to see the Gold Appreciation Calculator move, manually lower `lockedGoldRate22K` on an existing entry in `backend/data/advances.json`, then reload the profile view.
*   **Razorpay mock behavior — caution:** the customer portal is written to expect an automatic mock-checkout bypass whenever `rzp_test_` keys are configured. **As of 2026-07-13 this is verified broken** — `backend/server.js` only mocks on the exact literal `rzp_test_xxxxxx`, and the live `settings.json` has a different test key, so real Razorpay calls are attempted and fail. Tracked as a must-fix in `PROJECT_PLAN.md` §5.3 (Phase 9).

### B. Admin POS Dashboard (`index.html`)
*   **Security:** hidden by default behind an Admin Terminal lock screen. As of Phase 9 (2026-07-13) the PIN is verified **server-side** (`backend/adminAuth.js`) against `settings.adminPin`, issuing a random bearer session token (`sessionStorage.adminToken`) required on every gated endpoint — the PIN is no longer client-only. As of the 2026-07-17 hardening pass, login attempts are also rate-limited (5 failures → 30s lockout, doubling up to 15 minutes) — see §6 below. (An earlier version of this doc described PIN checking as UI-only; that has been fixed and this note corrects it.)
*   **Unlock/Session:** on success, sets `sessionStorage.adminAuthenticated = 'true'` and restores `appViewport.style.display = 'grid'`. **Must stay `'grid'`, not `'flex'` or `'block'`** — the viewport layout uses CSS Grid and other display values break it.
*   **Logout:** sidebar logout button clears `sessionStorage` and re-shows the lock screen.
*   **Diagnostics Tab:** telemetry/log-export tools live in their own `diagnostics-tab`, kept separate from the Settings tab.
*   **Settings & Gold Overrides:** opening the Settings tab auto-fetches the current live gold price to pre-fill the override inputs; saving POSTs to `/api/settings` and immediately refreshes the Billing Desk's rate via `window.billingDesk.fetchGoldRate()`.
*   **Making Charge dual-input UI:** the percentage is collected via two side-by-side inputs in the markup but parsed/combined into one `makingChargePercent` float inside `BillingDesk.js`; typing a flat ₹ amount reverse-calculates and re-splits the percentage across both boxes.

---

## 6. Extension / Plugin Architecture (added 2026-07-17)

A tenant's own hired developer can customize their instance without ever
touching core files — see `backend/extensions/README.md` for the full
contract and `docs/THIRD_PARTY_DEVELOPER_GUIDE.md` for the broader
"working with 3rd-party developers" guidance (both the platform-owner and
tenant scenarios).

Summary for an incoming agent:
*   **Backend:** `backend/extensions/index.js` auto-discovers any
    `*.extension.js` file dropped into `backend/extensions/` and loads it
    at boot (`loadExtensions()`, called from `server.js` bootstrap). Hooks
    (`onSaleSaved`, `onAdvanceDeposit`, `onSettingsUpdated`, `onServerBoot`)
    fire via `fireHook()` **after** the core operation is already durably
    saved and the response already sent — fire-and-forget, wrapped in a
    3-second timeout and try/catch per extension, so a broken extension can
    never crash the server, block a response, or corrupt data.
*   **Frontend:** `frontend/js/extensions/index.js` (ships as a no-op stub)
    is dynamically imported once in `app.js` after core components are
    constructed, and receives `{ billingDesk, dashboard, advancesManager,
    settingsManager, adminFetch, logTelemetry }`.
*   **This is also the mechanism that makes the update engine (§7) safe for
    tenant customizations** — an applied release structurally never
    overwrites `backend/extensions/*.extension.js` or
    `frontend/js/extensions/` (see `PROTECTED_PATHS` /
    `isProtectedRelativePath()` in `backend/updateEngine.js`).

## 7. Tiered Auto-Update Engine (added 2026-07-17)

Supersedes the "no unattended auto-updater" line in `PROJECT_PLAN.md` §5.1
(now intentionally superseded by this system, per the platform owner's
explicit direction: security fixes may auto-deploy, but data must never be
touched and the manual/framework-stable release model otherwise stays).

**Versioning & channels** (`CHANGELOG.md`): semver (`MAJOR.MINOR.PATCH`).
Every release is published on one of three channels:
| Channel | Rollout |
|---|---|
| `security` | Auto-applied by every tenant's daily check |
| `feature` / `patch` | Surfaced as a banner; a human clicks "Apply Update Now" |

**Publishing a release** (platform owner, via the licensing server dashboard
at `http://localhost:6060`, "Publish Release" form): version, channel,
changelog, a `downloadUrl` (an already-hosted zip — e.g. the output of
`node release_pipeline.js` uploaded somewhere reachable by tenants), and its
SHA-256. The server signs `{version, channel, changelog, downloadUrl,
sha256, publishedAt}` with a **dedicated release-signing RSA-4096 keypair**
(`licensing_server/keys/release_private.pem` / `release_public.pem`,
auto-generated on first boot — deliberately separate from the
license-signing key, same compartmentalization pattern as the Level-2
developer key vs. the black-box key). The public half must be copied to
every POS client at `backend/keys/release_public.pem` (already done for
this repo's own client instance).

**Client side** (`backend/updateEngine.js`):
1.  Daily 2:00 AM check (`checkForUpdates()`, off-hours by design, same
    reasoning as the pricing/backup schedulers) fetches
    `GET /api/releases/latest?channel=security` from the licensing server
    and **verifies its RSA signature against the bundled
    `release_public.pem` before trusting anything about it** — a
    compromised or spoofed licensing server cannot get arbitrary code
    auto-applied to a tenant this way.
2.  A verified, newer `security` release is applied immediately
    (`applyUpdate()`); anything else newer is only ever recorded into
    `license.json.pendingRelease` for the Settings → License & Subscription
    "Apply Update Now" button (`POST /api/admin/update/apply`) — never
    applied without a human clicking it.
3.  `applyUpdate()` sequence: `createBackup()` (data safety net) →
    snapshot current code into `backend/_rollback/` (`snapshotTree()`) →
    download the release zip → **verify its SHA-256 matches the signed
    manifest before extracting anything** → extract to `backend/_staging/`
    → copy into place via `copyTreeExcludingProtected()`, which skips
    `backend/data/`, `backend/logs/`, `backend/backups/`, `backend/.env`,
    `backend/keys/`, `backend/extensions/*.extension.js`, and
    `frontend/js/extensions/` — **structurally, not just by convention**,
    this is what "a patch can never touch tenant data or customizations"
    actually means in code. Any failure at any step triggers
    `restoreFromRollback()` and leaves the tenant on the last-known-good
    version with nothing partially applied.
4.  Restart: under PM2 (`process.env.pm_id` set — see
    `deploy/ecosystem.config.cjs`), the process exits cleanly for PM2 to
    restart onto the new code. Outside PM2 (local/dev `node server.js`),
    it logs manual-restart instructions instead of force-exiting, since
    nothing would supervise a bare `node` process back to life.

**Verified end-to-end during this session**, in an isolated filesystem
sandbox (never against this repo's own live files): a manual `patch`-channel
apply, an automatic `security`-channel apply, and a deliberately-corrupted
release (wrong SHA-256) correctly rejected and rolled back — including
catching and fixing a real bug where the rollback snapshot step initially
copied nothing at all (its own destination path collided with the
live-tree protection filter; fixed by giving snapshotting its own simpler
copy function, `snapshotTree()`, entirely separate from
`copyTreeExcludingProtected()`).

**Daily detection (separate from deployment):**
`.github/workflows/daily-checks.yml` runs `backend/test_suite.js` and
`npm audit --audit-level=high` (both `backend/` and `licensing_server/`)
once a day and on every push. This only detects and reports — it never
publishes or applies anything. Turning a finding into a shipped release is
still: fix → review → publish via the dashboard above.
