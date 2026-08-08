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

This runs two suites and exits non-zero on any failure:

| Suite | Covers |
| --- | --- |
| `npm run test:billing` | Invoice money math — discount ordering, GST inclusive/exclusive, advance capping, making-charge %/₹ conversion, NaN hardening, printed rows reconciling to the Grand Total, paise settlement (57 checks) |
| `npm run test:integration` | Troy-ounce conversion, licensing grace periods, crypto envelopes, customer password hashing (scrypt round-trip, salt uniqueness, tampered-hash rejection), login-lockout escalation |

Items below marked **[math automated]** have their *arithmetic* verified by
`test:billing` — you are only confirming the UI is wired to it (right field,
right row, updates live). If the numbers themselves are wrong, `npm test`
should have caught it before you got here.

---

## 0. Setup

- [ ] `cd backend && npm test` is green. Three suites run in order: `test_billing_math.js` (pricing/rounding), `test_suite.js` (helper-level integration), then `test_routes.js` (HTTP routes + auth boundary). The third boots a real server on an ephemeral port against a temp data directory, so it is safe to run with a dev server already up on :5000.
  Result: _____  Notes: ______________________________________________

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

- [ ] Leave weight at 0 and click "SAVE INVOICE" → blocked with "Please enter a valid gold weight."
  Result: _____  Notes: ______________________________________________

- [ ] Fill a valid sale and click "SAVE INVOICE" → "Invoice Saved Successfully!", form resets, preview reverts to Cash Sale/blank.
  Result: _____  Notes: ______________________________________________

- [ ] Click "PRINT INVOICE" → browser print dialog opens showing just the invoice sheet (not the whole app chrome).
  Result: _____  Notes: ______________________________________________

- [ ] Go back to Dashboard → new sale appears in Recent Transactions and today's revenue total.
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

---

## 9. Settings → Backup & Email Reports

- [ ] Click "Create Backup Now" → status line shows "Backup created: backup_<date>"; confirm a new dated folder appears under `backups/` on disk.
  Result: _____  Notes: ______________________________________________

- [ ] Leave SMTP fields blank, click "Send Daily Report Now" → status shows a skip reason (not an error) since SMTP isn't configured.
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

- [ ] **[auto]** Enter a valid amount (e.g. `5000`) on "Online Payment (Razorpay)" → demo keys auto-mock: "TEST MODE: Razorpay mock payment verified successfully!" and the balance updates immediately.
  Result: _____  Notes: ______________________________________________

- [ ] Switch to "Manual UPI" → QR renders (once a UPI ID is set per Module 8) with the amount encoded; changing the amount live-updates the QR.
  Result: _____  Notes: ______________________________________________

- [ ] Submit Manual UPI with no Transaction Reference ID → blocked.
  Result: _____  Notes: ______________________________________________

- [ ] Submit Manual UPI with a reference ID → success; the deposit appears on the admin Advances tab under **your account's** name, not anything typed in the request. *(Known gap: this still posts real credit on an unverified reference — see `docs/PRODUCTION_READINESS_ROADMAP.md` §3 P0 "Manual UPI creates unverified credit".)*
  Result: _____  Notes: ______________________________________________

- [ ] **[auto]** History tab lists your deposits with date, ref ID, type, amount — and **only** yours.
  Result: _____  Notes: ______________________________________________

- [ ] **Gold Appreciation Calculator:** note "Current Day Worth" on the Profile tab. In `backend/data/advances.json`, lower `lockedGoldRate22K` on one of this customer's deposits, save, reload → "Current Day Worth" and "Appreciation" recompute against your edited locked rate.
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

- [ ] With SMTP unconfigured (Module 9), click "Forgot password?" → a clear "contact the store" message, not an error.
  Result: _____  Notes: ______________________________________________

- [ ] With SMTP configured and an email saved on the account, request a reset → a 10-character code arrives by email; entering it sets a new password, and entering it a second time is refused.
  Result: _____  Notes: ______________________________________________

### 12e. Two windows, two customers (the isolation check)

- [ ] Sign in as customer A in one browser profile and customer B in another (or one normal + one incognito window). Confirm each sees only their own balance and history, and that neither can reach the other's by editing anything on screen.
  Result: _____  Notes: ______________________________________________

---

## 13. Cross-cutting / edge cases

- [ ] Open `http://localhost:5000/api/settings` directly in browser (no auth header) → should be rejected (401), confirming admin-gated endpoints aren't accessible unauthenticated.
  Result: _____  Notes: ______________________________________________

- [ ] Open `http://localhost:5000/api/advances/lookup?phone=<a real customer number>` directly in the browser → **401**, not that customer's ledger. Same for `http://localhost:5000/api/customer/advances`. Before Phase 20.1 the first of these returned real customer data to anyone who asked.
  Result: _____  Notes: ______________________________________________

- [ ] While logged into the admin terminal, wait past a server restart (restart the server, don't refresh the tab), then click any admin action (e.g. Dashboard refresh) → bounces you back to the lock screen (session invalidated) rather than erroring silently.
  Result: _____  Notes: ______________________________________________

- [ ] Enter a customer name containing `<script>` or `"` characters in Billing Desk or the Advances deposit form → check it renders as literal text (escaped) in Dashboard/Advances lists, not executed — confirms the stored-XSS escaping holds.
  Result: _____  Notes: ______________________________________________

---

## Notes / issues found (free space)

_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
_____________________________________________________________________
