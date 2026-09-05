# Gold POS: 360° adversarial product, operations and performance audit

**Audit date:** 2026-09-02  
**Scope:** Read-only code and documentation review; local automated tests; clean-instance HTTP benchmark; current Indian regulatory-source review. No product configuration, ledger data, or production service was changed.

## Executive verdict

Gold POS has a surprisingly serious financial core for a lightweight product. Server-authoritative pricing, SQLite transactions, append-only financial records, idempotency, concurrency/crash tests, named operators, customer sessions, inventory lots and audit evidence are all real strengths.

It is **not yet a self-serve, production-ready jewellery platform**. The blockers are mostly at the edges where good code meets a real shop: legal invoice completeness, physical-counter workflow, onboarding, operating discipline, live payment/deployment proof, recovery ownership, and performance under real write/log pressure. Do not solve these by adding a framework, microservices, a database server, or a large dependency tree.

The product goal should be: **one fast local web page, one Node process, one SQLite file, one clearly trained counter workflow**. Every recommended implementation below preserves that posture unless explicitly marked as a future scale trigger.

## Evidence gathered

- Automated suites observed passing: 164 billing arithmetic checks, 81 schema checks, 150 repository/service/importer checks, 16 concurrency/crash checks, 15 integration checks, 29 HTTP/auth checks, 17 production-guard checks and 16 alerting checks.
- Browser E2E was started; the first six cashier scenarios passed, including server repricing and partial-phone refusal. Treat the complete 44-test E2E run as a release gate and capture its final report in CI rather than relying on this local observation.
- Clean local benchmark (Windows, Node 26, one empty temporary tenant, warm loopback):

| Request | p50 | p95 | Notes |
|---|---:|---:|---|
| `GET /api/health`, serial, n=250 | 9.63 ms | 19.73 ms | Healthy cold-data baseline |
| `GET /`, serial, n=100 | 12.79 ms | 20.08 ms | Static HTML baseline |
| `GET /js/app.js`, serial, n=100 | 9.66 ms | 18.08 ms | Static JS baseline |
| `GET /api/health`, 25-way, n=500 | 16.25 ms | 35.45 ms | 694.8 req/s overall; p99 123.83 ms |

These numbers prove only that the local empty-instance core is quick. They are **not** checkout latency, a VPS result, a browser-interaction result, a printer result, or a large-ledger capacity statement.

## The journeys: several deliberately biased eyes

### 1. Cashier / floor person who only knows basic English

**Happy journey:** sign in → choose purity → enter weight/making → optional customer mobile → take payment → save → print.

**What feels good**

- The single-item path does not require first adding an item to a cart.
- Live invoice totals and a clear customer-advance lookup reduce mental arithmetic.
- Invalid partial phone numbers are stopped before an invoice number is consumed.
- Reprint, return, exchange-credit and cash-shift controls exist instead of being improvised on paper.

**Where this person gets stuck**

1. The counter vocabulary is expert vocabulary: *inclusive/exclusive tax*, *wastage model*, *HUID*, *advance redemption*, *pending claim*, *delivery status*, and multi-tender reconciliation. It assumes the cashier understands the accounting effect, not just the button.
2. No guided first-day counter mode, sample sale, role-specific landing screen, keyboard map, or “what do I do now?” checklist is visible. A novice will learn by asking a senior, which produces inconsistent transactions.
3. No evidence of tested weighing-scale, barcode-scanner, thermal-printer, cash-drawer, label-printer, browser-print margin, or power-loss-at-the-counter journeys. Retail friction often lives there, not in APIs.
4. The UI is English-only. If the shop needs Kannada/Hindi/Tamil/etc., staff training becomes the product instead of the product carrying the training.
5. A customer number triggers a lookup when the tenth digit is entered; a delayed response could overwrite a newer number unless the client uses request cancellation/sequence checking.

**Decision:** pilot only with a cashier playbook, a laminated fallback procedure, a named manager on the floor, and hardware UAT. Build “counter basics” before adding another financial feature.

### 2. Shop owner / CEO

**Happy journey:** configure store → set rates and tax mode → add staff → open a shift → track sales, advances, stock and cash variance → close day → inspect reports/backups.

**What is mature**

