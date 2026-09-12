# Go-Live Runbook — The Safe Route to Opening Gold POS

**Read this first.** This is the simple, ordered route from “the app works on a
computer” to “a real shop can safely use it.” It is written for the owner, not
only for developers.

**Current decision — 2026-09-06: NO-GO for a public or paid real-money launch.**
There is useful code and some automated evidence, but the required real-world
proof is still incomplete: merchant/legal approval, production security,
payments, exact counter hardware, disaster recovery, realistic performance,
and independent security review. A green screen or a local test is not proof
that a jewellery shop is ready to take money.

This is not legal, tax, payment, or security certification. A CA, appropriate
legal/privacy adviser, payment provider, platform operator, and independent
security assessor must sign the parts that belong to them.

## The three possible launch levels

Do not jump from a demo straight to a public launch. Choose the smallest level
that matches what you need today.

| Level | What it means | May it use real customer data or money? | When it is allowed |
|---|---|---|---|
| **Demo** | A developer/owner shows the product with invented data. | **No.** Use fake names, amounts and payments. | Any time, as long as it is clearly a demo. |
| **Managed pilot** | One named shop uses it with close daily support and an agreed rollback path. | Only after every pilot gate in this runbook is signed off. | After steps 1–11 are complete and the owner accepts the limited risk. |
| **Public commercial launch** | The product is marketed or sold to shops without one-to-one launch support. | Yes, subject to the merchant’s legal and payment controls. | Only after a successful pilot and every public-launch gate in step 12 is complete. |

