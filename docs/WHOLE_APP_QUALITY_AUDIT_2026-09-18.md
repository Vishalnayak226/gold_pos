# Whole-App Quality Audit — Lumina POS

**Audit date:** 2026-09-18  
**Scope:** cashier POS, customer portal, backend, SQLite repository layer, licensing/release service, deployment, Capacitor wrapper, documentation, operations and SaaS readiness.

This is an independent “third-eye” audit. It asks what a cashier, owner, customer, hostile tester, support engineer, product leader, and future SaaS operator would each need to trust. It does **not** claim that any software can have zero future bugs. The useful standard is: important promises are explicit, tested repeatedly, observable in production, recoverable when something fails, and safe to change.

## Snapshot and boundaries

The source snapshot was `e8d7a93` plus active uncommitted work on 2026-09-18. The audit did not change application behaviour or publish anything. Each automated test uses its own temporary tenant/data directory; no test was pointed at `backend/data/`.

The architecture is deliberately light: one Node/Express process and one SQLite database per tenant, a separate licensing/release service, static vanilla-JS user interfaces, and an optional Capacitor wrapper for the customer portal. This is a strong small-tenant shape; it is not yet a shared, self-service SaaS control plane.

## Test map — what was exercised

A **pass** proves only its stated scope. A local pass is never proof of a real shop, bank, VPS or every device.

| Test family | Repetitions completed on 2026-09-18 | Result and exact scope |
|---|---:|---|
| Schema evolution safety | 3 | Pass: all 17 migrations scanned each time; no destructive DDL pattern. This is static safety, not a real-merchant upgrade rehearsal. |
| Runtime dependency security — POS | 3 | Pass: `npm audit --omit=dev --audit-level=moderate` reported 0 vulnerabilities each time. It does not audit host OS, configuration, or future advisories. |
| Security HTTP regression | 3 | Pass: 10 checks each for CSRF, role authorization, static traversal, oversized requests and log-secret redaction. It repeatedly exposed QA-001 below. |
| Full backend regression suite | 2 | Pass: two clean `npm --prefix backend test` runs, each completing all 12 Node suites. The suite includes arithmetic, schema, repositories, concurrency, routes, HTTP, production guard, alerting, log writer/rotation and security. |
| HTTP/API and financial boundary | 3 | Pass: one independent 139-check run plus that same suite inside both full regressions. It covers settings, sales, returns, advances, payment/webhook refusals, audit export, rate limits, request IDs and graceful draining. |
| Browser end-to-end journeys | 2 | Pass: **67/67** in 7.6 minutes, then **71/71** in 5.9 minutes. The test inventory grew between passes because active work added Store Profile coverage; both are recorded as passing source snapshots, not falsely as identical-revision flake evidence. It drives real pages, server and isolated database; it is not hardware, cross-browser, screen-reader, or Android-native coverage. |
| Performance smoke baseline | 3 | Pass: seeded authenticated loopback benchmark. Serial checkout p95 **29.74–34.68 ms**; 5-till checkout p95 **92.42–170.51 ms** on the local Windows laptop. |
| Static accessibility smoke | 3 | Pass: no missing `alt` on static images and no empty static buttons. It found 32 top-level buttons relying on browser-default button type; hardening task, not confirmed breakage. |
| Licensing-service syntax | 3 | Pass: `node --check licensing_server/server.js`. No licensing-service behavioural test suite exists yet. |
| Licensing dependency audit | 2 | Pass: 0 production dependency vulnerabilities. A third run and automated behavioural coverage remain open. |
| Mobile wrapper dependency audit | 0 runnable | Blocked: `mobile/` has no lockfile, so `npm audit` refuses to run. There is no generated Android project or device build in this workspace. |
| Knowledge-map coverage | 2 | Initial check reported 20 unclaimed files. After adding audit-document mapping and rebuilding, coverage improved to 91.3% but 18 older source/operating files remain unclaimed. Tooling/documentation debt, not a POS runtime defect. |

### What the existing suite already proves well

- Money/tax arithmetic, paise rounding, discounts, advances, returns, multi-line invoices, wastage and scheme arithmetic.
- Database constraints, append-only financial records, migration safety, duplicate/idempotent requests, real multi-process concurrency and crash injection.
- Authentication, named roles, MFA/refund controls, session revocation, CSRF, request limits, secret redaction, payment verification and webhook replay.
- Desktop journeys for login, billing, advances, customer portal, dashboard, inventory-to-sale-to-return/void, reprint and returns; customer journeys repeat at a mobile browser viewport.