- Financial documents are not silently rewritten; return and audit facts are retained.
- Named operator roles, session revocation, optional MFA, approval thresholds, cash shifts and reconciliation are exactly the controls a serious owner needs.
- Rate authority sits on the server, and a bad production configuration is designed to refuse to boot.

**CEO objections**

1. The management reports feature is hidden/off by default and profitability is only as good as linked lot costs. A CEO can mistake “no report” or “partial coverage” for zero profit.
2. There is no visible daily operating cockpit that answers: open till? pending UPI claims? stale rate? unsent invoice? low disk? backup last verified? payment settlement mismatch? These exist in separate surfaces or logs, not as one red/amber/green decision screen.
3. The current set-up model expects ownership of a domain, VPS, SSH, DNS, environment keys, Razorpay webhooks and backup destinations. That is operator/DevOps work, not normal shop-owner self-service.
4. The product has no stated migration/import certification for a real jewellery shop's catalogue, stock, customer ledger and opening balances. A CEO will ask, correctly: “Can I switch on Monday without retyping years of data?”
5. The gold savings scheme, old-gold exchange and wastage controls are financially sensitive. Correct code is not a substitute for approved merchant terms, accounting treatment and staff policy.

**Decision:** sell a managed onboarding/pilot, not “download and self-install.” The commercial offer must include a data-migration rehearsal, staff training, printer/scale certification, CA sign-off, backup drill and go-live hypercare.

### 3. Product head from another retail industry

**Strength:** this is a credible vertical core, not generic billing software. Weight, purity, rate lock, advance redemption, HUID lots, returns and exchange credit are differentiated.

**Maturity gaps**

1. Product configuration is store-wide rather than a coherent policy engine. The owner needs versioned terms and effective dates for rates, discounts, wastage, return windows, approval limits, exchange deductions and scheme conditions.
2. “Customer” is split across sale snapshots, account login and master data. The workflow needs one clear identity/reconciliation model and an explicit duplicate-merge policy.
3. There is no complete omnichannel promise: quote → appointment → sale → delivery/alteration/repair → customer communication → exchange/return is incomplete. Do not advertise omnichannel until this is intentionally designed.
4. No first-class supplier purchase, job-work/karigar, repair, consignment, stone, certification, branch-transfer or physical stock-take workflow was evidenced. These are normal jewellery operations; each needs a product decision, not an accidental field addition.
5. There is no release-quality product telemetry: completion time, abandoned draft reasons, reprint rate, price override frequency, refund approval rate, and support outcomes. Technical telemetry is not product learning.

**Product principle:** add vertical workflows only when each has (a) a legal/accounting owner, (b) a state model, (c) a reversal model, (d) printed evidence, (e) a cashier script, and (f) a test fixture.

### 4. Customer / normal user

**Good:** customer login, balances, returns, password reset and payment verification are materially better than a public phone-number lookup.

**Break points**

1. A customer with existing store history may be blocked from self-registration and told to visit the counter. This is secure, but conversion and support are not yet designed around it.
2. Customer phone ownership is not demonstrated by OTP or an audited store-assisted verification flow. Treat account establishment as a risk decision until this is closed.
3. Password reset depends on SMTP. If mail is unconfigured, the fallback is human support; a normal customer sees a dead end.
4. Payment success needs a clear “pending / confirmed / contact store” state that survives browser closure, network loss and late webhooks. The backend handles important gateway cases; the customer-facing communication must be tested separately.
5. Privacy notice, consent purpose, deletion/export expectations, grievance contact and retention explanation must be discoverable in the customer journey, not only in developer documents.

### 5. External developer with 20 years of POS, distributed systems and incident experience

**The code is strongest where it matters most:** money values are integer-scaled; server calculates sale facts; transaction boundaries are real; database constraints enforce invariants; duplicate payment and request paths are defended; concurrent till and crash-injection tests exist.

**The loopholes I would attack first**

