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

This runs eight suites and exits non-zero on any failure (**437 checks** as of
2026-08-16). None of them touch `backend/data/` — every one that needs a
database makes its own temp directory — so all are safe to run with a dev
server already up on :5000.

| Suite | Covers |
| --- | --- |
| `npm run test:billing` | Invoice money math (145 checks) —  — discount ordering, GST inclusive/exclusive, advance capping, making-charge %/₹ conversion, NaN hardening, printed rows reconciling to the Grand Total, paise settlement, advance-deposit status arithmetic (pending/rejected hold no balance; a missing status still counts, so existing ledgers keep their balances), metal value from weight × server rate, rupee↔paise conversion, the tax base being metal **+** making charge in both modes, and the return-refund pipeline — full and partial-by-weight refunds, the refunded gross including any advance redeemed, no drift across split returns, legacy/non-reconciling invoices falling back to pro-rata, and every refusal. Plus, since 2026-08-12: multi-line invoices — the per-line allocation summing exactly to the header at every slab in both tax modes, a two-line invoice equalling the single-line invoice of its summed values, per-line discounts, `saleLines()` reading both the new and the legacy record shape, per-line returns priced at the right line's rate, and the store's advance-liability rollup |
| `npm run test:schema` | Every SQLite migration and every SQL constraint, each asserted by attempting the violation (43 checks) |
| `npm run test:repositories` | The repository seam: every repository's reads and writes, the legacy wire-shape projections older readers still depend on, pagination, and the JSON importer (82 checks) |
| `npm run test:concurrency` | Real OS processes, not mocks: concurrent writers competing for one balance, crash injection mid-sale, duplicate requests, and migration drift. The slowest suite by far (~1–2 min) and in `npm test` anyway — "one balance cannot be spent twice" and "a kill mid-sale leaves nothing behind" are not observable any other way (16 checks) |
| `npm run test:integration` | Troy-ounce conversion, licensing grace periods, crypto envelopes, customer password hashing (scrypt round-trip, salt uniqueness, tampered-hash rejection), login-lockout escalation, and the password-reset code lifecycle (single use, expiry, guess budget, never stored in the clear). Plus, since 2026-08-13: admin PIN hashing (the plaintext migration, its idempotence, fresh-install seeding, refusal when no salt exists, recovery-code single use) and **TOTP against the published RFC 6238 vectors** — the one check that proves a real authenticator app will interoperate, since every other MFA test presents a code from our own generator (9 tests) |
| `npm run test:routes` | Real server over HTTP: public surface, admin auth boundary, credential redaction and the masked save round-trip, persistence failure, invoice-sequence guard, logout invalidation, brute-force lockout (28 checks) |
| `npm run test:http` | The money paths over HTTP: server-authoritative rate and metal value, the client-field allowlist, refusal to price without a rate, Razorpay webhook signature/idempotency/amount-mismatch/unknown-order/failed-payment handling, transaction rollback, and the returns money path — admin gating, cash vs gold refund, the server pricing the refund rather than the client, cumulative over-return refusal, gold-refund rollback, and the session-scoped customer view. Plus, since 2026-08-12: multi-line sales and their rollup, one bad line refusing the whole invoice without burning an invoice number, per-line returns, tender validation in paise (including the amountless "whole bill" form and the advance-settled zero case), actor identity on the sale and the refund, the owner/manager approver gate, operator PIN rules and redaction, and the paged ledger envelopes. Plus, since 2026-08-13: no PIN hash or tenant salt reaching a browser, session revocation on a PIN change and on deactivation, the session list and who may read it, TOTP enrolment requiring a live code, recovery-code replay refusal, the MFA gate on an approval, and the refund threshold either side of the line. Plus, since 2026-08-16: the audit-trail read path and its gate, and §"The operational boundary" — request ids generated, reused and refused; readiness reporting a migrated ledger; liveness staying dependency-free; a JSON 404 on an unknown API path; a parser rejection returning a safe body with no stack trace; and a draining process answering 503 before it stops listening (98 checks) |
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

- [x] `cd backend && npm test` is green — **437 checks, verified 2026-08-16**. Eight suites run in order: `test_billing_math.js` (pricing/rounding), `test_schema.js` (migrations + SQL constraints), `test_repositories.js` (the repository seam + legacy projections), `test_concurrency.js` (real OS processes), `test_suite.js` (helper-level integration), `test_routes.js` (HTTP routes + auth boundary), `test_http.js` (money paths + webhook), `test_production_guard.js` (fail-closed startup). Every suite that needs a database makes its own temp directory via `GOLD_POS_DATA_DIR`, so all are safe to run with a dev server already up on :5000.
  Result: PASS  Notes: 145 + 43 + 82 + 16 + 9 + 28 + 98 + 16, in run order.

