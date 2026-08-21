# Gold Savings Scheme Module — Plan & Build Checklist (Phase 20 series)

**Status:** Engine built 2026-08-21 (Phase 41), flagged off by default. **Created:** 2026-08-07.
Companion to `docs/PROJECT_PLAN.md` (§5.15). This document remains the DISCOVERY record — the
feature inventory below is still useful reference — but is no longer the live build checklist:
what actually shipped (schema, service, routes, `SchemeDesk.js`, tests) is described in
`docs/PRODUCTION_READINESS_ROADMAP.md` Phase 6 and `docs/LEDGER.md` Phase 41, rebased on the
Phase-1 SQL model rather than the JSON-file design this plan's discovery predates. Placeholder
terms only — real terms and Indian legal/CA review still gate enabling this for a live tenant.

---

## 0. What this is

A **gold savings scheme (chit/plan) module** for the Gold POS platform — the
store sells a monthly savings plan, the customer pays installments over a fixed
tenure, each payment locks a weight of gold at that day's rate, and at maturity
the accumulated weight (plus any bonus) is redeemed against a purchase.

### 0.1 Reference app reviewed

A competitor customer app was reviewed from 10 screenshots supplied by the
platform owner (a scheme app branded *"SchemePay from Indsoft"*, deployed for a
jeweller in Puttur). It was used **only as a feature inventory**. No code,
copy, layout, icon, colour, naming, or asset from it is reproduced — that app's
maroon/pink palette and 3-tab shell are theirs. Our UI/UX is built fresh
against this project's own design language (BRD §4.1: low-saturation,
high-contrast, paper-ledger; locked 100vh viewports).

### 0.2 Feature inventory observed in the reference app

| # | Observed | Notes |
|---|---|---|
| 1 | Customer login with **username + email + password**, "Reset Password" | Not phone-only, not OTP |
| 2 | Home header: greeting + **today's gold rate per gram** | Live rate on every screen open |
| 3 | **"My Schemes"** list — scheme name, member number, branch | One customer can hold many schemes |
| 4 | **"Join New Scheme"** CTA | Self-service enrollment from the app |
| 5 | Scheme detail: **Date of Joining, Member Number, Branch** | Membership identity card |
| 6 | **"Pending Installments"** with an amount stepper (₹2500 / ₹3000) + Pay CTA | Flexible amount, not fixed-only |
| 7 | Payment gateway handoff (UPI / UPI-ID / "Pay Securely ₹2,500") | They use Paytm; we already have Razorpay |
| 8 | **Passbook** tab → per-scheme passbook | Separate from the schemes list |
| 9 | Passbook table: **Date, Weight, Rate, S/A flag, Amount**, then **Total weight + Total ₹** | The core artifact of the whole product |
| 10 | "Click on the installment to download the receipt" | Per-installment receipt |
| 11 | Settings: profile card, account (username/phone/branch), Reset Password, **Notification Settings** | |
| 12 | Support: About Us, Contact Us, **Store Locator** | Store Locator implies multi-branch |
| 13 | Legal: **Refund & Cancellation, T&C, Privacy Policy** | Also a Play Store + gateway onboarding requirement |
| 14 | Logout, social links, powered-by footer | |

**Passbook maths confirmed from their data:** ₹2000 ÷ ₹13145/g = 0.152 g;
8 installments, ₹16,000 total, 1.164 g total. So `weight = amount ÷ rate on the
day of payment`, and the total is the **sum of the stored per-row weights** —
never recomputed at today's rate. The `S`/`A` column is a per-row source flag
(first row `S`, all later rows `A`); we define our own meaning: **`S` = store
counter collection, `A` = app/online payment.**

---

## 1. What we already have vs. what's missing

