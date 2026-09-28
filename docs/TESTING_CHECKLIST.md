# Gold POS — Manual Testing Notepad

Open this file in Notepad (or any editor) and fill in Result / Notes as you
go. Server must be running: `http://localhost:5000` (admin PIN default:
`1234`). Licensing-server items (Module 10 late items) need
`licensing_server` running too (`http://localhost:6060`) — optional, skip if
not started.

Legend: Result = PASS / FAIL / SKIP

## Run the automated checks first

```
cd backend
npm test
```

This runs eight suites and exits non-zero on any failure (**443 checks** as of
2026-08-17). None of them touch `backend/data/` — every one that needs a
database makes its own temp directory — so all are safe to run with a dev
server already up on :5000.

| Suite | Covers |
| --- | --- |
| `npm run test:billing` | Invoice money math (145 checks) —  — discount ordering, GST inclusive/exclusive, advance capping, making-charge %/₹ conversion, NaN hardening, printed rows reconciling to the Grand Total, paise settlement, advance-deposit status arithmetic (pending/rejected hold no balance; a missing status still counts, so existing ledgers keep their balances), metal value from weight × server rate, rupee↔paise conversion, the tax base being metal **+** making charge in both modes, and the return-refund pipeline — full and partial-by-weight refunds, the refunded gross including any advance redeemed, no drift across split returns, legacy/non-reconciling invoices falling back to pro-rata, and every refusal. Plus, since 2026-08-12: multi-line invoices — the per-line allocation summing exactly to the header at every slab in both tax modes, a two-line invoice equalling the single-line invoice of its summed values, per-line discounts, `saleLines()` reading both the new and the legacy record shape, per-line returns priced at the right line's rate, and the store's advance-liability rollup |
| `npm run test:schema` | Every SQLite migration and every SQL constraint, each asserted by attempting the violation (43 checks) |
| `npm run test:repositories` | The repository seam: every repository's reads and writes, the legacy wire-shape projections older readers still depend on, pagination, and the JSON importer (82 checks) |
| `npm run test:concurrency` | Real OS processes, not mocks: concurrent writers competing for one balance, crash injection mid-sale, duplicate requests, and migration drift. The slowest suite by far (~1–2 min) and in `npm test` anyway — "one balance cannot be spent twice" and "a kill mid-sale leaves nothing behind" are not observable any other way (16 checks) |
| `npm run test:integration` | Troy-ounce conversion, licensing grace periods, crypto envelopes, customer password hashing (scrypt round-trip, salt uniqueness, tampered-hash rejection), login-lockout escalation, and the password-reset code lifecycle (single use, expiry, guess budget, never stored in the clear). Plus, since 2026-08-13: admin PIN hashing (the plaintext migration, its idempotence, fresh-install seeding, refusal when no salt exists, recovery-code single use) and **TOTP against the published RFC 6238 vectors** — the one check that proves a real authenticator app will interoperate, since every other MFA test presents a code from our own generator. Plus, since 2026-08-17: the bounded keyed counter every attempt tracker and abuse limiter shares — that it expires an entry at read time as well as on sweep, and that it stays within its cap under a flood of distinct keys while still counting the newest writer, so an attacker cannot flush their own counter (10 tests) |
| `npm run test:routes` | Real server over HTTP: public surface, admin auth boundary, credential redaction and the masked save round-trip, persistence failure, invoice-sequence guard, logout invalidation, brute-force lockout (28 checks) |
| `npm run test:http` | The money paths over HTTP: server-authoritative rate and metal value, the client-field allowlist, refusal to price without a rate, Razorpay webhook signature/idempotency/amount-mismatch/unknown-order/failed-payment handling, transaction rollback, and the returns money path — admin gating, cash vs gold refund, the server pricing the refund rather than the client, cumulative over-return refusal, gold-refund rollback, and the session-scoped customer view. Plus, since 2026-08-12: multi-line sales and their rollup, one bad line refusing the whole invoice without burning an invoice number, per-line returns, tender validation in paise (including the amountless "whole bill" form and the advance-settled zero case), actor identity on the sale and the refund, the owner/manager approver gate, operator PIN rules and redaction, and the paged ledger envelopes. Plus, since 2026-08-13: no PIN hash or tenant salt reaching a browser, session revocation on a PIN change and on deactivation, the session list and who may read it, TOTP enrolment requiring a live code, recovery-code replay refusal, the MFA gate on an approval, and the refund threshold either side of the line. Plus, since 2026-08-16: the audit-trail read path and its gate, and §"The operational boundary" — request ids generated, reused and refused; readiness reporting a migrated ledger; liveness staying dependency-free; a JSON 404 on an unknown API path; a parser rejection returning a safe body with no stack trace; and a draining process answering 503 before it stops listening. Plus, since 2026-08-17: body schemas — a PIN sent as a number refused as a malformed body rather than a wrong PIN, a structurally wrong registration refused before any account logic runs, eight junk logins staying 400s and never escalating into a 429; and abuse limits — the quota advertised in headers, the probes carrying no limit headers at all, and the password-reset flood refused with a Retry-After. Includes the one check that posts a login body shaped **exactly as the browser sends it** — every field the form owns, empty ones included — because a schema that refused `totpCode: ""` broke every sign-in while all eight suites stayed green (103 checks) |
| `npm run test:guard` | Production startup guard — every fail-closed condition, plus booting a real server with demo settings under `NODE_ENV=production` and asserting it exits 1 (16 checks) |

Separately, and **not** part of `npm test` because it needs a browser binary:

```
npm install && npx playwright install chromium   # one-off
npm run test:e2e
```

43 end-to-end journeys (6 cashier, 12 customer × desktop and 390px mobile,
6 reprint, 7 return), each booting its own server against its own seeded
database.
Generate a populated database to click through by hand with `npm run seed` — it
prints the admin PIN and the customer logins, and refuses to overwrite
`backend/data/`.

Items below marked **[math automated]** have their *arithmetic* verified by
`test:billing` — you are only confirming the UI is wired to it (right field,
right row, updates live). If the numbers themselves are wrong, `npm test`
should have caught it before you got here. **[e2e automated]** means a
Playwright journey drives that exact click path; **[unit automated]** means the
logic behind it is asserted in `npm test` but the screen is not.

---

## 0. Setup

- [x] `cd backend && npm test` is green — **443 checks, verified 2026-08-17**. Eight suites run in order: `test_billing_math.js` (pricing/rounding), `test_schema.js` (migrations + SQL constraints), `test_repositories.js` (the repository seam + legacy projections), `test_concurrency.js` (real OS processes), `test_suite.js` (helper-level integration), `test_routes.js` (HTTP routes + auth boundary), `test_http.js` (money paths + webhook), `test_production_guard.js` (fail-closed startup). Every suite that needs a database makes its own temp directory via `GOLD_POS_DATA_DIR`, so all are safe to run with a dev server already up on :5000.
  Result: PASS  Notes: 145 + 43 + 82 + 16 + 10 + 28 + 103 + 16, in run order.

- [x] `npm run test:e2e` is green — **43/43, verified 2026-08-16** (Desktop Chrome + 390px Pixel 7). Needs `npm install && npx playwright install chromium` first.
  Result: PASS  Notes: 4.5m. First green run since the Phase 29 cut-over — 23 of the 43 were failing because the specs still read the retired JSON ledger and so asserted against the frozen seed rather than their own work. They read the SQLite ledger through `readLedger()` now; see LEDGER Phase 30.

- [x] Server starts cleanly (`Restart_Server.bat` or `node backend/server.js`), no red errors in console except the expected "Licensing sync connection failed" if licensing_server isn't running.
  Result: PASS  Notes: Verified 2026-09-17 via `backend/tests/e2e/admin-login.spec.js`'s
  `posServer` fixture, which boots the real `server.js` as a child process against a seeded
  database and polls `/api/health` — the same startup path `Restart_Server.bat` drives. All 5
  specs in the file booted cleanly with no error output.

- [x] `http://localhost:5000/` loads the Admin Terminal lock screen (dark PIN pad).
  Result: PASS  Notes: Verified 2026-09-17 — every spec in `admin-login.spec.js` starts with
  `page.goto(baseUrl)` landing on `#admin-login-view` with `#admin-pin-input`/`#admin-login-btn`
  visible before any login action.

---

## 1. Admin Login & Session