### What these results do *not* prove

- A real payment settlement, production webhook, printer/scanner/scale/cash-drawer integration, low-end counter speed, Wi-Fi loss or eight hours of shop use.
- Android/iOS build quality, Play Store review, native secure storage or push notifications.
- A legal/tax/privacy conclusion, a penetration-test conclusion, or that the live host is secure.
- Multi-tenant isolation in a shared SaaS deployment. The current product is deliberately one tenant per install/database.

## Confirmed bug found in this audit

### QA-001 — Security-test teardown races the asynchronous log writer

**Severity:** Medium test/reliability defect; no evidence of customer-data or financial-data exposure from this finding.

**Evidence:** all three `test:security` runs printed a green 10-check result and then printed one or both of these after the temporary folder had been removed:

```text
[LogWriter] Could not rotate ... logs\telemetry.log: ENOENT
[LogWriter] Could not append ... logs\blackbox.log: ENOENT
```

**Cause:** `backend/test_security.js` closes its listener with `server.close()` and deletes the temp directory. Production shutdown uses `shutdown(server, reason)`, which drains `logWriter` before closing the ledger. The test bypasses that path, leaving queued diagnostic writes targeting a deleted directory.

**Required build task:** make the security test use and await the production graceful-shutdown path before cleanup; assert that the log writer has no queued or in-flight entries. The test must fail on a post-cleanup write warning. This proves the intended shutdown guarantee rather than merely printing it.

**Resolved 2026-09-19.** `backend/test_security.js`'s `finally` block now calls `await shutdown(server, reason)` — the same exported function production's SIGTERM/SIGINT handlers use — before removing its temp directory, and asserts `getLogWriterStats()` shows zero queued/in-flight entries immediately after. A new regression guard monkeypatches `console.warn`/`console.error` around the cleanup step and throws on any post-cleanup `[LogWriter]` message. The guard was proven, not just written: the old bare `server.close()` was temporarily reintroduced, reproduced the exact pre-fix `ENOENT`, and the new guard correctly failed the suite (exit 1) instead of passing silently; the real fix was then restored and diffed byte-identical before final verification. `npm run test:security` × 6 and full `cd backend && npm test` (12 suites) × 2, all exit 0 with zero `[LogWriter]` lines from the security suite in any run. Full detail: `docs/LEDGER.md` 2026-09-19 entry, `docs/TESTING_CHECKLIST.md` §25a.

## Module coverage from a product-user view

| Surface | What is present | Current automated confidence | Next test/build item |
|---|---|---|---|
| Admin lock screen, roles, MFA and sessions | Present | Strong route + browser coverage | Add keyboard/screen-reader and cross-browser role-matrix journeys. |
| Dashboard | Present | Dedicated desktop journey | Add empty/error/offline and large-data visual/performance cases. |
| Billing, tenders, discounts, advances, rates, quote/hold and old-gold panel | Present | Strong arithmetic/HTTP/browser coverage | Add dedicated UI tests for discount toggle, no-advance negative state, hold/quote recovery and enabled old-gold options. |
| Reprint and returns | Present | Strong browser and arithmetic coverage | Build a legacy-shaped fixture so old-invoice warnings are exercised in a real UI. |
| Customer portal | Present | Strong desktop + mobile-browser coverage | Add accessibility, network retry, real payment sandbox and native-app tests. |
| Inventory, lots, stock adjustments | Present | One broad operations journey plus repository/HTTP coverage | Add stock-count, barcode/scale/printer, permission and high-volume catalogue cases. |
| Advances | Present | Dedicated browser journey added in current working tree | Add approval/rejection, pagination and busy-counter/error-retry paths in the browser. |
| Cash shifts, reports, audit trail, customer master, quotes/holds, gold schemes | Present in UI/API | Mostly service/route coverage; no complete dedicated browser suite for each | Add focused browser journeys before calling every tab counter-ready. |
| Settings and diagnostics | Present | Strong route security, partial browser coverage | Add save/reload/error/cancel/role-denied matrix for every settings section. |
| Licensing/release service | Present | Syntax and dependency audit only | Add isolated API, signature, entitlement, rollout, rollback and authorization suite. |
| Capacitor customer app | Scaffold only | No native build/device evidence | Lock dependencies, build Android, run device matrix and store-review checklist. |
| Deployment/operations | Scripts and runbooks present | Local checks only | Exercise disposable VPS, DNS/TLS, rollback, restore, alert and incident drill. |