| Capability | Today in Gold POS | Needed for schemes |
|---|---|---|
| Gold rate per carat, auto-sync + manual override | ✅ `priceEngine.js` | Reuse as-is |
| Rate locked onto a payment row | ⚠️ Partial — `lockedGoldRate22K` on advance rows | Formalise: rate **and** weight stored, immutable |
| Money-in ledger per customer | ⚠️ `advances.json` — one flat ₹ pool per phone | Need scheme / enrollment / installment entities |
| Grams accrual + appreciation display | ✅ Computed client-side in `customer.html` | Move to server-side stored weight (auditable) |
| Razorpay order + HMAC verify | ✅ `/api/payment/order`, `/api/payment/verify` | Extend with a scheme-payment purpose |
| UPI QR fallback | ✅ `qrGenerator.js` + `/api/qrcode` | Reuse |
| Customer portal shell | ✅ `customer.html` (Profile/Deposit/History) | New scheme-oriented shell |
| Customer authentication | ❌ **Phone-only, unverified** — typing any 10-digit number opens that customer's ledger | Must be fixed before schemes ship (§3.1) |
| Admin session auth, rate limiting, XSS-safe rendering | ✅ Phase 18 | Reuse for all new admin routes |
| Branches / multi-store | ❌ Single store | New lightweight `branches.json` |
| Receipts (PDF/print) | ❌ | New printable receipt view |
| Due-date reminders | ❌ | Reuse `emailReporter.js` cron pattern |
| Maturity / redemption into a bill | ⚠️ Advances redemption exists in `BillingDesk.js` | Extend the same pattern for schemes |

---

## 2. Locked-in architecture decisions

1. **Stay buildless.** Vanilla ESM frontend, Express backend, JSON file DB with
   the existing atomic `writeJSON()`. No React, no ORM. (PROJECT_PLAN §5.1.)
2. **Extend the existing platform**, don't fork a new app. Admin side = a new
   `Schemes` tab in `frontend/index.html`; customer side = a new
   `frontend/scheme.html` portal (leaving `customer.html` advances portal
   untouched and working).
3. **The passbook is append-only and immutable.** A posted installment row's
   `rate` and `weight` are frozen forever. An admin later overriding the gold
   rate must never retro-change a historical row. Corrections happen via a
   reversal row, never an edit.
4. **Weight is stored, not derived.** Store to 6 dp, display to 3 dp. Totals
   sum stored values so the passbook always foots exactly.
5. **Receipts are printable HTML + print CSS first** (zero new dependency,
   matches the 20-year no-dependency-rot goal). `pdfkit` only if a true
   server-generated PDF file is later required.
6. **Money never moves without server-side validation.** The client never sends
   a rate; the server stamps the rate from `priceEngine.getActiveGoldRates()` at
   post time and validates the amount against the scheme's min/max/step.
7. **Multi-branch is a first-class field from day one** (even for single-store
   tenants, who get one auto-created `BR-MAIN`). Retrofitting a branch key onto
   live member numbers later is painful.
8. **Reuse the extension surface.** Anything tenant-specific goes through
   `backend/extensions/` — the scheme module itself is core, not an extension.

---

## 3. Data model (new files under `backend/data/`)

### `branches.json`
```jsonc
{ "id": "BR-MAIN", "name": "Main Branch", "code": "MN",
  "address": "...", "phone": "...", "mapUrl": "...", "active": true }
```

### `schemes.json` — the scheme product catalogue (admin-defined)
```jsonc
{ "id": "SCH-XXXX", "name": "Mangalya Gold Plan", "code": "MGP",
  "status": "active|paused|closed",
  "tenureMonths": 11,                    // see §8 compliance note
  "amountMode": "fixed|flexible",
  "fixedAmount": 2000,                   // when amountMode = fixed
  "minAmount": 1000, "maxAmount": 100000, "stepAmount": 500,
  "purity": "22K",                       // which rate the weight accrues at
  "bonus": { "type": "none|installments|percentWeight", "value": 1 },
  "gracePeriodDays": 10,
  "terms": "…free-text shown at join…",
  "createdAt": 0 }
```

