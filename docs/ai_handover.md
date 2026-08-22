# AI Handover: Gold Business POS (SaaS Platform)

This document contains key architectural details, non-negotiable design guidelines, and developer context for the completed **Gold Business POS** SaaS platform. Any incoming AI agent or developer must strictly adhere to these instructions.

> **Fresh session: read §0 only.** The rest of this file is ~5k tokens of reference you almost
> never need up front. Standing rules live in root `CLAUDE.md` (auto-loaded); the reasoning
> behind them lives in `docs/FOUNDATION.md`.

---

## 0. Version Control & Handover Status

*Keep this section current whenever a unit of work finishes. Absolute dates only.*

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
