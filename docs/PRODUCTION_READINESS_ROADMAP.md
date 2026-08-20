# Gold POS — Production Readiness and Future-Proof Roadmap

**Audit date:** 2026-08-07  
**Reviewed:** working tree on `main` at `e4999bc`, including current uncommitted work  
**Status:** authoritative production plan; `PROJECT_PLAN.md` remains the feature-history ledger

## 1. Executive decision

This project can become a strong vertical retail platform for gold businesses. It already has a useful nucleus: gold-rate handling, billing arithmetic, advances, a customer portal, licensing, signed updates, deployment scripts, and a planned savings-scheme module.

It is **not ready for real-money production today**. The main gap is not visual polish or another feature. It is the financial and operational foundation: JSON storage cannot make an invoice number, sale, payment, and advance redemption one atomic transaction; several browser flows no longer match the protected API; payment amounts are not bound to stored orders; the shared admin PIN is not an accountable staff identity; and the tests do not exercise HTTP routes, persistence failures, browsers, payments, restores, or deployment.

The right order is:

1. Freeze feature expansion and close P0 correctness/security defects.
2. Move financial state to a transactional database and immutable audit model.
3. Prove security, recovery, compliance, and deployment in sandbox.
4. Run one controlled pilot store.
5. Add full jewellery-retail operations and the savings-scheme module.
6. Scale into tenant-aware SaaS and a richer mobile product.

> **Go-live rule:** do not enable live Razorpay, customer-entered manual UPI credits, automatic fleet updates, or a paying tenant until Phase 0 and Phase 1 exit gates are green.

## 2. Current architecture and capability

| Area | Current implementation | Assessment |
|---|---|---|
| Admin POS | Vanilla HTML/CSS/ES modules served by Express | Lightweight; browser/API regressions need automated coverage |
| Customer portal | One `customer.html`; backend now has password/session APIs | UI still uses legacy phone/public advance calls, so security is not wired end to end |
| API | One Express process and a 1,300+ line `server.js` | Keep a modular monolith, but split route, domain, and persistence concerns |
| Data | JSON files with synchronous atomic rename | Protects one file from torn writes; cannot provide multi-file transactions, constraints, indexes, or multi-process scale |
| Financial model | One aggregate gold line and a flat advances ledger | Useful prototype, not yet a complete jewellery POS/accountable ledger |
| Payments | Razorpay order call + browser callback verification; manual UPI reference | Missing persisted orders, amount binding, captured-state webhook, reconciliation, refunds, disputes |
| Identity | Shared four-digit admin PIN; customer password/session file | No named staff, roles, MFA, staff attribution, or verified mobile ownership |
| Licensing/updates | Separate licensing service, signed manifests, self-update | Promising base; high blast radius and not proven on a live VPS |
| Backups | Daily same-disk copy, seven-day retention | Convenience copy, not disaster recovery |
| CI/CD | Actions tests/audits and three-stage SSH deployment | Pipeline unexercised; gates omit key tests and rollback proof |
| Mobile | Capacitor remote-WebView scaffold | Not built/store-tested; one binary/domain per tenant will not scale |
| Extensions | In-process dynamic JavaScript imports | Trusted customization only; not a security sandbox |

### Strengths to preserve

- Shared browser/server billing arithmetic and 57 passing math checks.
- Server recalculation of discount and GST fields.
- Atomic per-file replacement and explicit handling of important write failures.
- Signed license payloads and release manifests, with non-production/production separation.
- Customer passwords hashed with scrypt and persisted sessions stored as hashes.
- Login throttling and a deliberately small dependency surface.
- Clear deployment intent and a domain-specific savings-scheme design.

## 3. Evidence-based risk register

### P0 — stop ship

| Finding | Current evidence | Required outcome |
|---|---|---|
| ~~Customer portal/API mismatch~~ **RESOLVED 2026-08-08** | `customer.html` calls `/api/advances/lookup`, `/api/advances`, and payment routes without a customer bearer token | Rebuilt around `/api/customer/*`; register/login/reset/session/ledger/payment all browser-tested. See `CHANGELOG.md` [Unreleased] |
| ~~Admin advance/API mismatch~~ **RESOLVED 2026-08-08** | Billing advance lookup and Advances manual deposit use raw `fetch()` against admin-gated routes | Both moved to `adminFetch()`; the E2E pass asserts zero 4xx/5xx across the admin terminal |
| ~~Payment amount not bound to order~~ **RESOLVED 2026-08-08** | Order is not persisted; verify trusts the caller's `amount`. The gateway signature does not bind that submitted amount | Orders persisted to `backend/data/payment_orders.json` with customer, amount and status at creation; `/api/payment/verify` credits the *stored* amount and no longer reads `req.body.amount` at all. Order bound to its owner (403 on another customer's order) and unknown ids rejected (400). Live-verified: a ₹100 order with `amount: 500000` posted back credited ₹100. **Still open from the original wording:** amount is not stored in paise, and there is no `fetch payment` call to Razorpay confirming captured/paid state — the stored order amount is trusted as what the gateway collected |
| ~~Manual UPI creates unverified credit~~ **RESOLVED 2026-08-08** | An authenticated customer can enter arbitrary reference text and immediately receive a ledger deposit | Deposit rows carry `status`; portal UPI submissions are written `pending` and hold no balance until approved at `POST /api/advances/:id/approve` from the Advances tab. Reference IDs unique across the ledger (case/whitespace-insensitive), enforced in `recordAdvanceDeposit`. Balance arithmetic centralised in `billingMath.js` so the server, Dashboard and Advances tab cannot disagree. A missing `status` reads as approved, so existing tenant ledgers keep their balances |
| Demo mode can create mock credit | Shipped defaults activate an exact-key mock bypass | Production boot fails closed on demo keys/provider/default credentials |
| Advance over-redemption possible | Sale calculation treats the requested redemption as its own “balance” and does not verify the ledger | Lock/read authoritative balance in the transaction and reject over-redemption |
| Sale is not atomic | Sequence, sale, and redemption are separate JSON writes; partial success is explicitly possible | One ACID transaction for number, invoice/lines, tender, advance, stock, and audit |
| Server accepts authoritative commercial inputs | Rate, metal value, making value, timestamp and spread fields originate in the request; metal value is not recomputed from weight × approved rate | Server owns time, IDs, rate snapshot and all financial calculations; overrides require permission + reason |
| Dependency gate fails | Current backend audit reports direct high `nodemailer` and moderate `node-cron`/transitive `uuid` findings | Upgrade/test; `npm ci`; SBOM; high/critical blocks release |
| Tests overstate assurance | Passing suites test arithmetic/crypto helpers, not the server, database, browser, payments, recovery, or deployment | Add API, DB, E2E, security, migration, recovery and deployment tests |

### P1 — before a paying pilot

- Named staff accounts and roles (`owner`, `manager`, `cashier`, `auditor`), strong credentials, session revocation, and privileged MFA.
  *(**Partially done 2026-08-12.** Named operators with per-person PINs and the four roles are
  configured in Settings → Staff & Roles; the PIN both authenticates and identifies, so the session
  carries a real actor. `requireAdminSession` attaches `req.actor` at the single choke point every
  admin route already passes through, and **every financial write now names a person** — the sale,
  the return/refund, the advance redemption, the counter deposit, and the deposit approval. Approving
  or rejecting a customer's unverified UPI claim is gated to `owner`/`manager` by `requireApprover`.
  A store that configures no operators still works: the legacy master PIN resolves to the `owner`
  identity, matching the bootstrap row in `userRepository.js`. Verified by 6 checks in `test_http.js`.
  **Completed 2026-08-13** — the three items this line previously deferred are all now done:
  - **Strong credentials.** Every PIN — the master one and each operator's — is stored as a scrypt
    hash in the same `scrypt$N$r$p$<hex>` format `customerAuth.js` already used for customer
    passwords. Nothing plaintext is written, and an existing tenant is migrated on its next boot with
    nobody retyping anything (`migratePinsToHashes`). The tenant salt and every hash are masked out
    of `GET /api/settings` and of the support export. **Honest limit:** a 4-digit PIN is a
    10,000-value keyspace, so a stolen `settings.json` still yields to an offline grind whatever the
    KDF — the UI allows 8 digits and the Settings copy asks for 6+, and the login lockout is what
    defends the live endpoint. Replacing the PIN with a username/password login remains Phase 2.
  - **Session revocation.** Deactivating, removing, re-PINning or *demoting* an operator ends their
    live sessions inside the same request (`revokeSessionsForRosterChange`), so the credential and
    the access can no longer diverge for up to 12 hours. An owner or manager can also see every live
    sign-in and end one deliberately (`GET /api/admin/sessions`, `POST /api/admin/sessions/revoke`);
    tokens never appear in that listing, only opaque handles, and nobody can revoke their own session
    from it.
  - **Privileged MFA.** Per-operator TOTP (RFC 6238, HMAC-SHA1 via `node:crypto` — no dependency
    added; the enrolment QR uses the `qrcode` package already in the budget). Enrolment requires a
    live code, so a secret nobody actually holds cannot be stored. Ten single-use recovery codes are
    issued once and kept only as hashes, because a lost phone must not lock a shop out of its own
    till. With `requireMfaForApprovers` on, releasing money needs a session that passed the factor —
    which the shared master PIN cannot do, by design, since there is no person to enrol.
    Interoperability with real authenticator apps is pinned against the published RFC 6238 vectors
    in `test_suite.js` Test 9, not merely against our own generator.)*
- Never return Razorpay/SMTP/admin secrets to a browser. Use environment/secret management and expose only redacted configuration state.
  *(**The browser half is done.** `redactSettingsForBrowser` builds the operator roster field by
  field rather than spreading and nulling — so a credential added later cannot leak by default — and
  as of 2026-08-13 the tenant PIN salt, every scrypt hash and every TOTP secret are excluded from
  `GET /api/settings` and from the support export. Asserted by `the tenant salt and every PIN hash are
  kept out of the browser` in `test_http.js`, which greps the raw response for `scrypt$`. **Still
  open:** the secrets are still stored on the tenant's disk in `settings.json` rather than in
  environment/secret management, and Razorpay/SMTP credentials are still held there in plaintext —
  only the PINs and TOTP secrets are hashed, because those are credentials this system *verifies*
  rather than ones it must *present* to a third party.)*
- Remove open CORS unless a documented native origin requires it. Add strict CSP/security headers, safe cache rules, request limits, and runtime schemas.
- Verify customer phone ownership via OTP or audited store-assisted proof.
- Scrub PII from telemetry. `req.originalUrl` currently includes query strings such as phone lookup; error/detail logs also contain financial identifiers despite “zero PII” claims.
- Encrypted off-site backups, point-in-time recovery where available, retention policy, restore automation, and recurring restore evidence.
- Explicit `Asia/Kolkata` business timezone for invoice date, schedules, reports, backups, and financial-year sequences.
- Append-only audit events for access, rate/settings changes, invoices, reversals, payments, exports, updates, and actor identity.
- Exercise dev/sandbox/live and a deliberately failed rollback on real infrastructure.
- Disable tenant extensions by default. Imported JavaScript has full filesystem/network/process power; a Promise timeout cannot stop a synchronous loop or malicious code.
- Correct claims such as “fully completed,” “system integrity verified,” “zero PII,” and “cannot corrupt” unless a test or isolation boundary proves them.

### P2 — needed for a competitive jewellery POS

- Product/SKU catalogue: barcode/QR, category, purity, HSN, hallmark/HUID, gross/net/stone weights, stone value, wastage, making policy, images, price tags.
- Lot inventory and immutable stock movements for purchase, sale, return, repair, transfer, adjustment, and physical count.
  *(**Opening-balance and adjustment/physical-count movements landed 2026-08-20, Phase 37** — see
  the Phase 5 §2 note further down for full detail. **Purchase, sale, return, repair and transfer
  movements are not started** — purchase and transfer stay gated on the legal/business definition
  named two lines below, and sale/return/repair integration is a deliberately separate, unstarted
  pass into the billing flow.)*
- Multi-line invoices, split tender, cash/card/UPI/bank/advance allocation, quotes, hold/resume, reprint, delivery.
  *(**Multi-line invoices, split tender and the allocation vocabulary landed 2026-08-12; reprint
  shipped in Phase 22.** Quotes, hold/resume and delivery are not started.)*
- Returns/exchange, void/cancel, credit/debit notes, refund lifecycle, approval thresholds, and reversal entries instead of history edits.
  *(**Returns, credit notes and refunds shipped in Phase 23**, per-line on 2026-08-12; a return has
  always been a new document pointing at the original, never a history edit. **Refund approval
  thresholds landed 2026-08-13** — `refundApprovalThreshold` refuses a refund at or above a configured
  amount unless an owner or manager authorises it, checked against the amount the SERVER priced rather
  than one the client proposed, and additionally requiring the second factor when
  `requireMfaForApprovers` is on. 0 disables it, which is the previous behaviour and the default.
  Exchange and void/cancel are not started.)*