### `enrollments.json` — a customer's membership in one scheme
```jsonc
{ "id": "ENR-XXXX", "memberNo": "MGP-MN-2026-00311",
  "schemeId": "SCH-XXXX", "branchId": "BR-MAIN",
  "customerPhone": "9xxxxxxxxx", "customerName": "…",
  "joinDate": 0, "maturityDate": 0,
  "status": "active|matured|redeemed|closed|defaulted",
  "installmentsPaid": 8, "totalPaid": 16000, "totalWeight": 1.164000,
  "closedAt": null, "closeReason": null }
```
`memberNo` format: `<schemeCode>-<branchCode>-<year>-<5-digit seq>`, sequence
held in `settings.json` (same atomic-increment discipline as invoice numbers,
which already has a proven duplicate-number failure mode — see CHANGELOG 1.0.1).

### `scheme_payments.json` — the passbook ledger (append-only)
```jsonc
{ "id": "SPY-XXXX", "receiptNo": "RCPT-2026-000045",
  "enrollmentId": "ENR-XXXX", "installmentNo": 8,
  "amount": 2000, "rate": 13430.00, "purity": "22K", "weight": 0.148920,
  "source": "S|A",                       // S = store counter, A = app/online
  "paymentMethod": "CASH|UPI|RAZORPAY|CARD|BANK",
  "referenceId": "pay_…", "postedBy": "admin|customer",
  "reversalOf": null,                    // set on correction rows
  "timestamp": 0 }
```

### `customer_auth.json` — customer credentials (new, see §3.1 of the checklist)
```jsonc
{ "phone": "9xxxxxxxxx", "email": "…", "passwordHash": "scrypt$…",
  "salt": "…", "notifyEmail": true, "notifyPush": false,
  "resetToken": null, "resetExpires": 0, "failedAttempts": 0, "lockedUntil": 0 }
```
Never store a plaintext password; use Node's built-in `crypto.scryptSync` (no
new dependency). `customer_auth.json` must be excluded from any diagnostics or
black-box export path.

---

## 4. Build checklist

Tick as they land. Every phase's **Exit** line is the "verified live, not
asserted" bar this repo already holds itself to (PROJECT_PLAN §6).

### Phase 20.0 — Spec lock (no code)
- [ ] Owner confirms the open decisions in §7 (auth model, self-service join,
      bonus rule, branch count, tenure).
- [ ] Write the concrete scheme rules for the pilot store into this doc.
- [ ] **Exit:** §7 has zero unanswered items.

### Phase 20.1 — Customer identity & auth (blocking prerequisite) — **DONE 2026-08-08**
Today anyone can type any phone number into `customer.html` and read that
customer's full ledger. That is already a privacy hole; with schemes it exposes
member data and passbooks, so it is fixed first.
- [x] `backend/customerAuth.js` — scrypt hash/verify, bearer token sessions
      (mirror `adminAuth.js`), per-account lockout + IP rate limiting.
- [x] `POST /api/customer/register`, `/login`, `/logout`, `GET|PATCH
      /api/customer/me`, `/password/change`. Self-service registration is
      refused for a number that already has store history (`409
      CLAIM_REQUIRES_STORE`) so an outsider cannot claim an existing customer's
      ledger; those customers are issued a login at the counter via the new
      admin `POST /api/customer-accounts/issue-login`, which returns a one-time
      temporary password and forces a change on first sign-in.
- [x] `POST /api/customer/password/forgot` + `/reset` — a single-use 10-char
      code emailed via `emailReporter.js`'s SMTP transport (new reusable
      `sendMailIfConfigured()`); gracefully disabled with a clear message when
      SMTP isn't configured. A **code, not a link** — see §3.1 note below.
- [x] `requireCustomerSession` / `requireEstablishedCustomer` middleware; every
      customer read/write scoped to the **session's own** phone — never a phone
      from the body or query string.
- [x] Retro-fit `customer.html`'s advances endpoints behind the same session,
      and move the two admin components that were calling admin-gated routes
      with a raw `fetch()` (`BillingDesk` advance lookup, `AdvancesManager`
      counter deposit) onto `adminFetch()`.