- [x] `npm run test:e2e` is green — **43/43, verified 2026-08-16** (Desktop Chrome + 390px Pixel 7). Needs `npm install && npx playwright install chromium` first.
  Result: PASS  Notes: 4.5m. First green run since the Phase 29 cut-over — 23 of the 43 were failing because the specs still read the retired JSON ledger and so asserted against the frozen seed rather than their own work. They read the SQLite ledger through `readLedger()` now; see LEDGER Phase 30.

- [ ] Server starts cleanly (`Restart_Server.bat` or `node backend/server.js`), no red errors in console except the expected "Licensing sync connection failed" if licensing_server isn't running.
  Result: _____  Notes: ______________________________________________

- [ ] `http://localhost:5000/` loads the Admin Terminal lock screen (dark PIN pad).
  Result: _____  Notes: ______________________________________________

---

## 1. Admin Login & Session

- [ ] Enter wrong PIN (e.g. `0000`) → "Incorrect Admin PIN" alert, stays locked.
  Result: _____  Notes: ______________________________________________

- [ ] Enter correct PIN `1234` → unlocks into the Dashboard, sidebar/nav visible.
  Result: _____  Notes: ______________________________________________

- [ ] **Lockout:** enter wrong PIN 5 times in a row → further attempts blocked for ~30 seconds (message should indicate lockout). Wait it out, confirm you can log in again after.
  Result: _____  Notes: ______________________________________________

- [ ] **Logout:** click the sidebar Logout button → returns to lock screen; refreshing the page does NOT auto-log you back in.
  Result: _____  Notes: ______________________________________________

- [ ] **Session persists across reload:** log in, refresh the browser tab → stays logged in (no re-prompt) as long as the server hasn't restarted.
  Result: _____  Notes: ______________________________________________

---

## 2. Dashboard tab

- [ ] Four stat tiles render: Today's Revenue, This Month's Revenue, Outstanding Advances, Active Gold Rate (22K). Values are ₹0 / empty on a fresh dataset — fine.
  Result: _____  Notes: ______________________________________________

- [ ] "Purity Mix — Lifetime Revenue Share" bar shows "No sales recorded yet" before any sale exists; after creating sales in Module 3, come back and confirm the bar/legend updates with correct % split across 24K/22K/18K.
  Result: _____  Notes: ______________________________________________

- [ ] "Recent Transactions" and "Recent Advance Deposits" lists populate after you create data in Modules 3 & 4 (shows latest 5 each, newest first).
  Result: _____  Notes: ______________________________________________

- [ ] Click "Refresh" button → button shows "Loading..." then re-enables; "Updated <time>" text updates.
  Result: _____  Notes: ______________________________________________

---

## 3. Billing Desk tab (create a sale)

- [ ] Select purity (24K/22K/18K) → the invoice preview's rate/g and gold-rate badge update.
  Result: _____  Notes: ______________________________________________

- [ ] Enter a weight (e.g. `5`) → Metal Value in the invoice preview updates live (weight × rate).
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** **Bi-directional making charge:** change the % input (e.g. to `12.5`) → the ₹ amount field updates to match. Then edit the ₹ amount directly → the % field re-splits correctly (int.dec boxes). Try an amount larger than metal value → % should clamp at 100 while the ₹ amount stays as typed (deliberate — see `makingPercentFromAmount`).
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** Change GST Tax Slab % → tax line and Grand Total recompute.
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** **Tax mode — Exclusive:** with Settings → Billing set to `Exclusive`, confirm the summary tax row reads `Excl` and the Grand Total is *higher* than Metal + Making (tax added on top).
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** **Tax mode — Inclusive:** switch Settings → Billing to `Inclusive`, reload Billing Desk. Tax row now reads `Incl`, the tax figure *drops* (it is carved out of the price rather than added), and the Grand Total equals the quoted price (Metal + Making − Discount, gross). The Metal/Making/Discount rows are now restated **net of GST** and labelled `(net of GST)`, and a **Taxable Value** subtotal sits above the tax row.
  Result: _____  Notes: ______________________________________________