The Android customer app is a separate, optional distribution channel. It is
**not** the cashier POS and a Play Store listing does not make the POS safe or
legally ready. Follow [Track E in the detailed checklist](GO_LIVE_CHECKLIST.md#track-e--play-store-android-app)
only after the relevant product gates below.

## One rule that prevents most disasters

**Do not mark a step complete because somebody said “it should work.”** Mark it
complete only when its listed proof is saved in a private launch-evidence
folder and the named person has checked it.

Create this folder outside the source-code repository and limit access to the
people who need it:

```text
launch-evidence/
  01-scope-and-merchant/
  02-legal-tax-privacy/
  03-host-security-and-access/
  04-payments/
  05-data-backup-and-recovery/
  06-hardware-and-training/
  07-performance/
  08-rehearsal-and-pilot/
  09-public-launch/
  10-play-store-optional/
```

Save dated PDFs, screenshots, test reports, signed decisions, and redacted
logs there. **Never put passwords, private keys, recovery keys, PINs, payment
secrets, or full customer exports in this folder or in chat.** Put secrets in
the approved password manager/vault and record only where the secret is held
and who may access it.

## Who does what

| Person | Simple job |
|---|---|
| **Business owner** | Chooses what is being sold, accepts or rejects risk, and signs the final go/no-go decision. |
| **Store manager** | Tests the actual counter, trains staff, and proves a normal shop day can be reconciled. |
| **CA/accountant** | Approves invoice, tax, credit-note, exchange, retention, and accounting treatment. |
| **Legal/privacy adviser** | Approves customer notices, contracts, consent, deletion/retention, and complaints/breach process. |
| **Platform operator** | Secures the server, domain, backups, monitoring, accounts, deployment and recovery keys. |
| **Engineering owner** | Runs the software tests, checks release evidence, fixes defects, and does not bypass a gate. |
| **Independent security assessor** | Tries to break the system and reports vulnerabilities without being paid to defend the original design. |

One person may hold more than one role in a very small business, but nobody may
approve their own independent security assessment.

---

# The steps, in order

## Step 0 — Decide exactly what “launch” means

**Owner does this. Do it before paying for servers or advertising anything.**

1. Choose one launch level above: Demo, Managed pilot, or Public commercial.
2. Name the first merchant and shop location. A pilot must have only one named
   merchant unless the owner formally expands it.
3. Write what is in scope: sale, return, advance, rate display, printer, UPI/
   card/cash, customer portal, old-gold exchange, savings scheme, etc.
4. Put every risky or undecided feature in the **out of scope / disabled** list.
   In particular, do not enable old-gold exchange or savings schemes until the
   CA and counsel approve them.
5. Set a target date as a goal, not a promise. It moves if a gate is not ready.

**Save:** a one-page scope decision in `01-scope-and-merchant/`, signed or
dated by the owner. Use [OWNER_QUESTIONS.md](OWNER_QUESTIONS.md) to gather the
shop facts in plain language.

**Move on only when:** the owner can answer, in one sentence, “Which shop,
which users, which features, and which type of launch are we doing?”

## Step 1 — Name the people and make an evidence board

**Owner does this with the engineering owner.**

1. Put a real person’s name beside every role in the table above.
2. Create the `launch-evidence` folder structure.
3. Make a short list of phone numbers for the owner, store manager, platform
   operator, payment contact, CA, and security assessor.
4. Open [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md) and
   [TESTING_CHECKLIST.md §23–24](TESTING_CHECKLIST.md#23-pos-360-remediation-and-pilot-readiness-added-2026-09-02).
   They are the detailed tick-box evidence record. Do not replace their empty
   boxes with “we discussed it.”
5. Decide where the go/no-go meeting will be recorded: a signed PDF, meeting
   note, or issue tracker entry.

**Save:** named roles, contact list, target launch level, and link/path to the
evidence folder.

**Move on only when:** no important job says “someone will handle that later.”

## Step 2 — Collect the shop facts and configure the business correctly

**Owner and CA do this. Engineering enters approved facts; it does not guess.**

1. Complete the business identity, address, GST/other registrations, invoice
   prefix/numbering, rate policy, payment methods, return policy, and record
   retention questions in [OWNER_QUESTIONS.md](OWNER_QUESTIONS.md).
2. Ask the CA to approve the exact invoice and credit-note template for this
   merchant. Print a sample; do not approve only a screenshot.
3. If hallmarked articles are sold, get merchant/BIS-adviser confirmation that
   the actual printed article description, weight, fineness/carat and related
   statement are correct.
4. Keep old-gold exchange and gold-savings features disabled until the CA and
   lawyer approve their terms, tax treatment, reversals/refunds, and customer
   documents.

**Save:** completed owner form, CA approval, printed sample invoice/credit
note, and any hallmarking/exchange/scheme approval in
`02-legal-tax-privacy/`.

**Move on only when:** the merchant and CA say the shop can issue the printed
documents to a real customer without manual correction.

## Step 3 — Publish customer, privacy, and operating documents

**Owner and legal/privacy adviser do this.**

1. Write and publish the customer privacy notice at a stable HTTPS URL. It must
   match the fields the app actually collects; do not copy a random template.
2. Decide why each customer field is collected, who can see it, how long it is
   kept, how a customer asks for a copy/correction/deletion, and who handles a
   complaint or data breach.
3. Prepare the merchant’s terms, return/refund policy, support contact and
   customer-facing payment language.
4. Have counsel check the relevant rules. Useful starting points are the
   [CBIC GST invoice rules](https://cbic-gst.gov.in/gst-invoice-rules.html),
   [BIS hallmarking consumer FAQ](https://www.bis.gov.in/hallmarking-overview/hallmarking-faqs/common-consumer-faq/),
   and [MeitY DPDP Rules material](https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa?pageTitle=Digital-Personal-Data-Protection-Rules-2025).
   These links are references, not a substitute for legal advice.

**Save:** final document links/PDFs, counsel’s review, data-field map, deletion
and breach contact procedure in `02-legal-tax-privacy/`.

**Move on only when:** the owner can show a customer where the notice and
support/complaint route are, and the legal adviser has not left a blocker open.

## Step 4 — Prepare a real production home, not a developer computer

**Platform operator does this.**

1. Obtain the production domain, VPS/hosting account, DNS access, and
   organization-owned source-control/deployment accounts. Do not build the
   business around one employee’s personal account.
2. Follow Track A and Track F in [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md)
   and the deployment procedure in `deploy/README.md`. Keep development,
   test, and live systems separate.
3. Ensure the public site uses HTTPS and that production refuses unsafe or
   placeholder settings rather than silently accepting payments.
4. Use a named non-root service account, firewall, supported OS/Node version,
   least-privilege files, security updates, and a monitored disk budget.
5. From a device outside the server, check the real domain, HTTPS certificate,
   security headers, error redaction, login protections, and allowed browser
   origin. The server being reachable from itself is not enough.

**Save:** redacted deployment record, domain/HTTPS screenshot, external
security-header checks, host-hardening checklist, update policy, and the name
of the platform operator in `03-host-security-and-access/`.

**Move on only when:** the platform operator can explain how to update, roll
back, stop, and contact the person responsible for the live server.

## Step 5 — Set up access and secrets like they matter

**Platform operator and owner do this.**

1. Create separate accounts for each operator. Do not share an admin PIN or
   reuse personal passwords.
2. Give each role only the access it needs. Money-release/approver roles need
   strong authentication and a clear process to remove access when someone
   leaves.
3. Store application keys, payment secrets, mail credentials, recovery keys,
   SSH credentials, and signing keys in an access-controlled vault/password
   manager. Record two recovery-key custodians who are not the same person if
   possible.
4. Test joining, changing role, locking, and revoking a staff account. Test a
   lost/stolen counter-device procedure.
5. Read [RUNBOOKS.md](RUNBOOKS.md), especially secret rotation, lost key,
   device loss, payment mismatch, and incident response procedures.

**Save:** access list (without secrets), role approval, revocation test result,
key-custody record, and incident contact list in
`03-host-security-and-access/`.

**Move on only when:** no shared administrator identity remains and a departed
staff member can be locked out promptly.

## Step 6 — Prove payment handling before accepting a rupee

**Merchant and onboarding engineer do this.**

1. Set up the merchant’s payment provider account. Enter test credentials only
   through the approved Settings/vault process; never paste a secret into chat,
   source code, or a screenshot.
2. Test each payment story in sandbox: immediate success, customer abandons
   payment, invalid signature, duplicate webhook, late/out-of-order webhook,
   amount mismatch, payment retry, refund/return, and settlement reconciliation.
3. Compare the POS result, provider dashboard, and bank/settlement report.
4. Only after sandbox proof and provider/merchant approval, configure live
   credentials, webhook URL, and webhook secret. Retest a deliberately small,
   authorized live transaction before normal trade.
5. Keep the exact procedure for a payment mismatch ready at the counter.

**Save:** redacted test cases and result screenshots, provider dashboard
evidence, webhook configuration proof, reconciliation sheet, and approved
live-payment sign-off in `04-payments/`. Razorpay’s current testing guidance
is at [Razorpay webhook testing](https://razorpay.com/docs/webhooks/validate-test/?preferred-country=IN).

**Move on only when:** every money event has one clear result, duplicate events
do not create duplicate money records, and the merchant can reconcile it.

## Step 7 — Protect data and rehearse the worst day

**Platform operator, store manager, and owner do this.**

1. Decide exactly where encrypted backups go and make sure at least one copy is
   off the live server and in another physical/location failure domain.
2. Make a fresh encrypted backup of a non-demo data set.
3. Restore it to a different, clean host. Do **not** restore over the live shop.
4. Verify the database integrity, audit trail, invoice totals, stock, operator
   records, and approved settings. Measure how long it took.
5. Practise the rollback, lost key, payment mismatch, gold-rate outage,
   connectivity-loss, and stolen-device instructions in [RUNBOOKS.md](RUNBOOKS.md).
6. Record who holds recovery keys and how the owner can reach them during an
   emergency.

**Safe engineering checks (run from the repository root):**

```powershell
npm --prefix backend run backup:verify
npm --prefix backend run restore:drill
npm --prefix backend run audit:verify
```

`restore:drill` intentionally keeps a drill copy for inspection; use the
runbook before cleaning it up. These commands are evidence helpers, not a
replacement for the clean-host rehearsal above.

**Save:** backup location design, clean-host restore log, elapsed restore time,
audit result, key-custody names, and signed drill acceptance in
`05-data-backup-and-recovery/`.

**Move on only when:** the owner has watched a restore and knows how much data
could be lost and how long recovery could take.

## Step 8 — Certify the actual counter and make it usable by normal staff

**Store manager leads this. Do not test on a different “nice” laptop.**

1. List the exact workstation, browser, scanner, weighing scale, thermal
   printer, label printer, cash drawer, network and power backup at the shop.
2. On that equipment, test sale, split tender, advance, return, manager
   approval, print/reprint, scanner Enter behaviour, 125% zoom, touchscreen,
   slow computer, paper-out, cash-drawer failure, network loss, and power
   return.
3. Ask a new cashier who understands only simple English to follow the role
   cards without a developer standing beside them. Watch where they hesitate.
4. Fix/document unclear words, missing buttons, confusing errors, or a step
   that needs technical knowledge. Then repeat the task with a different
   person.
5. Train every cashier and manager with practice transactions. No one receives
   live access before an observed practice pass.

**Save:** device list, test sheet, printer/scanner/scale model details, photos
of printed output, staff attendance, practice results, and open usability
issues in `06-hardware-and-training/`.

**Move on only when:** a trained cashier can complete a normal sale and recover
from ordinary printer/network problems without guessing or losing the cart.

## Step 9 — Prove speed with real-sized data and the real equipment

**Engineering owner and store manager do this.**

The current benchmark is an honest **empty-tenant loopback baseline**. It does
not prove checkout speed, printer speed, an internet connection, a busy shop,
or a low-end counter. Do not publish its numbers as a merchant promise.

1. First run the reproducible software checks:

```powershell
npm --prefix backend test
npm --prefix backend run audit:security
npm --prefix backend run migrate:check-safety
npm --prefix backend run benchmark
```

2. Build a safe, representative test dataset (for example, historical-like
   products, customers, invoices, advances, and operator roles) without
   copying unprotected customer data into a developer laptop.
3. On the target VPS and exact counter device, measure login, product/customer
   lookup, typing/scanning, total recalculation, sale save, print preparation,
   tab change, reports, memory growth, and eight hours of normal use.
4. Agree a written response-time budget with the shop before observing results.
   For example, a cashier must see input feedback immediately and must receive
   a clear wait/error state rather than a frozen screen. Do not choose numbers
   merely because a local machine happened to be fast.
5. Fix only the measured bottleneck, retest, and make sure financial writes and
   audit durability were not weakened to make a chart look better.

For benchmark meaning and safe output handling, read
[PERFORMANCE_BENCHMARK.md](PERFORMANCE_BENCHMARK.md).

**Save:** device/VPS details, dataset description, test plan, p50/p95/p99 or
other agreed measurements, browser traces, eight-hour soak result, and any
accepted exception in `07-performance/`.

**Move on only when:** the store manager accepts the measured counter experience
on the real equipment and there is no unexplained memory, error, or data-loss
pattern.

## Step 10 — Let security people try to break it

**Engineering owner and an independent security assessor do this.**

1. Review [THREAT_MODEL.md](THREAT_MODEL.md) and update it for the exact launch
   scope, domains, payment flow, staff roles, and hosted services.
2. Check authorization/tenant isolation, ID guessing (IDOR), session fixation
   and revocation, CSRF, XSS, unsafe uploads/paths, malformed or oversized
   requests, rate limiting, secret leakage, payment replay, duplicate money
   events, and audit tampering attempts.
3. Have an independent qualified assessor perform a scoped test and code review
   before accepting a paid merchant. They need a safe test environment and
   written permission; never attack a live system casually.
4. Fix every critical/high issue. For a lower-risk exception, the business owner
   must record why it is accepted, who accepts it, mitigation, and an expiry
   date.

**Save:** threat-model revision, automated security results, independent report,
findings list, fix verification, and approved time-limited exceptions in
`03-host-security-and-access/`.

**Move on only when:** there are no open critical/high findings and the owner
understands any written temporary exception.

## Step 11 — Run a fake full shop day

**Store manager, owner, CA, and engineering owner do this together.**

1. Use a non-production rehearsal environment or explicitly labelled rehearsal
   records. Do not mix test receipts with live customer accounting.
2. Open the day; create normal sales, cash/card/UPI payments, split tender,
   advance, return/credit note, manager approval, a printer failure, a network
   interruption, a duplicate payment callback, and day close.
3. Reconcile physical cash, card/UPI settlement, sales register, returns,
   credit notes, advances, stock movement, bank/provider settlement, and the
   audit trail. The CA checks the result.
4. Stop on every mismatch. Explain it, correct the process or software, then
   repeat the affected test. Do not call a mismatch “close enough.”
5. Practise the decision to pause selling if the system is unsafe or unavailable,
   including who tells staff and how manual records are later reconciled.

**Save:** rehearsal script, transaction list, reconciliation sheet, CA/store
manager sign-off, defects and retest results in `08-rehearsal-and-pilot/`.

**Move on only when:** the full day balances and the people at the counter can
say what to do when a payment, printer, rate, or connection fails.

## Step 12 — Run a limited managed pilot

**Owner approves it; store manager operates it; engineering watches closely.**

1. Recheck that steps 0–11 have saved proof. Update the detailed checklists;
   blank boxes are blockers, not paperwork to finish later.
2. Limit the pilot: one named shop, named staff, agreed hours, no unapproved
   features, clear support contact, and a documented stop/rollback decision.
3. At opening, verify the live domain, backups, current rate source, printer,
   payment configuration, user access, and cashier readiness.
4. During the pilot, reconcile every day, review errors/alerts, check backups,
   and record staff/customer problems immediately.
5. Hold a daily short review. Critical finance, security, privacy, or repeated
   counter errors pause the pilot until fixed and retested.
6. At pilot end, review measurable evidence: reconciliation accuracy, recovery
   readiness, payment settlements, speed, training success, defects, support
   burden, and customer impact.

**Save:** signed pilot authorization, daily checklist, reconciliation records,
incidents, defects, resolution evidence, and pilot acceptance/rejection in
`08-rehearsal-and-pilot/`.

**Move on only when:** the pilot succeeds for the agreed period without an
unexplained money, stock, security, privacy, or data-recovery failure.

## Step 13 — Approve public commercial launch (only after a successful pilot)

**This is an owner decision, not a developer decision.**

At a go/no-go meeting, the owner checks all of the following:

- The detailed [Testing Checklist §23](TESTING_CHECKLIST.md#23-pos-360-remediation-and-pilot-readiness-added-2026-09-02)
  relevant to the release has evidence and named owners.
- CA/legal/privacy/payment approvals are current for this merchant and feature set.
- Production host, TLS, backups, monitoring, secret custody, access removal,
  incident contacts, and restore drill are proven.
- Exact shop hardware and staff training are certified.
- Realistic performance evidence meets the agreed budget.
- An independent security assessment has no unresolved critical/high finding.
- The pilot reconciled successfully and its defects are closed or have a
  documented, time-limited owner acceptance.
- Support, incident response, upgrade/rollback, and a first-week monitoring
  rota have named people.

**If even one item is missing: NO-GO.** Continue the pilot or return to the
relevant step. A delayed launch is cheaper than a wrong invoice, missing stock,
unreconciled payment, leaked customer data, or unrecoverable shop day.

**Save:** dated go/no-go minutes signed by the business owner, CA/legal/security
sign-off references, final scope, release revision, and first-week support rota
in `09-public-launch/`.

### First day and first week after approval

1. Open with a smaller, well-staffed shift and the support contact available.
2. Reconcile every tender and stock movement at close each day for the first
   week; do not wait for month end.
3. Check backups, disk space, errors, payment settlements, certificate expiry
   alerts, staff-access changes, and customer support requests daily.
4. Record every issue. If it affects money, stock, privacy, security, or
   recovery, pause the affected workflow and follow [RUNBOOKS.md](RUNBOOKS.md).
5. Hold a one-week review before advertising wider availability or adding more
   merchants.

---

## Immediate “do not launch” list

Keep the POS in Demo or stop the pilot if any of these is true:

- The CA has not approved the merchant’s actual invoice/credit-note output.
- Payment webhooks or settlement reconciliation have not been tested end to end.
- Customer privacy notice, deletion/complaint route, or legal review is missing.
- Live secrets are in source code, chat, screenshots, a shared spreadsheet, or
  a single person’s private account.
- A clean-host restore has not been timed and checked.
- A cashier has not used the exact counter devices and printed the real receipt.
- A real-sized/real-device performance test has not been accepted.
- A critical/high independent security issue is open.
- The day-rehearsal or pilot does not reconcile cash, card/UPI, stock and
  invoices.
- A person says “we will fix it after launch” for money, security, privacy,
  legal, backup, or access control.

## Detailed documents behind this runbook

| Need | Read this next |
|---|---|
| Owner facts, provider choices and CA questions | [OWNER_QUESTIONS.md](OWNER_QUESTIONS.md) |
| Accounts, domain, VPS, Razorpay, Play Store and first tenant | [GO_LIVE_CHECKLIST.md](GO_LIVE_CHECKLIST.md) |
| Formal pilot/security/durability evidence boxes | [TESTING_CHECKLIST.md §§23–24](TESTING_CHECKLIST.md#23-pos-360-remediation-and-pilot-readiness-added-2026-09-02) |
| What to do during backup, payment, outage, lost device or incident | [RUNBOOKS.md](RUNBOOKS.md) |
| Security threats that must be revisited for each new feature | [THREAT_MODEL.md](THREAT_MODEL.md) |
| What the current benchmark proves—and what it does not | [PERFORMANCE_BENCHMARK.md](PERFORMANCE_BENCHMARK.md) |
| Long-term engineering gates | [ENGINEERING_EXCELLENCE_PROGRAM.md](ENGINEERING_EXCELLENCE_PROGRAM.md) |

**Start today:** complete Step 0, then Step 1. Do not spend time on a Play
Store release or marketing before you know which merchant, payment workflow,
legal documents, people, and counter equipment are actually launching.