- [x] **Exit — verified live, not asserted.** 53-check API pass + 20-check
      post-restart pass + 29-check Playwright pass, all green, against a running
      server with `backend/data/` backed up and restored byte-identical
      afterwards. Proved: B's token returns zero of A's rows and is rejected
      (401) by the admin lookup; a body-supplied `customerPhone` is ignored and
      the row lands on the session's own account; 6 wrong passwords → 429
      `ACCOUNT_LOCKED`, still enforced after a server restart; the reset code
      that **actually arrived in the email** completes the reset, cannot be
      replayed, and kills every pre-existing session; a replayed
      `razorpay_payment_id` does not double-credit. The email was captured with
      a throwaway local SMTP server rather than Ethereal, so the code under test
      is the one really delivered rather than one re-issued for the test.

**§3.1 note — reset code, not reset link.** Building a reset URL server-side
means trusting some base URL, and the only one available per-request is the
`Host` header, which the caller controls. A forged `Host` would mail the real
customer a valid token pointing at an attacker's site. A short code typed into
the portal the customer already has open removes that class of problem entirely
and needs no `PUBLIC_BASE_URL` configuration per tenant.

### Phase 20.2 — Branches & scheme master (admin)
- [ ] `branches.json` + `schemes.json` seeded in `db.js: initDatabaseFiles()`
      (auto-create `BR-MAIN` for existing single-store tenants).
- [ ] Admin CRUD: `GET/POST /api/branches`, `GET/POST/PATCH /api/schemes`
      (all behind `requireAdminSession`).
- [ ] Server-side validation: tenure 1–36, `minAmount ≤ fixed/step ≤ maxAmount`,
      purity ∈ {24K, 22K, 18K}, code unique + uppercase alnum.
- [ ] Destructive guard: closing a scheme that has active enrollments requires
      the `confirmDestructive: true` flag → else `409 CONFIRMATION_REQUIRED`
      (same pattern as `invoiceSeqStart` in Phase 12).
- [ ] `frontend/js/components/SchemeManager.js` → new `schemes-tab` in
      `index.html`, sub-nav: **Scheme Master | Members | Collect | Passbook |
      Maturity | Reports**. Build Scheme Master + Branches panes here.
- [ ] **Exit:** create/edit/pause a scheme through the UI; invalid payloads
      rejected server-side (verified by curl, not just by the disabled button).

### Phase 20.3 — Enrollment / membership (admin)
- [ ] `POST /api/enrollments` — creates the member, allocates `memberNo`
      atomically, sets `maturityDate = joinDate + tenureMonths`, and creates the
      customer auth record if the phone is new.
- [ ] `GET /api/enrollments` (filter by phone/scheme/branch/status),
      `GET /api/enrollments/:id`.
- [ ] Duplicate guard: same phone + same active scheme → warn, allow only on
      explicit confirm (a customer legitimately may hold two of the same plan).
- [ ] Members pane: searchable list (phone/name/member no.), status chips,
      drill-down to the member card (Date of Joining / Member No. / Branch).
- [ ] **Exit:** 20 members created across 2 schemes and 2 branches; member
      numbers are unique, sequential, and survive a server restart.

### Phase 20.4 — Counter collection (the store's daily job)
- [ ] `POST /api/scheme-payments` — server stamps `rate` from the active rate
      for the scheme's purity, computes `weight`, allocates `receiptNo` and
      `installmentNo`, appends the row, and updates the enrollment rollups in
      the same request.
- [ ] Reject: closed/matured enrollment, amount outside the scheme band, amount
      not on `stepAmount`, more installments than `tenureMonths`.
- [ ] `POST /api/scheme-payments/:id/reverse` (admin, confirm-gated) — writes a
      negative `reversalOf` row; never mutates or deletes the original.
- [ ] Collect pane: search member → shows plan, paid-so-far, next installment
      no., pending count → amount field prefilled → Post → receipt opens.