- [ ] **Printed invoice adds up (both modes):** press **PRINT INVOICE** and, on the print preview, add the visible rows by hand — Metal + Making − Discount should equal **Taxable Value**, and Taxable Value + GST − Advance should equal the **Grand Total**. Do this once in `Exclusive` and once in `Inclusive`. This is the customer-facing check the arithmetic tests back up (§9); it is here because only the rendered slip can confirm the right *values* reached the right *rows*.
  Result: _____  Notes: ______________________________________________

- [ ] **Paise, never sub-paise:** with a bill that divides awkwardly (e.g. 12.5 g @ ₹6,875/g, 12% making, 5% discount, 3% GST), confirm every ₹ figure on the preview shows exactly two decimals — the Grand Total should read `₹94,180.63`, never `₹94,180.625`.
  Result: _____  Notes: ______________________________________________

- [ ] **Legacy tax-mode casing:** stop the server, hand-edit `taxMode` in `backend/data/settings.json` to lowercase `inclusive`, restart, and reload the Billing Desk. The bill must still be computed **Inclusive** (tax row reads `Incl`), and opening Settings → Billing must show the **Inclusive** option preselected. Saving Settings rewrites the value as canonical `Inclusive`.
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** Enter a Discount (%) → discount row appears in preview, Grand Total drops accordingly, and the GST line drops too (tax is charged on the discounted value, not the gross).
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** **Discount toggle:** with a non-zero `Default Discount %` saved in Settings → Billing, the Billing Desk shows a **Remove** button pre-applied. Click it → discount goes to 0, button becomes **Apply**, Grand Total rises. Click again → original discounted total returns exactly. With the default at 0, no button is shown at all.
  Result: _____  Notes: ______________________________________________

- [ ] Enter a **new** 10-digit phone with no advance history → no "Apply Advance" box appears.
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** Enter a phone that HAS an advance balance (create one first via Module 4, then come back) → "Customer Advance Available" box appears; click "Apply Advance" → total reduces by the advance (capped at the pre-advance total, so a large balance drives the total to ₹0 and never negative); click again to remove it. With the advance applied, lower the weight → the redeemed amount re-clamps down to the smaller bill.
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** **Tax base is the whole bill, including making charge.** With a 10 g @ ₹6,875/g sale and making charge set to a large figure (say 30%), note the GST amount. Drop making charge to 0% and watch the GST amount fall — the slab applies to Metal **+** Making, not to metal alone. The summary line names the base: `Taxable Value (Metal + Making)`. Repeat in `Inclusive` mode: the carved-out tax must move with the making charge there too.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Leave weight at 0 and click "SAVE INVOICE" → blocked with "Please enter a valid gold weight."
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** **Partial customer number is refused before it is sent.** Type a valid weight and a 5-digit customer phone, then click **SAVE INVOICE**. It must be blocked *on the field* — the red message reads "Customer phone must be exactly 10 digits — 5 entered", focus jumps to the phone box, and **no** alert appears. Check `backend/data/settings.json`: `invoiceSeqStart` must be unchanged (a refused sale never burns an invoice number). Complete the number to 10 digits → the sale files normally. Clear the field entirely → it also files, as a cash sale.
  Result: _____  Notes: ______________________________________________

- [ ] Fill a valid sale and click "SAVE INVOICE" → "Invoice Saved Successfully!", form resets, preview reverts to Cash Sale/blank.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Click "PRINT INVOICE" → browser print dialog opens showing **the invoice sheet, populated** (not the whole app chrome, and *not a blank page* — this printed blank until 2026-08-09). The left-hand input column, the sidebar, and every button must be absent from the preview.
  Result: _____  Notes: ______________________________________________

- [ ] Go back to Dashboard → new sale appears in Recent Transactions and today's revenue total.
  Result: _____  Notes: ______________________________________________

---

## 3a. Reprint Invoice tab

*Added 2026-08-09. The rule this module exists to keep: a reprint shows what was **filed**, never
what today's settings would price.*

- [ ] Open **Reprint Invoice** and click **SEARCH INVOICES** with every field empty → refused with "Enter an invoice number, phone, or name…", and no results table. (An unfiltered search would dump the whole ledger.)
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Search by the invoice number of a sale you filed in §3 → exactly one row, showing the invoice number, when it was saved, customer, phone and total. Click **Open**.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** The sheet renders with a red **DUPLICATE — REPRINT** stamp in the header, the original invoice number and *original* date, and figures identical to the slip from §3 — Taxable Value, GST and Grand Total all matching to the paise.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** **A reprint is not re-priced.** After opening a duplicate, go to Settings, change the gold rate override and the GST slab, and flip tax mode. Come back, reload, search the *same* invoice and open it again — every figure must be unchanged. If any number moved, the module is re-pricing and is wrong.
  Result: _____  Notes: ______________________________________________

