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
- Never return Razorpay/SMTP/admin secrets to a browser. Use environment/secret management and expose only redacted configuration state.
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
- Multi-line invoices, split tender, cash/card/UPI/bank/advance allocation, quotes, hold/resume, reprint, delivery.
- Returns/exchange, void/cancel, credit/debit notes, refund lifecycle, approval thresholds, and reversal entries instead of history edits.
- Customer master with consent/preferences, deduplication, correction/export and legally appropriate deletion/anonymisation.
- Vendor/purchase, branch transfer, old-gold workflows only after legal/business definition.
- Cash drawer and shift close/count/variance, staff permissions/commissions, daily closing.
- GST-ready invoice and export configuration reviewed by a practising CA.
- Paginated search/reports, accounting export, settlement/advance reconciliation, profitability and inventory ageing.

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

- [ ] Freeze feature work, including Scheme work, except P0 remediation.
- [ ] Create reproducible seeded dev/test data with no real customer information.
- [x] Wire `customer.html` to register/login/logout/profile/password/reset and authenticated customer advance APIs. *(2026-08-08 — `backend/customerAuth.js` + `/api/customer/*`; verified by a 53-check API pass, a 20-check post-restart pass, and a 29-check Playwright pass at a 390px viewport, all green with `backend/data/` restored byte-identical afterwards.)*
- [x] Replace every raw call to an admin-gated route with the authenticated API client. *(2026-08-08 — `BillingDesk` advance lookup and `AdvancesManager` counter deposit moved to `adminFetch()`; the Playwright pass asserts zero 4xx/5xx across the whole admin terminal, which is what would surface a remaining raw call.)*
- [ ] Persist payment orders and bind phone, amount in paise, currency, state and expiry.
- [ ] Add signed Razorpay raw-body webhook ingestion, event-ID idempotency, out-of-order handling and reconciliation. Credit only captured/paid transactions.
- [ ] Convert manual UPI to a pending claim requiring manager reconciliation.
- [ ] Validate real advance balance and make the server authoritative for rate, metal value, time and sale totals.
- [ ] Reject duplicate payment/reference IDs and use cryptographically strong IDs. *(Half done 2026-08-08 — `POST /api/payment/verify` now returns the original deposit for an already-seen `razorpay_payment_id` instead of appending a second row, verified live. Still open: ledger row IDs are `Math.random()`-derived, and a manual-UPI `referenceId` is not yet unique-constrained.)*
- [ ] Fail production startup on demo keys, mock rates, default credentials, missing public URLs, or environment confusion.
- [ ] Upgrade vulnerable dependencies; use `npm ci`; run all suites in every gate.
- [ ] Add route tests for auth/money endpoints and Playwright cashier/customer journeys.
- [ ] Correct documentation claims and distinguish “implemented” from “independently verified.”

**Exit:** all P0s have regression tests; no high/critical audit finding; customer/cashier golden paths pass in desktop and mobile viewports; production cannot run in demo mode.

### Phase 1 — Transactional financial foundation (3–5 weeks)

**Goal:** make duplicate money, partial writes and silent corruption structurally difficult.

- [ ] Approve ADR-001: PostgreSQL recommended, or time-boxed SQLite bridge.
- [ ] Migrate organisations, staff, customers, rates, invoices/lines, tenders, payment orders/events, advances/entries and audit.
- [ ] Build a JSON importer with dry run, validation report, counts/checksums, backup, rollback and repeatability.
- [ ] Split route handlers, domain services and repositories.
- [ ] Execute invoice allocation + sale/lines + tender + advance redemption + stock + audit in one transaction.
- [ ] Add unique constraints for invoice scope, provider order/payment/event IDs, references and idempotency keys.
- [ ] Make advances append-only with `pending`, `posted`, `reversed`; reserve funds safely during checkout.
- [ ] Add explicit invoice transitions and reversal/credit-note behavior; issued facts are never edited.
- [ ] Paginate/filter every list and remove full-history browser loads.
- [ ] Add concurrency, crash-injection, duplicate-request and migration tests.

**Exit:** process kills at every write step cannot create an unbalanced sale; 100 duplicate/concurrent submissions create one result; imported totals reconcile exactly; rollback is rehearsed.

### Phase 2 — Identity, security, privacy and compliance (2–4 weeks)

**Goal:** accountable access and a defensible production baseline.

- [ ] Named staff, RBAC/least privilege, strong password or passkey, MFA for owner/manager/control plane, device/session view, revocation and forced expiry.
- [ ] HttpOnly/Secure/SameSite browser sessions (or documented threat-modeled native token design); CSRF protection where cookies apply.
- [ ] OTP or audited store-assisted customer phone verification.
- [ ] Secrets outside settings responses/exports; redaction, encryption and key-rotation runbook.
- [ ] Same-origin policy, CSP/security headers, runtime schemas, upload/request limits, rate/abuse limits and safe errors.
- [ ] Structured audit/security logs with PII classification, retention, clock sync, access control, alerts and tamper-evident export.
- [ ] Threat-model payments, account takeover, tenant isolation, updates, insider/cashier fraud, extensions, backups and support exports.
- [ ] Independent security review; SAST, secret scanning, dependency review, SBOM and host/image scans where applicable.
- [ ] Privacy notice, purposes/consents, rights workflow, retention/deletion, vendor register, incident response and export policy reviewed by Indian counsel.
- [ ] GST invoice, credit-note, records and applicable e-invoice/e-way configuration reviewed by a practising CA for the pilot merchant.

**Exit:** no unresolved critical/high security issue; full authorization matrix tested; privacy request and incident tabletop completed; CA approves pilot invoice/correction samples.

### Phase 3 — Reliability, deployment and operations (2–3 weeks)

**Goal:** prove the software can be operated and recovered, not merely started.

- [ ] Reproducible dev/sandbox/live provisioning; pin runtimes/dependencies.
- [ ] Separate readiness from liveness; graceful shutdown, request IDs, structured logs, metrics and critical-flow traces.
- [ ] Alert on payment/webhook failures, ledger imbalance, backup failure, stale rates, error/latency, capacity, TLS expiry and control-plane failure.
- [ ] Encrypted off-site backup and point-in-time recovery; automated isolated restore; monthly restore drill.
- [ ] Migration compatibility gates, canary/pilot release, rollback and post-deploy synthetic checks.
- [ ] Protected branches, reviewed PRs, signed provenance, artifact retention, scoped secrets and dual approval for fleet auto-updates.
- [ ] Exercise existing GitHub deploy paths on real sandbox, including forced failure/rollback.
- [ ] Runbooks: day open/close, payment mismatch, invoice duplicate, rate outage, connectivity loss, device loss, termination, restore and incident.

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
2. Lot inventory, purchase receiving, adjustments/counts and branch transfer.
3. Split tenders, cash shifts/closing, quotes/holds, reprint and delivery.
4. Returns/exchanges, credit notes, refunds, approvals and old-gold only after legal sign-off.
5. Customer master, consent/communications, accounting exports and tax/reconciliation reports.

Do not build dashboard charts before their underlying ledger/reconciliation definitions are accepted.

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
6. **Scope:** simple bullion-weight billing or full jewellery SKU/stone/hallmark inventory.
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