| Priority | Finding | Why it matters | Lightest remedy |
|---|---|---|---|
| P0 | Invoice rendering lacks a demonstrated complete GST/BIS field matrix: code comments acknowledge no GSTIN/state/per-line HSN split is wired into billing. | A financially correct bill can still be legally insufficient. | Create a CA/BIS-approved document schema, then block go-live per tenant until the required fields are configured and printed. |
| P0 | Old-gold exchange has an explicit unresolved GST/RCM/business-treatment question. | A sale/exchange ledger can be wrong even when its arithmetic is correct. | Keep disabled; obtain written CA/legal policy; design purchase/exchange documents and reversal treatment from that policy. |
| P0 | Savings-scheme terms are placeholder product values. | Consumer/financial/regulatory exposure and customer disputes. | Keep disabled until entity, terms, bonus/default/refund treatment, customer documents and counsel sign-off exist. |
| P0 | Live deployment, real Razorpay webhooks, real restore and rollback remain operational gates, not completed proof. | A local pass does not prove a live money system. | Sandbox rehearsal with real-but-test payment, webhook fault injection, restore-to-new-host and rollback evidence. |
| P1 | Every HTTP response synchronously appends both telemetry and black-box logs to disk. | Disk stalls and log growth can directly lengthen cashier requests; there is no evidence of rotation/size cap. | Bounded in-memory queue, periodic batched async flush, explicit drop/back-pressure counters, log rotation/retention. Keep audit ledger writes synchronous and separate. |
| P1 | `GET /api/health` synchronously reads `package.json` for every request. | Small now, needless work at probe frequency and a warning sign for hot paths. | Read version once at startup. |
| P1 | Static assets use default Express serving with no explicit cache policy. | Repeat page loads revalidate more than necessary; source modules are 563 KB before compression. | Cache immutable/versioned assets; short-cache HTML; add content/version query on release without a bundler. |
| P1 | No checkout performance SLA, benchmark data set, soak test, disk-full test, or rate-provider outage test is a release gate. | “Fast on an empty laptop” becomes slow only in a busy shop. | Add a dependency-free Node benchmark harness and seeded test tenant; run in CI/nightly. |
| P1 | UI refreshes are request-rich: dashboard fires five parallel calls; inventory fires three; whole regions are rerendered with `innerHTML`. | Fine at small size, but perceptibly janky on low-end tills or large data. | Add a single small dashboard-summary endpoint; page/virtualize lists; use targeted DOM updates only after measurement. |
| P1 | Customer/advance lookup has no observed cancellation or latest-request guard. | Slow network can display stale balance against a different customer. | Use `AbortController` plus a monotonically increasing lookup token; validate the phone again before applying result. |
| P1 | Browser printer and hardware devices are out of automated scope. | A POS that saves but cannot produce a compliant readable slip is not operational. | Hardware compatibility matrix and Playwright print-layout snapshots; pilot on exact hardware. |
| P1 | The base URL and operational model are network-dependent; there is no explicit offline transaction queue or local terminal mode. | Internet/server interruption can halt a counter. | Decide the policy. For v1, do not queue money offline; show a clear outage screen plus paper fallback. A true offline-first ledger is a separate product. |
| P2 | Large service and UI files are becoming change-risk hotspots. | Regression probability rises even if runtime stays fast. | Continue using the existing service/repository/component seams; split only at stable domain boundaries, not into microservices. |

## Legal and compliance worklist (India; validate with qualified counsel/CA)

This is a product risk map, not legal advice.