- [ ] **Exit:** post 8 installments across changing gold rates; enrollment
      rollups equal the sum of the ledger rows exactly; a reversal leaves the
      original row byte-identical.

### Phase 20.5 — Passbook & receipts
- [ ] `GET /api/enrollments/:id/passbook` → rows + `{totalAmount, totalWeight,
      installmentsPaid, installmentsRemaining}`, totals summed from stored
      weights.
- [ ] `GET /api/scheme-payments/:id/receipt` → printable HTML (store profile +
      logo, member no., installment no., date, amount, rate, weight, method,
      reference) with `@media print` CSS; opens in a new tab, browser prints to
      PDF.
- [ ] Passbook pane (admin) rendering Date | Installment | Rate | Weight |
      Source | Amount, with the footer totals row.
- [ ] All customer-supplied strings rendered as `textContent`, never `innerHTML`
      (BRD §4.2 — this exact class of bug was a real Phase 18 finding).
- [ ] **Exit:** passbook totals match a hand-calculated control set to 3 dp; a
      receipt prints correctly to PDF from Chrome; a name containing
      `<img onerror=…>` renders as literal text in both panes.

### Phase 20.6 — Customer app shell + Schemes screen
- [ ] `frontend/scheme.html` — new portal, our own visual language, locked
      viewport, bottom nav: **My Plans | Passbook | Account**.
- [ ] Header strip: greeting + today's per-gram rate (reuse `/api/gold-price`).
- [ ] My Plans: card per enrollment (scheme name, member no., branch, progress
      `8/11 paid`, weight accrued, next due date). Empty state → "Enquire about
      a plan" (self-service join is §7 Q2).
- [ ] Passbook tab: plan picker → the same passbook table, tap a row → receipt.
- [ ] **Exit:** logged in as a real seeded member on a 360px viewport — no
      horizontal scroll, no body scroll, all figures match the admin passbook.

### Phase 20.7 — Online installment payment (customer)
- [ ] Extend `POST /api/payment/order` with `{purpose:'scheme', enrollmentId,
      amount}`; server re-validates the amount against the scheme band and
      remaining installments **before** creating the order.
- [ ] Extend `POST /api/payment/verify` — on valid HMAC, post a
      `source:'A', postedBy:'customer'` ledger row through the *same* code path
      as §20.4 (one write path, no duplicated maths).
- [ ] Idempotency: a replayed `razorpay_payment_id` must not create a second row.
- [ ] UPI QR fallback reusing `qrGenerator.js`, with the manual reference-ID
      flow posting a `pending` row an admin approves.
- [ ] Pay screen: pending-installment summary, amount stepper honouring
      `stepAmount`, live "this buys ≈ 0.148 g at today's rate" preview.
- [ ] **Exit:** full mock-Razorpay round trip lands one row, visible in both the
      customer passbook and the admin passbook; replaying the verify call is a
      no-op; a tampered amount is rejected server-side.

### Phase 20.8 — Dues, reminders & notification settings
- [ ] Due engine: derive per-enrollment `nextDueDate`, `overdueDays`,
      `missedInstallments` from `joinDate` + tenure + rows paid.
- [ ] Cron (reuse `backupEngine.js`/`emailReporter.js` scheduling pattern):
      daily due-soon + overdue email digest to the customer; monthly collection
      summary to the store.
- [ ] Account → Notification Settings toggles persisted on the auth record;
      unsubscribe honoured.
- [ ] Admin Reports pane: due-this-week, overdue, defaulted lists.
- [ ] **Exit:** clock-shifted fixture data produces correct due/overdue
      classifications; one real reminder sent via a disposable Ethereal account.

### Phase 20.9 — Maturity, bonus & redemption into a bill
This is what makes the module worth money to the store — it closes back into the POS.
- [ ] Auto-flip `active → matured` when tenure completes (cron + on-read guard).
- [ ] Bonus applied **once**, at maturity, per the scheme's `bonus` rule, as its
      own clearly-labelled ledger row.