- [ ] Search by the customer's 10-digit phone, and by a fragment of their name → both find the invoice. Search a phone with no sales → "No filed invoice matches that", not an empty table.
  Result: _____  Notes: ______________________________________________

- [ ] Set a **From**/**To** date range around the sale's date → it appears. Narrow the range to exclude it → it does not. A `To` earlier than `From` is refused with a clear message.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Click **PRINT DUPLICATE** → the print preview shows the stamped sheet only. The search box, results table, and both buttons must be absent.
  Result: _____  Notes: ______________________________________________

- [ ] **Pre-Phase-20 invoice (only if your `backend/data/sales_*.json` has one).** Open an invoice filed before `taxableAmount`/`taxAmount`/`taxMode` were stored. It must print its filed Grand Total with the tax row reading *"not recorded on this invoice"* and an amber notice above the sheet — **never** a ₹0.00 GST line, which would assert that no tax was charged.
  Result: _____  Notes: ______________________________________________

---

## 3b. Returns & Refunds tab

*Added 2026-08-11. Three rules this module exists to keep: the refund is priced by the **original
invoice** and never by today; **only the store** can issue one; and an invoice can never give back
more than it took.*

- [ ] Open **Returns & Refunds** and click **FIND INVOICE** with every field empty → refused with "Enter an invoice number, phone, or name…", no results table.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Search the invoice number of the sale you filed in §3 → one row showing weight, a `—` in the Returns column, the billed total, and a **Return** button. Click it. The form opens with the weight box defaulted to the full weight.
  Result: _____  Notes: ______________________________________________

- [ ] **[math automated]** Enter a **partial** weight (say 4g of a 10g invoice). The preview itemises metal, making, discount (if any) and GST, and the REFUND line equals the sum. It states how much would remain returnable.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** With **Cash** selected, click **FILE RETURN & REFUND** and confirm → a **CREDIT NOTE** sheet appears, marked *RETURN & REFUND*, naming the credit-note number and the original invoice. The figure matches the preview exactly.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** **A cash refund is not store credit.** Check the customer's balance in the Advances tab before and after → unchanged. Then check the Reprint Invoice tab → the original invoice still reprints with its *original* total. Returns never rewrite an invoice.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Search the same invoice again → the row now reads "4.000 g returned", and reopening the form offers only the remaining 6g. Typing more than that is refused inline and the FILE button greys out.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Return the remaining weight → the note says the invoice is fully returned, and searching it again shows **Fully returned** with the button disabled. **The two refunds must sum to exactly the invoice's billed total** (add them up by hand; if they are a paisa out, the true-up is broken).
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** **Gold refund.** File a sale against a customer *with* a phone number, return it choosing **Gold**, then check that customer in the Advances tab → an approved deposit for the refund amount, described as a return credit against that invoice. Start a new bill for them → **Apply Advance** offers it immediately, with no approval step.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** **Walk-in with no phone.** Open a return against a cash sale filed without a customer number → the Gold option is disabled with an explanation, and Cash is preselected. There is no account to credit.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** **A return is not re-priced.** After filing a sale, change the gold rate override, the GST slab and the tax mode in Settings. Reload, open a return against that invoice → the preview must still quote the *original* rate and slab. If any figure moved, the module is re-pricing and is wrong.
  Result: _____  Notes: ______________________________________________

- [ ] **An invoice that redeemed an advance refunds the full charge.** Return a sale that used advance credit → the refund is `total + advance redeemed`, not the cash the customer handed over. (The advance was their money too.)
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** Click **PRINT CREDIT NOTE** → the print preview shows the note only. Search box, results table, the Recent Returns list and both buttons must be absent.
  Result: _____  Notes: ______________________________________________

- [ ] **[e2e automated]** The **Recent Returns** list at the bottom shows every filed return with its mode (CASH / GOLD CREDIT), and **Note** reopens any credit note.
  Result: _____  Notes: ______________________________________________

- [ ] **Pre-Phase-20 invoice (only if your `backend/data/sales_*.json` has one).** Return against one → the refund is a straight pro-rata share of the filed total and the note says the itemised breakdown was *not recorded on the original invoice*. Never an invented GST line.
  Result: _____  Notes: ______________________________________________

---

## 4. Customer Advances tab

- [ ] Click "+ New Deposit" → form expands. Try submitting with a phone under 10 digits → blocked with validation alert.
  Result: _____  Notes: ______________________________________________

- [ ] Submit a valid manual deposit (10-digit phone, name, amount, method) → success alert, form clears/hides, new row appears in the table with correct balance.
  Result: _____  Notes: ______________________________________________

- [ ] Use the search box to filter by phone or name → table filters live.
  Result: _____  Notes: ______________________________________________

- [ ] Click "View" on a customer row → expands a ledger drill-down showing deposit/redemption history with correct +/− signs and dates; click "Hide" to collapse.
  Result: _____  Notes: ______________________________________________

- [ ] Redeem part of that customer's advance in Billing Desk (Module 3) → return here, refresh → balance reduced by the redeemed amount, drill-down shows a "Redeemed at Billing" entry referencing the invoice ID.
  Result: _____  Notes: ______________________________________________

---

## 5. Settings → Store Profile

- [ ] Edit Company Name, Phone, Address, GST Number, Currency → Save → success alert.
  Result: _____  Notes: ______________________________________________

- [ ] Upload a logo image (small PNG/JPG) → preview updates; Save → go to Billing Desk, confirm the logo now appears on the invoice preview header (replacing the text company name).
  Result: _____  Notes: ______________________________________________

- [ ] Click "Clear Logo" → preview clears; Save → logo removed from invoice too.
  Result: _____  Notes: ______________________________________________

- [ ] **Admin PIN is masked.** The Admin PIN box shows `••••••••`, not the real PIN. Edit Company Name only and Save, then log out and log back in with your *existing* PIN → it still works (saving an unrelated field must not overwrite the PIN with the mask).
  Result: _____  Notes: ______________________________________________

- [ ] Type a new PIN over the mask (e.g. `4321`) → Save → log out → the new PIN works and the old one does not. Set it back afterwards.
  Result: _____  Notes: ______________________________________________

---

## 6. Settings → Gold Pricing & Overrides

- [ ] Click "Sync Price Now" → succeeds (needs internet — Yahoo Finance XAU) and Billing Desk's live rate updates.
  Result: _____  Notes: ______________________________________________

- [ ] Enable "manual overrides", set custom 24K/22K/18K prices, Save → Billing Desk and Dashboard now show your override values with a "Manual Override" badge instead of "Auto Midnight".
  Result: _____  Notes: ______________________________________________

- [ ] Disable overrides again, Save → rates revert to the auto-synced values.
  Result: _____  Notes: ______________________________________________

---

## 7. Settings → Billing & Invoice

- [ ] Change GST Tax Slab and Invoice Prefix → Save → succeeds.
  Result: _____  Notes: ______________________________________________

- [ ] Change Admin PIN to something else, Save, Logout, log back in with the NEW pin → works. (Set it back to `1234` after, or note the new value here: ___________ )
  Result: _____  Notes: ______________________________________________

- [ ] **Destructive guard:** lower "Next Invoice Sequence Number" below its current value → a confirmation prompt appears requiring you to type `LOWER SEQUENCE` exactly. Cancel it (type something wrong or dismiss) → save is aborted, "Cancelled" alert shown, nothing changed.
  Result: _____  Notes: ______________________________________________

- [ ] Repeat but type `LOWER SEQUENCE` correctly → save succeeds.
  Result: _____  Notes: ______________________________________________

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

- [ ] Add two people — one **Cashier** with PIN `4321`, one **Manager** with PIN `8765` — and Save.
  The PIN boxes go blank and their placeholders change to `unchanged`; the two names persist on a
  page reload.
  Result: _____  Notes: ______________________________________________

- [ ] Save again **without retyping either PIN** → both still work at the lock screen. (This is the
  write-only round-trip: a save that masked the PINs must not blank them.)
  Result: _____  Notes: ______________________________________________

- [ ] Give both people the **same PIN** and Save → refused, with a message naming both. Give one the
  **master PIN** → refused. Leave a new person's PIN **blank** → refused, naming them.
  Result: _____  Notes: ______________________________________________

- [ ] Log out, sign in with `4321` → sidebar reads `Signed in: <name> (cashier)`. Bill a sale, then
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

## Notes / issues found (free space)

_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