## Mature-product and SaaS opportunity queue

These are **open build items**, not promises to build blindly. Each needs an owner decision, concise acceptance criteria, threat-model update and tests before implementation.

### P0 — decide before a paid/public multi-shop SaaS launch

- [ ] **[needs design decision: operating model]** Decide whether Lumina remains dedicated-one-tenant-per-install or will offer shared managed SaaS. Document data isolation, tenant provisioning/deactivation, support access, backup ownership, uptime responsibility, cost model and exit/offboarding.
- [ ] **[needs design decision: branch model]** Define multi-branch operation: store/counter identity, rate ownership, invoice sequences, cashier movement, stock transfer, branch reporting and permission boundaries. The data model has branch concepts; the owner workflow is not yet a complete product surface.
- [ ] **[needs design decision: authority]** Set approval rules for large discount, stock adjustment, void, cash-shift variance, old-gold assessment, scheme settlement and rate override. Name threshold, approver, evidence and emergency override—do not let an implementation accidentally set financial policy.
- [ ] **[needs design decision: outage mode]** Decide whether a shop must sell during internet/provider loss. If yes, design encrypted local storage, queue/conflict/idempotency, rate staleness and reconciliation before building it. If no, make the blocked/offline counter experience clear and practised.
- [ ] **[needs design decision: compliance scope]** Confirm CA/counsel-approved GST/credit-note, hallmarking, old-gold, savings-scheme, retention, privacy, customer deletion, breach and support policies for each merchant type.

### P1 — capabilities expected of a mature vertical SaaS

- [ ] Build an organization-controlled SaaS control plane: tenant onboarding, plan/entitlement changes, suspension, fleet health/release cohorts, backup freshness, tenant-approved support access, exports and offboarding.
- [ ] Build a licensing-service suite for license issue/suspend/renew, signature validation, release publishing, rollout widening, authorization, malformed input and control-plane outage.
- [ ] Make the mobile project reproducible: committed lockfile, dependency review, Android build/signing pipeline, real-device matrix, native token-storage decision, deep links, notification policy and Play Store evidence.
- [ ] Define purchase receiving, suppliers, vendor invoices, repair/job-work, inventory counts, shrinkage approval, branch transfers and stock valuation rules. Lots and adjustments exist; these lifecycle flows are distinct decisions.
- [ ] Define hardware contracts for scanner, weighing scale, thermal/label printer, cash drawer and card terminal; certify exact models and failure/retry behaviour.
- [ ] Provide a machine-readable complete merchant export/import contract, including invoices, returns, advances, stock, operators, settings (with safe secret treatment) and audit evidence; prove independent restore/import.
- [ ] Build support maturity: consented support sessions, redacted diagnostics, status page, incident communication templates, SLA/ownership and support-audit trail.

### P2 — competitive and experience-expanding options

- [ ] **[needs design decision: retail workflows]** Evaluate repair orders, made-to-order/job tracking, supplier purchase orders, layaway, wishlists, loyalty/referrals, CRM reminders and sales-associate commissions.
- [ ] **[needs design decision: tax/accounting integrations]** Evaluate accounting exports/integrations, e-invoice/e-way-bill needs, payment-terminal integrations and settlement automation with CA input.
- [ ] **[needs design decision: accessibility/localisation]** Select supported languages, transliteration, Indian-number/date formats, simple English, high-contrast/large-type modes and supported browser/device list.
- [ ] **[needs design decision: analytics]** Define privacy-safe product and operational metrics, opt-in/retention rules, failure analytics and a way to act on them without collecting unnecessary customer data.

## Best-in-class UI acceptance checklist

“Beautiful” is not enough at a jewellery counter. The release bar below makes smoothness, clarity and recovery testable.

- [ ] Every primary cashier flow works by keyboard, barcode scanner and touch; focus is visible, logical and returns to the trigger after dialogs.
- [ ] Every button declares semantic type (`button`, `submit`, `reset`) and every form field has a programmatic label, error association, useful `inputmode`/autocomplete and predictable Enter-key behaviour.
- [ ] Every destructive/money-moving action names the customer/item/amount, requires appropriate confirmation, blocks duplicate submission and leaves an audit event.
- [ ] Errors use short plain language: what happened, what the cashier can do now, what was preserved, and when a manager/support person is needed.
- [ ] Loading, retry, timeout and offline states never look frozen; late responses cannot overwrite newer input or an existing cart.
- [ ] Desktop layouts work at 100%, 125% and 200% zoom; customer journeys work at the smallest supported phone width; print output is independently checked.
- [ ] Add Playwright visual-regression baselines for lock screen, billing, invoice, return note, warnings and customer portal.
- [ ] Run manual screen-reader, keyboard-only, colour/contrast and simple-English cashier sessions with people who did not build the app.