- [ ] `GET /api/enrollments/redeemable?phone=` for the Billing Desk.
- [ ] `BillingDesk.js`: "Redeem Scheme" lookup alongside the existing advances
      redemption — shows matured plans, applies weight-or-value against the bill,
      writes a `redeemed` closure row, links `saleId ↔ enrollmentId`.
- [ ] Guard: a plan can be redeemed exactly once; partial redemption either
      fully supported or hard-blocked (decide in 20.0 — no half-state).
- [ ] **Exit:** a matured 11-installment plan redeems into a real invoice; the
      enrollment closes; a second redemption attempt is rejected; the sale record
      carries the enrollment link.

### Phase 20.10 — Dashboard KPIs & scheme reports
- [ ] `Dashboard.js` tiles: active members, collections MTD, **total gold-weight
      liability (g)**, matured-unredeemed count, overdue count.
- [ ] Reports: collection register (date range, branch, scheme), member
      statement, weight-liability by scheme, maturity forecast (next 90 days).
- [ ] CSV export for each report.
- [ ] **Exit:** every figure reconciles against the raw ledger computed
      independently in a scratch script.

### Phase 20.11 — Account, support & legal screens
- [ ] Account: profile, member numbers, reset password, notification settings.
- [ ] Support: About Us, Contact Us, **Store Locator** (branch list + map link,
      driven by `branches.json`).
- [ ] Legal: Refund & Cancellation, Terms & Conditions, Privacy Policy —
      tenant-editable text in Settings, since these are contractual documents the
      store (not us) owns, and are required for both Play Store review and
      payment-gateway onboarding.
- [ ] Settings → Schemes pane: branches, receipt prefix, member-no format,
      reminder timing, legal-page content.
- [ ] **Exit:** every link resolves, no placeholder lorem text ships, legal
      pages reachable while logged out.

### Phase 20.12 — Test suite & hardening pass
- [ ] Extend `backend/test_suite.js`: weight-rounding precision, totals footing,
      member-no uniqueness under concurrency, immutability after a rate override,
      band/step validation, idempotent verify, cross-customer access denial.
- [ ] Add a **§14 Gold Savings Schemes** section to `docs/TESTING_CHECKLIST.md`.
- [ ] Live stress pass in the Phase 18 style: concurrent posting, replayed
      payments, mid-write restart, tampered payloads.
- [ ] `npm audit` clean; `graphify update .` to refresh the knowledge graph.
- [ ] **Exit:** full suite green; every bug found is fixed and logged in
      `CHANGELOG.md` under a new minor version.

### Phase 20.13 — Android app & release
- [ ] Point the Capacitor wrapper (`mobile/`) at `scheme.html`; add FCM push for
      due reminders (replaces email-only).
- [ ] Play Store listing: privacy-policy URL, screenshots, data-safety form.
- [ ] Publish as a signed `feature`-channel release through the existing
      `updateEngine.js` pipeline; promote dev → sandbox → live per
      `deploy/README.md` §8.
- [ ] **Exit:** installed on a real device against the sandbox instance, one
      real installment paid end-to-end.

---

## 5. New/changed files at a glance

**New backend:** `customerAuth.js`, `schemeEngine.js` (all scheme maths, single
source of truth), `data/{branches,schemes,enrollments,scheme_payments,customer_auth}.json`
**Changed backend:** `db.js` (seed new files), `server.js` (routes),
`emailReporter.js` (reminders), `backupEngine.js` (include new files in backups)
**New frontend:** `js/components/SchemeManager.js`, `scheme.html`,
`js/schemePortal.js`, `js/receipt.js`
**Changed frontend:** `index.html` (schemes tab), `Dashboard.js`,
`BillingDesk.js` (redemption), `SettingsManager.js` (schemes pane)
**Docs:** this file, `PROJECT_PLAN.md` §5.15, `TESTING_CHECKLIST.md` §14,
`CHANGELOG.md`