- Customer master with consent/preferences, deduplication, correction/export and legally appropriate deletion/anonymisation.
- Vendor/purchase, branch transfer, old-gold workflows only after legal/business definition.
- Cash drawer and shift close/count/variance, staff permissions/commissions, daily closing.
- GST-ready invoice and export configuration reviewed by a practising CA.
- Paginated search/reports, accounting export, settlement/advance reconciliation, profitability and inventory ageing.
  *(**Pagination landed 2026-08-12.** `GET /api/sales`, `/api/returns` and `/api/advances` each
  returned the whole ledger as a bare array, and the Dashboard, Return Desk and Advances tab each
  downloaded a store's entire trading history on tab open. All three now answer with a clamped
  `{results, total, truncated, limit}` page, and — the part that made paging safe rather than merely
  smaller — **the aggregates the screens were summing are computed server-side over the whole
  matched set**, so a revenue tile cannot silently understate a month once it outgrows one page. A
  per-customer advance rollup (`GET /api/advances/customers`) replaced the client-side collapse of
  the full ledger, since a customer's spendable balance is their whole history and cannot be
  computed from a page. Accounting export, settlement reconciliation, profitability and ageing are
  not started.)*

## 4. Target architecture

Build a **jewellery commerce operating system**, not only a bill calculator: one authoritative ledger for sales, payments, advances, stock and schemes; auditable reversals instead of edits; multi-branch-ready identity and data; and safe operation during ordinary provider/network failures.

### Recommended decision: modular monolith + PostgreSQL

- Keep one backend application, divided into identity, organisation, catalogue, pricing, sales, payments, advances, inventory, schemes, reporting, audit, licensing and notifications modules. Do not introduce microservices yet.
- PostgreSQL provides migrations, constraints, row locks, unique/idempotency keys, transactions and a transactional outbox. Put `tenant_id` and `branch_id` on tenant-owned rows.
- Support both shared managed SaaS and dedicated tenant deployments from the same schema.
- Store money as integer paise where possible; constrained decimals for grams/rates/percentages. JavaScript floating point must not be the ledger source of truth.
- Use object storage for PDFs, product images, exports and encrypted artifacts—not the app filesystem.
- Use a durable job table/worker for emails, webhooks, reminders, reports, imports and rate sync. Jobs must be idempotent and observable.
- Define/version the API with OpenAPI and runtime validation; generate clients/types where practical.
- Introduce TypeScript, linting, formatting, reproducible builds and component/E2E tests incrementally. A framework is optional; “buildless” is not itself future-proof.
- Keep the control plane separate, but move it to a real database and protect fleet-wide signing/publishing with named MFA identities, audit and dual approval.

**Fast-pilot alternative:** SQLite WAL can deliver ACID for one process/tenant sooner. Treat it as a time-boxed bridge behind repository interfaces and migration tooling; PostgreSQL remains the multi-branch/shared-SaaS destination.

### Minimum data domains

| Domain | Records |
|---|---|
| Identity | users, roles, permissions, sessions, MFA, customer identities, consents |
| Organisation | tenants, stores, branches, counters, business-day/financial-year sequences |
| Catalogue | products, variants, lots, barcodes, stock movements/counts/transfers |
| Pricing | sources, approved immutable snapshots, price/making/tax policies |
| Sales | quotes/carts, invoices/lines, taxes, discounts, tenders, returns, credit notes |
| Payments | orders, attempts, provider events, captures, refunds, settlements, reconciliation |
| Customer funds | accounts, append-only entries, reservations, redemptions, reversals |
| Schemes | definitions, enrollments, installments, benefits, maturity, redemption |
| Operations | audit events, outbox/jobs, notifications, exports, devices, deployments |

Every financial row needs a stable UUID, human document number, tenant/branch, server time, business date, creator/approver, explicit state, source/idempotency key, and reversal relationship.

## 5. Delivery roadmap

The estimates are planning ranges for a small experienced team. Recalibrate after Phase 0 tests expose the real defect count. AI assistance can shorten coding, but not merchant UAT, settlement, security/legal review, restore drills, or app-store review.

### Phase 0 — Stabilise current code (1–2 weeks)

**Goal:** remove immediate money/security hazards before infrastructure or features.