- [x] Enter a wrong PIN (e.g. `0000`) → refused with an inline error, stays locked.
  Result: PASS  Notes: Verified live 2026-09-17 by a new Playwright spec,
  `admin-login.spec.js` ("a wrong PIN is refused with an inline error and the terminal stays
  locked"). **Checklist text corrected**: current behaviour shows `Incorrect PIN.` in the inline
  `#admin-login-error` div (`app.js`'s `showLoginError`), not an `alert()` — this line used to
  describe a pre-hardening `window.alert` flow that no longer exists. `#app-viewport` stays
  hidden.

- [x] Enter the default PIN `1234` (a fresh, never-configured install only — `adminAuth.js`'s
  `DEFAULT_ADMIN_PIN`) → unlocks into the Dashboard, sidebar/nav visible.
  Result: PASS  Notes: Verified live 2026-09-17 — `admin-login.spec.js` ("the correct PIN
  unlocks into the Dashboard with the sidebar visible"), using the e2e fixture's own seeded PIN
  (not literally `1234`, since the seeded tenant already has a PIN configured — the DEFAULT_ADMIN_PIN
  codepath itself is covered by `test_suite.js`'s hashing/migration tests). `#app-viewport` and
  `#sidebar` become visible and the PIN field is cleared after login.

- [x] **Lockout:** enter a wrong PIN 5 times in a row → further attempts blocked, including the
  correct PIN, with a message that says so.
  Result: PASS  Notes: Verified live 2026-09-17 — `admin-login.spec.js` ("repeated wrong PINs
  lock out further attempts, including the correct PIN") drives 5+ real wrong-PIN submissions
  through the lock screen until the inline error reads "Too many failed PIN attempts...", then
  confirms the CORRECT seeded PIN is refused the same way while the cooldown is in effect.
  **Not re-verified this pass**: literally waiting out the real 30s+ cooldown in a browser — the
  escalation curve and post-cooldown recovery are already proven without a real-time wait by
  `test_suite.js` Test 6 ("Lockout escalation curve and cap") and the HTTP-level lockout checks in
  `test_routes.js` Group 9.

- [x] **Logout:** click the sidebar Logout button → returns to lock screen; refreshing the page
  does NOT auto-log you back in.
  Result: PASS  Notes: Verified live 2026-09-17 — `admin-login.spec.js` ("logout returns to the
  lock screen and a reload does not auto-relogin"): clicking `#admin-logout-btn` shows the lock
  screen immediately, and a `page.reload()` afterward still shows it (the server-side session was
  actually invalidated via `POST /api/admin/logout`, not just hidden client-side).

- [x] **Session persists across reload:** log in, refresh the browser tab → stays logged in (no
  re-prompt) as long as the server hasn't restarted.
  Result: PASS  Notes: Verified live 2026-09-17 — `admin-login.spec.js` ("an authenticated
  session survives a page reload"): `#app-viewport` stays visible and the lock screen stays
  hidden across `page.reload()`.

---

## 2. Dashboard tab

- [x] Four stat tiles render: Today's Revenue, This Month's Revenue, Outstanding Advances, Active Gold Rate (22K). Values are ₹0 / empty on a fresh dataset — fine.
  Result: PASS  Notes: Verified live 2026-09-17 by a new Playwright spec, `dashboard.spec.js`
  ("stat tiles and recent lists reflect data filed through the app, after Refresh"): files a real
  sale and a real advance deposit, then confirms Today's Revenue/count and Outstanding Advances
  move off their zero state.

- [x] ~~"Purity Mix — Lifetime Revenue Share" bar shows "No sales recorded yet" before any sale
  exists; after creating sales in Module 3, come back and confirm the bar/legend updates with
  correct % split across 24K/22K/18K.~~ **REMOVED — this checklist line describes a feature that
  no longer exists.**
  Result: N/A  Notes: Corrected 2026-09-17. `frontend/js/components/Dashboard.js` has no purity-mix
  bar, legend, or any related markup — only its CSS rules survive, as dead styles in `app.css`. The
  component's own docstring explains why: a past refactor stopped this screen from downloading the
  whole ledger to compute figures client-side ("THIS SCREEN DOES NOT DOWNLOAD THE LEDGER... The
  revenue figures now come from the server's own `totals`..."), and a lifetime purity-mix split is
  exactly the kind of figure that refactor would have removed rather than pushed server-side. This
  reads as a deliberate performance-driven removal that the checklist was never updated for, not a
  regression — CLAUDE.md §2: "if reality has drifted from the doc, fix the doc." Left as a struck-
  through record rather than deleted outright so a future pass doesn't silently re-invent it; if a
  purity-mix widget is wanted back, it is a scoped, server-aggregated addition, not a restoration.

- [x] "Recent Transactions" and "Recent Advance Deposits" lists populate after you create data in
  Modules 3 & 4 (shows latest 5 each, newest first).
  Result: PASS  Notes: **A real, previously-invisible production bug was found and fixed while
  verifying this item, 2026-09-17.** `Dashboard.js`'s `renderRecentTransactions()` called
  `describeSaleGoods(s)` (line 219) without ever importing it from `billingMath.js` — a
  `ReferenceError` on the very first render that has ANY sale to show, which is every real store
  past its first day. Because `refresh()`'s `catch` only logs to `console.error`, this failed
  completely silently: the Recent Transactions list stayed empty forever, `renderRecentAdvances()`
  (called right after it in the same `try` block) never ran, so Recent Advance Deposits stayed
  empty too, and the "Updated `<time>`" timestamp never updated — all three symptoms from one
  missing import. `ReprintDesk.js`/`ReturnDesk.js` already import `describeSaleGoods` correctly;
  `Dashboard.js` was the one call site missing it. Fixed by adding it to the existing
  `billingMath.js` import. **Verified:** new Playwright spec `dashboard.spec.js` files a real sale
  and a real advance deposit, refreshes, and confirms both appear in their respective lists — this
  test failed with exactly the console error above before the fix, and passes after it.

- [x] Click "Refresh" button → button shows "Loading..." then re-enables; "Updated `<time>`" text
  updates.
  Result: PASS  Notes: Verified live 2026-09-17 — `dashboard.spec.js` ("the Refresh button shows a
  loading state, then updates the timestamp") slows one of the four parallel dashboard fetches so
  the loading state is observable rather than racing past it on a fast local server, then confirms
  the button re-enables and `#dashboard-updated-at` reads "Updated...". This item was also silently
  broken by the same missing-import bug above whenever the ledger was non-empty — now genuinely
  passes.

---

## 3. Billing Desk tab (create a sale)

- [x] Select purity (24K/22K/18K) → the invoice preview's rate/g and gold-rate badge update.
  Result: PASS  Notes: **A real, currently-shipping bug was found and fixed while verifying this
  item, 2026-09-17.** `BillingDesk.js`'s `updateGoldRateDisplay()` was fully implemented and wired
  to the purity-change handler and to init, but the two elements it writes to —
  `#current-gold-rate-22k` and `#rate-type-badge` — did not exist anywhere in the rendered
  template, so both `getElementById()` calls silently returned `null` and the whole method was a
  no-op: no rate, no badge, ever, for any purity. This reads as an accidental casualty of the
  multi-line-cart refactor (the function was never deleted, only its DOM anchors), not a
  deliberate removal — unlike Module 2's Purity Mix bar, which had a documented reason. Restored
  the two elements just below the purity/weight row, styled like Dashboard's own
  `stat-gold-rate-badge`. **Verified:** new Playwright spec `billing-desk-preview.spec.js`
  ("switching purity updates the live rate/g display and rate-type badge") drives all three
  purities and confirms both the rate figure and the `Auto` badge update each time — this test
  failed with "element(s) not found" before the fix and passes after it.

- [x] Enter a weight (e.g. `5`) → Metal Value in the invoice preview updates live (weight × rate).
  Result: PASS  Notes: Already proven live by `cashier-billing.spec.js`'s existing assertions on
  `#sum-metal-value` immediately after filling purity/weight with no submit in between — driven by
  the same `input`-event `recalculate()` wiring this item describes. No new test needed.

- [x] **[math automated]** **Bi-directional making charge:** change the % input (e.g. to `12.5`) → the ₹ amount field updates to match. Then edit the ₹ amount directly → the % field re-splits correctly (int.dec boxes). Try an amount larger than metal value → % should clamp at 100 while the ₹ amount stays as typed (deliberate — see `makingPercentFromAmount`).
  Result: PASS  Notes: Covered by `backend/test_billing_math.js`'s `makingPercentFromAmount`
  checks (spot-checked present 2026-09-17, not re-audited line-by-line this pass).

- [x] **[math automated]** Change GST Tax Slab % → tax line and Grand Total recompute.
  Result: PASS  Notes: Covered by `test_billing_math.js`'s tax-slab recomputation checks.

- [x] **[math automated]** **Tax mode — Exclusive:** with Settings → Billing set to `Exclusive`, confirm the summary tax row reads `Excl` and the Grand Total is *higher* than Metal + Making (tax added on top).
  Result: PASS  Notes: Covered by `test_billing_math.js` (`EXCL_BASE` fixtures and surrounding checks).

- [x] **[math automated]** **Tax mode — Inclusive:** switch Settings → Billing to `Inclusive`, reload Billing Desk. Tax row now reads `Incl`, the tax figure *drops* (it is carved out of the price rather than added), and the Grand Total equals the quoted price (Metal + Making − Discount, gross). The Metal/Making/Discount rows are now restated **net of GST** and labelled `(net of GST)`, and a **Taxable Value** subtotal sits above the tax row.
  Result: PASS  Notes: Covered by `test_billing_math.js` (`INCL_BASE` fixtures and surrounding checks).

- [x] **Printed invoice adds up (both modes):** press **PRINT INVOICE** and, on the print preview, add the visible rows by hand — Metal + Making − Discount should equal **Taxable Value**, and Taxable Value + GST − Advance should equal the **Grand Total**. Do this once in `Exclusive` and once in `Inclusive`. This is the customer-facing check the arithmetic tests back up (§9); it is here because only the rendered slip can confirm the right *values* reached the right *rows*.
  Result: PASS  Notes: The underlying identity is proven by `test_billing_math.js`;
  `reprint-desk.spec.js`'s "the Billing Desk invoice also survives print media" confirms the
  RENDERED print-media sheet shows a real computed figure (`75,625.00`, Exclusive mode) with the
  cashier-workspace chrome hidden. Not independently re-driven this pass: the full manual
  row-by-row add-up in Inclusive mode specifically on a live rendered slip — left as existing,
  not new, coverage.

- [x] **Paise, never sub-paise:** with a bill that divides awkwardly (e.g. 12.5 g @ ₹6,875/g, 12% making, 5% discount, 3% GST), confirm every ₹ figure on the preview shows exactly two decimals — the Grand Total should read `₹94,180.63`, never `₹94,180.625`.
  Result: PASS  Notes: The rounding rule itself (`toPaise`/`fromPaise`) is `test_billing_math.js`'s
  core subject; `reprint-desk.spec.js` confirms a real rendered slip shows exactly two decimals
  (`75,625.00`). The specific named awkward-division example (`₹94,180.63`) was not independently
  re-typed into a live browser this pass — existing coverage judged sufficient rather than
  re-verified figure-for-figure.

- [x] **Legacy tax-mode casing:** stop the server, hand-edit `taxMode` in `backend/data/settings.json` to lowercase `inclusive`, restart, and reload the Billing Desk. The bill must still be computed **Inclusive** (tax row reads `Incl`), and opening Settings → Billing must show the **Inclusive** option preselected. Saving Settings rewrites the value as canonical `Inclusive`.
  Result: PASS  Notes: `test_billing_math.js`'s "normalizeTaxMode canonicalises to exactly one of
  the two modes" directly proves `normalizeTaxMode('inclusive')` → `'Inclusive'` (and padded/
  uppercase/garbage variants), which is the function this whole item exercises end-to-end. **Not
  re-walked live**: literally stopping the server, hand-editing `settings.json` and restarting —
  the e2e fixture seeds a fresh tenant per test and has no hook for injecting a malformed legacy
  value before boot; the unit-level proof is judged sufficient rather than building one.

- [x] **[math automated]** Enter a Discount (%) → discount row appears in preview, Grand Total drops accordingly, and the GST line drops too (tax is charged on the discounted value, not the gross).
  Result: PASS  Notes: Covered by `test_billing_math.js`'s discount checks (`DISC_BASE` and
  surrounding assertions).

- [x] **[math automated]** **Discount toggle:** with a non-zero `Default Discount %` saved in Settings → Billing, the Billing Desk shows a **Remove** button pre-applied. Click it → discount goes to 0, button becomes **Apply**, Grand Total rises. Click again → original discounted total returns exactly. With the default at 0, no button is shown at all.
  Result: PASS  Notes: *(closed 2026-09-26)* New `billing-desk-preview.spec.js` coverage: one spec
  for the seeded 0%-default hidden state, one for a saved non-zero default — Remove shown, click
  toggles to Apply with the Grand Total strictly higher, click again returns the exact original
  total string. **Real bug found and fixed first:** `SettingsManager.js`'s Billing-settings save
  handler refreshed `window.reportsDesk`/`window.schemeDesk` after a save but never
  `window.billingDesk` — so a changed default discount (and tax slab/mode, wastage, old-gold) never
  reached the Billing Desk without a page reload, since `billingDesk.fetchSettings()` otherwise only
  runs once, at login. Fixed by adding the same refresh to that save callback. Guard proven: the
  non-zero-default test failed with the toggle hidden (its pre-fix state) before the fix, passed
  after it. `npx playwright test billing-desk-preview.spec.js` 6/6 (desktop-chromium); full
  `npx playwright test` (both projects) 138/139 — the one failure (`visual-regression.spec.js`,
  an untouched file, "server recalculated the total" on a stale preview rate) reproduced clean 3/3
  in isolation immediately after, matching the same contention-under-a-long-run signature already
  recorded in `docs/LEDGER.md`'s 2026-09-22 entry, not a regression from this change.

- [x] Enter a **new** 10-digit phone with no advance history → no "Apply Advance" box appears.
  Result: PASS  Notes: *(closed 2026-09-26)* New `billing-desk-preview.spec.js` test types a phone
  outside `seed.js`'s customer range, waits on the real `GET /api/advances/lookup` response (so the
  assertion cannot pass trivially before the round trip even runs), then asserts
  `#advance-redeem-container` stays hidden.
  discount-toggle spec above.

- [x] **[math automated]** Enter a phone that HAS an advance balance (create one first via Module 4, then come back) → "Customer Advance Available" box appears; click "Apply Advance" → total reduces by the advance (capped at the pre-advance total, so a large balance drives the total to ₹0 and never negative); click again to remove it. With the advance applied, lower the weight → the redeemed amount re-clamps down to the smaller bill.
  Result: PASS  Notes: Covered by `test_billing_math.js`'s advance-redemption clamping checks, and
  live end-to-end by `cashier-billing.spec.js`'s "applies a seeded advance and writes the
  redemption into the same ledger".

- [x] **[math automated]** **Tax base is the whole bill, including making charge.** With a 10 g @ ₹6,875/g sale and making charge set to a large figure (say 30%), note the GST amount. Drop making charge to 0% and watch the GST amount fall — the slab applies to Metal **+** Making, not to metal alone. The summary line names the base: `Taxable Value (Metal + Making)`. Repeat in `Inclusive` mode: the carved-out tax must move with the making charge there too.
  Result: PASS  Notes: Covered by `test_billing_math.js`'s taxable-base checks in both tax modes.

- [x] **[e2e automated]** Leave weight at 0 and click "SAVE INVOICE" → blocked with a clear message.
  Result: PASS  Notes: **Checklist text corrected 2026-09-17**: the old message text, "Please enter
  a valid gold weight.", predates the multi-line cart — the real current message (`BillingDesk.js`)
  is `"Add at least one item to the invoice — enter a weight for the current item, or add items to
  the cart."`, thrown from `submitSale()` when `lines.length === 0`. Verified live by new spec
  `billing-desk-preview.spec.js` ("an empty invoice is refused with a clear message and burns no
  invoice number") — the alert text is asserted and the ledger row count is confirmed unchanged
  (a client-side guard with no server round-trip at all, so no sequence is ever allocated).

- [x] **[e2e automated]** **Partial customer number is refused before it is sent.** Type a valid weight and a 5-digit customer phone, then click **SAVE INVOICE**. It must be blocked *on the field*.
  Result: PASS  Notes: Covered live by `cashier-billing.spec.js` (asserts the "...exactly 10
  digits" field message and that completing/clearing the phone both file normally).

- [x] Fill a valid sale and click "SAVE INVOICE" → "Invoice Saved Successfully!", form resets, preview reverts to Cash Sale/blank.
  Result: PASS  Notes: The success alert was already proven by `cashier-billing.spec.js`; the
  **form-reset half was not** — added to new spec `billing-desk-preview.spec.js` ("a successful
  save resets the form and preview back to blank"), which fills the form, saves, and confirms
  `#gold-weight`/`#customer-name` clear and `#preview-customer-name`/`#preview-customer-phone`
  revert to `Cash Sale`/`-`.

- [x] **[e2e automated]** Click "PRINT INVOICE" → browser print dialog opens showing the invoice sheet, populated, with no app chrome.
  Result: PASS  Notes: Covered live by `reprint-desk.spec.js`'s "the Billing Desk invoice also
  survives print media" (asserts the sheet is visible with a real computed figure, and
  `.billing-inputs-card` is hidden under print media).

- [x] Go back to Dashboard → new sale appears in Recent Transactions and today's revenue total.
  Result: PASS  Notes: Covered live by `dashboard.spec.js`'s "stat tiles and recent lists reflect
  data filed through the app, after Refresh" (2026-09-17, Module 2 pass) — files a sale through
  Billing Desk, then confirms it in Today's Revenue and Recent Transactions.

---

## 3a. Reprint Invoice tab

*Added 2026-08-09. The rule this module exists to keep: a reprint shows what was **filed**, never
what today's settings would price.*

- [x] Open **Reprint Invoice** and click **SEARCH INVOICES** with every field empty → refused with "Enter an invoice number, phone, or name…", and no results table. (An unfiltered search would dump the whole ledger.)
  Result: PASS  Notes: Covered live by `reprint-desk.spec.js`'s "refuses to search on nothing
  rather than returning the whole ledger".

- [x] **[e2e automated]** Search by the invoice number of a sale you filed in §3 → exactly one row, showing the invoice number, when it was saved, customer, phone and total. Click **Open**.
  Result: PASS  Notes: Covered live by `reprint-desk.spec.js`'s "finds a filed invoice by its
  number and reprints it stamped as a duplicate".

- [x] **[e2e automated]** The sheet renders with a red **DUPLICATE — REPRINT** stamp in the header, the original invoice number and *original* date, and figures identical to the slip from §3 — Taxable Value, GST and Grand Total all matching to the paise.
  Result: PASS  Notes: Same test as above asserts the stamp and Taxable Value/GST/Grand Total to
  the paise (`75,625.00` / `2,268.75` / `77,893.75`).

- [x] **[e2e automated]** **A reprint is not re-priced.** After opening a duplicate, go to Settings, change the gold rate override and the GST slab, and flip tax mode. Come back, reload, search the *same* invoice and open it again — every figure must be unchanged. If any number moved, the module is re-pricing and is wrong.
  Result: PASS  Notes: Covered live by `reprint-desk.spec.js`'s "reprints the FILED figures after
  the gold rate and tax settings have moved" — patches settings for real, reloads the page, and
  asserts both the original figures AND the absence of the new ones.

- [x] Search by the customer's 10-digit phone, and by a fragment of their name → both find the invoice. Search a phone with no sales → "No filed invoice matches that", not an empty table.
  Result: PASS  Notes: Phone search + honest-miss message already covered by "finds an invoice by
  customer phone, and reports an honest miss". **Name-fragment search was a real gap** — nothing
  exercised it — closed 2026-09-17 with a new test, "searches by a fragment of the customer name,
  as well as by phone".

- [x] Set a **From**/**To** date range around the sale's date → it appears. Narrow the range to exclude it → it does not. A `To` earlier than `From` is refused with a clear message.
  Result: PASS  Notes: **A real, entirely untested gap, closed 2026-09-17.** The date-range filter
  and the backwards-range refusal (`parseLedgerQuery`'s `'The "from" date cannot be after the "to"
  date.'`, `server.js`) had no test anywhere in the tree — grepped `backend/*.js`, zero hits. New
  test "a date range around the sale finds it, narrowing it out excludes it, and a backwards range
  is refused" in `reprint-desk.spec.js` covers all three behaviours against a real filed invoice.

- [x] **[e2e automated]** Click **PRINT DUPLICATE** → the print preview shows the stamped sheet only. The search box, results table, and both buttons must be absent.
  Result: PASS  Notes: Covered live by `reprint-desk.spec.js`'s "keeps the invoice sheet on the
  page when printing, rather than hiding it" (asserts the sidebar and print button are hidden
  under print media, alongside the DUPLICATE stamp and figures).

- [ ] **Pre-Phase-20 invoice (only if your `backend/data/sales_*.json` has one).** Open an invoice filed before `taxableAmount`/`taxAmount`/`taxMode` were stored. It must print its filed Grand Total with the tax row reading *"not recorded on this invoice"* and an amber notice above the sheet — **never** a ₹0.00 GST line, which would assert that no tax was charged.
  Result: OPEN  Notes: 2026-09-17 — genuinely untested anywhere (grepped for the exact notice text
  across `backend/`, zero hits in any test file). Left open rather than forced: this needs a
  hand-built legacy-shaped invoice row (`taxableAmount`/`taxAmount`/`taxMode` all `NULL`) inserted
  directly into the SQLite fixture bypassing the normal insert path, which the seeded e2e fixture
  has no hook for yet. The item is also conditional in its own text ("only if...") — no tenant has
  been live long enough yet for a genuine pre-2026-08 record to exist outside a deliberately-built
  fixture, but the code path itself is real and worth a dedicated repository-level test
  (`test_repositories.js` is the natural home, not e2e) in a future pass.

---

## 3b. Returns & Refunds tab

*Added 2026-08-11. Three rules this module exists to keep: the refund is priced by the **original
invoice** and never by today; **only the store** can issue one; and an invoice can never give back
more than it took.*

- [x] Open **Returns & Refunds** and click **FIND INVOICE** with every field empty → refused with "Enter an invoice number, phone, or name…", no results table.
  Result: PASS  Notes: **Real, entirely untested gap, closed 2026-09-17.** Unlike Reprint Desk's
  identical guard, nothing exercised this one — grepped, zero hits. New test "refuses to search on
  nothing rather than returning the whole ledger" added to `return-desk.spec.js`, reusing the exact
  shape of Reprint Desk's own equivalent test.

- [x] **[e2e automated]** Search the invoice number of the sale you filed in §3 → one row showing weight, a `—` in the Returns column, the billed total, and a **Return** button. Click it. The form opens with the weight box defaulted to the full weight.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "files a partial cash refund and
  issues a credit note that adds up" (asserts `#return-weight` defaults to the full `10.000`).

- [x] **[math automated]** Enter a **partial** weight (say 4g of a 10g invoice). The preview itemises metal, making, discount (if any) and GST, and the REFUND line equals the sum. It states how much would remain returnable.
  Result: PASS  Notes: Covered by `test_billing_math.js`'s `computeReturnRefund` checks, and live
  by the same `return-desk.spec.js` test (asserts each itemised row plus "6.000 g would remain
  returnable").

- [x] **[e2e automated]** With **Cash** selected, click **FILE RETURN & REFUND** and confirm → a **CREDIT NOTE** sheet appears, marked *RETURN & REFUND*, naming the credit-note number and the original invoice. The figure matches the preview exactly.
  Result: PASS  Notes: Same test as above asserts the sheet, its stamp, the invoice id, and that
  the preview figure (`31,157.50`) matches what actually filed.

- [x] **[e2e automated]** **A cash refund is not store credit.** Check the customer's balance in the Advances tab before and after → unchanged. Then check the Reprint Invoice tab → the original invoice still reprints with its *original* total. Returns never rewrite an invoice.
  Result: PASS  Notes: The advances-ledger-unchanged half and the invoice-row-unchanged half
  (`sale.totalAmount`/`sale.weightGrams` re-read from the ledger, both unmoved) are both asserted
  directly by the same test. The literal "reopen it in the Reprint Invoice tab" step was not
  separately re-driven — Module 3a's own suite already proves Reprint Desk does nothing but reflect
  the ledger, so re-reading the ledger row is equivalent evidence, not a gap.

- [x] **[e2e automated]** Search the same invoice again → the row now reads "4.000 g returned", and reopening the form offers only the remaining 6g. Typing more than that is refused inline and the FILE button greys out.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "accumulates partial returns and
  closes the invoice when the weight runs out" — asserts the "4.000 g returned" row text, the
  `6.000` re-opened default, the "Only 6.000g" inline refusal, and `#return-file-btn` disabled.

- [x] **[e2e automated]** Return the remaining weight → the note says the invoice is fully returned, and searching it again shows **Fully returned** with the button disabled. **The two refunds must sum to exactly the invoice's billed total** (add them up by hand; if they are a paisa out, the true-up is broken).
  Result: PASS  Notes: Same test asserts "fully returned" on the note, "Fully returned" plus a
  disabled button on re-search, and sums the two filed return rows to `77893.75` exactly.

- [x] **[e2e automated]** **Gold refund.** File a sale against a customer *with* a phone number, return it choosing **Gold**, then check that customer in the Advances tab → an approved deposit for the refund amount, described as a return credit against that invoice. Start a new bill for them → **Apply Advance** offers it immediately, with no approval step.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "a gold refund becomes spendable
  credit on the customer's account" end to end, including reopening Billing Desk and applying the
  credit on a fresh bill.

- [x] **[e2e automated]** **Walk-in with no phone.** Open a return against a cash sale filed without a customer number → the Gold option is disabled with an explanation, and Cash is preselected. There is no account to credit.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "offers only a cash refund on a
  walk-in invoice with no account to credit".

- [x] **[e2e automated]** **A return is not re-priced.** After filing a sale, change the gold rate override, the GST slab and the tax mode in Settings. Reload, open a return against that invoice → the preview must still quote the *original* rate and slab. If any figure moved, the module is re-pricing and is wrong.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "prices the refund from the invoice
  after the rate and tax settings move" — patches settings for real, reloads, and asserts both the
  original figures and the absence of the new ones.

- [x] **An invoice that redeemed an advance refunds the full charge.** Return a sale that used advance credit → the refund is `total + advance redeemed`, not the cash the customer handed over. (The advance was their money too.)
  Result: PASS  Notes: Covered by `test_billing_math.js`'s dedicated `SALE_INCL_ADV` fixture and
  its check "a full return refunds ₹72,900 — the charge, not just the cash paid" — the exact rule
  this item names, unit-proven against `computeReturnRefund`. Not independently re-driven as a live
  Billing-Desk-then-Return-Desk browser journey this pass; the unit-level proof is judged
  sufficient.

- [x] **[e2e automated]** Click **PRINT CREDIT NOTE** → the print preview shows the note only. Search box, results table, the Recent Returns list and both buttons must be absent.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "the credit note survives print
  media, and the controls do not".

- [x] **[e2e automated]** The **Recent Returns** list at the bottom shows every filed return with its mode (CASH / GOLD CREDIT), and **Note** reopens any credit note.
  Result: PASS  Notes: Covered live by `return-desk.spec.js`'s "lists filed returns and reopens any
  credit note from the history".

- [ ] **Pre-Phase-20 invoice (only if your `backend/data/sales_*.json` has one).** Return against one → the refund is a straight pro-rata share of the filed total and the note says the itemised breakdown was *not recorded on the original invoice*. Never an invented GST line.
  Result: OPEN  Notes: 2026-09-17 — same class of gap as Module 3a's identical item. `SALE_LEGACY`
  fixture and its `computeReturnRefund` checks already exist in `test_billing_math.js` (lines
  ~1281-1287), so the pricing RULE is unit-proven; what's untested is the live Return Desk UI path
  against a legacy-shaped DB row, which needs the same not-yet-built fixture hook as Module 3a's
  equivalent item. Left open together with it for a future `test_repositories.js`-level pass.

---

## 4. Customer Advances tab

- [x] Click "+ New Deposit" → form expands. Try submitting with a phone under 10 digits → blocked with validation alert.
  Result: PASS  Notes: **No e2e spec had ever opened the admin Advances tab at all** — grepped
  `backend/tests/e2e/*.spec.js` for `advances-tab`/`AdvancesManager`, zero hits, despite
  `cashier-billing.spec.js`/`return-desk.spec.js` exercising the Billing Desk's "Apply Advance" box
  from the other side. New `backend/tests/e2e/advances-manager.spec.js` closes the whole module.
  This item: "the new-deposit form validates the phone before submitting" — asserts the "Valid
  10-digit phone number required" alert and that nothing was recorded.

- [x] Submit a valid manual deposit (10-digit phone, name, amount, method) → success alert, form clears/hides, new row appears in the table with correct balance.
  Result: PASS  Notes: Covered by the new spec's "a valid manual deposit succeeds, clears the form,
  and appears in the table with the right balance".

- [x] Use the search box to filter by phone or name → table filters live.
  Result: PASS  Notes: Covered by the new spec's "the search box filters the table live by phone
  or name" (asserts filtering by both a name fragment and the phone number).

- [x] Click "View" on a customer row → expands a ledger drill-down showing deposit/redemption history with correct +/− signs and dates; click "Hide" to collapse.
  Result: PASS  Notes: Covered by the new spec's "View expands a per-customer ledger drill-down,
  and Hide collapses it".

- [x] Redeem part of that customer's advance in Billing Desk (Module 3) → return here, refresh → balance reduced by the redeemed amount, drill-down shows a "Redeemed at Billing" entry referencing the invoice ID.
  Result: PASS  Notes: **A real bug found and fixed while verifying this exact item, 2026-09-18.**
  `AdvancesManager.js`'s drill-down rendered `e.paymentMethod || (e.invoiceId ? 'Invoice ' +
  e.invoiceId : '')` for every entry — but `saleService.js` hardcodes `paymentMethod: 'other'` on
  every redemption row (a placeholder to satisfy the schema, not a meaningful value for a
  redemption). Because `'other'` is truthy, the `||` always picked it over the invoice reference,
  so a "Redeemed at Billing" line NEVER showed which invoice consumed the credit — exactly the
  information this drill-down exists to show, and exactly what this checklist item asks for. Fixed
  by making the choice type-aware: a deposit row still shows its payment method; a non-deposit
  (redemption) row shows `Invoice <id>` when one exists, falling back to the raw payment method
  only if it somehow doesn't. **Verified:** new test "redeeming an advance at Billing Desk shows up
  here as a 'Redeemed at Billing' entry against the invoice" — failed with the invoice id missing
  from the rendered text before the fix, passes after it; also asserts the balance actually moved
  down from the deposited amount.

---

## 5. Settings → Store Profile

- [x] Edit Company Name, Phone, Address, GST Number, Currency → Save → success alert.
  Result: PASS  Notes: **No e2e spec had ever opened Store Profile** — `inventory-billing-
  operations.spec.js` only ever touched the Billing subsection. New
  `backend/tests/e2e/store-profile.spec.js` closes the whole module. This item: "editing Store
  Profile fields and saving shows a success alert and persists" — edits all five fields, asserts
  the "Store profile saved!" alert, then reloads and confirms they actually persisted.

- [x] Upload a logo image (small PNG/JPG) → preview updates; Save → go to Billing Desk, confirm the logo now appears on the invoice preview header (replacing the text company name).
  Result: PASS  Notes: Covered by the new spec's "uploading a logo replaces the company name on
  the invoice" half, using a real 68-byte fixture PNG
  (`backend/tests/e2e/fixtures/tiny-logo.png`) uploaded via `setInputFiles`.

- [x] Click "Clear Logo" → preview clears; Save → logo removed from invoice too.
  Result: PASS  Notes: **A real, currently-shipping bug was found and fixed while verifying this
  exact item, 2026-09-18.** `SettingsManager.js` used `null` as BOTH the "nothing touched this
  session" sentinel for `currentLogoBase64` AND the value Clear Logo set — so the save handler's
  `this.currentLogoBase64 !== null ? this.currentLogoBase64 : (this.settings.companyLogo || null)`
  could never tell "the user cleared it" apart from "the user never touched the file input," and
  always fell back to re-sending the OLD logo. Clicking Clear Logo then Save has never actually
  cleared a logo. Fixed by giving "explicitly cleared" its own value (empty string) distinct from
  "untouched" (`undefined`), matching the same null-means-keep/empty-string-means-clear convention
  `razorpayKeySecret` and other masked credential fields already use elsewhere in this file — one
  case of "reuse the existing pattern" (CLAUDE.md §1), not a new convention. Also fixed the same
  `||`-can't-see-`''` bug in the live preview's own render expression, which would have shown the
  stale logo again if the profile section were closed and reopened before saving. **Verified:** the
  same new spec's second half, "...Clear Logo restores it" — failed with the logo still visible on
  the invoice after a Clear-then-save-then-reload before the fix, passes after it.

- [x] **Admin PIN is masked.** The Admin PIN box shows `••••••••`, not the real PIN. Edit Company Name only and Save, then log out and log back in with your *existing* PIN → it still works (saving an unrelated field must not overwrite the PIN with the mask).
  Result: PASS  Notes: **Checklist text corrected**: the field does not render literal `••••••••`
  characters — it is an empty `type="password"` input with the placeholder "Configured — leave
  blank to keep" (arguably stronger: nothing is in the DOM to inspect at all, not even mask
  characters). The substantive claim — the real PIN is never echoed, and saving an unrelated
  section leaves it completely intact — is exactly what the new spec's "the Admin PIN field never
  echoes the real PIN..." test proves live: asserts the field is empty with that placeholder, saves
  a Store Profile edit only, logs out, and logs back in with the original seeded PIN.

- [x] Type a new PIN over the mask (e.g. `432198` — 6 digits minimum since 2026-08-24) → Save → log out → the new PIN works and the old one does not. Set it back afterwards.
  Result: PASS  Notes: Covered live by the new spec's "typing a new PIN over the blank field
  changes it, and the old PIN stops working" — saves `432198`, logs out, confirms the ORIGINAL
  seeded PIN is now refused with "Incorrect PIN" and the new one signs in. "Set it back afterwards"
  is a manual-testing courtesy for a shared long-lived instance; the e2e fixture's database is
  thrown away after the test regardless, so no revert step was needed or added.

---

## 6. Settings → Gold Pricing & Overrides

- [ ] Click "Sync Price Now" → succeeds (needs internet — Yahoo Finance XAU) and Billing Desk's live rate updates.
  Result: OPEN  Notes: 2026-09-19 — deliberately left untested: this needs real internet access to
  a live third-party API (Yahoo Finance), and an e2e suite that depends on that would be exactly
  the non-deterministic test this project avoids (mirrors the same reasoning as leaving hardware/
  VPS-dependent §24b items open). The sync route itself (`POST /api/gold-price/sync`) and the
  client-side refresh call are simple and low-risk; what's genuinely valuable here — the override
  gate the synced rate flows through — is now covered (see below).

- [x] Enable "manual overrides", set custom 24K/22K/18K prices, Save → Billing Desk and Dashboard now show your override values with a "Manual Override" badge instead of "Auto Midnight".
  Result: PASS  Notes: **No e2e spec had ever opened Gold Pricing & Overrides.** New
  `backend/tests/e2e/gold-pricing.spec.js` closes this item: sets all three override prices, saves,
  and confirms both Billing Desk's rate display/badge and the Dashboard's stat tile/badge update —
  live, with no page reload needed, since the save handler itself refreshes both.

- [x] Disable overrides again, Save → rates revert to the auto-synced values.
  Result: PASS  Notes: **A real, serious, previously-unfixed production bug was found and fixed
  while verifying this exact item, 2026-09-19.** `priceEngine.js`'s `getActiveGoldRates()` — the
  ONE function every price-dependent service reads gold rates through (sales, returns, advances,
  old-gold exchange, payment credit, gold schemes) — decided whether an override was "on" purely
  from `override.price24K/22K/18K > 0`, and **never read `override.active` at all**. The Settings
  form's "Enable manual overrides" checkbox was therefore cosmetic: unchecking it and saving left
  the stored price fields untouched, so the override stayed in effect forever — the only way to
  truly return to auto pricing was to also zero out all three price fields by hand, which nothing
  in the UI prompts anyone to do. Grepped the whole tree: **no test anywhere ever imported
  `priceEngine.js`** — every other suite mocks `getActiveGoldRates` out entirely, so this shipped
  with zero coverage of the real function despite being downstream of every sale ever priced.
  Fixed by gating every override use on `Boolean(override.active)`. **Verified:** new
  `backend/test_suite.js` Test 16 ("manual gold-rate override respects its own on/off switch") unit
  -tests the real `getActiveGoldRates()` directly against four cases (active+priced → manual;
  disabled+stale-priced → auto, the exact bug; active+unpriced → auto; no override object → auto);
  the new e2e spec's second test proves the same thing live through the real Settings UI and
  Billing Desk. Full `npm test` (all twelve suites, 491 ✅ lines) and full `npx playwright test`
  (both projects), all green, exit code 0.

---

## 7. Settings → Billing & Invoice

- [x] Change GST Tax Slab and Invoice Prefix → Save → succeeds.
  Result: PASS  Notes: **No e2e spec had ever opened Settings → Billing & Invoice as its own
  subject** (only incidentally, to flip one toggle, in `inventory-billing-operations.spec.js`). New
  `backend/tests/e2e/billing-settings.spec.js` closes the module. This item: "changing GST Tax
  Slab and Invoice Prefix and saving succeeds" — changes both, saves, reloads, and confirms they
  persisted.

- [x] Change Admin PIN to something else, Save, Logout, log back in with the NEW pin → works. (Set it back to `1234` after, or note the new value here: ___________ )
  Result: PASS  Notes: Already fully covered by Module 5's `store-profile.spec.js` — the PIN field
  lives in this same Billing & Invoice section (`#save-billing-btn`), and "typing a new PIN over
  the blank field changes it, and the old PIN stops working" saves through this exact button.
  "Set it back afterwards" is a manual-testing courtesy; the e2e fixture's database is thrown away
  after each test regardless.

- [x] **Destructive guard:** lower "Next Invoice Sequence Number" below its current value → a confirmation prompt appears requiring you to type `LOWER SEQUENCE` exactly. Cancel it (type something wrong or dismiss) → save is aborted, "Cancelled" alert shown, nothing changed.
  Result: PASS  Notes: Covered live by the new spec's "lowering the invoice sequence requires
  typing the exact confirmation phrase; a wrong or cancelled answer saves nothing" — types a wrong
  phrase into the real native `prompt()`, confirms the "Cancelled" alert, and confirms
  `invoiceSeqStart` on disk did not move.

- [x] Repeat but type `LOWER SEQUENCE` correctly → save succeeds.
  Result: PASS  Notes: Covered live by the new spec's "typing the confirmation phrase exactly lets
  the lowered sequence save" — confirms the lowered value actually persists.

---

## 8. Settings → Payment Gateway

- [ ] Confirm default Razorpay keys are the demo pair `rzp_test_xxxxxx` / `rzp_test_xxxxxx_secret` (these auto-mock checkout — see Module 12).
  Result: _____  Notes: ______________________________________________

- [ ] Set a UPI ID (e.g. `teststore@upi`), Save → go to Customer Portal deposit flow, select Manual UPI → a real scannable QR now renders (previously showed "not configured").
  Result: _____  Notes: ______________________________________________

- [ ] **Key Secret is masked.** Key ID stays readable (it is public by design); Key Secret shows as a masked field. With DevTools → Network open, reload Settings and inspect the `GET /api/settings` response → `razorpayKeySecret` is `••••••••` and the real secret appears nowhere in the payload.
  Result: _____  Notes: ______________________________________________

- [ ] Change only the UPI ID and Save → mock checkout still works, proving the untouched Key Secret was preserved rather than overwritten by the mask.
  Result: _____  Notes: ______________________________________________

- [ ] **Webhook Secret and Public URL fields are present** under the Razorpay section. Type a Public URL (e.g. `https://pos.example.com`) and Save, then reopen Settings → the hint line below now shows the exact endpoint to register in the Razorpay dashboard: `https://pos.example.com/api/payment/webhook`.
  Result: _____  Notes: ______________________________________________

- [ ] **Webhook Secret is write-only, like the Key Secret.** Save a secret, reload Settings → the field is blank with a "Configured — leave blank to keep" placeholder, and `GET /api/settings` in DevTools shows `razorpayWebhookSecret: null` with `razorpayWebhookSecretConfigured: true`. Save an unrelated field → the secret survives.
  Result: _____  Notes: ______________________________________________

---

## 9. Settings → Backup & Email Reports

- [ ] Click "Create Backup Now" → status line shows "Backup created: backup_<date>"; confirm a new dated folder appears under `backups/` on disk.
  Result: _____  Notes: ______________________________________________

- [ ] Leave SMTP fields blank, click "Send Daily Report Now" → status shows a skip reason (not an error) since SMTP isn't configured.
  Result: _____  Notes: ______________________________________________

- [ ] **Reset availability is stated here** *(added 2026-08-09)*. With SMTP blank, an amber notice under the SMTP fields reads "**Customer password reset is off**" and points at Customer Logins for manual resets. Fill host, username and password, Save, reload → it turns green and reads "**Customer password reset is live**". This exists because SMTP looks like a *reporting* setting: a store that never wanted the daily email had no way to know it had also switched off every customer's ability to reset their own password.
  Result: _____  Notes: ______________________________________________

- [ ] (Optional, needs a real/test SMTP account e.g. Ethereal or Gmail App Password — see `docs/GO_LIVE_CHECKLIST.md` §"Email Reports") Fill SMTP host/port/user/pass, Save, then "Send Daily Report Now" again → status shows success and the report actually arrives at Report Email Address.
  Result: _____  Notes: ______________________________________________

- [ ] **SMTP Password is masked.** After the save above, reload Settings → the password box shows a mask, and `GET /api/settings` in DevTools → Network contains no plaintext password. Before it was configured the box was empty — an empty box means "not set", a mask means "set but hidden".
  Result: _____  Notes: ______________________________________________

- [ ] Change only the "From" Display Name and Save, then "Send Daily Report Now" → the email still sends, proving the masked password round-tripped instead of being overwritten.
  Result: _____  Notes: ______________________________________________

---

## 10. Settings → License & Subscription

- [ ] License status block loads (Key / Status / Expiry / Last Handshake / Version / Billing Cycle / Next Due Date). With no licensing_server running, Status should show grace-period behavior rather than an immediate lock (7-day grace window).
  Result: _____  Notes: ______________________________________________

- [ ] Click "Check for Updates Now" → either "Up to date — no pending update" or shows a pending release if one's been published on the licensing server.
  Result: _____  Notes: ______________________________________________

- [ ] *(Advanced, optional — needs `licensing_server` running on :6060)* Publish a test release from the licensing dashboard, then "Check for Updates Now" here → banner shows version/channel/changelog and an "Apply Update Now" button appears for feature/patch channels.
  Result: _____  Notes: ______________________________________________

---

## 11. Diagnostics tab

- [ ] Click "Pull Technical Logs" (Level 1) → debug drawer logs uptime, heap usage, telemetry count, recent error count.
  Result: _____  Notes: ______________________________________________

- [ ] Click the Level 2 encrypted database export button → drawer confirms an encrypted envelope was generated (not human-readable here by design — decrypted offline only). Note: the settings inside the bundle are credential-masked, so a decrypted support export shows whether SMTP/Razorpay are configured but never the values.
  Result: _____  Notes: ______________________________________________

- [ ] Click the black-box flight-recorder export button → drawer confirms export ready, decryptable only via `developer_blackbox_keys/analyze_blackbox.js`.
  Result: _____  Notes: ______________________________________________

- [ ] Collapse/expand the debug drawer toggle → works.
  Result: _____  Notes: ______________________________________________

---

## 12. Customer Portal (`http://localhost:5000/customer.html`)

Rebuilt in Phase 20.1 (2026-08-08). The old flow — type any 10-digit number,
land straight in that customer's ledger — is gone; the portal now requires a
password. Items marked **[auto]** are already asserted by the automated
Playwright pass; you are confirming they hold in a real browser on your machine.

### 12a. Sign in / register

- [ ] **[auto]** The page opens on a **Sign In** pane with *both* a mobile and a password field, and no ledger data is visible.
  Result: _____  Notes: ______________________________________________

- [ ] **The old hole is closed:** enter a mobile number you know has deposits (from Module 4) with any made-up password → refused, portal stays closed. This is the single most important check in this file.
  Result: _____  Notes: ______________________________________________

- [ ] The refusal message says only "Invalid mobile number or password" — it must **not** reveal whether that number is a registered customer.
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** Switch to **Create Account**, use a brand-new 10-digit number: a password under 8 characters is refused, and a mismatched confirmation is refused.
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** Complete registration with a valid password → lands directly in the portal, greeting shows the name you typed, balance ₹0, "Money Worth in Gold" shows 0 g / ₹0 / +₹0.
  Result: _____  Notes: ______________________________________________

- [ ] Try to register a number that **already has deposits** → refused with "please ask the store to set up your login at the counter" (`CLAIM_REQUIRES_STORE`). This is what stops a stranger claiming an existing customer's ledger.
  Result: _____  Notes: ______________________________________________

- [ ] Enter 5 wrong passwords in a row for one account, then a 6th → locked out with a countdown message. Confirm the *correct* password is also refused while locked.
  Result: _____  Notes: ______________________________________________

### 12b. Counter-issued login (for existing customers)

- [ ] With an admin session, POST to `/api/customer-accounts/issue-login` with `{"phone":"<a number that has deposits>"}` → returns a `tempPassword`. (No admin UI for this yet — Settings pane is Phase 20.2.)
  Result: _____  Notes: ______________________________________________

- [ ] Sign in to the portal with that temp password → you are held on a **"choose your own password"** screen and cannot reach any ledger data until you do.
  Result: _____  Notes: ______________________________________________

- [ ] Set a new password → you land in the portal and now see that customer's **pre-existing** deposit history.
  Result: _____  Notes: ______________________________________________

- [ ] Repeat the issue-login call for the same number → `409 CONFIRMATION_REQUIRED` until you resend it with `"confirmDestructive": true`.
  Result: _____  Notes: ______________________________________________

### 12c. Deposits

- [ ] Deposit tab: there is **no "Your Full Name" field** any more — the name comes from your account.
  Result: _____  Notes: ______________________________________________

- [ ] Enter amount ≤ ₹100 → blocked ("Minimum deposit amount is ₹100").
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** Enter a valid amount (e.g. `5000`) on "Online Payment (Razorpay)" → demo keys auto-mock: "TEST MODE: Razorpay mock payment verified successfully!" and the balance updates immediately. A gateway payment needs no counter approval — the signature is the confirmation.
  Result: _____  Notes: ______________________________________________

- [ ] Switch to "Manual UPI" → QR renders (once a UPI ID is set per Module 8) with the amount encoded; changing the amount live-updates the QR.
  Result: _____  Notes: ______________________________________________

- [ ] Submit Manual UPI with no Transaction Reference ID → blocked.
  Result: _____  Notes: ______________________________________________

- [x] Submit Manual UPI with a reference ID → the alert says **"Submitted for verification"** and states the money is *not yet* in your balance. **The balance figure does not move.** A yellow "₹X awaiting the store's confirmation" note appears under it, and the History row reads **AWAITING APPROVAL**, struck through. *Verified 2026-08-08 by live run: submitted ₹50,000 against a customer whose balance was ₹11,000 → balance stayed ₹11,000, `pendingTotal` 50,000.* (Phase 20.2 — this used to post instant real credit on an unverified reference.)
  Result: _____  Notes: ______________________________________________

- [x] Submit the **same reference ID a second time** (also try it with different capitalisation and surrounding spaces) → refused: "That transaction reference has already been submitted." *Verified 2026-08-08: both the exact repeat and a ` utr-test-9001 ` case/space variant returned 409 `DUPLICATE_REFERENCE`.*
  Result: _____  Notes: ______________________________________________

- [ ] While that deposit is pending, check the **Gold Appreciation** panel on Profile → "Total Grams Locked" does **not** include the pending amount. That panel and the balance above it must describe the same money.
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** History tab lists your deposits with date, ref ID, type, amount — and **only** yours.
  Result: _____  Notes: ______________________________________________

- [ ] **Gold Appreciation Calculator:** note "Current Day Worth" on the Profile tab. In `backend/data/advances.json`, lower `lockedGoldRate22K` on one of this customer's deposits, save, reload → "Current Day Worth" and "Appreciation" recompute against your edited locked rate.
  Result: _____  Notes: ______________________________________________

### 12c-i. Returns, as the customer sees them *(added 2026-08-11)*

*The store issues refunds; the customer only ever sees them. Do this on a phone, or with the
browser at 390px — a refund the customer cannot find is a refund they telephone the shop about.*

- [ ] **[e2e automated]** After the store files a **cash** refund for this customer (§3b), open **History** → a row reading `RETURN — CASH REFUND (<invoice number>)` for the refund amount, and the **balance is unchanged**. Cash was handed over the counter; it is not credit.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** After a **gold** refund, History shows `RETURN CREDIT (<invoice number>)` — named against the invoice, so it does not read as a deposit the customer knows they never made — and the balance has gone **up** by the refund. It must appear **once**, not twice.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** With a gold refund on the account, the **Gold Appreciation** panel counts its grams (not 0.000 g). A refund credit is gold-backed like any other deposit.
  Result: _____  Notes: ______________________________________________

- [ ] There is **no** button, form, or link anywhere in the portal for raising or cancelling a return. Returns are the store's to issue.
  Result: _____  Notes: ______________________________________________

### 12d. Account, session, and password reset

- [ ] **[auto]** Account tab shows your name and email; edit and Save → success, and the greeting on Profile updates.
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** Reload the browser tab → you stay signed in. Restart the server, reload again → **still** signed in (customer sessions are persisted; admin sessions deliberately are not).
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** Click Logout → back to Sign In; reload → does **not** sign you back in.
  Result: _____  Notes: ______________________________________________

- [ ] Change your password from the Account tab → you are signed out of every device and must sign in again with the new one.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** With SMTP unconfigured (Module 9), click "Forgot password?" → the reset **pane opens** (it must not fire an alert and bounce you back to Sign In — that dead-end was the whole reason customers had to come to the counter). Inside it, an amber notice explains reset emails are not switched on and the **SEND RESET CODE** button is disabled.
  Result: _____  Notes: ______________________________________________

- [ ] **[unit automated]** With SMTP configured (Module 9) and an email saved on the account, request a reset → a 10-character code arrives by email; entering it sets a new password, and entering it a second time is refused. Also confirm the code never appears in `backend/data/customer_auth.json` — only its hash.
  Result: _____  Notes: ______________________________________________

- [ ] **Request a reset for a number with no account, and for an account with no email.** Both must return the *same* wording as a successful send — the portal must never reveal which mobile numbers are customers. Expand **"No code arrived?"** on the next screen: it names both possibilities and what to do about each.
  Result: _____  Notes: ______________________________________________

- [ ] **[unit automated]** Lock yourself out (5 wrong passwords), then complete a reset → the new password signs you in immediately. A lockout must not also block the way out of it.
  Result: _____  Notes: ______________________________________________

### 12d-i. Getting an email onto an account that has none *(added 2026-08-09)*

*Every gate below exists so that a forgotten password never needs a trip to the store.*

- [ ] **[e2e automated]** On **Create account**, fill everything except Email and submit → refused with "Please enter a valid email address — it is how you reset your own password later." Add a valid address → the account is created and carries it.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Issue a login at the counter (§13) **without** an email. The green handover panel must carry an amber warning that the account has no email and that "Forgot password" has nowhere to send a code.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Sign in as that counter-issued customer and set a password. On the **Profile** tab an amber **"Add your email address"** prompt is visible. Click **ADD MY EMAIL** → it switches to the Account tab with the email field focused. Save an address → the prompt disappears without a reload, and the address is in `backend/data/customer_auth.json`.
  Result: _____  Notes: ______________________________________________

### 12e. Two windows, two customers (the isolation check)

- [ ] Sign in as customer A in one browser profile and customer B in another (or one normal + one incognito window). Confirm each sees only their own balance and history, and that neither can reach the other's by editing anything on screen.
  Result: _____  Notes: ______________________________________________

---

## 13. Customer Logins tab (admin) — Phase 20.2

The store-side screen for portal logins. Before 20.2 these endpoints existed but had no UI at all.

- [x] Sidebar shows a **Customer Logins** tab between Customer Advances and Settings; opening it lists every account with name, email, state, active device count and creation date. *Verified 2026-08-08: `GET /api/customer-accounts` returns exactly the fields the table renders.*
  Result: _____  Notes: ______________________________________________

- [ ] With no accounts yet → the table shows "No customer has a portal login yet", not an empty grid.
  Result: _____  Notes: ______________________________________________

- [x] **Issue Login** for a number that already has deposit history → succeeds and shows a one-time temporary password **in the page** (not an alert you can dismiss and lose). The account's state reads **Temp password**. *Verified 2026-08-08 for a legacy customer carrying ₹11,000 of pre-existing deposits.*
  Result: _____  Notes: ______________________________________________

- [x] Sign in to the portal with that temporary password → you are forced to set your own password before any data loads; API calls before the change return `PASSWORD_CHANGE_REQUIRED`. *Verified 2026-08-08: a deposit attempt on a temp-password session was refused.*
  Result: _____  Notes: ______________________________________________

- [ ] **Reset password** on an existing account → confirmation prompt warns it signs the customer out of every device; after confirming, a new temporary password is shown and that customer's other session stops working.
  Result: _____  Notes: ______________________________________________

- [ ] Issue a login for a number that already has one **without** using the Reset button → you are asked to confirm, then it behaves as a reset. (This is the `CONFIRMATION_REQUIRED` round-trip.)
  Result: _____  Notes: ______________________________________________

- [ ] Set a customer's name to something containing `<script>` from the portal's Account tab, then reload this tab → renders as literal text, not executed.
  Result: _____  Notes: ______________________________________________

---

## 14. Pending deposit approvals (admin Advances tab) — Phase 20.2

- [x] After a customer submits a Manual UPI deposit, the **Advances** tab shows a yellow "N deposits awaiting verification" block above the ledger, with the amount, customer, reference and how long it has been waiting. *Verified 2026-08-08 via `GET /api/advances/pending`.*
  Result: _____  Notes: ______________________________________________

- [x] The customer's row in the ledger below shows the **spendable** balance, with "+₹X pending" beneath it — the pending amount is *not* added into the balance. Same on the Dashboard: "Outstanding Advances" excludes pending, and a separate line reports what is awaiting approval. *Verified 2026-08-08.*
  Result: _____  Notes: ______________________________________________

- [x] **Approve** → confirmation prompt names the amount and reference; after confirming, the money lands in the customer's balance and the queue block disappears. *Verified 2026-08-08: ₹11,000 → ₹61,000 on approving ₹50,000.*
  Result: _____  Notes: ______________________________________________

- [x] Approving the **same deposit twice** (e.g. two tabs open) → the second attempt is refused with "already approved and cannot be reviewed again", not a double credit. *Verified 2026-08-08: 409.*
  Result: _____  Notes: ______________________________________________

- [x] **Reject** with no reason typed → refused; the reason is required. With a reason → the row reads REJECTED with the reason shown, and the balance does **not** change. *Verified 2026-08-08: 400 without a note; balance unchanged at ₹61,400 after rejecting ₹7,777.*
  Result: _____  Notes: ______________________________________________

- [ ] Open a customer's ledger drill-down → pending and rejected rows are greyed with struck-through amounts, so scanning the list cannot leave the impression an unverified claim is money on hand.
  Result: _____  Notes: ______________________________________________

- [ ] **The redemption check that matters:** with a pending deposit outstanding and no approved balance, go to Billing Desk, look up that customer and try to apply their advance → nothing is applied (the pending money is not available to redeem).
  Result: _____  Notes: ______________________________________________

---

## 15. Payment amount binding (Phase 20.2)

These need a REST client (or the browser console) because the point is what happens when the
*client lies* — you cannot express that through the normal UI.

- [x] Create an order for ₹100 via `POST /api/payment/order`, then call `POST /api/payment/verify` for it with `amount: 500000` in the body → **₹100 is credited, not ₹500,000.** The amount now comes from the stored order record, never the body. *Verified 2026-08-08 with the mock keys: response reported `amount: 100`.*
  Result: _____  Notes: ______________________________________________

- [x] Sign in as a second customer and try to verify the first customer's order id → **403**, "This payment order does not belong to your account." *Verified 2026-08-08.*
  Result: _____  Notes: ______________________________________________

- [x] Verify a made-up order id → **400**, "This payment order is not recognised", quoting the payment id to take to the store. *Verified 2026-08-08.*
  Result: _____  Notes: ______________________________________________

- [x] Send the same successful verify request twice → second returns `duplicate: true` with the original ledger row id and no second credit. *Verified 2026-08-08.*
  Result: _____  Notes: ______________________________________________

- [ ] Check `backend/data/payment_orders.json` → each order carries the customer's phone and the amount it was created for, and settles to `status: "paid"` with the payment and deposit ids after verification.
  Result: _____  Notes: ______________________________________________

---

## 16. Cross-cutting / edge cases

- [ ] Open `http://localhost:5000/api/settings` directly in browser (no auth header) → should be rejected (401), confirming admin-gated endpoints aren't accessible unauthenticated.
  Result: _____  Notes: ______________________________________________

- [ ] Open `http://localhost:5000/api/advances/lookup?phone=<a real customer number>` directly in the browser → **401**, not that customer's ledger. Same for `http://localhost:5000/api/customer/advances`. Before Phase 20.1 the first of these returned real customer data to anyone who asked.
  Result: _____  Notes: ______________________________________________

- [ ] While logged into the admin terminal, wait past a server restart (restart the server, don't refresh the tab), then click any admin action (e.g. Dashboard refresh) → bounces you back to the lock screen (session invalidated) rather than erroring silently.
  Result: _____  Notes: ______________________________________________

- [ ] Enter a customer name containing `<script>` or `"` characters in Billing Desk or the Advances deposit form → check it renders as literal text (escaped) in Dashboard/Advances lists, not executed — confirms the stored-XSS escaping holds.
  Result: _____  Notes: ______________________________________________

---

## 17. Razorpay webhook & capture confirmation (2026-08-09)

The signature, idempotency, amount-mismatch and unknown-order paths are all
covered by `npm run test:http`. What automation **cannot** prove is that a real
Razorpay account, a real public URL and a real card all line up — that is what
this section is for, and it needs a Razorpay **test-mode** account plus a
tunnel (ngrok/Cloudflare) or a deployed instance.

- [ ] In the Razorpay dashboard, add a webhook for `payment.captured` and `payment.failed` pointing at `<public URL>/api/payment/webhook`, and paste the generated secret into Settings → Payments. Use Razorpay's "Test webhook" button → the delivery shows **200** in their log, and `backend/data/payment_events.json` gains a row.
  Result: _____  Notes: ______________________________________________

- [ ] With the secret **removed** from Settings, fire the test webhook again → Razorpay logs a **503** and no ledger row appears. (Fails closed: a callback that cannot be verified must never credit.)
  Result: _____  Notes: ______________________________________________

- [ ] Make a real test-mode payment from the customer portal and let it complete normally → balance updates once. Check `payment_orders.json`: the order is `status: "paid"` with an `amountPaise` matching what was charged, and `advances.json` has exactly **one** deposit for that `razorpay_payment_id` even though both the browser and the webhook reported it.
  Result: _____  Notes: ______________________________________________

- [ ] **The tab-close case — this is the whole point of the webhook.** Start a test payment, complete it in the Razorpay window, then close the tab *before* it returns to the portal. Sign back in → the deposit is there anyway, credited by the webhook. Before this change that money was taken and never recorded.
  Result: _____  Notes: ______________________________________________

- [ ] Use a Razorpay test card that **fails** → no ledger row, and the order shows `status: "failed"`.
  Result: _____  Notes: ______________________________________________

- [ ] Temporarily point `razorpayKeySecret` at a wrong-but-well-formed value so the capture lookup fails, then pay → the portal says the payment could not be confirmed *and was not credited* (503, `pending: true`), rather than either crediting or claiming failure.
  Result: _____  Notes: ______________________________________________

---

## 18. Production startup guard (2026-08-09)

Every condition is asserted by `npm run test:guard`, including a real process
exiting 1. Confirm here only that it behaves sanely on a real machine.

- [ ] Start the server with `NODE_ENV=production` against a stock demo `settings.json` → it prints a numbered list of blockers under "REFUSING TO START IN PRODUCTION" and exits; nothing is listening on :5000.
  PowerShell: `$env:NODE_ENV="production"; node backend/server.js`
  Result: _____  Notes: ______________________________________________

- [ ] Fix every listed item (real Razorpay keys, a webhook secret, an `https://` public URL, a non-`1234` PIN, provider `public`) and start again → it boots normally.
  Result: _____  Notes: ______________________________________________

- [ ] Start **without** `NODE_ENV=production` on the same demo settings → boots normally, mock checkout still works. (The guard must not make local development harder, or it will be worked around.)
  Result: _____  Notes: ______________________________________________

---

## 19. Seeded data (2026-08-09)

- [ ] `cd backend && npm run seed` → writes to `backend/data-seed/` and prints the admin PIN plus four customer logins. Run it a second time → the files are byte-identical (`git status` stays clean if you point it somewhere tracked).
  Result: _____  Notes: ______________________________________________

- [ ] `npm run seed -- --out backend/data` → **refuses**, naming the live database. (The one destructive thing this script could do.)
  Result: _____  Notes: ______________________________________________

- [ ] Start the server against the seeded database and click through it: the dashboard shows six invoices across 2026 and 2027, the Advances tab shows one pending claim awaiting approval and one rejected claim holding no balance, and the four seeded logins all work at `/customer.html`.
  PowerShell: `$env:GOLD_POS_DATA_DIR="<abs path>\backend\data-seed"; node backend/server.js`
  Result: _____  Notes: ______________________________________________

---

## 20. Staff & Roles, multi-line invoices, tenders, per-line returns *(added 2026-08-12)*

The automated suites cover the arithmetic and the API. These are the things only a
person clicking through can confirm.

### 20a. Named staff

- [ ] **Settings → Staff & Roles** with an empty roster → the table says so, and the master PIN
  from Settings → Billing & Invoice still unlocks the terminal. The sidebar reads
  `Signed in: Store Owner (owner)`.
  Result: _____  Notes: ______________________________________________

- [ ] Add two people — one **Cashier** with PIN `432198`, one **Manager** with PIN `876543` (operator
  PINs need 6-8 digits since 2026-08-24; a 4-digit entry is refused with "must be 6 to 8 digits") —
  and Save. The PIN boxes go blank and their placeholders change to `unchanged`; the two names
  persist on a page reload.
  Result: _____  Notes: ______________________________________________

- [ ] Save again **without retyping either PIN** → both still work at the lock screen. (This is the
  write-only round-trip: a save that masked the PINs must not blank them.)
  Result: _____  Notes: ______________________________________________

- [ ] Give both people the **same PIN** and Save → refused, with a message naming both. Give one the
  **master PIN** → refused. Leave a new person's PIN **blank** → refused, naming them.
  Result: _____  Notes: ______________________________________________

- [ ] Log out, sign in with `432198` → sidebar reads `Signed in: <name> (cashier)`. Bill a sale, then
  open **Reprint Invoice** and find it → the control strip above the sheet says `billed by <name>
  (cashier)`. Print it → that line does **not** appear on the paper.
  Result: _____  Notes: ______________________________________________

- [ ] Still signed in as the cashier, open **Customer Advances** with a pending claim in the queue →
  the Approve/Reject buttons are absent and a note says an Owner or Manager is needed. Sign in as
  the manager → the buttons are there, approving works, and the drill-down row for that deposit
  shows the manager's note.
  Result: _____  Notes: ______________________________________________

- [ ] Untick **Active** on the cashier and Save → their PIN no longer unlocks the terminal, but the
  invoice they filed earlier still shows their name in the Reprint Desk.
  Result: _____  Notes: ______________________________________________

### 20b. A multi-item invoice

- [ ] Billing Desk: enter 22K / 10 g / 8% making, type `Bangles` in the item box, press
  **+ Add Item to Invoice** → the row appears in the cart table and the weight box clears.
  The invoice preview on the right shows one row.
  Result: _____  Notes: ______________________________________________

- [ ] Add a second item: 18K / 5 g / 10% making, `Chain`. Do **not** press Add — leave it in the
  form. The preview now shows **two** rows, each at its own rate.
  Result: _____  Notes: ______________________________________________

- [ ] **Add up the printed rows by hand.** Metal Value + Making Charges − Discount must equal the
  Taxable Value, and Taxable + GST must equal the Grand Total, to the paise. Then switch Settings →
  Billing & Invoice to **Inclusive** and do it again — the rows are restated `(net of GST)` and must
  still add up.
  Result: _____  Notes: ______________________________________________

- [ ] Press **Save Invoice**, then reprint it → the duplicate shows **both** rows, each with its own
  purity, weight and rate. The Reprint Desk's Goods column reads `2 items · 22K, 18K · 15.000g`.
  Result: _____  Notes: ______________________________________________

- [ ] Remove a cart line with **Remove** → the totals and the preview both drop it immediately.
  Result: _____  Notes: ______________________________________________

- [ ] File a **single-item** sale exactly as before (type a weight, press Save, no Add Item) → it
  works with no extra clicks, and the invoice shows its purity rather than `MIXED`.
  Result: _____  Notes: ______________________________________________

### 20c. How the bill was paid

- [ ] With a bill on screen, the **Payment** section shows one Cash row whose amount tracks the
  total as you type a weight, and the note reads `Payment matches the total.`
  Result: _____  Notes: ______________________________________________

- [ ] Press **+ Split payment** → a Card row appears pre-filled with the unallocated remainder.
  Change the cash amount to less than the bill → the note turns amber and names what is still to
  allocate. Try to Save → refused at the counter, naming the figure.
  Result: _____  Notes: ______________________________________________

- [ ] Fix the split so it adds up, add a reference on the card row, Save, then reprint → the control
  strip reads `paid cash ₹… + card ₹…`.
  Result: _____  Notes: ______________________________________________

- [ ] Bill a customer whose advance covers the **whole** bill → the total is ₹0 and no tender is
  recorded (nothing was handed over the counter).
  Result: _____  Notes: ______________________________________________

### 20d. Returning one item of several

- [ ] Returns & Refunds → search the two-item invoice → the form shows a **Which item is being
  returned** dropdown listing both, each with its returnable weight.
  Result: _____  Notes: ______________________________________________

- [ ] Pick item 2 → the weight box resets to that item's returnable weight and its max label
  follows. The refund preview quotes **item 2's** purity and rate, not item 1's.
  Result: _____  Notes: ______________________________________________

- [ ] File it in full → the note says it closes that item and that other items remain returnable.
  Search the invoice again → item 2 is listed as `(fully returned)` and disabled; item 1 is still
  selectable.
  Result: _____  Notes: ______________________________________________

- [ ] Return item 1 in full too → the note says it closes the invoice, and **the two refunds added
  together equal exactly what the invoice charged.**
  Result: _____  Notes: ______________________________________________

- [ ] Do the same on a **single-item** invoice → no dropdown appears, and the wording is exactly as
  it was before (`… would remain returnable afterwards`, no "item 1").
  Result: _____  Notes: ______________________________________________

### 20e. Screens no longer download the whole ledger

- [ ] Open DevTools → Network, then open the **Dashboard** → the `/api/sales` calls carry
  `limit=` and `from=`/`to=`, and no response contains the full history. The Today and This Month
  revenue tiles are still correct (cross-check against the Reprint Desk search for that range).
  Result: _____  Notes: ______________________________________________

- [ ] **Customer Advances** → the balances are correct, and typing in the search box issues a
  request rather than filtering locally. Open a customer's drill-down → their rows are fetched at
  that moment.
  Result: _____  Notes: ______________________________________________

- [ ] **Returns & Refunds** → the recent-credit-notes list appears, and if there are more than 25 a
  line beneath says so.
  Result: _____  Notes: ______________________________________________

- [ ] Approve a pending deposit → the Advances tab **and** the Dashboard's outstanding-advances tile
  both move.
  Result: _____  Notes: ______________________________________________

---

## 21. Hashed PINs, session revocation, two-factor, refund limits *(added 2026-08-13)*

### 21a. The PIN upgrade is invisible to the user

- [ ] Before starting the server, open `backend/data/settings.json` and note the `adminPin` value.
  Start the server, then look again: `adminPin` is **gone**, replaced by `adminPinHash` and
  `authSalt`. **The old PIN still unlocks the terminal.** (This is the upgrade path every existing
  install takes; nobody retypes anything.)
  Result: _____  Notes: ______________________________________________

- [ ] Search that file for any operator's PIN as plain digits → not found. (A 4-digit sequence may
  appear by chance inside a hex hash; check it is inside a `pinHash` value, not a `pin` key.)
  Result: _____  Notes: ______________________________________________

- [ ] Restart the server twice more → `settings.json` does not change on either boot. (The migration
  is idempotent; a boot loop must not rehash a hash.)
  Result: _____  Notes: ______________________________________________

- [ ] DevTools → Network → open Settings → the `/api/settings` response contains **no** `scrypt$`
  string, no `authSalt`, and each operator shows `pinConfigured: true` with `pin: null`.
  Result: _____  Notes: ______________________________________________

### 21b. Sessions end when access should

- [ ] Sign in as a cashier in one browser. In another (as the owner), change that cashier's PIN and
  Save → the save reports how many sign-ins were ended. Back in the first browser, click any tab →
  it drops to the lock screen. The old PIN no longer works; the new one does.
  Result: _____  Notes: ______________________________________________

- [ ] Repeat, but **untick Active** instead of changing the PIN → same result, and their PIN is now
  refused at the lock screen entirely.
  Result: _____  Notes: ______________________________________________

- [ ] Repeat, but change their **role** from Cashier to Manager → their session also ends. (A demoted
  manager's open session must not keep its approving role for the rest of the day.)
  Result: _____  Notes: ______________________________________________

- [ ] Change **your own** PIN as the owner → you stay signed in. (Otherwise nobody would use this.)
  Result: _____  Notes: ______________________________________________

- [ ] Settings → Staff & Roles → **Who is signed in right now** lists every live sign-in, marks your
  own "(this browser)", shows whether each passed two-factor, and offers **Sign out** on the others
  but not on yours. Ending one drops that browser to the lock screen on its next action.
  Result: _____  Notes: ______________________________________________

- [ ] Sign in as a Cashier and open Settings → the session table says only an Owner or Manager can
  see it.
  Result: _____  Notes: ______________________________________________

### 21c. Two-factor for the people who release money

- [ ] Staff & Roles → **Set up** in a manager's Two-factor column → a QR appears with a typed key
  beside it. Scan it with any authenticator app (Google Authenticator, Authy, …). **This is the check
  that matters most — a real app must accept it.**
  Result: _____  Notes: ______________________________________________

- [ ] Enter a **wrong** code → refused, and nothing is saved (the column still says "Set up").
  Then enter the real code → enabled, and **ten recovery codes are shown once**. Print or copy them.
  Result: _____  Notes: ______________________________________________

- [ ] Reload Settings → the codes are **not** shown again, and the column reports "10 recovery codes
  left".
  Result: _____  Notes: ______________________________________________

- [ ] Log out. Enter that manager's PIN alone → the screen asks for a 6-digit code and **keeps the
  PIN you typed**. Enter the code from the app → signed in.
  Result: _____  Notes: ______________________________________________

- [ ] Log out, enter the PIN, then click **"Lost your phone? Use a recovery code"** and use one →
  signed in, and Settings now says 9 left. Try the *same* code again → refused.
  Result: _____  Notes: ______________________________________________

- [ ] Set **Require two-factor to release money** to Yes and Save. Sign in with the **master PIN**
  and try to approve a pending deposit → refused, with a message explaining the shared PIN cannot
  carry a second factor. Sign in as the enrolled manager with a code → approval works.
  Result: _____  Notes: ______________________________________________

- [ ] With nobody enrolled, try to set that switch to Yes → refused in the browser, before saving.
  (Otherwise a store locks itself out of its own approvals.)
  Result: _____  Notes: ______________________________________________

- [ ] Turn two-factor off for someone → you are asked for **your own** PIN first, and their sessions
  end.
  Result: _____  Notes: ______________________________________________

### 21d. A limit on refunds

- [ ] Settings → Staff & Roles → set **Refund needing an Owner/Manager** to ₹5,000 and Save.
  Result: _____  Notes: ______________________________________________

- [ ] As a **Cashier**, file a return worth more than ₹5,000 → refused, naming the amount, the
  store's limit and the cashier's role. Check the Returns list: **nothing was filed**.
  Result: _____  Notes: ______________________________________________

- [ ] The same return as the Owner or a Manager → filed normally, with their name on the credit note.
  Result: _____  Notes: ______________________________________________

- [ ] As the Cashier, file a return worth **less** than ₹5,000 → allowed, with their name on it.
  Result: _____  Notes: ______________________________________________

- [ ] Set the limit back to 0 → a cashier can refund any amount again (the original behaviour).
  Result: _____  Notes: ______________________________________________

---

## 22. Billing-linked inventory, exchanges/voids, off-site backup and management reports *(added 2026-08-24)*

### 22a. SKU to invoice to stock

- [ ] Inventory → create an active item with a unique SKU/barcode, purity and nominal net weight;
  open a costed lot. In Billing, scan/type the SKU → name, purity and weight fill automatically and
  the exact positive-stock lot is selectable.
  Result: _____  Notes: ______________________________________________

- [ ] File the sale → the invoice line retains the item/lot link and the lot drops by exactly the
  billed weight. Try to file more than the remaining lot → 409/refused, with no invoice number or
  stock movement consumed.
  Result: _____  Notes: ______________________________________________

### 22b. Return exchange and void/cancel

- [ ] Return part of that linked line using **Exchange credit** → the credit note says EXCHANGE
  CREDIT, the exact source lot increases by the returned weight, and Billing opens for the same
  customer with the exchange-credit banner. Apply Advance and file the replacement → the exchange
  note links once to that invoice; attempting to reuse it is refused.
  Result: _____  Notes: ______________________________________________

- [ ] File a fresh linked sale and use Reprint → Void with an Owner/Manager and a meaningful reason
  on the same business date → invoice remains visible as cancelled, stock is restored by a new void
  movement and any redeemed advance is restored by a reversal. A prior-day or partly returned sale
  must refuse void and direct staff to the return flow.
  Result: _____  Notes: ______________________________________________

### 22c. Off-site destination

- [ ] Settings → Backup & Email → enable off-site copy and choose a mounted/synchronised directory
  outside both the live data and local backup trees. Create Backup Now → local backup succeeds, the
  off-site status says verified, and the destination contains the dated folder plus `manifest.json`
  with a SHA-256 entry for every copied file.
  Result: _____  Notes: ______________________________________________

- [ ] Temporarily make the destination unavailable → local backup still reports its own success,
  off-site status explicitly fails, and `BACKUP_OFFSITE_FAILED` reaches the configured alert path.
  Restore the destination and run again. Confirm retention removes only matching old `backup_*`
  folders in that destination.
  Result: _____  Notes: ______________________________________________

### 22d. Management report definitions

- [ ] Management Reports → Settlement for a known period → active counter tenders, tenders retained
  on voids, refunds/credits and net settlement agree with filed documents; advance tender is not
  counted as new counter cash.
  Result: _____  Notes: ______________________________________________

- [ ] Reconciliation → a correctly tendered invoice (including one partly paid by advance) is clean;
  a tender mismatch, tender on a void or paid gateway order without an equal posted advance credit
  appears as an exception.
  Result: _____  Notes: ______________________________________________

- [ ] Profitability → a costed linked lot shows remaining net-of-GST revenue after returns less lot
  cost; a manual/uncosted line is labeled uncosted and lowers cost coverage instead of inventing a
  margin. Ageing → only positive on-hand lots appear in the correct opening-date bucket, with cost
  value only for costed lots.
  Result: _____  Notes: ______________________________________________

---

## Notes / issues found (free space)

_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________

---

## 23. POS 360° remediation and pilot-readiness *(added 2026-09-02)*

This section is the executable checklist for the findings in
[`POS_360_AUDIT_PLAN_2026-09-02.md`](POS_360_AUDIT_PLAN_2026-09-02.md).
Code-side checks may be completed by automated tests; legal, merchant, payment,
deployment and hardware checks must be evidenced by the named real-world owner.
For the owner-readable order of work and the current launch decision, start with
[`GO_LIVE_RUNBOOK.md`](GO_LIVE_RUNBOOK.md); this section remains the detailed
evidence record and does not become complete merely because a meeting occurred.

### 23a. Lightweight performance and resilience

- [x] Replace synchronous request telemetry/black-box disk writes with a bounded,
  observable batch writer; financial SQL commits and durable audit facts must remain
  synchronous. Verify the queue is bounded, flushes on graceful shutdown, reports
  drops/failures and cannot make a successful sale appear unsuccessful.
  Result: Automated log-writer + full backend HTTP suite green (2026-09-03).
  Notes: Queue/flush/drop/failure metrics appear in owner diagnostics. ______

- [x] Add log rotation/retention and a disk-budget alert. Verify a full or unwritable
  log destination produces an actionable warning without corrupting or blocking the ledger.
  Result: Log rotation/retention already existed (`logWriter.js`, `test_log_rotation.js`).
  The disk-budget alert existed for the data volume (`checkDiskCapacity`) but the log
  writer's own failure/rotation/drop counters (`getLogWriterStats()`) never reached the
  one alert choke point — a full or unwritable log destination only ever reached a
  console nobody watches. Added `checkLogWriterHealth()` (`alerting.js`), wired into the
  5-min cron tick alongside the error-rate check, raising `LOG_WRITE_FAILING` (critical),
  `LOG_ROTATION_FAILING` and `LOG_QUEUE_OVERFLOW` (warning) on the delta since the last
  tick — never re-alerting on an already-counted, already-fixed failure.
  Notes: `test_alerting.js` §7 (3 new checks, 19/19 green). 2026-09-16.

- [x] Cache the server version at boot and apply explicit static-asset caching:
  revalidated HTML and release-versioned JS/CSS/assets. Verify a new release does not
  serve stale code and a repeat visit avoids redundant asset downloads.
  Result: Was already implemented (`ASSET_VERSION`, `versionedHtml()` in server.js) but
  had no automated regression test — added one (`test_http.js`, 137/137 green). Building
  it surfaced a real, previously-unnoticed bug: the `<script type="module">` entry tag
  was ALSO being stamped `?v=...`, while every component imports shared helpers back from
  that same file via a bare, unversioned `'../app.js'` specifier. Two different URLs for
  one ES module means the browser fetched and executed `app.js` TWICE per page load,
  silently double-registering every component and double-firing every click handler
  system-wide — found via a new Playwright spec that finally clicked Billing Desk's
  "Add Item" button (nothing had before) and got a false "Enter a weight" alert on a
  successful add. Fixed by excluding `<script type="module">` entry tags from the
  version stamp (`server.js`'s `versionedHtml()`) — they stay `no-cache`/always-revalidated,
  exactly as an unversioned asset already did, which also fixed an unrelated-looking
  pre-existing failure in the management-reports e2e journey (same root cause).
  Notes: `test_http.js` (1 new check, locks in the module-entry invariant too) +
  `tests/e2e/inventory-billing-operations.spec.js` both green; full `npx playwright test`
  (46/46) green. 2026-09-16.

- [x] Customer and SKU lookup requests are latest-result-wins: type one valid phone/SKU,
  change it before the first response returns, and confirm stale data can never populate
  the new customer/item. Verify a failed/aborted lookup leaves the current cart intact.
  Result: Already correctly implemented for both (token + `AbortController` pattern in
  `BillingDesk.js`'s `lookupCustomerAdvance`/`lookupSku`). The customer-phone race already
  had an e2e regression test; the SKU race did not — added
  `tests/e2e/inventory-billing-operations.spec.js`: "a slow SKU lookup cannot overwrite a
  faster one, and leaves the existing cart untouched", which also asserts a cart line
  added before the race is untouched by it.
  Notes: `npx playwright test` (46/46) green. 2026-09-16.

- [ ] Run the dependency-free benchmark against a seeded tenant on the target VPS:
  1,000 invoices, 50,000 advances and expected concurrent tills. Record p50/p95/p99 for
  input feedback, lookup, save, tab load, memory and disk. Compare with the targets in
  the 360° audit before accepting a pilot.
  Result: _____  Notes: ______________________________________________

### 23b. Legal, payments and operating evidence — external launch gates

- [ ] CA approves the final tax-invoice and credit-note template for this merchant,
  including GST/HSN/place-of-supply/recipient facts where applicable. A printed sample
  is attached to the merchant launch record.
  Owner: CA  Result: _____  Notes: ___________________________________

- [ ] BIS/jeweller review approves hallmarked-article invoice content and the consumer
  verification statement. Test the actual printed invoice for description, net weight,
  carat/fineness and hallmarking-charge presentation.
  Owner: Merchant/BIS adviser  Result: _____  Notes: __________________

- [ ] Old-gold exchange and gold-savings schemes remain disabled until a CA/lawyer signs
  their purchase/exchange/scheme terms, GST/RCM treatment, reversal/refund policy and
  customer-facing documents. Do not substitute a settings toggle for this evidence.
  Owner: Merchant + counsel  Result: _____  Notes: ____________________

- [ ] Prove Razorpay in a sandbox against the merchant account: immediate success,
  abandoned checkout, signature failure, duplicate webhook, late/out-of-order webhook,
  amount mismatch and settlement reconciliation. Capture dashboard evidence.
  Owner: Merchant/onboarding engineer  Result: _____  Notes: __________

- [ ] DPDP/privacy review maps every customer field, consent purpose, retention/deletion,
  export, grievance contact, processor access and breach response. Publish the approved
  customer notice before enabling public sign-up or the mobile app.
  Owner: Privacy counsel  Result: _____  Notes: _______________________

### 23c. Counter and recovery acceptance

- [ ] Certify the exact browser, workstation, scanner, weighing scale, thermal printer,
  label printer and cash drawer used at the pilot. Test scanner Enter behavior, printer
  paper-out/retry, 125% zoom, touchscreen, slow device and power/network loss.
  Owner: Store manager  Result: _____  Notes: _________________________

- [ ] Run a full shop-day reconciliation: physical cash, card/UPI settlement, sales
  register, returns/credit notes, advances, stock movement and bank settlement all agree.
  Owner: Owner/manager  Result: _____  Notes: _________________________

- [ ] Restore the latest encrypted backup onto a different host, verify the audit chain
  and ledger totals, then rehearse a documented rollback. Record restore time and the
  people who hold the recovery key.
  Owner: Onboarding engineer + owner  Result: _____  Notes: ___________

- [ ] Train cashier and manager using the role cards: sale, split tender, advance,
  return, manager approval, rate-stale/outage behavior, printer failure and day close.
  Each person completes an observed practice transaction before live access.
  Owner: Store manager  Result: _____  Notes: _________________________

### 23d. Security hardening — continuous release gates *(added 2026-09-03)*

- [x] Maintain a versioned threat model covering cashier, manager, owner, customer,
  attacker on the internet, malicious insider, stolen device, compromised VPS,
  compromised dependency, payment-webhook spoofing, ransomware and accidental operator error.
  Every new route or financial workflow names its assets, trust boundary, abuse case,
  mitigation, test and owner.
  Result: `docs/THREAT_MODEL.md` baseline added 2026-09-03.
  Notes: Update it as part of every workflow/route change. _______________

- [ ] Enforce a production security baseline: HTTPS/TLS, secure cookies, CSP, CSRF,
  exact CORS allowlist, security headers, input/body limits, request IDs, error redaction,
  login/payment rate limits, named roles, session revocation and MFA for money-release roles.
  Verify the deployed response headers and failed-path bodies from outside the VPS.
  Result: _____  Notes: ______________________________________________

- [x] Add a security-focused automated suite for regression-prone boundaries:
  authorization matrix, IDOR/tenant isolation, CSRF, XSS rendering sinks, path traversal,
  oversized/malformed requests, hostile request IDs, replay/duplicate money events,
  session fixation/revocation and secret redaction. Run it in CI on every pull request.
  Result: New `backend/test_security.js`, wired into `npm test` (so it runs on every PR
  via `daily-checks.yml`'s existing `pull_request: branches: ['**']` trigger — already
  in place, no new workflow needed). Several boundaries were already covered elsewhere
  and are cited rather than duplicated (hostile request IDs, session revocation,
  replay/duplicate money events, settings/browser secret redaction — see the new file's
  header comment). New coverage: an authorization matrix (any-role / owner-or-manager /
  owner-only routes × no-session/cashier/manager/owner), CSRF rejection for both the
  admin and customer double-submit-cookie code paths (missing + mismatched token, plus a
  baseline proving the refusal is real), an over-5mb body refusal, and a check that
  planted credentials never reach error.log/telemetry.log in the clear. IDOR/tenant
  isolation and path traversal were investigated and found not applicable to custom code
  (single-tenant-per-database; no route builds a filesystem path from request input) —
  the static-file-serving traversal guard is still regression-tested as belt-and-suspenders.
  One real, unrelated XSS gap surfaced during the investigation and was fixed:
  `SettingsManager.js`'s license-status block interpolated `licenseKey`/`status`/
  `currentVersion`/`billingCycle` into `innerHTML` unescaped, inconsistent with the very
  next method's use of `escapeHtmlAttr` for the same license object — now escaped.
  Notes: `node test_security.js` (10/10) and full `npm test` (all twelve suites) green.
  2026-09-16.

- [x] Pin and continuously audit runtime dependencies, Node version, GitHub Actions,
  release signatures and deployment scripts. Produce an SBOM and review every new runtime
  dependency as an exception to the zero-dependency-growth rule.
  Result: Both service locks override transitive qs to 6.16.0; `audit:security`
  reports 0 vulnerabilities (2026-09-03). `sbom:dependencies` scripts added.
  Notes: CI/release workflow review remains an operational gate. __________

- [ ] Secure the host and secrets: non-root service account, least-privilege filesystem,
  firewall, unattended OS security updates, encrypted/off-host backups, separated vault-key
  custody, SSH MFA/rotation, incident contacts and tested credential revocation.
  Owner: Platform operator  Result: _____  Notes: _____________________

- [ ] Commission an independent penetration test and code review before accepting a paid
  merchant. Triage every high/critical finding to closure; record risk acceptance only with
  a named business owner and expiry date.
  Owner: Independent security assessor  Result: _____  Notes: _________

---

## 24. Twenty-year durability standard *(added 2026-09-04)*

This is a design and operating standard, not a claim that a browser, provider,
law, hardware platform or cryptographic algorithm will remain unchanged for two
decades. It requires the system to be understandable, recoverable and safely
replaceable as those things change.

- [x] Every backup is self-describing: immutable format version, application/Node
  version, creation time, ledger filename and migration inventory; the restore tool
  reads it when present but continues to accept legacy snapshots. Verify it is encrypted
  with the archive and that metadata matches the restored ledger.
  Result: Encrypted manifest + restore validation verified by integration Test 15
  on 2026-09-04. Notes: Clean-host recovery remains an external annual drill.

- [ ] Maintain additive data evolution only. Run migration checksum, orphan and
  destructive-DDL checks in CI; record a supported rollback/forward-only policy for every
  release. Never use a code rollback to interpret a database with newer semantics without
  a compatibility test.
  Result: _____  Notes: ______________________________________________

- [ ] Annually prove recovery independence: restore a backup onto a clean supported OS/Node
  version with only documented environment variables and the separately-held recovery key.
  Measure RTO/RPO, verify invoices/audit chain/stock, and retain the evidence outside the POS.
  Owner: Platform operator + owner  Result: _____  Notes: ____________

- [ ] Maintain a machine-readable data export specification and a tested export containing
  invoices, returns, advances, stock, operators and audit evidence. A merchant must be able
  to leave the product without a proprietary database client or an active vendor account.
  Owner: Product + finance owner  Result: _____  Notes: _______________

- [ ] Create a supported-version policy: Node LTS review, browser support window, dependency
  audit cadence, TLS/certificate/crypto review and a documented deprecation path. Time-box any
  exception with an owner, mitigation and removal date.
  Owner: Engineering owner  Result: _____  Notes: ____________________

- [ ] Keep operations boring: a one-page install/upgrade/rollback/runbook, external secrets
  inventory, named recovery-key custodians, off-host encrypted backups, spare-counter hardware
  plan and an annual disaster rehearsal with a non-engineer store owner observing.
  Owner: Platform operator + store owner  Result: _____  Notes: _______

### 24b. Whole-app future-proofing — continuous engineering gates

- [ ] Publish and enforce stable contracts for every external surface: versioned API behaviour,
  machine-readable error codes, pagination/filter bounds, authentication semantics, webhook
  idempotency and export schemas. Add rather than mutate; announce and measure any deprecation.
  Result: **Pagination/filter bounds slice closed 2026-09-17.** `parseLedgerQuery`'s
  `LEDGER_PAGE_MAX` (500) was looser than every ledger repository's own `MAX_PAGE` (200,
  `advanceRepository.js`/`invoiceRepository.js`/`creditNoteRepository.js`), so `GET
  /api/sales`, `/api/returns` and `/api/advances` echoed `limit: q.limit` up to 500 while the
  repository silently capped the actual rows fetched at 200 — a client paging with
  `offset += page.limit` would silently skip up to 300 rows. `LEDGER_PAGE_MAX` lowered to 200
  to match (no behaviour change for the two internal "fetch everything reasonable" callers,
  which the repository already capped at 200 regardless). Also exported each repository's
  `clampLimit()` and used it to fix the same class of bug in `advanceService.customerLedger/
  listLedger/listPending`, `saleService.listSales` and `returnService.listReturns`, which
  echoed the unclamped input rather than the bound actually applied. Error codes/webhook
  idempotency/export schemas were already covered (`domainCodes.js`, existing webhook-replay
  tests, `docs/API_COMPATIBILITY.md`) before this pass. **Verified:** `node test_http.js`
  (138/138, new check "an oversized limit clamps the echoed `limit`, not just the page").
  **Authentication-semantics slice closed 2026-09-17 (second pass).** CSRF rejection itself was
  already covered for both session types by `test_security.js` (added 2026-09-16), so the real
  gap was narrower than it first looked: nothing anywhere asserted the cookie ATTRIBUTE contract
  (`HttpOnly`/`SameSite`/`Secure`) `server.js`'s `cookieOpts()` documents, or that safe methods
  (GET) need no CSRF header at all. Added both as a new "Authentication semantics contract" group
  in `test_routes.js` (admin session+CSRF cookies) and one new check in `test_http.js` (customer
  session+CSRF cookies), deliberately NOT re-asserting CSRF rejection itself — that would have
  been a second implementation of a contract `test_security.js` already owns (CLAUDE.md §1).
  **Verified:** `node test_routes.js` (33/33, up from 29) and `node test_http.js` (139/139, up
  from 138), plus full `npm test` (all twelve suites), all green, exit code 0. Notes: versioned
  API behaviour, error codes, pagination/filter bounds, webhook idempotency and export schemas
  were already covered before this pass (see above and §24 above) — every bullet of this item is
  now closed except export schemas, which is a separate, unstarted, product-owned decision.

- [ ] Treat financial, stock, tax, identity and audit invariants as executable specifications.
  For every new workflow, test normal, retry, replay, concurrency, partial failure, upgrade and
  permission-denied paths against a disposable real database—not only mocked helpers.
  Result: **Concurrency coverage added for the two newest workflows, 2026-09-17.**
  `stockService.adjustLot` and `reconciliationService.openShift`/`closeShift` (built
  2026-09-16) were the only workflows in `test_concurrency.js`'s own inventory with zero race
  coverage — every other workflow (sale, return, void, advance, payment webhook) already had
  one. Added two real-child-process races: ten managers racing a -6g adjustment against a 10g
  lot (only one may land without going negative; the other nine must each see
  `STOCK_ADJUSTMENT_NEGATIVE`, not a stale-balance double-apply), and ten cashiers racing to
  open a shift for one branch (exactly one succeeds, the rest see
  `CASH_SHIFT_ALREADY_OPEN`). **Verified:** `node test_concurrency.js` (33/33, up from 31).
  **Crash-injection slice closed 2026-09-17 (second pass).** The two newest workflows were also
  the only ones in `test_concurrency.js`'s own §4b inventory with no process-kill coverage —
  every other workflow (sale, return, void, advance approval, payment credit) already dies and
  rolls back cleanly at a named point. Added three real-child-process kills, same
  `crashOnSql`/rollback-verification shape as the existing return/void/advance/payment tests: (1)
  a stock adjustment killed right before its `audit_events` insert — verified the lot balance is
  back to its pre-adjustment value, not partially applied; (2) a cash-shift open killed at the
  same point — verified no shift is left open at all; (3) a cash-shift close killed at the same
  point — verified the shift is still `open`, not left half-closed. All three crash exactly where
  `crash-void`/`crash-advance-approve-*` already do (the one `INSERT INTO audit_events` write each
  workflow makes last), so no new `crashOnSql` target was needed. **Verified:** `node
  test_concurrency.js` (36/36, up from 33), plus full `npm test` (all twelve suites), both green,
  exit code 0. Notes: upgrade paths (a pre-Phase-21 DB replaying one of these two workflows) are
  still untested for either workflow — left open, same as every other workflow in this suite.

- [ ] Keep modules replaceable: documented domain boundaries, no browser-only financial authority,
  no hidden cross-module writes, no permanent vendor lock-in, and a supported import/export path.
  New runtime dependencies require a written lifecycle, licence, vulnerability and exit review.
  Result: **Dependency review process written 2026-09-17.** New `docs/DEPENDENCY_REVIEW.md`:
  a required-fields template for any future runtime dependency (purpose, why not stdlib,
  alternatives, lifecycle signal, licence, vulnerability posture, exit plan, blast radius) plus
  a filled entry for all 9 current runtime dependencies and the one exempt devDependency.
  Incidentally found and fixed a real drift while writing it: CLAUDE.md §0 claimed
  `licensing_server/` carries 3 runtime dependencies; it has always had 2 (`dotenv`,
  `express` — verified against its `package.json` and by grepping every import in the tree).
  Corrected in both documents. Domain boundaries/import-export path/vendor lock-in were
  already covered elsewhere (the repository seam, ADR-001, `docs/API_COMPATIBILITY.md`).
  Notes: the data-export-schema gate (§24 above) is still a separate, unstarted, product-owned
  item — this only covers the dependency half of "replaceable."

- [ ] Enforce a counter performance budget on supported low-end hardware and target VPS: boot,
  login, product/customer lookup, recalculation, sale commit, print, tab switch, memory growth and
  slow/offline failure response. Regressions block release; optimise measured bottlenecks only.
  Result: _____  Notes: No low-end device or target VPS exists yet (see §23a's identical open
  item) — nothing to build here without one; left untouched 2026-09-17.

- [ ] Make the UI durable for real operators: keyboard/scanner/touch paths, readable errors,
  responsive layouts, semantic focus order, contrast/zoom, no data loss on slow requests, and
  all destructive actions reversible or explicitly confirmed and audited.
  Result: **One real gap closed 2026-09-17: stock adjustment had no confirmation.**
  Auditing every `confirm()` in `frontend/js/components/` against every destructive action
  found one workflow with none — `InventoryManager.js`'s "Adjust" lot form posted straight to
  `/api/inventory/lots/:id/adjust` with no confirmation step, unlike every other destructive
  action in the app (void, return, session revoke, staff removal, scheme default/mature, quote
  discard all already confirm). Stock adjustment is also the one destructive action with no
  undo in the UI (a mistake needs a later equal-and-opposite entry), which makes the missing
  confirmation the sharper gap of the two. Added a `confirm()` naming the item and the signed
  delta before submission. **Verified:** new Playwright test in
  `inventory-billing-operations.spec.js` — dismissing the dialog leaves the lot and its item's
  rollup weight untouched; accepting it applies the adjustment; the dialog message is asserted
  to name the item and the delta. Keyboard/scanner/touch paths, focus order and contrast/zoom
  were not audited this pass — left open.
  **Keyboard/focus and contrast slice closed 2026-09-17 (second pass).** Audited all five named
  areas. Scanner paths, touch paths and focus order in `BillingDesk.js`/`InventoryManager.js`'s
  own forms were all already sound (no debounce/keyup heuristic that could fragment a scanner
  burst, no hover-only interactions, cart/lot forms already return focus sensibly). Two real gaps
  found: (1) **keyboard** — `adminAlertOverride.js`/`customerAlertOverride.js`'s hand-rolled
  `#custom-alert-box` (the one non-native dialog in the app; every admin/customer message,
  including the outcome of a destructive action, funnels through it) never moved focus onto its
  OK button, had no Escape handler, and didn't trap Tab — a keyboard user could tab into controls
  hidden behind the overlay instead of reaching OK. This was also the **focus-order** gap: focus
  was never returned to the triggering control on close. Fixed both files identically: capture
  `document.activeElement` before opening, focus OK on open, trap Tab on the single control,
  close on Escape, restore focus to the trigger on close. (2) **contrast** — `.btn-danger:hover`
  (`app.css`) changed its background to Red 300 (`#fca5a5`) while keeping Red 700 text, dropping
  contrast to ~3.4:1 on hover, below the 4.5:1 AA floor for this non-large button text; changed to
  Red 100 (`#fee2e2`), ~5.3:1. **Verified:** new Playwright test in
  `inventory-billing-operations.spec.js` ("the notification overlay is keyboard accessible") —
  OK is focused on open, Escape dismisses, focus returns to the trigger; existing
  `customer-portal.spec.js` (24/24, desktop + 390px) and `reprint-desk`/`return-desk`/
  `cashier-billing` specs (20/20) re-run clean, confirming no regression from the shared
  `app.css`/alert-override change; full `npm test` (all twelve suites), green, exit code 0.

- [ ] Maintain an upgrade discipline: reproducible locked installs, API/data compatibility matrix,
  release notes, canary rollout, observability dashboard, rollback decision tree and a scheduled
  removal process for retired flags/code. No unreviewed production hotfixes.
  Result: _____  Notes: Not started 2026-09-17 — `package-lock.json` is already committed and
  `docs/API_COMPATIBILITY.md`/`CHANGELOG.md` already exist, but canary rollout/observability
  dashboard/rollback decision tree need real deployed infrastructure (none provisioned yet,
  see §7) and a scheduled-removal process has nothing to remove against yet: a grep for
  deprecation markers across `backend/` turned up none, and the one retired settings key
  (`goldApiKey`) predates this policy with no recorded retirement/removal date to model.

### 24c. Trusted-core implementation queue *(started 2026-09-04)*

- [x] Build a machine-checkable invariant matrix for every money/stock workflow:
  sale, tender split, advance redemption, return, exchange, void, payment webhook,
  stock adjustment and day reconciliation. Each row proves units, authorization,
  atomic writes, retry/replay handling, audit actor and historical projection.
  Result: `docs/INVARIANT_MATRIX.md`, one row per workflow, each cell verified against a cited
  source line. First built 2026-09-09, re-verified 2026-09-13 against the tests below — two real
  gaps remain and are recorded as named follow-ups, not silently closed: stock adjustment and day
  reconciliation have no owning service layer and (for stock adjustment) no domain-code refusal,
  both real design decisions, not mechanical fixes. Notes: see the matrix's "Cross-cutting
  findings" section.

- [x] Add targeted adversarial tests for configuration drift during a transaction,
  concurrent/duplicate document actions, process interruption, permission/session change,
  malformed legacy record and post-restore replay. A green happy path is insufficient.
  Result: configuration drift — `test_concurrency.js` §6 (settings/rates read exactly once per
  sale and per old-gold exchange). Concurrent/duplicate document actions —
  `test_concurrency.js` §3 (idempotent sale, duplicate advance reference, 20-way concurrent
  webhook-event-id race added 2026-09-13) and §3b (10-way races on return/void/exchange-credit).
  Process interruption — `test_concurrency.js` §4/§4b (crash injection across sale, return, void,
  advance approval, payment credit). Permission/session change — `test_http.js` "Gateway await
  gap" (customer session revoked while `/api/payment/verify` is suspended on the gateway call).
  Malformed legacy record — `test_repositories.js` §12 (corrupt JSON file, a legacy advance row
  missing its `status` field entirely). Post-restore replay — `test_suite.js` Test 15 (an
  idempotency key replayed against a freshly restored backup still dedupes). Verified by running
  each suite green, not by re-reading prior claims. Notes: `docs/INVARIANT_MATRIX.md` is the
  traceability record tying each of these back to the workflow row it closes.

- [x] Centralize and freeze domain refusal codes at service boundaries. Routes may map a
  code to HTTP/operator guidance, but no browser or route handler may invent financial,
  stock or authorization business rules independently.
  Result: `backend/domainCodes.js` now also covers sale (stock/lot/purity, advance-balance,
  exchange-credit, tender), return/credit-note, advance deposit/review, gateway-payment and
  old-gold-exchange refusals, on top of the refund/MFA, stock and void codes already there.
  Every `DomainRefusal` throw site and plain refusal return across `saleService.js`,
  `returnService.js`, `advanceService.js`, `paymentService.js` and `oldGoldService.js` now
  carries a code; routes forward it additively (`code` is a new field, `error` keeps its
  existing prose) except the pre-existing `APPROVER_REQUIRED`/`MFA_REQUIRED` shape on
  `/api/returns`, where `error` has always legitimately held the bare code and still does.
  Verified 2026-09-07: full `npm test` green (all nine suites), plus new HTTP regressions
  asserting `code` on `INVOICE_NOT_FOUND`, `RETURN_MODE_INVALID`, `RETURN_LINE_REQUIRED`,
  `SALE_TENDER_TOTAL_MISMATCH`, `SALE_TENDER_INVALID`, `EXCHANGE_CREDIT_INVALID`,
  `EXCHANGE_CUSTOMER_MISMATCH`, `OLD_GOLD_EXCHANGE_DISABLED` and the reused `APPROVER_REQUIRED`
  on the old-gold-exchange route. **Closed 2026-09-16**: `DUPLICATE_REFERENCE` and the gateway
  `PAYMENT_AMOUNT_MISMATCH`/`PAYMENT_CREDIT_PERSIST_FAILED` codes now each have a `test_http.js`
  check — the first two at the real HTTP boundary (a duplicate-reference `/api/advances` deposit;
  a signed `/api/payment/verify` checkout whose gateway-reported capture amount is deliberately
  mismatched, reusing the "Gateway await gap" fixture's `razorpayDouble`). The third,
  `PAYMENT_CREDIT_PERSIST_FAILED`, is asserted by calling `paymentService.creditCapturedPayment()`
  directly with a hand-built order rather than through HTTP: `payment_orders.customer_phone` and
  `advance_accounts.customer_phone` are both `NOT NULL`, so no order any real checkout (or this
  suite) can create ever reaches that function in a state that fails to persist — the only way to
  exercise the branch is to construct one by hand. Verified: `node test_http.js` alone, 136/136
  (up from 132).

- [x] Verify every permanent record has an owning service/repository, integer boundary
  units, server-issued identity/timestamp, actor/audit context and an immutable projection
  that survives settings/rate/operator changes.
  Result: every workflow in `docs/INVARIANT_MATRIX.md` now has an owning service. The two
  remaining gaps it named — stock adjustment and day reconciliation calling their repository
  directly from the route — were closed 2026-09-16: `backend/services/stockService.js` and
  `backend/services/reconciliationService.js` now own those workflows, and stock adjustment's
  refusals gained a `DOMAIN_CODE` (day reconciliation's audit gap was already fixed 2026-09-13).
  No new approver gate was added to either — that remains a named, open product decision, not a
  gap in this item. Verified: `node test_http.js` (132/132, two new checks) and full `npm test`
  (all eleven suites), both green, exit code 0. Notes: see `docs/INVARIANT_MATRIX.md`'s
  2026-09-16 update for the full detail.

### 24d. Counter-performance implementation queue *(started 2026-09-05)*

- [x] Provide a dependency-free, repeatable benchmark that boots the real server against an
  isolated tenant, warms it, measures serial and concurrent health/static paths, emits p50/p95/p99
  JSON evidence and never touches merchant data. It is a baseline tool—not proof of checkout,
  low-end hardware, VPS or printer performance.
  Result: `npm --prefix backend run benchmark` passed on 2026-09-05 (Node 26,
  Windows loopback): p95 16.79 ms health serial, 17.01 ms HTML serial, 17.49 ms
  app-module serial, 47.25 ms health at 25-way concurrency. `benchmark:quick`
  also passed. Notes: The seeded/VPS/browser gates below remain open. _______

- [ ] Extend the benchmark with a representative seeded merchant dataset and authenticated
  checkout/lookup/paged-ledger workload; record target-hardware and target-VPS budgets before
  treating a regression as release-blocking.
  Result: The seeded/authenticated half is done and verified 2026-09-07 — `backend/benchmark.js`
  now signs in as the tenant owner over the real `/api/admin/login` + session-cookie + CSRF path,
  files 40 customers × 5 invoices through `POST /api/sales` (10×2 in `--quick`), then measures a
  serial checkout, a 5-till concurrent checkout, `GET /api/sales/lookup` and
  `GET /api/sales?limit=` against that populated tenant — the pre-seed empty-tenant scenarios are
  unchanged and still measured first. Full and `--quick` runs both passed on this dev laptop (Node
  26, Windows loopback): checkout serial p95 35.69 ms, 5-till concurrent p95 99.91 ms, lookup p95
  34.97 ms, paged-ledger p95 33.74 ms (`API_RATE_MAX` raised for the child process so the harness's
  own request volume does not trip the abuse-prevention throttle it is not testing).
  **Return/void/mixed-concurrency closed 2026-09-24**: `backend/benchmark.js` gained serial
  return/void/stock-adjust/advance-deposit scenarios (each against its own disposable invoice or
  lot) plus a `mixedTill` scenario — several concurrent tills each running a
  sale→sale→return→void→advance-deposit cycle against the same ledger, contending for one SQLite
  writer lock the way single-endpoint scenarios never do. Full run (Node 26, Windows loopback):
  return p95 26.16 ms, void p95 28.05 ms, stock-adjust p95 23.25 ms, advance-deposit p95 31.62 ms;
  mixed-till (5 tills × 5 cycles) sustained 69.4 ops/s with per-kind p95 89.7–144.9 ms. Full detail
  and per-kind breakdown: `docs/PERFORMANCE_BENCHMARK.md`. The shared server-boot logic moved to
  new `backend/benchmarkHarness.js` so `perfTrace.js` (next item) could reuse it rather than
  duplicating it (CLAUDE.md §1). Notes: **still open** — target-hardware and target-VPS budgets
  (no such device/VPS is available to this session) and a representative production-scale tenant
  (thousands, not tens, of invoices). Leaving unchecked until those numbers exist.

- [ ] Capture a low-end-counter browser trace for keyboard/scanner input, total recalculation,
  tab transitions, print preparation and an 8-hour soak. Fix only bottlenecks the trace proves;
  preserve synchronous financial commits and audit guarantees.
  Owner: Product + engineering  Result: **PARTIAL** Notes: **Tool built and run 2026-09-24**: new
  `backend/perfTrace.js` (`npm run perf-trace`) drives a real headless Chromium tab (via
  `@playwright/test`, CLAUDE.md §0's exempt devDependency — no new dependency) through repeated
  cycles: four admin-screen tab transitions, a barcode-scan round trip, then a hand-corrected
  weight timing pure client-side recalculation and the invoice-preview re-render, plus a
  once-per-cycle Chromium JS-heap sample as a same-tab memory-growth proxy. `--minutes` controls
  soak length. Smoke run (19 cycles, ~18s, Chromium 151, Windows dev laptop): recalculation p95
  8.45 ms, preview re-render p95 16.31 ms, barcode-scan round trip p95 53.38 ms, tab transitions
  p95 117–196 ms, heap grew ~777 KB over 19 cycles (not diagnostic on its own — needs the real
  multi-hour run to separate genuine growth from GC timing noise). Full detail:
  `docs/PERFORMANCE_BENCHMARK.md`. **Still open, genuinely needs what this session does not have**:
  a real low-end counter (this ran on a dev laptop) and the actual `--minutes 480` eight-hour soak,
  which holds a browser and server process open for 8 hours and should be started deliberately by
  whoever owns that hardware, not run unattended by this session.

---

## 25. Whole-app quality audit and maturity backlog *(added 2026-09-18)*

The full third-eye assessment, scope, evidence and personas are in
[`WHOLE_APP_QUALITY_AUDIT_2026-09-18.md`](WHOLE_APP_QUALITY_AUDIT_2026-09-18.md).
This is the executable follow-up. None of these items is complete merely
because an adjacent unit or route test is green.

### 25a. Audit defect and test-system integrity

- [x] Fix **QA-001** *(closed 2026-09-24)*: `test_security.js` must await the
  production graceful shutdown/log-writer drain before removing its temporary
  directory, then assert no post-cleanup diagnostic write/rotation warning
  occurs. The defect reproduced in all three 2026-09-18 security-suite runs; it
  is a test/reliability defect, not evidence of a financial or data exposure.
  **Fix applied, matching the planned approach exactly:** the `finally` block
  now calls `await shutdown(server, 'test-security-suite-teardown')` (the same
  function `server.js`'s SIGTERM/SIGINT handlers and `test_http.js`'s
  operational-boundary check use) before the temp-dir `rmSync`, then asserts
  `getLogWriterStats()` shows zero queued/in-flight entries. A
  `console.warn`/`console.error` monkeypatch wraps the cleanup window so any
  `[LogWriter]` message after this point throws
  (`QA-001 regression: log writer wrote after cleanup: ...`) instead of merely
  printing, with a 250ms outwait past the writer's own 50ms flush delay before
  the guard is declared clear.
  Owner: Engineering  Result: **PASS**  Notes: `node test_security.js` run 3
  times in isolation, exit 0 every time, 10/10 checks, zero `[LogWriter]`/
  `ENOENT` lines in any run's output. `cd backend && npm test` green (all
  twelve suites, `test_security.js` included via the existing `npm test`
  chain).

- [x] Add behavioural tests for `licensing_server/` *(done 2026-09-19)*: admin
  authentication, license issue/suspend/renew, signed release manifest,
  malformed input, release-channel/rollout rules, authorization and
  control-plane failure. Syntax checks and `npm audit` did not prove the
  shared service behaves safely — now 36 real HTTP checks do.
  **Made it testable first:** `server.js` hardcoded its data/keys directories
  to `licensing_server/{data,keys}` and called `app.listen()` at import time
  with no override, so importing it for a test would have written into the
  real license/key files. Added `GOLD_POS_LICENSING_DATA_DIR` /
  `GOLD_POS_LICENSING_KEYS_DIR` env overrides (default unchanged, additive —
  mirrors `backend/db.js`'s `GOLD_POS_DATA_DIR`) and an exported
  `startServer(port, host)` gated behind `GOLD_POS_DISABLE_BOOTSTRAP` (same
  variable and convention `backend/server.js` already uses).
  **Real bug found and fixed while building the malformed-input test:** this
  service had no terminal error-handling middleware, so a truncated JSON
  body (or any thrown error) fell through to Express's default handler,
  which renders the **full stack trace** — absolute filesystem paths,
  `node_modules` internals — into the HTML response outside
  `NODE_ENV=production`. Confirmed live via curl before fixing. Fixed by
  porting `backend/server.js`'s exact safe-error-handler pattern (§1: reuse,
  don't reinvent) plus a JSON 404 for unmatched `/api/*` routes.
  **New `licensing_server/test_licensing.js`** (36 checks, real HTTP over
  `fetch()` against the real server on an ephemeral port, isolated temp
  data/keys dirs — no mocks): entitlement semantics for active/expired/
  suspended/unknown licenses; cryptographic signature validity for both the
  license-verify and release-manifest signatures, and that tampering breaks
  each; issue/suspend/renew/revoke lifecycle; release-publish input
  validation (channel, semver, URL, sha256, changelog length, rollout
  range); the **only rollback lever this API has** — republishing an older
  version can never usurp `/api/releases/latest` (documented, not
  discovered-as-a-gap: there is no delete/true-rollback endpoint at all,
  only republishing the same version at a lower `rolloutPercent`, which
  wins on the tie-break); malformed/oversized bodies; both rate limiters
  (license-verify-specific and the general per-IP ceiling, with the
  `/api/health` exemption proved while the general limiter is fully
  tripped); the admin brute-force lockout (proved it blocks the *correct*
  token too, not just wrong ones); and tenant isolation (one license's
  verify response never carries another's data).
  **Open item, not fixed this pass (noted, not silently patched):** there is
  no true "rollback" (delete/unpublish) endpoint for a bad release — only
  the rolloutPercent-shrink lever above. Recording as a gap for a future
  phase, not inventing one.
  Owner: Engineering  Result: **PASS**  Notes: `node test_licensing.js` run 4
  times, all exit 0, 36/36 every time. `npm run audit:security`
  (licensing_server) — 0 vulnerabilities. `node --check server.js` and
  `node --check test_licensing.js` clean. `git diff --check` clean. Full
  detail: `docs/LEDGER.md` 2026-09-19 entry.

- [~] Make `mobile/` reproducible before treating it as a product *(lockfile +
  audit + CI + runbook done 2026-09-19; native build/device evidence still
  genuinely blocked — see below)*: choose the committed lockfile/install
  policy, run dependency audit/SBOM, generate the Android project on a
  trusted release machine, and add build/device evidence. On 2026-09-18
  `npm audit` could not run because no mobile lockfile existed.
  **Done, reachable from this sandbox:**
  - `npm ci` now installs from a committed `mobile/package-lock.json`.
    Generating it surfaced a real finding: `@capacitor/{core,android,cli}
    ^6.0.0` resolved to a `tar` transitive dependency with several
    critical/high archive-extraction advisories, with no fix available
    within the 6.x line. Bumped to `^7.0.0` (the next major, not the latest
    8.x — no `android/` project has ever existed in this tree to re-migrate,
    so this was the cheapest possible time to absorb one major version;
    jumping two felt like unnecessary added risk for the same audit result).
    `npm audit` now reports 0 vulnerabilities. `npx cap --version` (7.6.9)
    and `npx cap sync` (no platform present, so this only proves CLI/config
    compatibility) both ran clean.
  - `npm run audit:security` / `sbom:dependencies` added to `mobile/package.json`,
    matching `backend/`'s and `licensing_server/`'s convention.
  - `.github/workflows/daily-checks.yml`'s `dependency-audit` and `sbom`
    matrices now include `mobile` (previously `[backend, licensing_server]`
    only) — this is the actual "CI-ready checks" deliverable: everything an
    Android-SDK-less GitHub runner can prove (install reproducibility, 0
    known vulnerabilities, a generated SBOM) now runs on every push. Also
    added `licensing_server`'s new test suite (previous item) to the
    `integration-tests` job while touching this file.
  - `docs/RUNBOOKS.md` §14 (new): a numbered, repeatable Android build/
    device-test procedure (generate `android/`, sync, build, a concrete
    device smoke-test checklist covering login/OTP, ledger load, a
    test-mode Razorpay checkout, the UPI QR fallback, and backgrounding/
    rotation) plus its own drill-log table, matching the existing backup-
    drill-log convention.
  **Still genuinely blocked, not faked:** this sandbox has no Android SDK/
  Studio/JDK (confirmed in `mobile/README.md`, unchanged by this pass), so
  `npx cap add android`, an actual Gradle build, and any device test remain
  unrun. The runbook's own log table is intentionally empty pending that.
  Owner: Mobile/release engineering  Result: **PARTIAL** Notes: `npm ci`,
  `npm audit --audit-level=high`, `npx cap --version`/`sync`, and
  `npm sbom --sbom-format cyclonedx` (92 components) all run clean — see
  `docs/LEDGER.md` 2026-09-19 entry. Next real step needs a machine with the
  Android SDK: follow `docs/RUNBOOKS.md` §14 and record the outcome there.

- [x] Update `docs/brain/brain.map.json` until the quality/architecture check
  has no unclaimed current source or important operating-document files. The
  initial 2026-09-18 check reported 20; after audit-document mapping/rebuild it
  still reported 18. Generated graph coverage must be trustworthy, not optional.
  *(closed 2026-09-24)* — the 19 files still unclaimed (6 backend modules
  never mapped after their own build sessions — `auditRetention.js`,
  `backupCrypto.js`, `benchmark.js`, `domainCodes.js`, `logWriter.js`,
  `pitr.js` — plus 9 operating docs and 4 extracted frontend scripts) were
  filed into their nearest existing region by role, not dumped into a
  catch-all: the three backup/retention modules joined **Backups &
  Reporting**, `domainCodes.js` joined **Domain Services** (the layer that
  owns declaring a domain outcome), `logWriter.js` joined **Crypto, Auth &
  Black Box** beside its sibling `blackBoxLogger.js`, `benchmark.js` and its
  companion `docs/PERFORMANCE_BENCHMARK.md` joined **Test Suites**, the four
  extracted inline-script files (`adminAlertOverride.js`, `preAuthCheck.js`
  → **Cashier UI Shell**; `customer-app.js`, `customerAlertOverride.js` →
  **Customer Portal**) joined whichever surface actually loads them
  (confirmed by grep, not assumed by name), `docs/THREAT_MODEL.md` joined
  **Crypto, Auth & Black Box**, and the remaining status/decision docs
  (`ENGINEERING_EXCELLENCE_PROGRAM.md`, `GO_LIVE_RUNBOOK.md`,
  `OWNER_QUESTIONS.md`) joined **Live Trackers** while the stable
  policy/reference docs (`API_COMPATIBILITY.md`, `DEPENDENCY_REVIEW.md`,
  `INVARIANT_MATRIX.md`, `USABILITY_SESSION_PROTOCOL.md`) joined **Reference
  Docs**. No new region, no explicit file list — every addition is still a
  glob pattern per file, consistent with `docs/brain/README.md`'s "never
  replace the globs with an explicit file list."
  Owner: Engineering  Result: **PASS**  Notes: `node docs/brain/build-brain.mjs
  --check --skip-graph` — before: `19 file(s) not claimed by any region`,
  exit 1; after: `239 files, 19 regions, coverage 100.0%`, exit 0. No
  source file was added/moved/deleted, so `--skip-graph` (map-only redraw)
  was the correct, cheaper path per `docs/brain/README.md` — a full
  `graphify update .` re-extraction was not needed.

### 25b. UI, accessibility and human-factors proof

- [x] Add dedicated browser journeys for every currently underrepresented admin
  surface: Settings sub-sections, Cash Shifts, Quotes & Holds, Customer Master,
  Gold Schemes, Audit Trail, Management Reports and Diagnostics. Each journey
  covers normal action, empty/error/denied state, cancel/retry and reload.
  *(Done 2026-09-19, in the order Cash Shifts, Quotes & Holds, Customer
  Master, Gold Schemes, Audit Trail, Management Reports, Diagnostics —
  concurrent sessions were already actively covering several Settings
  sub-sections and Dashboard/Advances the same day, see docs/ai_handover.md
  §0, so Settings itself was deliberately left to that work rather than
  duplicated. Six of the seven modules this session covered turned up a real,
  previously-unknown bug; each is documented below with its own
  regression-guard proof.)*
  **Diagnostics (`backend/tests/e2e/diagnostics.spec.js`, new, 5 tests) —
  done, real bug found and fixed first:** all three action buttons' failure
  branch was `logTelemetry('... failed: ' + res.status)` — a manager or
  cashier denied by the owner-only `requireRole('owner')` gate on every
  `/api/diagnostics/*` route saw a bare "failed: 403" with no indication of
  what that meant or what to do. Fixed to name the real reason specifically
  for the 403 case, leaving other status codes as the raw code (where it is
  actually the useful signal — a genuine unexpected failure). **Guard
  proven**: temporarily reverted the fix, confirmed the permission-denied
  test reproduced the bare "failed: 403" and failed, restored the fix and
  diffed identical. Also covers: the owner successfully pulling Level 1
  telemetry, requesting the Level 2 encrypted export, and requesting the
  black-box export (each asserting the real response content, not a
  placeholder); and that repeated pulls append to the console log rather
  than replacing it. **Noted, not fixed (out of scope — a dead-code cleanup,
  not a defect for this pass to quietly patch):** `app.js` still wires a
  `#toggle-debug-btn` click handler, but no element with that id exists
  anywhere in `index.html` — the code's own `if (toggleBtn && drawer)` guard
  already makes this a silent no-op, not a broken feature.
  **Management Reports (`backend/tests/e2e/management-reports.spec.js`, new,
  5 tests) — done, no defect found this time:** a concurrent session already
  covers the Profitability/Ageing reports and a real local-vs-UTC
  date-default bug (found and fixed 2026-09-19) inside
  `inventory-billing-operations.spec.js` ("Module 22", per `ReportsDesk.js`'s
  own header comment) — deliberately not duplicated. This unit covers the
  actual gap instead: the Settlement report (a real cash sale filed same-day,
  exact ₹77,893.75 total, correct tender-method row); the Reconciliation
  report (0 exceptions for a cleanly-filed sale); the invalid-date-range
  error path (`from` after `to` shows the server's own message, not a
  broken/blank report); the Inventory-Ageing kind correctly disabling the
  date-range inputs client-side (and re-enabling them on switching back);
  and the hidden-by-default state before the owner enables the module. All 5
  passed on the first real run — this module's engineering already appears
  solid (its own committed history shows a real timezone bug already found
  and fixed by the concurrent session same-day), which is itself useful
  confirmation, not every module needs a defect to be worth covering.
  **Audit Trail (`backend/tests/e2e/audit-trail.spec.js`, new, 5 tests) —
  done, two real bugs found and fixed first:** (1) the 403 permission-denied
  path reused `requireApprover`'s server message verbatim, which reads
  "Approving a deposit needs a manager or the owner..." — written for a
  different call site, so a cashier trying to *view* the audit trail was
  told they were trying to *approve a deposit*. Fixed to always show the
  screen's own accurately-worded message; unlike Customer Master's bug this
  screen already correctly distinguished denied-from-empty, the defect was
  purely which message won. (2) The entity-type filter's "Advances"/
  "Payments" `<option>` values (`advance`/`payment`) never matched any real
  audit row — every service in this tree actually records `advance_entry`/
  `payment_order`, and `auditRepository.search()` does an exact-match `WHERE
  entity_type = @entityType`. Selecting either option silently returned zero
  rows, always, since the screen was built — nothing had ever exercised it
  in a real browser before this spec. Fixed both option values. **Guard
  proven for bug 2**: temporarily reverted the option values (and the
  test's own selector) together, confirmed the filter test reproduced the
  exact zero-rows bug and failed, restored both, diffed identical. Also
  covers: a filter-matches-nothing state distinct from a genuinely empty
  trail; a cross-module integration check (opening/closing a Cash Shift
  shows up with the right actor and variance); and reload persistence.
  One test-authoring correction along the way: the audit summary for a
  money event never carries the customer's name (by consistent design
  across every service, not a bug) — fixed the test to search by the
  actually-rendered amount instead of an assumed customer name.
  **Gold Schemes (`backend/tests/e2e/gold-schemes.spec.js`, new, 7 tests) —
  done, real bug found and fixed first:** `goldSchemeEnabled` saves through
  the exact same Billing-settings handler as `managementReportsEnabled`, and
  that handler's own comment says feature-gated modules must become
  reachable immediately after enabling — but it only ever called
  `window.reportsDesk.refresh()`, never `window.schemeDesk.refresh()`.
  Enabling Gold Schemes and saving left its nav button hidden until a full
  page reload: the exact defect already fixed once for Management Reports
  (`docs/LEDGER.md` 2026-09-03) and never carried over to this sibling
  module. Fixed by adding the missing refresh call. **Guard proven**:
  temporarily reverted to the pre-fix single-refresh version, confirmed the
  "enabling makes the tab reachable immediately" test reproduced the exact
  bug (button stayed hidden) and failed, restored the real fix, diffed
  identical. Also covers: the hidden-by-default state; enrollment phone
  validation; paying an installment (positive-amount validation, then a
  real payment updating the paid count); closing early (native `confirm()`,
  payout credited to the advance balance); marking defaulted (native
  `confirm()`, status-only change); and reload persistence of both the
  enabled flag and an enrollment. No permission-denied case — every
  `/api/gold-schemes/*` route is `requireAdminSession` with no role
  restriction.
  **Unrelated defect observed, not fixed (out of this unit's scope, in an
  actively-worked concurrent-session file):** while running the full
  Playwright suite for regression, `advances-manager.spec.js`'s "View
  expands... Hide collapses" test started failing consistently (3/3 in
  isolation) with a Playwright strict-mode violation — 5 "View" buttons
  matched where 1 was expected. Root cause understood, not fixed:
  `AdvancesManager.js`'s search input is debounced 250ms
  (`clearTimeout`/`setTimeout(() => this.refresh(), 250)`), and the test
  does not wait for that debounced fetch to settle before asserting on the
  row count — a race between the post-deposit unfiltered refresh and the
  debounced search-filtered refresh, both of which call `renderTable()`
  independently. This is a test-timing/reliability issue, not a financial
  or data bug, in a file this unit never touched (confirmed via `git diff`
  — the only pending change to `AdvancesManager.js` is an unrelated
  "Redeemed at Billing" text fix). Flagged here and in
  `docs/ai_handover.md` §0 rather than silently fixed or silently ignored.
  **Customer Master (`backend/tests/e2e/customer-master.spec.js`, new, 6
  tests) — done, real bug found and fixed first:** `GET /api/customer-accounts`
  is `requireRole('owner','manager')` server-side, but the nav tab has no
  role-gating and `refresh()` silently turned ANY non-ok response (403
  included) into an empty array — a cashier opening this tab saw a plausible
  but false "No customer on record yet" with no indication they lacked
  permission. Fixed `CustomerAccountsManager.js` to distinguish a genuine
  empty list from a 403 ("You do not have permission…") and from any other
  load failure, before writing the journey that proves it. **Guard proven,
  not just written**: temporarily reverted the fix, re-ran the permission
  test, confirmed it reproduced the exact pre-fix misleading empty state and
  failed loudly; restored the real fix and diffed identical. Also covers:
  issue-login phone validation; issuing a fresh login (one-time temp
  password shown, account badges "Temp password"); the reissue/reset-password
  native `confirm()` flow (a second dialog-driven spec after Quotes & Holds);
  correcting a record (required-field validation, a real edit persisting);
  and an owner anonymising a customer (native confirm, record scrubbed,
  actions replaced with "Anonymised", further edits blocked).
  **Cash Shifts (`backend/tests/e2e/cash-shifts.spec.js`, new, 6 tests):**
  empty state (no shift open, empty history); client-side validation on both
  open (blank float) and close (blank counted-cash); normal open→live
  expected-cash breakdown→close→variance-message→history-row flow; reload
  persistence (an open shift survives a page reload, proving server- not
  client-state); and a genuine two-terminal race (a second page's stale
  "open" form, submitted after the first terminal already opened the shift,
  surfaces the server's real `CASH_SHIFT_ALREADY_OPEN` refusal message). No
  permission-denied case exists for this module — every `/api/cash-shifts/*`
  route is `requireAdminSession` with no role restriction, and the nav
  button has no role-gating, unlike Settings/Management Reports — documented
  in the spec's own header rather than forcing a test that cannot fail
  meaningfully.
  **Quotes & Holds (`backend/tests/e2e/quotes-holds.spec.js`, new, 7 tests):**
  empty state; HOLD/QUOTE-with-empty-cart client-side refusal; saving a HOLD
  (form resets, appears in the list with correct customer/phone/weight);
  saving a QUOTE and proving the kind filter (Holds only / Quotes only)
  actually narrows the table; Resume (cart restored into Billing Desk's
  banked `#cart-list`, removed from the open list — first version of this
  test wrongly asserted against `#gold-weight`, the *next-line* entry field,
  not the banked cart display; fixed in the test, not a real bug); Discard's
  native `confirm()` both declined and accepted (first e2e spec in this tree
  to drive `page.on('dialog')`, since `confirm()` — unlike `alert()` — was
  never given the custom-box treatment here, consistent with every other
  destructive-action confirmation in this app); and reload persistence.
  Owner: Product + QA  Result: **DONE — all seven modules covered** Notes:
  all seven targeted specs green on repeat runs (6/6 ×2 Cash Shifts, 7/7 ×2
  Quotes & Holds, 6/6 ×2 Customer Master, 7/7 ×2 Gold Schemes, 5/5 ×2 Audit
  Trail, 5/5 ×2 Management Reports, 5/5 ×2 Diagnostics — 41 new browser
  checks total), each real bug's fix independently proven by temporarily
  reverting it and confirming the test reproduced the exact pre-fix
  behaviour before restoring. Full `npx playwright test` (both projects) ran
  four times across this batch — 96/96, 108/108, 112/113, then 117/118 (the
  one `advances-manager.spec.js` flake, first seen under Gold Schemes,
  recurred intermittently across three of the four runs, confirming it is
  timing-dependent and pre-existing — documented for its owner, not caused
  by or fixed in this batch). Full backend `npm test` (12 suites)
  re-confirmed green throughout. See `docs/LEDGER.md` 2026-09-19 entries.

- [x] Make every interactive control semantic and predictable: explicit button
  type, programmatic label, linked validation error, visible focus, keyboard
  order, Enter/Escape behaviour and focus return after dialogs. Static source
  smoke on 2026-09-18 found no missing image alt/no empty button, but 32
  top-level buttons rely on implicit browser-default button type.
  Owner: Frontend  Result: **DONE 2026-09-22** Notes: every `<button>` in
  `frontend/index.html`, `frontend/customer.html` and `frontend/js/app.js`
  now declares `type="button"` explicitly (33 found by grep, not 32 —
  `frontend/js/components/*.js` already did this everywhere, confirming the
  audit's count was these three files only); the two hand-rolled
  `okBtn = document.createElement('button')` calls in
  `adminAlertOverride.js`/`customerAlertOverride.js` now set `.type =
  'button'` too. Confirmed zero `<button` tags anywhere in `frontend/` lack
  a `type` (`grep -rn "<button" frontend | grep -v type=` → empty). The one
  icon-only control in the whole app, `BillingDesk.js`'s tender-remove "✕"
  button, got an `aria-label`; its sibling per-row tender method/amount/
  reference inputs (rows after the first, whose visible `<label>` only
  renders once per §0's "reuse the existing pattern") got `aria-label` too,
  since they had no programmatic name at all before. Every `.input-error-msg`
  span (7 across `customer.html` and `BillingDesk.js`) is now
  `aria-live="polite"` and referenced by its field's `aria-describedby` — the
  fields themselves were already correctly `<label for>`-linked, that part
  of the ask was already done. `.form-control:focus`'s replacement for the
  suppressed native outline was `rgba(148,163,184,0.1)` — 10% opacity, almost
  invisible; now uses the design system's own `--color-accent` token
  (`#334155`, already defined with the comment "gentle focus" but never
  actually wired to anything) at visible contrast. Keyboard order needed no
  fix: `grep -ri tabindex frontend` is empty, so DOM order already governs
  it everywhere. Enter/Escape and focus-return on the one hand-rolled dialog
  (the `#custom-alert-box` overlay) were already fixed 2026-09-17 (§24b) —
  verified still correct, not re-done. Native `confirm()`/`prompt()` dialogs
  (no custom override exists for either) get this for free from the browser.
  **Not done in this pass, scoped out deliberately:** per-keystroke
  `aria-invalid` toggling on the described fields (the static
  `aria-describedby` + `aria-live` region covers the "announced" half of the
  ask without touching every validation code path in
  `customer-app.js`/`BillingDesk.js`, which was judged higher-risk for the
  money/auth paths those files own than the accessibility gain justified in
  one pass) — worth a follow-up. **Verified:** `grep` audits above; full
  `npx playwright test` 136/136 after the button/focus/label changes, and
  again after the aria-describedby/aria-live pass (one unrelated flake in
  `customer-master.spec.js` reproduced as a clean pass in isolation — the
  full run took 1.1h against a normal ~10min that same day, pointing at
  contention from other concurrent sessions on this machine, not a real
  regression); `cd backend && npm test` (12 suites) green throughout.

- [x] Add visual-regression baselines and review workflow for lock screen,
  billing/print, return/print, warning/confirmation, settings and customer
  portal. Exercise desktop 100/125/200% zoom and smallest supported phone size.
  Owner: Product + QA  Result: **DONE 2026-09-22** Notes: new
  `backend/tests/e2e/visual-regression.spec.js`, 18 screenshot assertions
  using Playwright's built-in `toHaveScreenshot` (no new dependency —
  `@playwright/test` already carries this). The admin desk
  (`frontend/index.html`) has zero `@media` breakpoints in `app.css` — it is
  desktop-only by design (the "counter runs on a desktop" reasoning already
  in `playwright.config.js`) — so its five screens (lock screen, billing
  print preview, return credit note, the `#custom-alert-box` warning/
  confirmation overlay, and Settings → Store Profile) are each captured at
  100/125/200% zoom via the CSS `zoom` property (Chromium-only, which is all
  this config drives) instead of at a phone width that screen was never
  built for. The customer portal is the opposite — phone-first — so it is
  captured at a true 390×844 viewport (an explicit override, not the
  `mobile-chromium` project's 412px Pixel 7 preset, since "smallest
  supported phone size" asks for smaller than that project's everyday
  device) for both the sign-in screen and the signed-in dashboard, plus one
  desktop capture of the sign-in screen since the admin sidebar's "Open
  Customer Login" link opens it on desktop too. **Review workflow:** baseline
  PNGs are committed to the repo next to the spec
  (`visual-regression.spec.js-snapshots/`) — a pixel change shows as a diff
  in the PR, not silent drift; update deliberately with the new
  `npm run test:e2e:update-snapshots` script after visually confirming the
  new look is correct. **Two real flakiness sources found and fixed while
  proving this stable, not papered over:** (1) the return credit note's
  footer renders `Issued <server timestamp>`, real wall-clock time — the
  test now overwrites that one line's text in the DOM before the screenshot
  (tried Playwright's `mask` option first; it silently left the real text in
  place at 125%/200% zoom, so the direct DOM rewrite replaced it, not both).
  (2) Google Fonts ('Outfit') swap-in timing caused a few stray antialiased
  pixels run to run even with identical DOM/CSS — added a `document.fonts
  .ready` wait before every capture and a `maxDiffPixelRatio: 0.02` tolerance
  in `playwright.config.js`'s `expect` block as defense in depth. **Verified
  stable, not just green once:** the 18-test file run 5 times total after
  both fixes (1 generate + 4 plain re-runs, including inside two different
  full-suite runs) with zero flakes; before the fixes it flaked 2/2 times on
  the credit-note test and 1/1 time on the customer-portal-390 sign-in test.
  Full `npx playwright test` 136/136 (118 pre-existing + 18 new).

- [ ] Run independent manual usability/accessibility sessions: keyboard-only,
  screen reader, contrast/large text, touch, scanner, and a cashier who knows
  only simple English. Convert each observed hesitation into a defect or an
  explicit documented decision.
  Owner: Store manager + product  Result: _____  Notes: ________________

### 25c. Performance, resilience and production evidence

- [ ] Set explicit p50/p95/p99 counter budgets on target VPS and exact supported
  hardware. The three 2026-09-18 loopback quick runs are baseline only: seeded
  serial checkout p95 29.74–34.68 ms and five-till checkout p95 92.42–170.51 ms
  on a Windows development laptop.
  Owner: Product + engineering  Result: _____  Notes: ___________________

- [ ] Extend performance testing with return/void/stock/payment/mixed-till
  workloads, a large representative tenant, eight-hour browser soak, memory/
  open-handle trace, slow network/provider delay, disk pressure and real print
  preparation. Preserve durable financial/audit commits.
  Owner: Engineering  Result: **PARTIAL 2026-09-24** Notes: return/void/
  stock/payment/mixed-till workloads and a browser-side trace covering
  keyboard/scanner input, total recalculation, tab transitions and print
  preparation are now built and run — see §24d's two items above and
  `docs/PERFORMANCE_BENCHMARK.md` for full evidence, rather than duplicating
  it here. **Still open**: a large representative (thousands-of-invoices)
  tenant, the real eight-hour soak on real hardware, slow network/provider-
  delay simulation, and disk-pressure simulation — none of this session's
  work touched those four.

- [ ] Certify actual scanner, scale, thermal/label printer, cash drawer, card
  terminal, browser, workstation, power backup and network. Test disconnect,
  paper-out, retry, power loss and reconciliation—not only browser emulation.
  Owner: Store manager  Result: _____  Notes: __________________________

- [~] Run target-VPS deployment, DNS/TLS/proxy/firewall, alert, off-host backup,
  clean-host restore, rollback and incident exercises. Save RTO/RPO and evidence
  outside the POS. *(alert drill added 2026-09-19; the rest requires real cloud
  infrastructure and is explicitly not something this session will provision
  without asking first — see notes.)*
  **Split by what this sandbox can and cannot do:** a disposable VPS
  deployment/DNS/TLS/rollback drill needs real cloud credentials and spends
  real money — that is a "check first" action (irreversible-ish, affects
  shared/external systems), not a routine dev-loop step, so it is left for
  the platform operator to authorize explicitly rather than attempted here.
  A real backup **restore** drill against this machine's actual
  `backend/backups/` snapshots was attempted and correctly failed to decrypt
  — this sandbox does not have, and must not seek, the real
  `GOLD_POS_SECRET_KEY` those backups were sealed with (see
  `docs/RUNBOOKS.md` §2's "lost or wrong vault key" procedure for what that
  failure means and who can actually complete this drill). The *isolated*,
  synthetic-fixture version of this drill already exists and passes as part
  of `backend/test_suite.js` (re-confirmed green in this session's earlier
  full-suite runs) — that is real, repeated automated proof the restore
  mechanism itself works; it is not a substitute for a human periodically
  proving it against the live tenant's real encrypted snapshot with the
  real key, which only whoever holds that key can do. **Alert drill**: new
  `docs/RUNBOOKS.md` §15 — a fully local, zero-infrastructure procedure
  (trigger a real alert condition, capture the email with a throwaway local
  SMTP server, confirm cooldown) — done and proven live in this session, not
  just written up.
  Owner: Platform operator  Result: **PARTIAL** Notes: See
  `docs/LEDGER.md` 2026-09-19 entry for the alert-drill evidence. Disposable-
  VPS deployment/rollback drill remains an explicit open decision — see
  `docs/ai_handover.md` §0 for the question put to the user.

### 25d. SaaS and product decisions that must precede their build

- [ ] **[needs design decision: operating model]** Decide dedicated tenant
  install versus shared managed SaaS (or both), including isolation, lifecycle,
  support access, backup/data ownership, cost, SLO and offboarding.
  Owner: Business + architecture  Result: _____  Notes: _________________

- [ ] **[needs design decision: branches and authority]** Define branches,
  counters, stock transfer, rate/invoice ownership and approval policies for
  discounts, stock adjustment, void, cash variance, old gold and schemes.
  Owner: Product + CA/store owner  Result: _____  Notes: ________________

- [ ] **[needs design decision: outage mode]** Decide whether sales must work
  offline. If yes, define encrypted local storage, queue/conflict/idempotency,
  rate-staleness and reconciliation rules before implementation; if no, define
  and train a clear blocked/offline workflow.
  Owner: Product + engineering  Result: _____  Notes: ___________________

- [ ] **[needs design decision: mature jewellery operations]** Scope purchase
  receiving, suppliers, repair/job-work, stock counts/shrinkage, branch transfer,
  accounting/tax integrations, e-invoice/e-way-bill needs, loyalty/CRM and
  commissions before adding fields or screens.
  Owner: Product + CA/store owner  Result: _____  Notes: ________________

- [ ] **[needs design decision: platform/mobile]** Scope the SaaS control plane
  (onboarding, plans/entitlements, fleet health, support/export/offboarding) and
  native mobile product (one tenant-aware app, secure storage, deep links,
  notifications, accessibility and store compliance) before implementation.
  Owner: Business + product  Result: _____  Notes: ______________________

## 26. Customer Portal PWA (installable, offline fallback) *(added 2026-09-27)*

Build record in `docs/LEDGER.md` (2026-09-27 entry). Adds installable-PWA
support to `frontend/customer.html` only — manifest, service worker, iOS
meta tags — as a lighter-weight, store-independent alternative to the
Capacitor/Play Store track for that one page. Does not replace that track,
and does not resolve the "outage mode" open design decision above: the
offline fallback page is a UX nicety for a dropped connection, not queued
offline writes.

- [x] Manifest links correctly and fetches as valid JSON with the expected
  installability fields (`name`, `scope` pinned to `/customer.html`,
  `display: standalone`, three icons including a `maskable` one).
  Owner: Engineering  Result: **PASS**  Notes: `customer-pwa.spec.js`
  "links a valid manifest..." — green on both `desktop-chromium` and
  `mobile-chromium`.

- [x] Service worker activates scoped to `/customer.html` only, and is
  proven — not assumed — to never control the admin desk (`/index.html`)
  even when visited in the same browser context right after.
  Owner: Engineering  Result: **PASS**  Notes: `customer-pwa.spec.js`
  "activates a service worker scoped to customer.html only" and "does not
  let the customer-portal worker control the admin desk".

- [x] Offline fallback page renders on a genuine network drop mid-session,
  with a working retry; a real 4xx/5xx server response is never masked by
  it (the service worker only catches an actual failed fetch).
  Owner: Engineering  Result: **PASS**  Notes: `customer-pwa.spec.js`
  "shows the cached offline page when the network drops mid-session"
  (`context.setOffline(true)` + reload).

- [x] iOS Safari "Add to Home Screen" bookmark/icon add works.
  Owner: Product  Result: **PASS**  Notes: user-verified 2026-09-26,
  against the plain page (before the manifest/SW/meta tags existed) —
  confirms the baseline bookmark behavior, not standalone-mode launch.

- [ ] iOS standalone-mode re-verification on a real device: with
  `apple-mobile-web-app-capable=yes` now added, launching from the
  home-screen icon should open full-screen with no Safari chrome, and the
  status bar (`apple-mobile-web-app-status-bar-style: default`, chosen
  specifically to avoid needing `env(safe-area-inset-top)` CSS) should not
  overlap the header banner. Genuinely new behavior beyond the earlier
  plain-page pass above — not yet re-checked.
  Owner: Product  Result: _____  Notes: _________________

- [ ] Real Android/Chrome manual install click-through (Add to Home
  Screen / install prompt). The automated checks above prove the
  installability criteria are met programmatically (manifest + active
  worker with a fetch handler); they don't prove a human actually sees a
  working install prompt on a real device.
  Owner: Product  Result: _____  Notes: _________________

- [x] Zero regression on the existing customer-portal journeys and visual
  baselines after adding the new head tags/script.
  Owner: Engineering  Result: **PASS**  Notes: `customer-portal.spec.js` +
  `customer-master.spec.js` 34/34 unaffected specs still green on both
  viewport projects; `visual-regression.spec.js`'s three customer-portal
  screenshots (signin desktop/390, dashboard 390) unchanged.