⚠️ `backupEngine.js` must be extended in Phase 20.2 — the moment new JSON
collections exist and aren't in the backup set, there is a silent data-loss
window.

---

## 6. Effort estimate

Same basis as PROJECT_PLAN §5.12 (focused AI-assisted build+review sessions).

| Phase | Effort |
|---|---|
| 20.0 spec lock | 0.5 |
| 20.1 customer auth | 1–1.5 |
| 20.2 branches + scheme master | 1 |
| 20.3 enrollment | 1 |
| 20.4 counter collection | 1 |
| 20.5 passbook + receipts | 1 |
| 20.6 customer shell | 1–1.5 |
| 20.7 online payment | 1 |
| 20.8 dues + reminders | 1 |
| 20.9 maturity + redemption | 1–1.5 |
| 20.10 dashboard + reports | 1 |
| 20.11 account/support/legal | 0.5–1 |
| 20.12 tests + hardening | 1–1.5 |
| **Subtotal (web)** | **~12–14 sessions ≈ 3–4 calendar weeks** |
| 20.13 Android + Play Store | 1–2 sessions + 1–3 real days review |

A useful **thin-slice demo** (one scheme, one branch, enroll → collect →
passbook → receipt, admin-side only) is reachable at **20.2 + 20.3 + 20.4 +
20.5 ≈ 4 sessions**, if you want something to show the pilot store early.

---

## 7. Decisions needed from you (blocks Phase 20.0)

1. **Customer login model.** The reference app uses username + email + password.
   SMS OTP is friendlier but needs a paid SMS gateway. Password + email reset
   needs no new vendor. → *Recommendation: password + email reset now, OTP
   later once an SMS provider is chosen.*
2. **Self-service join?** Can a customer start a plan from the app (their
   "Join New Scheme" button), or must the store enroll them at the counter?
   Self-service means collecting KYC in-app. → *Recommendation: counter-only for
   v1, self-service in a later phase.*
3. **Bonus/maturity rule.** The commonest jeweller structure is "pay 11, get the
   12th free" (bonus installment). Alternatives: % extra weight, or making-charge
   waiver at redemption. What does the pilot store actually offer?
4. **Redemption rule.** At maturity does the customer get the **accumulated
   weight** (gold-price risk sits with the store) or the **accumulated rupees**
   (risk sits with the customer)? This changes the maths and the liability tile.
5. **Branches.** How many, and does the pilot store need a real Store Locator or
   just a single address?
6. **Tenure.** Standard 11 months, or something else? (See §8.)
7. **Partial redemption** allowed, or all-or-nothing at maturity?

---

## 8. Compliance flags — confirm with your CA/lawyer, not decidable here

These shape the data model, so they're worth settling before 20.2:

- Indian jeweller savings schemes are conventionally structured as **11-month**
  plans; longer tenures and interest-like returns can bring a scheme under the
  Companies (Acceptance of Deposits) Rules, 2014. The model supports any
  tenure — the *default* is 11 for this reason.
- A bonus expressed as **cash interest** reads very differently from a bonus
  expressed as a **free installment or extra weight**. Q3 above is a legal
  question as much as a commercial one.
- **KYC/PAN thresholds** apply on gold purchases above statutory limits; if
  redemption lands on a large invoice, the Billing Desk may need a PAN capture
  field. Not built in this plan — flagged for a decision.
- **Refund & Cancellation, T&C, and Privacy Policy** are mandatory for Play
  Store review and Razorpay merchant onboarding, and are the store's own
  contractual text. Phase 20.11 builds the *screens*; the store supplies the
  *words*.

---

## 9. Not in this plan (deliberately)

- Any use of the reference app's branding, copy, layout, palette, or assets.
- Migrating existing `advances.json` data into schemes — advances and schemes
  are separate products and both keep running side by side.
- Multi-tenant scheme templates shared across tenants (each tenant defines their
  own schemes).
- Gold price hedging, physical stock reservation against scheme weight liability.