1. **GST invoice and credit-note rules.** CBIC's invoice rules require, among other facts, supplier identity/GSTIN, a financial-year-unique consecutive number, issue date, recipient/delivery details in applicable cases, HSN, description, quantity/unit, taxable value, tax rate/amount, place of supply, reverse-charge declaration and signature. Turn this into a tenant-by-tenant print template acceptance test. [CBIC invoice rules](https://cbic-gst.gov.in/gst-invoice-rules.html)
2. **BIS hallmarking documents.** For hallmarked precious-metal articles, BIS says the sale bill/invoice must separately include article description, precious-metal net weight, purity in carat/fineness and hallmarking charge; its 2024 jeweller guidance also calls for a consumer-verification statement. HUID storage is useful, but it is not a substitute for document content. [BIS jeweller guidance](https://www.bis.gov.in/wp-content/uploads/2024/01/Revised-Guidelines-for-JEWELLERS-Jan-24.pdf)
3. **E-invoicing.** The current GSTN/IRP material says the mandate applies from ₹5 crore AATO in any preceding financial year since 2017–18, and the IRP notes a 30-day reporting restriction for ₹10 crore+ AATO from 2025. The POS must know whether the merchant is in scope; a normal PDF/printout is not an IRN-backed e-invoice. [GSTN e-invoice mandate](https://einvoice6.gst.gov.in/content/einvoice-mandate/), [IRP reporting restriction](https://einvoice6.gst.gov.in/content/)
4. **Cash/PAN and reporting.** Income-tax material identifies PAN quoting/reporting obligations around high-value goods transactions and cash receipts; counsel/CA must define the exact counter prompt, evidence, threshold aggregation and prohibited payment handling for the merchant. Do not hard-code a remembered threshold into billing without advice. [Income Tax Department source](https://www.incometax.gov.in/iec/foportal/sites/default/files/2020-08/System_Notification_1_of_2017.pdf)
5. **DPDP.** The 2025 Rules and enforcement timeline are published. Map every personal-data field, purpose, notice, consent record, correction/deletion/export flow, processor/access arrangement, retention schedule, breach process and grievance contact. Make the actual effective-date analysis counsel-owned. [MeitY DPDP Rules 2025](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?hl=en-US)
6. **Payments.** Razorpay requires server-side signature verification, order binding, idempotent webhook handling and tolerance for duplicate/out-of-order events. The code has meaningful controls here; prove them against the merchant's real dashboard, capture settings, webhook events and settlement/reconciliation process. [Razorpay webhook guidance](https://razorpay.com/docs/webhooks/validate-test/?locale=en-US)
7. **Contracts and operations.** Before paid deployment, approve terms, privacy policy, returns/cancellation, delivery/repair policy, support/SLA, data ownership/export/offboarding, incident/breach workflow, scheme terms, and a named authority for taking a trading system offline.

## Can a normal owner set this up alone by reading the current documents?

**Local evaluation: yes, with guided help. Live production: no, not safely.**

`docs/OWNER_QUESTIONS.md` is admirably plain-English and lets a shop owner make the business decisions. But `deploy/README.md` then requires Linux, Node, PM2, Nginx, Certbot, DNS, SSH, secrets, firewall assumptions, a central licensing service and Razorpay webhooks. That is not a shop-floor setup flow.

### Required operating model for now

1. **Platform/onboarding engineer:** provision server, TLS, secrets, licensing, backup destination, monitoring and updates.
2. **CA/legal reviewer:** approve tax invoice/credit-note, old-gold, scheme, retention and cash/PAN policy.
3. **Owner:** complete a single plain-language “Store Readiness” form: identity, GST, bill template, rates, return policy, approvals, staff, backup owner and escalation contact.
4. **Manager:** run a scripted pre-opening test, train staff, and execute end-of-day close/backup checks.
5. **Cashier:** uses a one-page task card; never edits tax, secrets, backup or policy settings.

### Documentation correction plan

Create one entry page called **“Start Here — opening a new shop safely”**. It should link, in order, to a 20-minute owner questionnaire, onboarding handoff, hardware checklist, first-boot wizard, cashier training, day-close card, incident card and monthly restore drill. Existing technical docs remain valuable, but must be behind that entry page.

## Performance plan: ultra-smooth without becoming heavy

### Performance definition

“Butter smooth” means a cashier sees input feedback in one frame and is never left wondering whether money was posted. It does **not** mean caching financial writes or turning off audit.

| Interaction | Pilot target | How to measure |
|---|---:|---|
| Keystroke → visible total | <16 ms p95 | Browser Performance trace on low-end supported till |
| SKU scanner → populated item | <150 ms p95 LAN; <350 ms p95 hosted | 500 scans against a seeded catalogue |
| Customer lookup → balance | <300 ms p95 LAN; <800 ms p95 hosted | Network shaping plus stale-response tests |
| Save sale → durable success | <500 ms p95 LAN; <1.5 s p95 hosted | 1k invoices, mixed tenders, concurrent tills |
| Tab/dashboard initial data | <750 ms p95 | 10k invoices / 50k advance entries seeded |
| Error state after unavailable backend | <1 s | Server killed during each critical action |
| Memory / disk | bounded growth | 8-hour soak, log/backup retention checks |

### Phase P0 — do before taking real money

- Complete a live sandbox proof: real test Razorpay order/capture/webhook/retry/out-of-order delivery, receipt, settlement reconciliation, backup restore to a new host, and deploy rollback.
- Adopt the CA/BIS-approved invoice/credit-note template and block go-live if required merchant facts are absent.
- Keep old-gold and schemes disabled pending documented approval.
- Define the outage policy and train paper fallback; never silently queue financial writes in a browser.
- Capture the full E2E result and add a release artifact with browser version, printer model and hardware matrix.

### Phase P1 — highest return for speed and reliability, zero runtime dependencies

1. Replace synchronous per-request telemetry/black-box writes with a bounded in-memory queue plus batched asynchronous file append. Preserve synchronous SQL commit/audit semantics. Track dropped/buffered events and flush on graceful shutdown.
2. Add log rotation, retention and disk budget. A full disk must result in a loud, safe degraded state—not an unexplained slow counter.
3. Cache package version at process start; add explicit static cache headers: short/revalidated HTML, long cache for release-versioned JS/CSS/assets.
4. Add `AbortController`/latest-request protection to customer and SKU lookups. Debounce only searches, never quantity/weight computation.
5. Measure browser hot paths. If a trace proves DOM work is expensive, render only altered total/line nodes; do not prematurely rewrite vanilla JS into a framework.
6. Replace dashboard fan-out with one small server summary read only if the benchmark shows it matters. Preserve paging and SQL aggregates.
7. Build a dependency-free benchmark harness: seeded SQLite data, scriptable concurrent read/write mix, CSV/JSON latency output, fixed thresholds. Run it on the target 1 GB VPS.

### Phase P2 — counter excellence

- Hardware adapters/configuration for USB keyboard-wedge scanners, supported scales, thermal/label printers and cash drawer; certify exact models.
- Keyboard-first fast sale: focus order, Enter/scan behavior, printable shortcut card, confirm/cancel semantics and double-submit protection feedback.
- Clear state chips: **Saved**, **Printing**, **Payment pending**, **Awaiting manager**, **Offline—do not continue**, **Rate stale**.
- Role-specific home screen and training/demo mode with resettable fixture data.
- Mobile/responsive and low-end Android/Windows browser performance certification, then accessibility and local-language design.

### Phase P3 — product maturity without scope creep

- Versioned policy/terms engine before schemes, old gold, alteration/repair or job work.
- Data-import rehearsal tool and signed cutover checklist before onboarding a merchant.
- Daily owner cockpit with action-oriented exceptions, not more reports.
- Product analytics based on anonymous operational events and explicit privacy approval.
- Introduce supplier/job-work/stock-take/branch transfer only as separately specified document lifecycles.

## Red-team test charter

Run these on every pilot, preferably with a cashier, manager, owner and independent observer in the room:

1. Double-click every money button; refresh/close browser while saving; lose network at each payment stage; retry from another browser.
2. Enter bad barcodes, duplicate HUIDs, malformed weights, extreme discounts, split tender mismatch, changing rates, duplicate UTR, return-after-partial-return and manager-unavailable scenarios.
3. Fill the inventory, sales, advances and audit data to 10× expected first-year size; repeat opening, lookup, sale, return, report, backup and restore.
4. Kill power/process at transaction checkpoints; verify document numbering, ledger totals, stock and customer balances after restart.
5. Fill the disk, block DNS, make rate provider slow, make SMTP fail, make off-site backup unavailable, delay webhooks and revoke a staff session during an active counter session.
6. Test eye-level conditions: glare, slow laptop, touchscreen, browser zoom 125%, printer out of paper, scanner adds Enter, scale sends noisy serial values, and a cashier who has never used the system.
7. Reconcile physical cash, card/UPI settlement, sales register, tax invoice/credit note, stock movement and bank settlement for one whole shop day.

## Release gates

No feature is “done” until its journey is: policy-approved → role-tested → reversal-tested → printed/exported → outage-tested → measured → documented.

For the first paid pilot, the minimum proof pack is: full CI/E2E report, target-VPS benchmark, real sandbox payment evidence, CA/BIS invoice sign-off, legal/DPDP checklist, hardware matrix, migration rehearsal, recovery drill, trained staff list, and daily reconciliation evidence for the pilot period.