- [x] Freeze feature work, including Scheme work, except P0 remediation. *(Held since 2026-08-08 — Scheme phases 20.2–20.5 remain unstarted and blocked on the product decisions in `SCHEME_MODULE_PLAN.md` §7; every commit since has been P0 remediation.)*
- [x] Create reproducible seeded dev/test data with no real customer information. *(2026-08-09 — `backend/seed.js`, `npm run seed`. Deterministic: a seeded mulberry32 PRNG and a fixed 2026-01-05 epoch, verified by diffing two independent runs byte-for-byte. Synthetic: invented names, the 90000000xx phone block, `@example.test` addresses. Isolated: refuses to write into `backend/data/` without `--force`, verified. Seeds settings, an active licence, fixed rates, 4 portal logins, an advances ledger covering approved/pending/rejected/redeemed, and invoices across two calendar years so annual partitioning is exercised. The Playwright fixture imports it directly.)*
- [x] Wire `customer.html` to register/login/logout/profile/password/reset and authenticated customer advance APIs. *(2026-08-08 — `backend/customerAuth.js` + `/api/customer/*`; verified by a 53-check API pass, a 20-check post-restart pass, and a 29-check Playwright pass at a 390px viewport, all green with `backend/data/` restored byte-identical afterwards.)*
- [x] Replace every raw call to an admin-gated route with the authenticated API client. *(2026-08-08 — `BillingDesk` advance lookup and `AdvancesManager` counter deposit moved to `adminFetch()`; the Playwright pass asserts zero 4xx/5xx across the whole admin terminal, which is what would surface a remaining raw call.)*
- [x] Persist payment orders and bind phone, amount in paise, currency, state and expiry. *(2026-08-09 — `payment_orders.json` rows now carry `customerPhone`, `amountPaise` (integer, authoritative), `amount` (rupee mirror for legacy readers only), `currency`, `status` (`created`/`paid`/`failed`/`mismatched`) and `expiresAt`. `toPaise`/`fromPaise` live in `frontend/js/lib/billingMath.js` with the rest of the money math and are covered by 6 conversion assertions in `test_billing_math.js`; the HTTP suite asserts the persisted paise/currency/status on a real order.)*
- [x] Add signed Razorpay raw-body webhook ingestion, event-ID idempotency, out-of-order handling and reconciliation. Credit only captured/paid transactions. *(2026-08-09 — `POST /api/payment/webhook`, mounted with `express.raw()` **before** the global JSON parser so the HMAC covers the exact bytes sent, and exempted from the licence gate so a lapsed licence cannot discard money already taken. Fails closed with no `razorpayWebhookSecret`. Credits only `payment.captured`; marks `payment.failed`; acknowledges anything else 2xx so Razorpay stops retrying. Separately, `/api/payment/verify` now calls `GET /v1/payments/:id` and refuses to credit unless the gateway itself reports `captured` for the order's exact paise — an `authorized` payment returns 202 and waits for the webhook. 12 HTTP checks cover unsigned, wrong-secret, post-signing tampering, credit, replay under the same and a different event id, amount mismatch, unknown order, `payment.failed`, unrelated events, and the no-secret refusal.)*
- [x] Convert manual UPI to a pending claim requiring manager reconciliation. *(Done 2026-08-12; the pending-claim half shipped earlier — a customer's manual UPI submission is written `status: 'pending'`, counts for nothing in any balance, and requires an explicit approval at `POST /api/advances/:id/approve`; duplicate references are rejected at the single ledger write path. Covered by Playwright and by the advance-status assertions in `test_billing_math.js`. **Design decision taken 2026-08-11 (owner): a manager is a DISTINCT NAMED ROLE, not a PIN-gated action** — a second PIN beside the admin PIN would be the parallel auth path CLAUDE.md §1 forbids, and an unnamed PIN answers "who approved this claim?" with "someone who knew the PIN", which is accountability theatre on the one flow that most needs the real thing. The minimal identity slice was pulled forward into Phase 1 rather than waiting for Phase 2's full RBAC, so `approved_by_user_id` exists on the advance row from the first schema instead of arriving as a second migration later. **Landed 2026-08-11:** `users.role IN ('owner','manager','cashier','auditor')`, an `approvers` view restricted to active owners/managers, and `CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)` so an entry cannot be posted anonymously — verified by 4 checks in `test_schema.js`. **Closed 2026-08-12:** the named-role half now exists on the live JSON path too. Operators with per-person PINs and the four roles are configured in Settings → Staff & Roles, `POST /api/advances/:id/approve` and `/reject` are gated by `requireApprover` (owner/manager only), and the approved row records `reviewedBy: {id, name, role}` — so "a manager reconciled this claim" is a stored fact rather than a description of a control that did not exist. A cashier attempting it gets a 403 naming their role, and the row is left untouched. Verified by `a cashier cannot approve a deposit, a manager can` in `test_http.js`. The `reviewedBy` field maps to `advance_entries.approved_by_user_id` at cutover; the CHECK constraint already forbids an anonymous post on the SQL side.)*
- [x] Validate real advance balance and make the server authoritative for rate, metal value, time and sale totals. *(2026-08-09 — `/api/sales` resolves the rate from `getActiveGoldRates()` by purity and computes `metalValue` as weight × that rate; it no longer reads `goldPricePerGram` or `metalValue` from the body except to detect drift and answer `rateCorrected` so the desk reprints. The `...req.body` spread is replaced by an explicit field allowlist, so the timestamp is the server's clock and unknown client fields are dropped. A sale is refused 503 rather than priced against a zero/unusable rate. Advance balance was already validated server-side; the E2E suite re-asserts it with a tampered client. Verified by 5 HTTP checks and 4 Playwright checks.)*
- [x] Reject duplicate payment/reference IDs and use cryptographically strong IDs. *(2026-08-09 — completes the half done on 2026-08-08. Ledger ids now come from `newId()` in `backend/db.js` (`crypto.randomBytes`, 48 bits, one generator for every write path) instead of `Math.random().toString(36)`; the transaction-journal suffix moved to CSPRNG too. Manual-UPI `referenceId` uniqueness is enforced at `recordAdvanceDeposit()` — the single choke point every deposit source runs through — and re-verified end-to-end by a Playwright check that submits the same UTR twice and asserts one ledger row. Gateway payment ids remain deduplicated, now across both the checkout and webhook paths.)*
- [x] Fail production startup on demo keys, mock rates, default credentials, missing public URLs, or environment confusion. *(2026-08-09 — `backend/productionGuard.js`, called from `bootstrapServer()` before any scheduler starts or the port binds. Under `NODE_ENV=production` it exits 1 on: demo or missing Razorpay credentials, a missing webhook secret, a missing or non-https public URL, a missing or default `1234` admin PIN, the `mock` gold price provider, and a `NODE_ENV`/`ENV_NAME` disagreement. Reports every blocker at once rather than one per failed boot. Inert outside production on purpose. 16 checks in `backend/test_production_guard.js`, the last two of which boot a real server process with demo settings and assert it exits non-zero — a guard that is only unit-tested is a guard nobody has confirmed is wired in.)*
- [ ] Upgrade vulnerable dependencies; use `npm ci`; run all suites in every gate. *(Dependencies: done — `npm audit` reports 0 vulnerabilities on both `backend/` and `licensing_server/`. Gates: done 2026-08-09 — all four workflows now use `npm ci` and run `npm test` (all five suites) instead of `npm install` and `test_suite.js` alone. **Still open:** none of this has executed on GitHub Actions yet. Root cause found 2026-08-11 and it was not the missing deploy target: `daily-checks.yml` — the one gate needing no infrastructure — triggered only on push-to-`main` and a nightly cron, while all nine unpushed commits sit on feature branches and `origin/main`, `origin/develop` and `origin/staging` are all still at `e4999bc`. The cron therefore only ever re-tested an old `main`. Fixed by adding a `pull_request` trigger on every branch plus pushes to the three pipeline branches; the workflow is renamed "CI — tests & security audit" to match its actual role. Still marked unchecked until a run is observed green on GitHub rather than assumed — that needs the branch pushed and a PR opened.)*
- [x] Add route tests for auth/money endpoints and Playwright cashier/customer journeys. *(2026-08-09 — route tests: `test_routes.js` (27) + `test_http.js` (24, of which 17 are new money-path checks) + `test_production_guard.js` (16). Playwright: `backend/tests/e2e/` — 4 cashier journeys (clean sale, advance redemption, stale-rate reprint warning, over-redemption refusal) and 6 customer journeys (balance excluding pending, wrong password, mock checkout deposit, manual UPI pending, duplicate reference, logout), the customer set run at both Desktop Chrome and a 390px Pixel 7 viewport. 16/16 green. Each spec boots its own server on an ephemeral port against its own seeded temp database, so `backend/data/` is never touched. Not wired into `npm test` — it needs a browser binary, and `npm test` must keep running on a bare checkout; run `npm run test:e2e` deliberately.)*
- [x] Correct documentation claims and distinguish “implemented” from “independently verified.” *(2026-08-09 — this Phase 0 block rewritten with what verified each item; `docs/ai_handover.md` §0 rewritten (it still described a `phase-20.1-customer-auth` merge conflict that had already been resolved three commits earlier, and understated how far `origin` is behind); `docs/LEDGER.md` and `docs/TESTING_CHECKLIST.md` updated. Two claims corrected rather than ticked: manual-UPI manager reconciliation above, and the CI gate, which is configured but has never run.)*

**Exit:** all P0s have regression tests; no high/critical audit finding; customer/cashier golden paths pass in desktop and mobile viewports; production cannot run in demo mode.

### Phase 1 — Transactional financial foundation (3–5 weeks)

**Goal:** make duplicate money, partial writes and silent corruption structurally difficult.

- [x] Approve ADR-001: PostgreSQL recommended, or time-boxed SQLite bridge. *(2026-08-11 — **accepted as the SQLite bridge**, not Postgres. `docs/adr/ADR-001-transactional-datastore.md` records the full argument; the short version is that deployment is already one process per tenant with its own data directory, so SQLite maps 1:1 onto it, adds zero dependencies (`node:sqlite` is stdlib, so the §0 budget is untouched), keeps `backupEngine.js` working, and needs no server on a VPS that does not exist yet. Postgres remains the destination and the ADR names four explicit revisit triggers. The repository seam that makes the swap cheap is item 4 below regardless of engine.)*
- [x] Lay the schema foundation: connection management, migration runner, initial schema. *(2026-08-11 — `backend/repositories/connection.js` (WAL, `foreign_keys=ON`, `busy_timeout`, `synchronous=FULL`, SAVEPOINT-nesting `inTransaction()`), `migrate.js` (idempotent, transactional per migration, refuses an edited already-applied migration by name), and `001_initial_schema.sql` — 19 tables, every quantity a scaled INTEGER (`_paise`/`_mg`/`_paise_per_g`/`_bp`), not one REAL. Verified by 43 checks in the new `backend/test_schema.js`, each asserting an invariant by attempting the violation and requiring a throw.)*
- [x] Migrate organisations, staff, customers, rates, invoices/lines, tenders, payment orders/events, advances/entries and audit. *(2026-08-13 — ten repositories under `backend/repositories/`, one per domain, each projecting back to the exact legacy wire shape via `toLegacySale()` / `toLegacyReturn()` / `toLegacyAdvance()` so no screen or test above the seam changes. Verified by 71 checks in the new `backend/test_repositories.js`, including a field-set assertion per shape so a dropped field fails as loudly as a renamed one.)*
- [x] Build a JSON importer with dry run, validation report, counts/checksums, backup, rollback and repeatability. *(2026-08-13 — `backend/importLegacyJson.js`, `npm run import:legacy[:dry-run]`. The dry run really writes every row inside the transaction and then rolls it back, so the report is a rehearsal rather than a guess; reconciliation is scoped to `import:*` idempotency keys so it stays true on a database that already holds data; the pre-write backup is checkpointed, not copied. Rehearsed end-to-end in `test_repositories.js` §12: dry run, commit, re-run no-op, fatal-row refusal, corrupt-file refusal, and rollback.)*
- [x] Split route handlers, domain services and repositories. *(2026-08-15 — **complete; the route half landed.** `server.js` now imports the four services and the repository index and reaches persistence only through them: every ledger `readJSON`/`writeJSON` call site is gone, and the ~500 lines of JSON read-modify-write they sat in went with them (`readSalesRecords`, `readReturnRecords`, `summarizeInvoiceReturns`, `withReturnState`, `pagedLedger`, `computeAdvanceLedger`, `buildAdvanceDepositRow`, `recordAdvanceDeposit`, `reviewPendingDeposit`, `recordPaymentOrder`, `settlePaymentOrder`, `claimPaymentEvent`, `validateSaleLine`, `validateTenders`). `settings.json` and `license.json` stay JSON on purpose — they are configuration, not ledger (§0). Verified by the full suite: 426 checks.)*
- [x] Execute invoice allocation + sale/lines + tender + advance redemption + stock + audit in one transaction. *(2026-08-13 — `saleService.createSale()` does all of it inside one `inTransaction()`. Proven by crash injection rather than by inspection: `test_concurrency.js` kills the process at four separate write steps and asserts the ledger is byte-for-byte unchanged each time, and that the invoice number the dead sale had taken is reissued rather than burned. Stock is not in scope — there is no stock module yet (Phase 5).)*
- [x] Add unique constraints for invoice scope, provider order/payment/event IDs, references and idempotency keys. *(Schema 2026-08-11, **enforced in production 2026-08-15.** `test_schema.js` covers each index by attempting the violation: unique invoice number, unique financial-year sequence slot, partial unique indexes on idempotency keys, provider order id, provider payment id, webhook event id, tender reference and advance reference. With the routes cut over these are now the live guarantee rather than a dormant one — `test_http.js` proves the webhook path end-to-end, including that the same gateway payment under a NEW event id still credits exactly once, which event-id deduplication alone would have let through.)*
- [x] Make advances append-only with `pending`, `posted`, `reversed`; reserve funds safely during checkout. *(Schema half done 2026-08-11: financial fields frozen by trigger, DELETE refused, transitions restricted to `pending→posted|rejected` and `posted→reversed`, amounts signed so a balance is a plain SUM, and `CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)` binds every posting to a named approver. **Reservation closed 2026-08-13:** the balance check runs INSIDE the sale's own `BEGIN IMMEDIATE` transaction, so two tills redeeming one balance serialise on the write lock — the second reads what the first already spent and is refused. `test_concurrency.js` §2 races ten processes at one ₹1,000 balance and asserts exactly one wins and the balance never goes negative. **Route cut-over landed 2026-08-15**, so the reservation is now what a real till actually gets.)*
- [x] Add explicit invoice transitions and reversal/credit-note behavior; issued facts are never edited. *(2026-08-13 — `issued → partially_returned → returned` driven by `returnService`, with the invoice's own figures never rewritten: what came back is a running counter on the line plus a numbered credit note pointing at the invoice. `test_repositories.js` §7 asserts the filed invoice is untouched after a return, and that three partial returns sum back to the invoice's filed gross to the paise.)*
- [x] Paginate/filter every list and remove full-history browser loads. *(2026-08-13 for the services; **routes landed 2026-08-15.** `GET /api/sales`, `/api/sales/lookup`, `/api/returns`, `/api/advances` and `/api/advances/customers` now filter, page and aggregate in SQL. The route this replaced read every `sales_YYYY.json` off disk, concatenated the store's entire history into one array and serialised the lot — the single largest thing the server did, and it got slower every day the store traded.

  Two aggregates are deliberately NOT the page: each ledger's period `totals` are summed by the database over the whole matched set (`invoices.periodTotals`, `creditNotes.periodTotals`, `advances.periodTotals`, sharing one filter builder with `search()` so a page and the figures printed above it can never describe different rows), and the advance liability `summary` ignores the date filter entirely because a lifetime balance is not a property of the period being browsed. `GET /api/advances/customers` rolls up per customer in SQL (`advances.customerRollup`) — the tab used to download the whole ledger and collapse it in the browser, which meant it could not be paged without reporting wrong balances.)*
- [x] Add concurrency, crash-injection, duplicate-request and migration tests. *(2026-08-13 — `backend/test_concurrency.js`, 16 checks driving real OS processes because `node:sqlite` is synchronous and an in-process test would prove only that a for-loop works. 40 concurrent sales produce 40 distinct numbers with no gaps; 10 tills racing one ₹1,000 balance produce exactly one redemption; 100 submissions of one idempotency key produce one invoice; 20 racing deposits on one UTR credit once; `process.exit()` at four write steps leaves nothing behind. Found and fixed a real open-time lock bug — see the LEDGER entry.)*

**Exit:** process kills at every write step cannot create an unbalanced sale; 100 duplicate/concurrent submissions create one result; imported totals reconcile exactly; rollback is rehearsed.

### Phase 2 — Identity, security, privacy and compliance (2–4 weeks)

**Goal:** accountable access and a defensible production baseline.

- [ ] Named staff, RBAC/least privilege, strong password or passkey, MFA for owner/manager/control plane, device/session view, revocation and forced expiry.
- [x] HttpOnly/Secure/SameSite browser sessions; CSRF protection where cookies apply. Verified 2026-08-17: `npm test` (443/443) + `npm run test:e2e` (43/43). See `docs/LEDGER.md` Phase 34.
- [ ] OTP or audited store-assisted customer phone verification.
- [x] Secrets outside settings responses/exports; redaction, encryption and key-rotation runbook. *(Redaction 2026-08-13 (Phase 27); **encryption at rest and the rotation runbook closed 2026-08-17, Phase 34**. Until now the Razorpay secret, the SMTP password, the tenant `authSalt`, every operator PIN hash and every TOTP secret sat in `settings.json` as plaintext — so redaction protected the wire while the file itself handed over live keys to anyone who took the directory. `backend/secretVault.js` seals them with AES-256-GCM under `GOLD_POS_SECRET_KEY`, **binding each ciphertext to its own dotted path as AAD** so a value cannot be cut from `smtp.pass` and pasted over `razorpayWebhookSecret`. The key is refused from inside the data directory under `NODE_ENV=production` — a key stored beside the data it protects defends against nothing — and that refusal is reported as a numbered startup blocker rather than thrown, via the new `assertVaultKeyReady()` which runs before anything reads settings. Migration is lazy: `open()` passes non-vault values through, so an existing tenant upgrades with no flag day. Rotation is `backend/rotateSecretKey.js` (`npm run key:rotate`), which verifies the rotated document reads back under the new key **before** replacing the original and leaves a timestamped pre-rotation copy. All thirty settings read/write call sites across eight files moved onto one choke point, `backend/settingsStore.js`, because a single reader that skipped decryption would hand Razorpay a string starting `encv1# Gold POS — Production Readiness and Future-Proof Roadmap

**Audit date:** 2026-08-07  
**Reviewed:** working tree on `main` at `e4999bc`, including current uncommitted work  
**Status:** authoritative production plan; `PROJECT_PLAN.md` remains the feature-history ledger

## 1. Executive decision

This project can become a strong vertical retail platform for gold businesses. It already has a useful nucleus: gold-rate handling, billing arithmetic, advances, a customer portal, licensing, signed updates, deployment scripts, and a planned savings-scheme module.

It is **not ready for real-money production today**. The main gap is not visual polish or another feature. It is the financial and operational foundation: JSON storage cannot make an invoice number, sale, payment, and advance redemption one atomic transaction; several browser flows no longer match the protected API; payment amounts are not bound to stored orders; the shared admin PIN is not an accountable staff identity; and the tests do not exercise HTTP routes, persistence failures, browsers, payments, restores, or deployment.

The right order is:

1. Freeze feature expansion and close P0 correctness/security defects.
2. Move financial state to a transactional database and immutable audit model.
3. Prove security, recovery, compliance, and deployment in sandbox.
4. Run one controlled pilot store.
5. Add full jewellery-retail operations and the savings-scheme module.
6. Scale into tenant-aware SaaS and a richer mobile product.

> **Go-live rule:** do not enable live Razorpay, customer-entered manual UPI credits, automatic fleet updates, or a paying tenant until Phase 0 and Phase 1 exit gates are green.

## 2. Current architecture and capability

| Area | Current implementation | Assessment |
|---|---|---|
| Admin POS | Vanilla HTML/CSS/ES modules served by Express | Lightweight; browser/API regressions need automated coverage |
| Customer portal | One `customer.html`; backend now has password/session APIs | UI still uses legacy phone/public advance calls, so security is not wired end to end |
| API | One Express process and a 1,300+ line `server.js` | Keep a modular monolith, but split route, domain, and persistence concerns |
| Data | JSON files with synchronous atomic rename | Protects one file from torn writes; cannot provide multi-file transactions, constraints, indexes, or multi-process scale |
| Financial model | One aggregate gold line and a flat advances ledger | Useful prototype, not yet a complete jewellery POS/accountable ledger |
| Payments | Razorpay order call + browser callback verification; manual UPI reference | Missing persisted orders, amount binding, captured-state webhook, reconciliation, refunds, disputes |
| Identity | Shared four-digit admin PIN; customer password/session file | No named staff, roles, MFA, staff attribution, or verified mobile ownership |
| Licensing/updates | Separate licensing service, signed manifests, self-update | Promising base; high blast radius and not proven on a live VPS |
| Backups | Daily same-disk copy, seven-day retention | Convenience copy, not disaster recovery |
| CI/CD | Actions tests/audits and three-stage SSH deployment | Pipeline unexercised; gates omit key tests and rollback proof |
| Mobile | Capacitor remote-WebView scaffold | Not built/store-tested; one binary/domain per tenant will not scale |
| Extensions | In-process dynamic JavaScript imports | Trusted customization only; not a security sandbox |

### Strengths to preserve

- Shared browser/server billing arithmetic and 57 passing math checks.
- Server recalculation of discount and GST fields.
- Atomic per-file replacement and explicit handling of important write failures.
- Signed license payloads and release manifests, with non-production/production separation.
- Customer passwords hashed with scrypt and persisted sessions stored as hashes.
- Login throttling and a deliberately small dependency surface.
- Clear deployment intent and a domain-specific savings-scheme design.

## 3. Evidence-based risk register

### P0 — stop ship

| Finding | Current evidence | Required outcome |
|---|---|---|
| ~~Customer portal/API mismatch~~ **RESOLVED 2026-08-08** | `customer.html` calls `/api/advances/lookup`, `/api/advances`, and payment routes without a customer bearer token | Rebuilt around `/api/customer/*`; register/login/reset/session/ledger/payment all browser-tested. See `CHANGELOG.md` [Unreleased] |
| ~~Admin advance/API mismatch~~ **RESOLVED 2026-08-08** | Billing advance lookup and Advances manual deposit use raw `fetch()` against admin-gated routes | Both moved to `adminFetch()`; the E2E pass asserts zero 4xx/5xx across the admin terminal |
| ~~Payment amount not bound to order~~ **RESOLVED 2026-08-08** | Order is not persisted; verify trusts the caller's `amount`. The gateway signature does not bind that submitted amount | Orders persisted to `backend/data/payment_orders.json` with customer, amount and status at creation; `/api/payment/verify` credits the *stored* amount and no longer reads `req.body.amount` at all. Order bound to its owner (403 on another customer's order) and unknown ids rejected (400). Live-verified: a ₹100 order with `amount: 500000` posted back credited ₹100. **Still open from the original wording:** amount is not stored in paise, and there is no `fetch payment` call to Razorpay confirming captured/paid state — the stored order amount is trusted as what the gateway collected |
| ~~Manual UPI creates unverified credit~~ **RESOLVED 2026-08-08** | An authenticated customer can enter arbitrary reference text and immediately receive a ledger deposit | Deposit rows carry `status`; portal UPI submissions are written `pending` and hold no balance until approved at `POST /api/advances/:id/approve` from the Advances tab. Reference IDs unique across the ledger (case/whitespace-insensitive), enforced in `recordAdvanceDeposit`. Balance arithmetic centralised in `billingMath.js` so the server, Dashboard and Advances tab cannot disagree. A missing `status` reads as approved, so existing tenant ledgers keep their balances |
| Demo mode can create mock credit | Shipped defaults activate an exact-key mock bypass | Production boot fails closed on demo keys/provider/default credentials |
| Advance over-redemption possible | Sale calculation treats the requested redemption as its own “balance” and does not verify the ledger | Lock/read authoritative balance in the transaction and reject over-redemption |
| Sale is not atomic | Sequence, sale, and redemption are separate JSON writes; partial success is explicitly possible | One ACID transaction for number, invoice/lines, tender, advance, stock, and audit |
| Server accepts authoritative commercial inputs | Rate, metal value, making value, timestamp and spread fields originate in the request; metal value is not recomputed from weight × approved rate | Server owns time, IDs, rate snapshot and all financial calculations; overrides require permission + reason |
| Dependency gate fails | Current backend audit reports direct high `nodemailer` and moderate `node-cron`/transitive `uuid` findings | Upgrade/test; `npm ci`; SBOM; high/critical blocks release |
| Tests overstate assurance | Passing suites test arithmetic/crypto helpers, not the server, database, browser, payments, recovery, or deployment | Add API, DB, E2E, security, migration, recovery and deployment tests |

### P1 — before a paying pilot

- Named staff accounts and roles (`owner`, `manager`, `cashier`, `auditor`), strong credentials, session revocation, and privileged MFA.
  *(**Partially done 2026-08-12.** Named operators with per-person PINs and the four roles are
  configured in Settings → Staff & Roles; the PIN both authenticates and identifies, so the session
  carries a real actor. `requireAdminSession` attaches `req.actor` at the single choke point every
  admin route already passes through, and **every financial write now names a person** — the sale,
  the return/refund, the advance redemption, the counter deposit, and the deposit approval. Approving
  or rejecting a customer's unverified UPI claim is gated to `owner`/`manager` by `requireApprover`.
  A store that configures no operators still works: the legacy master PIN resolves to the `owner`
  identity, matching the bootstrap row in `userRepository.js`. Verified by 6 checks in `test_http.js`.
  **Completed 2026-08-13** — the three items this line previously deferred are all now done:
  - **Strong credentials.** Every PIN — the master one and each operator's — is stored as a scrypt
    hash in the same `scrypt$N$r$p$<hex>` format `customerAuth.js` already used for customer
    passwords. Nothing plaintext is written, and an existing tenant is migrated on its next boot with
    nobody retyping anything (`migratePinsToHashes`). The tenant salt and every hash are masked out
    of `GET /api/settings` and of the support export. **Honest limit:** a 4-digit PIN is a
    10,000-value keyspace, so a stolen `settings.json` still yields to an offline grind whatever the
    KDF — the UI allows 8 digits and the Settings copy asks for 6+, and the login lockout is what
    defends the live endpoint. Replacing the PIN with a username/password login remains Phase 2.
  - **Session revocation.** Deactivating, removing, re-PINning or *demoting* an operator ends their
    live sessions inside the same request (`revokeSessionsForRosterChange`), so the credential and
    the access can no longer diverge for up to 12 hours. An owner or manager can also see every live
    sign-in and end one deliberately (`GET /api/admin/sessions`, `POST /api/admin/sessions/revoke`);
    tokens never appear in that listing, only opaque handles, and nobody can revoke their own session
    from it.
  - **Privileged MFA.** Per-operator TOTP (RFC 6238, HMAC-SHA1 via `node:crypto` — no dependency
    added; the enrolment QR uses the `qrcode` package already in the budget). Enrolment requires a
    live code, so a secret nobody actually holds cannot be stored. Ten single-use recovery codes are
    issued once and kept only as hashes, because a lost phone must not lock a shop out of its own
    till. With `requireMfaForApprovers` on, releasing money needs a session that passed the factor —
    which the shared master PIN cannot do, by design, since there is no person to enrol.
    Interoperability with real authenticator apps is pinned against the published RFC 6238 vectors
    in `test_suite.js` Test 9, not merely against our own generator.)*
- Never return Razorpay/SMTP/admin secrets to a browser. Use environment/secret management and expose only redacted configuration state.
  *(**The browser half is done.** `redactSettingsForBrowser` builds the operator roster field by
  field rather than spreading and nulling — so a credential added later cannot leak by default — and
  as of 2026-08-13 the tenant PIN salt, every scrypt hash and every TOTP secret are excluded from
  `GET /api/settings` and from the support export. Asserted by `the tenant salt and every PIN hash are
  kept out of the browser` in `test_http.js`, which greps the raw response for `scrypt$`. **Still
  open:** the secrets are still stored on the tenant's disk in `settings.json` rather than in
  environment/secret management, and Razorpay/SMTP credentials are still held there in plaintext —
  only the PINs and TOTP secrets are hashed, because those are credentials this system *verifies*
  rather than ones it must *present* to a third party.)*
- Remove open CORS unless a documented native origin requires it. Add strict CSP/security headers, safe cache rules, request limits, and runtime schemas.
- Verify customer phone ownership via OTP or audited store-assisted proof.
- Scrub PII from telemetry. `req.originalUrl` currently includes query strings such as phone lookup; error/detail logs also contain financial identifiers despite “zero PII” claims.
- Encrypted off-site backups, point-in-time recovery where available, retention policy, restore automation, and recurring restore evidence.
- Explicit `Asia/Kolkata` business timezone for invoice date, schedules, reports, backups, and financial-year sequences.
- Append-only audit events for access, rate/settings changes, invoices, reversals, payments, exports, updates, and actor identity.
- Exercise dev/sandbox/live and a deliberately failed rollback on real infrastructure.
- Disable tenant extensions by default. Imported JavaScript has full filesystem/network/process power; a Promise timeout cannot stop a synchronous loop or malicious code.
- Correct claims such as “fully completed,” “system integrity verified,” “zero PII,” and “cannot corrupt” unless a test or isolation boundary proves them.

### P2 — needed for a competitive jewellery POS

- Product/SKU catalogue: barcode/QR, category, purity, HSN, hallmark/HUID, gross/net/stone weights, stone value, wastage, making policy, images, price tags.
- Lot inventory and immutable stock movements for purchase, sale, return, repair, transfer, adjustment, and physical count.
  *(**Opening-balance and adjustment/physical-count movements landed 2026-08-20, Phase 37** — see
  the Phase 5 §2 note further down for full detail. **Purchase, sale, return, repair and transfer
  movements are not started** — purchase and transfer stay gated on the legal/business definition
  named two lines below, and sale/return/repair integration is a deliberately separate, unstarted
  pass into the billing flow.)*
- Multi-line invoices, split tender, cash/card/UPI/bank/advance allocation, quotes, hold/resume, reprint, delivery.
  *(**Multi-line invoices, split tender and the allocation vocabulary landed 2026-08-12; reprint
  shipped in Phase 22.** Quotes, hold/resume and delivery are not started.)*
- Returns/exchange, void/cancel, credit/debit notes, refund lifecycle, approval thresholds, and reversal entries instead of history edits.
  *(**Returns, credit notes and refunds shipped in Phase 23**, per-line on 2026-08-12; a return has
  always been a new document pointing at the original, never a history edit. **Refund approval
  thresholds landed 2026-08-13** — `refundApprovalThreshold` refuses a refund at or above a configured
  amount unless an owner or manager authorises it, checked against the amount the SERVER priced rather
  than one the client proposed, and additionally requiring the second factor when
  `requireMfaForApprovers` is on. 0 disables it, which is the previous behaviour and the default.
  Exchange and void/cancel are not started.)*
- Customer master with consent/preferences, deduplication, correction/export and legally appropriate deletion/anonymisation.
- Vendor/purchase, branch transfer, old-gold workflows only after legal/business definition.
- Cash drawer and shift close/count/variance, staff permissions/commissions, daily closing.
- GST-ready invoice and export configuration reviewed by a practising CA.
- Paginated search/reports, accounting export, settlement/advance reconciliation, profitability and inventory ageing.
  *(**Pagination landed 2026-08-12.** `GET /api/sales`, `/api/returns` and `/api/advances` each
  returned the whole ledger as a bare array, and the Dashboard, Return Desk and Advances tab each
  downloaded a store's entire trading history on tab open. All three now answer with a clamped
  `{results, total, truncated, limit}` page, and — the part that made paging safe rather than merely
  smaller — **the aggregates the screens were summing are computed server-side over the whole
  matched set**, so a revenue tile cannot silently understate a month once it outgrows one page. A
  per-customer advance rollup (`GET /api/advances/customers`) replaced the client-side collapse of
  the full ledger, since a customer's spendable balance is their whole history and cannot be
  computed from a page. Accounting export, settlement reconciliation, profitability and ageing are
  not started.)*

## 4. Target architecture

Build a **jewellery commerce operating system**, not only a bill calculator: one authoritative ledger for sales, payments, advances, stock and schemes; auditable reversals instead of edits; multi-branch-ready identity and data; and safe operation during ordinary provider/network failures.

### Recommended decision: modular monolith + PostgreSQL

- Keep one backend application, divided into identity, organisation, catalogue, pricing, sales, payments, advances, inventory, schemes, reporting, audit, licensing and notifications modules. Do not introduce microservices yet.
- PostgreSQL provides migrations, constraints, row locks, unique/idempotency keys, transactions and a transactional outbox. Put `tenant_id` and `branch_id` on tenant-owned rows.
- Support both shared managed SaaS and dedicated tenant deployments from the same schema.
- Store money as integer paise where possible; constrained decimals for grams/rates/percentages. JavaScript floating point must not be the ledger source of truth.
- Use object storage for PDFs, product images, exports and encrypted artifacts—not the app filesystem.
- Use a durable job table/worker for emails, webhooks, reminders, reports, imports and rate sync. Jobs must be idempotent and observable.
- Define/version the API with OpenAPI and runtime validation; generate clients/types where practical.
- Introduce TypeScript, linting, formatting, reproducible builds and component/E2E tests incrementally. A framework is optional; “buildless” is not itself future-proof.
- Keep the control plane separate, but move it to a real database and protect fleet-wide signing/publishing with named MFA identities, audit and dual approval.

**Fast-pilot alternative:** SQLite WAL can deliver ACID for one process/tenant sooner. Treat it as a time-boxed bridge behind repository interfaces and migration tooling; PostgreSQL remains the multi-branch/shared-SaaS destination.

### Minimum data domains

| Domain | Records |
|---|---|
| Identity | users, roles, permissions, sessions, MFA, customer identities, consents |
| Organisation | tenants, stores, branches, counters, business-day/financial-year sequences |
| Catalogue | products, variants, lots, barcodes, stock movements/counts/transfers |
| Pricing | sources, approved immutable snapshots, price/making/tax policies |
| Sales | quotes/carts, invoices/lines, taxes, discounts, tenders, returns, credit notes |
| Payments | orders, attempts, provider events, captures, refunds, settlements, reconciliation |
| Customer funds | accounts, append-only entries, reservations, redemptions, reversals |
| Schemes | definitions, enrollments, installments, benefits, maturity, redemption |
| Operations | audit events, outbox/jobs, notifications, exports, devices, deployments |

Every financial row needs a stable UUID, human document number, tenant/branch, server time, business date, creator/approver, explicit state, source/idempotency key, and reversal relationship.

## 5. Delivery roadmap

The estimates are planning ranges for a small experienced team. Recalibrate after Phase 0 tests expose the real defect count. AI assistance can shorten coding, but not merchant UAT, settlement, security/legal review, restore drills, or app-store review.

### Phase 0 — Stabilise current code (1–2 weeks)

**Goal:** remove immediate money/security hazards before infrastructure or features.

- [x] Freeze feature work, including Scheme work, except P0 remediation. *(Held since 2026-08-08 — Scheme phases 20.2–20.5 remain unstarted and blocked on the product decisions in `SCHEME_MODULE_PLAN.md` §7; every commit since has been P0 remediation.)*
- [x] Create reproducible seeded dev/test data with no real customer information. *(2026-08-09 — `backend/seed.js`, `npm run seed`. Deterministic: a seeded mulberry32 PRNG and a fixed 2026-01-05 epoch, verified by diffing two independent runs byte-for-byte. Synthetic: invented names, the 90000000xx phone block, `@example.test` addresses. Isolated: refuses to write into `backend/data/` without `--force`, verified. Seeds settings, an active licence, fixed rates, 4 portal logins, an advances ledger covering approved/pending/rejected/redeemed, and invoices across two calendar years so annual partitioning is exercised. The Playwright fixture imports it directly.)*
- [x] Wire `customer.html` to register/login/logout/profile/password/reset and authenticated customer advance APIs. *(2026-08-08 — `backend/customerAuth.js` + `/api/customer/*`; verified by a 53-check API pass, a 20-check post-restart pass, and a 29-check Playwright pass at a 390px viewport, all green with `backend/data/` restored byte-identical afterwards.)*
- [x] Replace every raw call to an admin-gated route with the authenticated API client. *(2026-08-08 — `BillingDesk` advance lookup and `AdvancesManager` counter deposit moved to `adminFetch()`; the Playwright pass asserts zero 4xx/5xx across the whole admin terminal, which is what would surface a remaining raw call.)*
- [x] Persist payment orders and bind phone, amount in paise, currency, state and expiry. *(2026-08-09 — `payment_orders.json` rows now carry `customerPhone`, `amountPaise` (integer, authoritative), `amount` (rupee mirror for legacy readers only), `currency`, `status` (`created`/`paid`/`failed`/`mismatched`) and `expiresAt`. `toPaise`/`fromPaise` live in `frontend/js/lib/billingMath.js` with the rest of the money math and are covered by 6 conversion assertions in `test_billing_math.js`; the HTTP suite asserts the persisted paise/currency/status on a real order.)*
- [x] Add signed Razorpay raw-body webhook ingestion, event-ID idempotency, out-of-order handling and reconciliation. Credit only captured/paid transactions. *(2026-08-09 — `POST /api/payment/webhook`, mounted with `express.raw()` **before** the global JSON parser so the HMAC covers the exact bytes sent, and exempted from the licence gate so a lapsed licence cannot discard money already taken. Fails closed with no `razorpayWebhookSecret`. Credits only `payment.captured`; marks `payment.failed`; acknowledges anything else 2xx so Razorpay stops retrying. Separately, `/api/payment/verify` now calls `GET /v1/payments/:id` and refuses to credit unless the gateway itself reports `captured` for the order's exact paise — an `authorized` payment returns 202 and waits for the webhook. 12 HTTP checks cover unsigned, wrong-secret, post-signing tampering, credit, replay under the same and a different event id, amount mismatch, unknown order, `payment.failed`, unrelated events, and the no-secret refusal.)*
- [x] Convert manual UPI to a pending claim requiring manager reconciliation. *(Done 2026-08-12; the pending-claim half shipped earlier — a customer's manual UPI submission is written `status: 'pending'`, counts for nothing in any balance, and requires an explicit approval at `POST /api/advances/:id/approve`; duplicate references are rejected at the single ledger write path. Covered by Playwright and by the advance-status assertions in `test_billing_math.js`. **Design decision taken 2026-08-11 (owner): a manager is a DISTINCT NAMED ROLE, not a PIN-gated action** — a second PIN beside the admin PIN would be the parallel auth path CLAUDE.md §1 forbids, and an unnamed PIN answers "who approved this claim?" with "someone who knew the PIN", which is accountability theatre on the one flow that most needs the real thing. The minimal identity slice was pulled forward into Phase 1 rather than waiting for Phase 2's full RBAC, so `approved_by_user_id` exists on the advance row from the first schema instead of arriving as a second migration later. **Landed 2026-08-11:** `users.role IN ('owner','manager','cashier','auditor')`, an `approvers` view restricted to active owners/managers, and `CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)` so an entry cannot be posted anonymously — verified by 4 checks in `test_schema.js`. **Closed 2026-08-12:** the named-role half now exists on the live JSON path too. Operators with per-person PINs and the four roles are configured in Settings → Staff & Roles, `POST /api/advances/:id/approve` and `/reject` are gated by `requireApprover` (owner/manager only), and the approved row records `reviewedBy: {id, name, role}` — so "a manager reconciled this claim" is a stored fact rather than a description of a control that did not exist. A cashier attempting it gets a 403 naming their role, and the row is left untouched. Verified by `a cashier cannot approve a deposit, a manager can` in `test_http.js`. The `reviewedBy` field maps to `advance_entries.approved_by_user_id` at cutover; the CHECK constraint already forbids an anonymous post on the SQL side.)*
- [x] Validate real advance balance and make the server authoritative for rate, metal value, time and sale totals. *(2026-08-09 — `/api/sales` resolves the rate from `getActiveGoldRates()` by purity and computes `metalValue` as weight × that rate; it no longer reads `goldPricePerGram` or `metalValue` from the body except to detect drift and answer `rateCorrected` so the desk reprints. The `...req.body` spread is replaced by an explicit field allowlist, so the timestamp is the server's clock and unknown client fields are dropped. A sale is refused 503 rather than priced against a zero/unusable rate. Advance balance was already validated server-side; the E2E suite re-asserts it with a tampered client. Verified by 5 HTTP checks and 4 Playwright checks.)*
- [x] Reject duplicate payment/reference IDs and use cryptographically strong IDs. *(2026-08-09 — completes the half done on 2026-08-08. Ledger ids now come from `newId()` in `backend/db.js` (`crypto.randomBytes`, 48 bits, one generator for every write path) instead of `Math.random().toString(36)`; the transaction-journal suffix moved to CSPRNG too. Manual-UPI `referenceId` uniqueness is enforced at `recordAdvanceDeposit()` — the single choke point every deposit source runs through — and re-verified end-to-end by a Playwright check that submits the same UTR twice and asserts one ledger row. Gateway payment ids remain deduplicated, now across both the checkout and webhook paths.)*
- [x] Fail production startup on demo keys, mock rates, default credentials, missing public URLs, or environment confusion. *(2026-08-09 — `backend/productionGuard.js`, called from `bootstrapServer()` before any scheduler starts or the port binds. Under `NODE_ENV=production` it exits 1 on: demo or missing Razorpay credentials, a missing webhook secret, a missing or non-https public URL, a missing or default `1234` admin PIN, the `mock` gold price provider, and a `NODE_ENV`/`ENV_NAME` disagreement. Reports every blocker at once rather than one per failed boot. Inert outside production on purpose. 16 checks in `backend/test_production_guard.js`, the last two of which boot a real server process with demo settings and assert it exits non-zero — a guard that is only unit-tested is a guard nobody has confirmed is wired in.)*
- [ ] Upgrade vulnerable dependencies; use `npm ci`; run all suites in every gate. *(Dependencies: done — `npm audit` reports 0 vulnerabilities on both `backend/` and `licensing_server/`. Gates: done 2026-08-09 — all four workflows now use `npm ci` and run `npm test` (all five suites) instead of `npm install` and `test_suite.js` alone. **Still open:** none of this has executed on GitHub Actions yet. Root cause found 2026-08-11 and it was not the missing deploy target: `daily-checks.yml` — the one gate needing no infrastructure — triggered only on push-to-`main` and a nightly cron, while all nine unpushed commits sit on feature branches and `origin/main`, `origin/develop` and `origin/staging` are all still at `e4999bc`. The cron therefore only ever re-tested an old `main`. Fixed by adding a `pull_request` trigger on every branch plus pushes to the three pipeline branches; the workflow is renamed "CI — tests & security audit" to match its actual role. Still marked unchecked until a run is observed green on GitHub rather than assumed — that needs the branch pushed and a PR opened.)*
- [x] Add route tests for auth/money endpoints and Playwright cashier/customer journeys. *(2026-08-09 — route tests: `test_routes.js` (27) + `test_http.js` (24, of which 17 are new money-path checks) + `test_production_guard.js` (16). Playwright: `backend/tests/e2e/` — 4 cashier journeys (clean sale, advance redemption, stale-rate reprint warning, over-redemption refusal) and 6 customer journeys (balance excluding pending, wrong password, mock checkout deposit, manual UPI pending, duplicate reference, logout), the customer set run at both Desktop Chrome and a 390px Pixel 7 viewport. 16/16 green. Each spec boots its own server on an ephemeral port against its own seeded temp database, so `backend/data/` is never touched. Not wired into `npm test` — it needs a browser binary, and `npm test` must keep running on a bare checkout; run `npm run test:e2e` deliberately.)*
- [x] Correct documentation claims and distinguish “implemented” from “independently verified.” *(2026-08-09 — this Phase 0 block rewritten with what verified each item; `docs/ai_handover.md` §0 rewritten (it still described a `phase-20.1-customer-auth` merge conflict that had already been resolved three commits earlier, and understated how far `origin` is behind); `docs/LEDGER.md` and `docs/TESTING_CHECKLIST.md` updated. Two claims corrected rather than ticked: manual-UPI manager reconciliation above, and the CI gate, which is configured but has never run.)*

**Exit:** all P0s have regression tests; no high/critical audit finding; customer/cashier golden paths pass in desktop and mobile viewports; production cannot run in demo mode.

### Phase 1 — Transactional financial foundation (3–5 weeks)

**Goal:** make duplicate money, partial writes and silent corruption structurally difficult.

- [x] Approve ADR-001: PostgreSQL recommended, or time-boxed SQLite bridge. *(2026-08-11 — **accepted as the SQLite bridge**, not Postgres. `docs/adr/ADR-001-transactional-datastore.md` records the full argument; the short version is that deployment is already one process per tenant with its own data directory, so SQLite maps 1:1 onto it, adds zero dependencies (`node:sqlite` is stdlib, so the §0 budget is untouched), keeps `backupEngine.js` working, and needs no server on a VPS that does not exist yet. Postgres remains the destination and the ADR names four explicit revisit triggers. The repository seam that makes the swap cheap is item 4 below regardless of engine.)*
- [x] Lay the schema foundation: connection management, migration runner, initial schema. *(2026-08-11 — `backend/repositories/connection.js` (WAL, `foreign_keys=ON`, `busy_timeout`, `synchronous=FULL`, SAVEPOINT-nesting `inTransaction()`), `migrate.js` (idempotent, transactional per migration, refuses an edited already-applied migration by name), and `001_initial_schema.sql` — 19 tables, every quantity a scaled INTEGER (`_paise`/`_mg`/`_paise_per_g`/`_bp`), not one REAL. Verified by 43 checks in the new `backend/test_schema.js`, each asserting an invariant by attempting the violation and requiring a throw.)*
- [x] Migrate organisations, staff, customers, rates, invoices/lines, tenders, payment orders/events, advances/entries and audit. *(2026-08-13 — ten repositories under `backend/repositories/`, one per domain, each projecting back to the exact legacy wire shape via `toLegacySale()` / `toLegacyReturn()` / `toLegacyAdvance()` so no screen or test above the seam changes. Verified by 71 checks in the new `backend/test_repositories.js`, including a field-set assertion per shape so a dropped field fails as loudly as a renamed one.)*
- [x] Build a JSON importer with dry run, validation report, counts/checksums, backup, rollback and repeatability. *(2026-08-13 — `backend/importLegacyJson.js`, `npm run import:legacy[:dry-run]`. The dry run really writes every row inside the transaction and then rolls it back, so the report is a rehearsal rather than a guess; reconciliation is scoped to `import:*` idempotency keys so it stays true on a database that already holds data; the pre-write backup is checkpointed, not copied. Rehearsed end-to-end in `test_repositories.js` §12: dry run, commit, re-run no-op, fatal-row refusal, corrupt-file refusal, and rollback.)*
- [x] Split route handlers, domain services and repositories. *(2026-08-15 — **complete; the route half landed.** `server.js` now imports the four services and the repository index and reaches persistence only through them: every ledger `readJSON`/`writeJSON` call site is gone, and the ~500 lines of JSON read-modify-write they sat in went with them (`readSalesRecords`, `readReturnRecords`, `summarizeInvoiceReturns`, `withReturnState`, `pagedLedger`, `computeAdvanceLedger`, `buildAdvanceDepositRow`, `recordAdvanceDeposit`, `reviewPendingDeposit`, `recordPaymentOrder`, `settlePaymentOrder`, `claimPaymentEvent`, `validateSaleLine`, `validateTenders`). `settings.json` and `license.json` stay JSON on purpose — they are configuration, not ledger (§0). Verified by the full suite: 426 checks.)*
- [x] Execute invoice allocation + sale/lines + tender + advance redemption + stock + audit in one transaction. *(2026-08-13 — `saleService.createSale()` does all of it inside one `inTransaction()`. Proven by crash injection rather than by inspection: `test_concurrency.js` kills the process at four separate write steps and asserts the ledger is byte-for-byte unchanged each time, and that the invoice number the dead sale had taken is reissued rather than burned. Stock is not in scope — there is no stock module yet (Phase 5).)*
- [x] Add unique constraints for invoice scope, provider order/payment/event IDs, references and idempotency keys. *(Schema 2026-08-11, **enforced in production 2026-08-15.** `test_schema.js` covers each index by attempting the violation: unique invoice number, unique financial-year sequence slot, partial unique indexes on idempotency keys, provider order id, provider payment id, webhook event id, tender reference and advance reference. With the routes cut over these are now the live guarantee rather than a dormant one — `test_http.js` proves the webhook path end-to-end, including that the same gateway payment under a NEW event id still credits exactly once, which event-id deduplication alone would have let through.)*
- [x] Make advances append-only with `pending`, `posted`, `reversed`; reserve funds safely during checkout. *(Schema half done 2026-08-11: financial fields frozen by trigger, DELETE refused, transitions restricted to `pending→posted|rejected` and `posted→reversed`, amounts signed so a balance is a plain SUM, and `CHECK (status <> 'posted' OR approved_by_user_id IS NOT NULL)` binds every posting to a named approver. **Reservation closed 2026-08-13:** the balance check runs INSIDE the sale's own `BEGIN IMMEDIATE` transaction, so two tills redeeming one balance serialise on the write lock — the second reads what the first already spent and is refused. `test_concurrency.js` §2 races ten processes at one ₹1,000 balance and asserts exactly one wins and the balance never goes negative. **Route cut-over landed 2026-08-15**, so the reservation is now what a real till actually gets.)*
- [x] Add explicit invoice transitions and reversal/credit-note behavior; issued facts are never edited. *(2026-08-13 — `issued → partially_returned → returned` driven by `returnService`, with the invoice's own figures never rewritten: what came back is a running counter on the line plus a numbered credit note pointing at the invoice. `test_repositories.js` §7 asserts the filed invoice is untouched after a return, and that three partial returns sum back to the invoice's filed gross to the paise.)*
- [x] Paginate/filter every list and remove full-history browser loads. *(2026-08-13 for the services; **routes landed 2026-08-15.** `GET /api/sales`, `/api/sales/lookup`, `/api/returns`, `/api/advances` and `/api/advances/customers` now filter, page and aggregate in SQL. The route this replaced read every `sales_YYYY.json` off disk, concatenated the store's entire history into one array and serialised the lot — the single largest thing the server did, and it got slower every day the store traded.

  Two aggregates are deliberately NOT the page: each ledger's period `totals` are summed by the database over the whole matched set (`invoices.periodTotals`, `creditNotes.periodTotals`, `advances.periodTotals`, sharing one filter builder with `search()` so a page and the figures printed above it can never describe different rows), and the advance liability `summary` ignores the date filter entirely because a lifetime balance is not a property of the period being browsed. `GET /api/advances/customers` rolls up per customer in SQL (`advances.customerRollup`) — the tab used to download the whole ledger and collapse it in the browser, which meant it could not be paged without reporting wrong balances.)*
- [x] Add concurrency, crash-injection, duplicate-request and migration tests. *(2026-08-13 — `backend/test_concurrency.js`, 16 checks driving real OS processes because `node:sqlite` is synchronous and an in-process test would prove only that a for-loop works. 40 concurrent sales produce 40 distinct numbers with no gaps; 10 tills racing one ₹1,000 balance produce exactly one redemption; 100 submissions of one idempotency key produce one invoice; 20 racing deposits on one UTR credit once; `process.exit()` at four write steps leaves nothing behind. Found and fixed a real open-time lock bug — see the LEDGER entry.)*

**Exit:** process kills at every write step cannot create an unbalanced sale; 100 duplicate/concurrent submissions create one result; imported totals reconcile exactly; rollback is rehearsed.

### Phase 2 — Identity, security, privacy and compliance (2–4 weeks)

**Goal:** accountable access and a defensible production baseline.

- [ ] Named staff, RBAC/least privilege, strong password or passkey, MFA for owner/manager/control plane, device/session view, revocation and forced expiry.
- [x] HttpOnly/Secure/SameSite browser sessions; CSRF protection where cookies apply. Verified 2026-08-17: `npm test` (443/443) + `npm run test:e2e` (43/43). See `docs/LEDGER.md` Phase 34.
- [ ] OTP or audited store-assisted customer phone verification.
. Runbooks 1 and 2 in `docs/RUNBOOKS.md` cover rotation and the lost-key path. Verified by Test 11 in `test_suite.js` (round trip, empty-stays-empty, lazy passthrough, wrong key, field binding, wildcard paths, rotation), a new at-rest check in `test_routes.js` asserting no canary secret survives in the file bytes, and a new `test_production_guard.js` check that a keyless production boot refuses with a blocker and not a stack trace.)*
- [ ] Same-origin policy, CSP/security headers, runtime schemas, upload/request limits, rate/abuse limits and safe errors.
  *(Audited 2026-08-16, because this line read as untouched and mostly is not. **Already in place:**
  the same-origin/CORS allowlist and a full helmet CSP directive set (`server.js`, asserted by
  "security headers and explicit CORS allowlist are emitted over HTTP" in `test_http.js`); request
  limits (5 MB JSON, 1 MB on the raw webhook body); and login rate limiting on both the admin and
  customer paths, with the 429 lockout asserted in `test_routes.js`. **Genuinely still open:**
  rate/abuse limits on anything that is not a login, and runtime schemas beyond
  `validateSettingsPatch()` — which covers `POST /api/settings` only and is the pattern the rest
  should follow rather than a second mechanism.*
  ***Both closed 2026-08-17, Phase 33, and the pattern was followed rather than duplicated.**
  `backend/rateLimit.js` holds one bounded keyed counter; the abuse limiters are built on it and
  the two pre-existing credential lockouts now store their counts in it. A blanket 600/min per IP
  covers `/api/*`, with the probes and the Razorpay webhook exempt (throttling a probe makes a
  healthy process look down; 429-ing the webhook loses the record of money already taken), and
  tighter named limits sit on the endpoints where every request succeeds and the abuse is the
  volume — registration, password reset, deposit claims, payment orders, and the expensive admin
  operations that send mail, call the price provider or encrypt the whole ledger.
  `backend/validation.js` is `validateSettingsPatch()`'s engine lifted out, not a second one:
  `validateSettingsPatch()` is now a two-line caller, and `validateBody()` applies the same rules
  to the credential surface (admin login, customer register/login/profile/password change, forgot,
  reset). It checks **shape only** — meaning stays in `customerAuth.js` and the services, so there
  is no second source of truth. The money routes are deliberately NOT wrapped: their services
  already validate exhaustively, and a thinner second check there would add risk, not coverage.
  **A real defect fixed on the way:** both credential lockouts used plain Maps that only shed an
  entry on a *successful* login, so every source that failed once and never returned stayed
  resident for the life of the process — one request per new IP grew them without bound. Asserted
  now by `test_suite.js` Test 10.*
  ***Safe errors closed 2026-08-16, Phase 32.** Until then there was no terminal error handler at
  all, so anything thrown outside a route's own try/catch reached Express's default handler — which
  renders the **stack trace into the response body** outside `NODE_ENV=production`, leaking absolute
  paths and internal structure to whoever provoked it. There is now one handler at the bottom of
  `server.js`: a fixed message plus the request id for a 500, the parser's own status honoured for a
  malformed or oversized body, and the stack in `error.log` where it belongs. An unmatched `/api/*`
  path answers a JSON 404 rather than the HTML one a `fetch()` cannot parse.)*
- [ ] Structured audit/security logs with PII classification, retention, clock sync, access control, alerts and tamper-evident export.
  *(**Advanced substantially on 2026-08-17, Phase 34 — three of the six sub-items closed.**
  **Tamper-evident export: done.** The trail was append-only by trigger, which stops the
  *application* rewriting history and proves nothing to a third party, because dropping a trigger
  is one statement for whoever holds the .db file. Migration 005 adds `chain_seq`/`prev_hash`/
  `row_hash`, so each event hashes its own content plus the previous row's hash;
  `GET /api/audit/verify` and `GET /api/audit/export` (both approver-only) expose verification and
  a manifest, `backend/verifyAuditChain.js` does it from the command line, and taking an export is
  itself an audited event. **The limit is documented rather than papered over:** a holder of the
  file can edit a row and recompute the whole tail, and the chain will then verify against itself —
  what defeats that is the head hash already being in somebody else's hands, which is why the
  export publishes it and why the runbook says to send exports off-site. Rows written before 005
  are NOT backfilled and are reported as "predating the chain", because hashing them today would
  prove nothing about what they said then while looking authoritative. Six checks in
  `test_repositories.js` §13 assert this by tampering the way an attacker would — dropping the
  triggers and editing with direct SQL — including the honest one that a fully re-hashed chain does
  verify but cannot reproduce a published head.
  **PII classification: done** — `docs/AUDIT_AND_PII.md`, a five-class scheme (P0 public → P4
  accountability) with every field placed, plus a checklist for adding one.
  **Access control: done** — approver-only on the trail, verification and export alike.
  **Clock sync:** documented as host provisioning (NTP), not implemented here.
  **Alerts:** still open, and shared with the Phase 3 alerting line below.
  **Retention: `[needs design decision: audit and personal-data retention periods]`, deliberately
  unstarted.** Not an engineering question — how long a jeweller must keep records naming who
  approved a refund is Indian tax/company law and the tenant's insurer. It also collides with the
  chain: `trg_audit_events_no_delete` refuses a DELETE outright, so a retention job needs an
  archive-then-prune path recording a checkpoint hash for the pruned range, or verification reports
  a gap forever after. That is worth building once the period is known and not before. Reasoning in
  `docs/AUDIT_AND_PII.md` §5.)*

  *(Earlier, 2026-08-16 — **the trail became readable**, which was the gap this strand kept
  hitting. `audit_events` has been append-only by trigger since Phase 24 and written on every money
  path since Phase 29, but nothing exposed it, so it was evidence in principle and not in practice.
  `GET /api/audit` and an Audit Trail screen close that: approver-only, on the same
  `requireApprover` gate as releasing a claim, because the trail names who released money and is
  therefore what a cashier under suspicion most wants to read. Filterable by record type, actor and
  date; four checks in `test_http.js` cover the read, the cashier's 403, the anonymous 401 and date
  validation. **Still open on this line:** PII classification, a retention policy, clock sync,
  alerting, and tamper-evident export — the trail cannot be edited, but nothing yet proves to a
  third party that it has not been.)*
- [ ] Threat-model payments, account takeover, tenant isolation, updates, insider/cashier fraud, extensions, backups and support exports.
  *(Not started. Note for whoever picks it up: the **insider/cashier fraud** strand was previously
  unanswerable rather than merely unanalysed — no financial record named who created it, so there
  was nothing to model. As of 2026-08-12 the sale, the refund, the advance redemption, the counter
  deposit and the deposit approval each carry an actor, and approvals carry a role, so the analysis
  now has data to reason about. As of 2026-08-13 the four controls that strand needed are in place:
  hashed PINs, session revocation on any roster change, optional per-operator TOTP required for
  releasing money, and a refund threshold above which a cashier is refused. **What is still missing
  for it:** a 4-digit PIN keyspace that does not survive file theft, and no dual control — one
  manager can still both authorise and take a large refund alone.
  **Both are `[needs design decision: ...]` as of 2026-08-16, deliberately unstarted.** Neither is
  a code question. Raising the PIN to six digits with a secret pepper from the environment changes
  every operator's muscle memory at the counter and needs a migration path for the PINs already in
  use; a dual-control threshold is a business rule about how much money one manager may move alone,
  and picking a number here would be inventing store policy. Asked and held open — §4 says guessing
  here produces work that gets thrown away.
  **Corrected 2026-08-15:** this note previously said the audit trail was unwritten. That was true
  when it was written on 2026-08-13, and Phase 29 (2026-08-15) changed it — moving the routes onto
  the service seam wired `audit.record()` into `saleService`, `returnService`, `advanceService` and
  `paymentService`, so the trail is written on every money path. What was still missing on
  2026-08-15 was the **read** path: nothing exposed the trail, so an append-only table nobody can
  read is evidence in principle and not in practice.)*
- [ ] Independent security review; SAST, secret scanning, dependency review, SBOM and host/image scans where applicable. *(**Scanning jobs added to `daily-checks.yml` on 2026-08-17, Phase 34, and NOT ticked because not one of them has ever executed** — like the rest of that workflow they need a pull request, and none has been opened. Three jobs: `secret-scan` (TruffleHog OSS over full history, `--only-verified` so an example key in a fixture cannot redden the gate permanently), `static-analysis` (Semgrep OSS, `p/javascript` + `p/nodejs` + `p/secrets`, ERROR severity only), and `sbom` (CycloneDX via `npm sbom`, which is built into npm 10+ and so adds no tooling and no dependency, published as a 90-day artifact per module). **Every tool was chosen to be free on a private repository:** CodeQL, `actions/dependency-review-action` and SARIF upload all need GitHub Advanced Security on a private repo, so none is used; dependency vulnerability review is already covered by the existing `npm audit` job. Expect the first real run to surface findings needing triage — that is the gate working. **Independent review remains external and unstarted.**)*
- [ ] Privacy notice, purposes/consents, rights workflow, retention/deletion, vendor register, incident response and export policy reviewed by Indian counsel.
- [ ] GST invoice, credit-note, records and applicable e-invoice/e-way configuration reviewed by a practising CA for the pilot merchant.

**Exit:** no unresolved critical/high security issue; full authorization matrix tested; privacy request and incident tabletop completed; CA approves pilot invoice/correction samples.

### Phase 3 — Reliability, deployment and operations (2–3 weeks)

**Goal:** prove the software can be operated and recovered, not merely started.

- [ ] Reproducible dev/sandbox/live provisioning; pin runtimes/dependencies.
- [~] Separate readiness from liveness; graceful shutdown, request IDs, structured logs, metrics and critical-flow traces.
  *(Four of the six landed 2026-08-16, Phase 32 — verified by seven checks in `test_http.js`
  §"The operational boundary" and by curling a live server. **Readiness/liveness split:**
  `GET /api/health` stays a dependency-free liveness answer, so a database blip can no longer make
  a restart supervisor kill a process that restarting cannot fix; new `GET /api/ready` answers 503
  with the failing check named until the ledger opens and every migration this build ships is
  applied. The three `cd-*.yml` smoke tests now poll it instead of sleeping 3s and curling
  liveness, so a half-migrated deploy fails the gate. **Graceful shutdown:** SIGTERM/SIGINT flip
  readiness to 503 first and close the listener second, so the proxy stops sending work while the
  sale already in flight still finishes; the ledger handle closes last. `kill_timeout: 15000` in
  both PM2 configs is load-bearing — PM2's 1600ms default would SIGKILL mid-drain and make the
  whole thing decorative. **Request IDs:** one id per request, echoed as `X-Request-Id`, honoured
  from an inbound header but only when it matches `[A-Za-z0-9._-]{1,64}` — the value reaches a log
  file, and an unvalidated one could forge entries. **Structured logs:** `logTelemetry()` takes
  merged structured fields (`requestId`, `method`, `path`, `statusCode`) and `logError()` takes a
  context object, so a reported error id is one grep. **Still open on this line:** metrics and
  critical-flow traces.)*
- [x] Alert on payment/webhook failures, ledger imbalance, backup failure, stale rates, error/latency, capacity, TLS expiry and control-plane failure. *(Closed 2026-08-19, Phase 35 — `backend/alerting.js`, one choke point (`raiseAlert()`) all eight signals funnel through: log always, email best-effort via the existing `emailReporter.js` transport, per-code 30-minute cooldown so a standing misconfiguration sends one email per window rather than one per event. **Payment/webhook**: hooked into the existing failure paths in the webhook route and `paymentService.js`. **Ledger imbalance**: new `invoiceRepository.js#findLineDrift()` (the line-sums-to-header invariant, checked live) plus the existing audit chain verification and readiness probe. **Backup failure**: alerts on `createBackup()` failure, and — since a file that copied is not proof it restores — spawns `verifyBackup.js` after every nightly backup and alerts on a failed restore; a separate daily freshness check catches the cron not firing at all. **Stale rates / capacity / control-plane**: rate-sync age, `fs.statfsSync` disk-free ratio, and the licensing-server catch blocks in `licenseChecker.js`/`updateEngine.js`. **TLS expiry**: no-ops unless `settings.publicUrl` is `https://` — correctly dormant, since no VPS/domain is provisioned yet (this doc's own note, above); activates the moment one is. Verified: `backend/test_alerting.js` (16 checks, `npm test` suite 9) plus a real local boot exercising `CONTROL_PLANE_UNREACHABLE` and the post-backup verify spawn against the actual tenant data — see `docs/LEDGER.md` Phase 35.)*
- [ ] Encrypted off-site backup and point-in-time recovery; automated isolated restore; monthly restore drill. *(**Two of the four closed 2026-08-17, Phase 34.** **Automated isolated restore: done** — `backend/verifyBackup.js` (`npm run backup:verify`) restores the latest snapshot into a temp directory and runs nine checks against it: files present, ledger present, SQLite `integrity_check`, migrations fully applied, business records actually there, **every invoice still summing to its own lines**, the audit chain verifying, and — the one that matters most now — whether the restored `settings.json` can be DECRYPTED on this host. It never touches the live install and exits non-zero on any failure, so it is usable as a scheduled job. Both paths were exercised against a real seeded snapshot: a clean one verifies 9/9, and one sealed with an unavailable key fails on exactly that check with an intact ledger. **Monthly restore drill: done** — procedure, failure-meaning table and a drill log in `docs/RUNBOOKS.md` §4. **Still open: off-site** (needs a destination — no VPS or object store is provisioned) **and point-in-time recovery** (SQLite PITR means WAL archiving or much more frequent snapshots; picking the interval is an RPO decision nobody has taken). **Partly closed: "encrypted"** — the credentials inside a snapshot are now ciphertext, so a stolen backup yields no keys, but the archive as a whole is not encrypted. **A trap worth knowing:** snapshots deliberately carry sealed secrets and never the key, so a restore onto a host without `GOLD_POS_SECRET_KEY` produces an intact ledger nobody can log into. Called out in the drill runbook.)*
- [x] Migration compatibility gates, canary/pilot release, rollback and post-deploy synthetic checks. *(Closed 2026-08-19, Phase 36. **Migration compatibility gate**: `backend/repositories/migrate.js#checkMigrationSafety()` (`npm run migrate:check-safety`, own CI job in `daily-checks.yml`) statically scans every migration on disk for a destructive DDL pattern — `DROP TABLE`/`DROP COLUMN`/rename — comment-stripped so an explanatory comment can't trip it. Needs no database; enforces the additive/backward-compatible rule CLAUDE.md §1 already states but nothing previously checked. **Canary/pilot release**: a release manifest gains `rolloutPercent` (1-100, default 100, part of the signed payload); `backend/updateEngine.js#isInRolloutCohort()` deterministically hashes `licenseKey:version` so a tenant's cohort membership is stable and widening a rollout (republishing the same version at a higher percentage — `GET /api/releases/latest` now prefers the most-recently-published entry on a version tie) only ever adds tenants, never drops one already auto-applying. Only meaningful on the security channel, the only one ever auto-applied. **Rollback**: `deploy/remote-deploy.sh` now records `.rollback-sha` (the commit it was about to move off of) before every normal deploy; a new `--rollback` flag resets to that commit instead of the branch tip. All three `cd-*.yml` workflows call it automatically when the post-deploy smoke test fails, then still fail the job — a rollback restores service, it does not make a bad build good. **Post-deploy synthetic checks**: already substantially covered before this phase — `GET /api/ready` (polled by every `cd-*.yml` smoke test) runs a real query and confirms zero pending/drifted migrations, not just a process-alive check; left as-is rather than risk writing synthetic test data into a live tenant's ledger. Verified: `backend/test_schema.js` (+3, the safety gate against fixtures and the real on-disk migrations), `backend/test_suite.js` Test 12 (+1, cohort determinism/monotonicity/per-tenant independence), a real local licensing-server boot (publish at 10%, confirm `rolloutPercent` round-trips through the signed payload, republish at 100%, confirm the widened entry wins, confirm out-of-range rejection), and the rollback shell logic exercised end-to-end against a throwaway local git repo (deploy A→B records `.rollback-sha`, `--rollback` correctly returns to A). **Not verified: the SSH/GitHub-Environment wiring itself** — same as the Phase 34 CI security-scanning jobs, this needs a real pull request and (for the deploy workflows specifically) a real VPS, neither of which exists yet (§7).)*
- [ ] Protected branches, reviewed PRs, signed provenance, artifact retention, scoped secrets and dual approval for fleet auto-updates.
- [ ] Exercise existing GitHub deploy paths on real sandbox, including forced failure/rollback.
- [ ] Runbooks: day open/close, payment mismatch, invoice duplicate, rate outage, connectivity loss, device loss, termination, restore and incident. *(**Eight of the nine written 2026-08-17, Phase 34 — `docs/RUNBOOKS.md`.** Day open/close, payment mismatch, duplicate/missing invoice number, rate outage, connectivity loss, lost or stolen device, tenant offboarding, and restore-from-backup, plus three the roadmap line did not name but the vault made necessary: rotating the secret-vault key, recovering from a lost key, and proving the audit trail has not been altered. **Missing: incident response**, left open deliberately — it overlaps the Phase 2 line requiring an incident process reviewed by Indian counsel, and writing a procedure that a lawyer then rewrites is wasted work. Not ticked until that ninth one exists.)*

**Initial measured targets:** 99.9% monthly availability; p95 ordinary API latency below 300 ms at pilot load; zero duplicate invoice/payment/ledger posting; RPO ≤15 minutes; RTO ≤60 minutes. Do not promise them contractually until measured.

**Exit:** restore/rollback meet targets; alerts reach a real on-call owner; seven-day sandbox burn-in has no unexplained ledger drift or unhandled critical alert.

### Phase 4 — Controlled pilot (2–4 weeks elapsed)

- [ ] One cooperative one-branch store; trained owner/cashiers; test payment before capped live payment.
- [ ] Merchant signs off opening balances/import.
- [ ] Parallel-run daily totals against the current process for 7–14 business days.
- [ ] Daily reconcile invoices, tenders, captures/settlements, advances, reversals/refunds and cash close.
- [ ] Collect support/performance/usability data and classify defects by financial impact.
- [ ] Agree rollback, escalation contacts and incident authority before live money.

**Exit:** two consecutive weeks at 100% daily reconciliation, no P0/P1 defect, pilot-like restore succeeds, and merchant accepts in writing.

### Phase 5 — Complete jewellery retail operations (6–12 weeks, staged)

Deliver vertical slices with stock, money, audit, reporting and permissions together:

1. Catalogue, multi-line sale, barcode/labels, HSN/hallmark and weight/stone/making model.
   *(**Multi-line sale landed 2026-08-12.** An invoice now holds up to 50 lines, each with its own
   purity, weight, store-side rate, making charge and discount, and each carrying its allocated
   share of the invoice's taxable value and GST. The Billing Desk has a cart, the Reprint Desk
   reproduces every filed line, and the Return Desk prices a return against a named line. The
   catalogue/SKU half of this slice — barcode, labels, HSN, hallmark/HUID, stone weights, wastage —
   is **not** started; see the note below on why it is the larger half.)*
2. Lot inventory, purchase receiving, adjustments/counts and branch transfer.
   *(**Lot inventory and adjustments/counts landed 2026-08-20, Phase 37** — the ungated half of
   this line. `inventory_items` (catalogue metadata), `inventory_lots` (a distinguishable batch of
   an item) and `inventory_movements` (append-only, trigger-enforced, exactly like
   `advance_entries`) via `backend/repositories/inventoryRepository.js`, `GET`/`POST
   /api/inventory/*`, and a new Inventory tab (`frontend/js/components/InventoryManager.js`).
   Stock only ever enters through an `opening_balance` movement (opening a new lot) or changes
   through an `adjustment` (a physical count, breakage, or correction) — refused if it would take
   a lot negative. **Purchase receiving and branch transfer are still NOT built** — the P2 section
   below gates both behind a legal/business definition (GST reverse-charge treatment for buying
   from a vendor or a customer, inter-GSTIN accounting for moving stock between branches) that has
   never been made; this migration's own header comment names the gap explicitly so a future
   change does not reinvent a `purchase`/`transfer` movement type without it. **Not wired into the
   sale/invoice flow** — a sale does not decrement stock yet; doing so would touch
   `computeInvoiceTotals`, which the "Cost note" below calls the most-tested function in the tree,
   and deserves its own pass. Verified: `test_schema.js` +4 (the CHECK constraints, via raw SQL
   bypassing the repository's own guards), `test_repositories.js` +11 (lot lifecycle, the
   negative-balance refusal, and a LEFT JOIN bug caught and fixed before it shipped — an item with
   zero lots in a branch-filtered stock query was silently dropped instead of reported at zero), a
   real local HTTP boot (item → lot → adjustment → refused-negative-adjustment → stock summary, all
   over the actual API with session cookies and CSRF), and a headless-Chromium run driving the real
   admin UI (login → new item → new lot → view lots → adjust → recent activity, screenshotted,
   zero console errors). Tests: 478 → 493, green, exit 0. See `docs/LEDGER.md` Phase 37.)*
3. Split tenders, cash shifts/closing, quotes/holds, reprint and delivery.
   *(**Reprint shipped in Phase 22. Split tenders landed 2026-08-12** — a sale records how it was
   paid across up to 10 tenders (`cash`/`card`/`upi`/`razorpay`/`bank_transfer`/`other`), validated
   in integer paise to sum exactly to the amount payable after any advance redemption. **Cash
   shifts/closing landed 2026-08-20, Phase 38** — `cash_shifts` (`backend/repositories/migrations/
   008_cash_shifts.sql`), append-only by trigger like `advance_entries`, one open shift per branch
   at a time. Expected cash is never stored until close — always computed fresh over the shift's
   own window: opening float, plus every cash tender and cash advance deposit, minus every cash
   refund, all read live from the existing ledger tables (`tenders`, `advance_entries`,
   `credit_notes`). `GET`/`POST /api/cash-shifts/*` and a new Cash Shifts tab
   (`frontend/js/components/CashShiftManager.js`) with a live expected-cash preview on an open
   shift. **Quotes/holds landed 2026-08-20, Phase 39** — `sale_drafts`
   (`backend/repositories/migrations/009_sale_drafts.sql`), the one table this session's phases
   added that is deliberately NOT append-only: a quote or a hold is scratch state, never a
   financial record, until the ordinary `POST /api/sales` path turns one into a real invoice. The
   cart is stored as opaque JSON and never priced or validated by the backend — it is priced by
   the Billing Desk at save time and re-priced there again at resume time, through the unmodified
   billing flow, so a stale rate or a moved tax setting is resolved exactly the way it always is:
   by the server's own recompute at submission. `GET`/`POST`/`PATCH /api/sale-drafts/*`, two new
   buttons on the Billing Desk (`HOLD`/`QUOTE`) that save the active cart without filing anything,
   and a new Quotes & Holds tab (`frontend/js/components/QuotesHoldsManager.js`) whose Resume
   button loads a saved cart straight back into the Billing Desk's own state. **Delivery is still
   not started** — this phase closes only the quotes/holds two-fifths of the roadmap line.
   Verified: `test_schema.js` +3 (kind/status enums, `json_valid(cart_json)`, and that the table
   really is freely mutable — no immutability trigger, unlike every other table this session
   added); `test_repositories.js` +6 (an empty cart refused, a full create → edit → resume →
   list-excludes-resumed lifecycle, a resumed draft's terminal refusal); a headless-Chromium run
   driving the real admin UI — entered an item on the Billing Desk, saved it as a Hold, found it
   under Quotes & Holds, resumed it, and watched the Billing Desk reload the exact cart and
   re-price it live to the paise through the unmodified billing engine. Full 43/43 Playwright e2e
   re-run — load-bearing here specifically, since this is the first change in this session's
   phases to touch `BillingDesk.js`, the most heavily e2e-covered file in the tree. Tests: 514
   checks in this commit (see `docs/LEDGER.md` Phase 39 for the concurrent-session caveat this
   figure carries forward from Phase 38).)*
4. Returns/exchanges, credit notes, refunds, approvals and old-gold only after legal sign-off.
   *(**Returns, credit notes and refunds shipped in Phase 23**, and were extended to per-line
   returns on 2026-08-12. **Approvals are done as of 2026-08-13**: advance deposits are owner/manager
   only and named on the row, and a refund at or above `refundApprovalThreshold` needs the same
   authority (plus a second factor when the store requires one). **Exchanges and old-gold remain
   blocked on legal sign-off.**)*
5. Customer master, consent/communications, accounting exports and tax/reconciliation reports.
   *(Not started.)*

Do not build dashboard charts before their underlying ledger/reconciliation definitions are accepted.

#### Cost note: what "multi-line sale" actually cost, and what is left

Slice 1 read as one feature among five and was the single largest hidden cost in this phase. It was
not an addition — it was a change to the most-tested function in the tree (`computeInvoiceTotals`),
to the shape of the permanent sale record, to `computeReturnRefund` (which prices off the stored
sale), and to three screens. It was made affordable by two decisions worth reusing:

- **Per-line figures are an ALLOCATION of the header figures, never an independent calculation.**
  The invoice total is computed exactly as it always was, over the summed lines, and then split
  across them in integer paise by largest remainder. That is why a one-line invoice still prices to
  the identical paise and why the printed rows always sum to the total.
- **The record carries `lines[]` *and* the old flat rollup**, read through one normaliser
  (`saleLines()`), so every invoice already on disk stayed reprintable and returnable and no reader
  needed changing to keep working.

**Wastage** appears in the SKU-catalogue list above and **exists nowhere in the code** — no field,
no helper, no setting, no test. It was named in `CLAUDE.md` §2 as money math requiring test coverage
before it was ever built, which has been corrected (2026-08-12). It is an unscoped catalogue
attribute, and it needs a product decision before it is anything else: whether wastage is a weight
uplift, a percentage of making charge, or a separate charged line, and whether it prints on the
customer's invoice. `[needs design decision: wastage model]`

### Phase 6 — Gold savings schemes (6–10 weeks after the foundation)

`SCHEME_MODULE_PLAN.md` contains useful discovery but proposes more JSON financial files. Rebase it on Phase 1:

- Installments are payment orders and append-only entries, never array appends.
- Gold/gram locks reference immutable approved rate snapshots.
- Maturity, bonus, default, closure and redemption are state machines with approval/reversal.
- Identity, consent, reminders, receipts, branch/staff audit, reconciliation and refunds reuse platform modules.
- Indian legal/CA review covers customer-money treatment, advertising, terms, receipts, cancellation/refund, bonus, nomination and state-specific applicability.

**Exit:** all installments reconcile; maturity/redemption cannot double-post; tenant/customer isolation tests pass; the legal-approved terms version is stored with each enrollment.

### Phase 7 — SaaS scale and mobile (ongoing)

- Control plane for provisioning, plans, billing/entitlements, fleet version/health, backup state, tenant-approved support and export/offboarding.
- Automated tenant isolation and database-level controls; optional dedicated deployment for high-value tenants.
- Replace licensing bearer secret with named MFA/RBAC identities, audit, rotation/KMS and dual release approval.
- One tenant-aware customer app with discovery/deep links, verified domains, secure native token storage, notification preferences, accessibility, consented analytics/crash reporting and complete store/privacy assets.
- Treat offline POS as a dedicated program: encrypted local store, idempotent commands, signed sync acknowledgement, conflict policy, device management and reconciliation. Do not bolt it onto JSON.
- Add replicas, warehouse, streams or microservices only when measured demand justifies them.

## 6. Test strategy and definition of done

| Layer | Minimum scope |
|---|---|
| Domain unit | Decimal/money rounding, tax, invoice/advance/scheme states, permissions |
| Database | Constraints, migrations, locks, rollback, idempotency, concurrent sale/payment/redemption |
| API integration | Every route: success, auth/role, validation, duplicate/stale state, provider and persistence failure |
| Contract | OpenAPI; Razorpay signed fixtures; email/SMS/OTP adapters |
| Browser E2E | Owner/manager/cashier/customer journeys, mobile, expiry, recovery, printing/PDF |
| Security | Authorization matrix, tenant isolation, limits, XSS/CSP, CSRF, secret leakage and scanners |
| Resilience | Process/DB/network/provider failure, webhook replay/order, disk full, restore, deploy rollback |
| Performance | Peak checkout, large paginated ledger/report, jobs and soak |
| UAT | Merchant-authored scenarios and signed reconciliation results |

Every financial feature is done only when its state diagram and rules are approved; the server owns amounts/time/identity; constraints/idempotency exist; audit, reversal and reconciliation are included; unit/API/E2E/failure tests pass; monitoring/runbooks are updated; migration and rollback work; and privacy/tax/legal impact is reviewed.

## 7. Go-live hard gates

### Financial correctness

- [ ] Customer and admin golden paths pass automated E2E.
- [ ] Server derives rate, metal value, tax, total, timestamp, balance and invoice number.
- [ ] Sale/payment/advance/stock operations are transactional and idempotent.
- [ ] Captured-state webhook and daily settlement reconciliation proven in test and capped live mode.
- [ ] Manual UPI cannot post credit without reconciliation/approval.
- [ ] Void, reversal, refund, reprint and credit-note behavior is audited.

### Security and compliance

- [ ] No demo/default credential or mock provider works in production.
- [ ] Named staff/RBAC, privileged MFA and verified customer identity.
- [ ] No secret in browser/log/export; TLS and headers verified.
- [ ] Independent high/critical security findings closed.
- [ ] Privacy/cyber processes and retention approved by counsel.
- [ ] Pilot invoices, credit notes and numbering approved by CA.

### Reliability and operations

- [ ] Real dev/sandbox/live deploy and rollback exercised.
- [ ] Off-site backup/full restore proven within RPO/RTO.
- [ ] Monitoring, on-call contact, support/status paths and incident runbooks active.
- [ ] Capacity/soak test meets pilot load with headroom.
- [ ] Seven-day sandbox burn-in and two-week pilot reconciliation complete.

### Commercial

- [ ] Terms, privacy, support/SLA, pricing, refunds/cancellation, data ownership/export and offboarding agreed.
- [ ] Onboarding, training, opening-data sign-off and escalation documented.
- [ ] Payment, OTP/SMS/email, domain/cloud/monitoring and Play accounts are company-controlled with MFA/recovery.

## 8. Owner decisions required in Phase 0

1. **Launch:** one pilot store first (recommended) or multi-tenant launch.
2. **Database:** PostgreSQL now (recommended) or time-boxed SQLite bridge.
3. **Hosting:** managed SaaS, dedicated tenant instances, or both.
4. **Offline:** acceptable v1 outage procedure or funded offline-first program.
5. **Staff:** roles, approval limits, shifts/cash responsibility and MFA.
6. ~~**Scope:** simple bullion-weight billing or full jewellery SKU/stone/hallmark inventory.~~ **Decided 2026-08-11 (owner): simple bullion-weight billing. There is no SKU concept.** The Catalogue domain in §4 — products, variants, lots, barcodes, stock movements/counts/transfers — is out of scope, as is the "stock" leg of the Phase 1 single-transaction item. Revisit only if inventory is reintroduced.
7. **Payments:** auto-capture, refund authority, manual UPI verification and settlement owner.
8. **Scheme:** entity, branch rules, installment/maturity/bonus/refund/default terms and legal jurisdiction.
9. **Data:** retention, support-access consent, backup geography and export/offboarding.
10. **Service:** support hours/contact, RPO/RTO, availability and pricing that funds operations.

## 9. First 30 days

### Week 1

- [ ] Freeze features; turn every P0 into a tracked issue.
- [ ] Add API/E2E harness; preserve current broken flows as failing regression tests.
- [ ] Patch dependencies and enforce production configuration validation.
- [ ] Write payment/order/advance state diagrams and database ADR.

### Week 2

- [ ] Repair frontend authentication/API integration.
- [ ] Persist/bind orders, implement webhook source of truth, make manual UPI pending.
- [ ] Make rate/value/time/balance server-authoritative.
- [ ] Add redaction and remove secrets from settings responses.

### Weeks 3–4

- [ ] Implement initial transactional schema and JSON migration dry run.
- [ ] Move sequence + sale + tender + redemption into one transaction.
- [ ] Add named staff/RBAC foundation and immutable audit.
- [ ] Deploy sandbox and publish migration/rollback/restore evidence.

At day 30, schedule a pilot only if evidence supports it—not because the interface looks complete.

## 10. Verification record from this audit

- `npm test` in `backend`: **pass** — 57 billing checks and 4 helper-level integration blocks.
- `npm audit` in `backend`: **fail** — 1 high and 2 moderate vulnerability groups (`nodemailer`, `node-cron`, transitive `uuid`).
- `npm audit` in `licensing_server`: **pass** — zero reported vulnerabilities.
- Git has substantial pre-existing uncommitted backend/frontend/deploy/docs/licensing work. This plan does not overwrite it.
- Deployment code/docs exist, but the repository checklist says the real VPS run, live approval gate and licensing isolation are not tested end to end.

Passing arithmetic tests are valuable; they do not establish system integrity. Production readiness requires repeatable evidence for every hard gate.

## 11. Primary compliance and payment references

Planning inputs, not legal advice:

- [CBIC GST tax-invoice particulars](https://cbic-gst.gov.in/gst-invoice-rules.html) — a CA must validate invoice content/numbering against the merchant's facts.
- [MeitY Digital Personal Data Protection Rules, 2025](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa) — counsel should track phased enforcement and review purposes, notice/consent, safeguards, rights, retention and breach processes.
- [CERT-In directions under section 70B](https://cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf) — assess incident reporting, clock synchronisation and secure log-retention duties for the operating entity.
- [Razorpay Standard Checkout](https://razorpay.com/docs/developer-tools/integrations/standard-checkout/) and [webhook validation/idempotency](https://razorpay.com/docs/webhooks/validate-test/?locale=en-US) — captured status, signed raw-body webhooks, duplicate and out-of-order events belong in the core payment design.

Before launch, use a practising Chartered Accountant and qualified Indian privacy/technology counsel. Software should provide controls and evidence; it should not claim to make every merchant compliant automatically.