## Lightweight-server and performance checklist

The correct way to be “ultra light” is to keep the trusted core simple and measure the slow part before adding machinery. Never weaken durable financial transactions or audit records to improve a dashboard number.

- [ ] Set merchant-facing budgets on exact supported counter and target VPS: boot/login, keystroke feedback, SKU/customer lookup, recalculation, sale commit, print preparation, tab switch, reports, memory growth and error feedback.
- [ ] Extend the benchmark with return, void, stock adjustment, payment/webhook and mixed-till contention workloads against a large safe representative tenant; retain p50/p95/p99 JSON with Node version, revision and hardware.
- [ ] Capture eight-hour counter-browser soak and target-VPS resource trace: RSS/heap, CPU, event-loop delay, SQLite/WAL/disk behaviour, logs and open handles.
- [ ] Verify cache headers/release invalidation in a real proxy/browser; test cold cache and offline/error paths.
- [ ] Test slow networks, packet loss, provider delays, DNS failure, disk pressure and clock drift. Every outcome must preserve financial correctness and give an operator a next step.
- [ ] Keep the dependency budget reviewed. Do not add a cache, queue, ORM, framework or telemetry agent without a demonstrated bottleneck and removal plan.

## Full quality programme still to run

| Area | Required repeatable evidence |
|---|---|
| Financial correctness | Property/generative tests, mutation tests of validation/refusal paths, invariant matrix coverage, crash/replay/concurrency tests and CA-reviewed examples. |
| API compatibility | Versioned contract fixtures, negative schema cases, pagination/filter boundaries and consumer compatibility for every public endpoint. |
| Browser/UI | Dedicated journeys for every tab/settings section, visual snapshots, keyboard paths, zoom/reflow, real print output and browser matrix. |
| Accessibility | Automated semantic checks plus manual screen-reader, keyboard-only, contrast and cognitive/simple-language assessment. |
| Security | Authz/IDOR/tenant-isolation matrix, CSRF/XSS/path/body/ID fuzzing, secrets scans, SBOM review, external penetration test and code review. |
| Payments | Provider sandbox and tiny controlled live transaction: success, cancel, timeout, signature failure, duplicate/late/out-of-order webhook, mismatch, refund and settlement reconciliation. |
| Reliability | Fault injection for disk full, read-only log/backups, process crash, abrupt power/network loss, provider outage and recovery without duplicate money/stock. |
| Recovery | Clean-host restore, audit-head verification, RTO/RPO measurement, rollback rehearsal, recovery-key custody and annual evidence. |
| Performance | Target-device/VPS load, concurrency, data scale, soak, memory/handle leak and input-to-print budgets. |
| Hardware | Exact scanner/scale/printer/drawer/card-terminal certification, paper-out/retry and device reconnect tests. |
| SaaS | Provision/suspend/offboard tenant, isolation, entitlement/rollout, support access, exports, shared-service outage and backup/restore tests. |
| Mobile | Android build/signing, device/OS/network matrix, deep links, secure storage, store review and accessibility tests. |
| Operations | Real DNS/TLS/proxy/firewall/alert/backup/rollback drill, incident exercise, support handoff and daily reconciliation. |
| Legal/privacy | CA/counsel approvals, retention/deletion/export rehearsal, customer notices, processor inventory and breach tabletop. |
| Release discipline | Clean reproducible install, CI on exact revision, SBOM, signed/reviewed artifact, canary, rollback and post-release monitoring. |

## Recommended build order

1. Fix **QA-001** so security tests prove graceful diagnostic shutdown and do not emit false operational failures.
2. Close browser coverage around settings, cash shifts, quotes/holds, customer master, schemes, audit, reports, diagnostics and licensing.
3. Choose P0 operating/branch/approval/outage/compliance decisions before adding features that would need redesign.
4. Establish target hardware/VPS budgets and perform real counter, payment, recovery and independent-security evidence before a paid/public launch.
5. Build SaaS control plane and native mobile only against the chosen commercial model, with testable tenant and privacy boundaries.

The detailed executable tasks are in [TESTING_CHECKLIST.md §25](TESTING_CHECKLIST.md#25-whole-app-quality-audit-and-maturity-backlog-added-2026-09-18).
