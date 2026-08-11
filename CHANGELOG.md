# Changelog

All notable changes to the Gold Business POS platform are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versions follow
[Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **MAJOR** — breaking changes to data shape, APIs, or licensing/crypto formats.
- **MINOR** — new backward-compatible features (e.g. a new tab, a new endpoint).
- **PATCH** — bug fixes and security hardening with no behavior changes for
  existing, correctly-formed usage.

## Release channels

Every published release is tagged with a channel, which determines how it
reaches a live tenant (see `docs/ai_handover.md` §7 for the full mechanism):

| Channel    | Meaning                                            | Rollout                          |
|------------|-----------------------------------------------------|-----------------------------------|
| `security` | Fixes a vulnerability or a data-integrity bug       | Auto-applied (signature-verified, backed up, rollback on failure) |
| `feature`  | New functionality, no urgency                       | Manual — tenant clicks "Apply Update" |
| `patch`    | Minor bug fix, cosmetic, non-urgent                 | Manual — tenant clicks "Apply Update" |

An auto-applied release **never** touches `backend/data/`, `backend/logs/`,
`backend/backups/`, `.env`, or anything under `keys/` — only application code
files are replaced. A full pre-patch backup and a code snapshot are always
taken first, and a failed apply automatically rolls back to the previous
working version. See `backend/updateEngine.js`.

---

## [Unreleased]

Customer identity and authentication (Phase 20.1), plus credential redaction
and dependency hardening (Phase 20.2). Ships as a **`security`** channel
release when cut — it closes an unauthenticated data-exposure hole, stops
credentials being served to the browser, and it changes who may call four
existing endpoints.

### Security

- **Online payments are now confirmed with Razorpay before any credit is
  given.** A valid checkout signature only proves that a payment id was issued
  against an order — it carries no amount and no outcome, so a payment that was
  authorised but never captured, one that later failed, one already refunded,
  and one captured for the wrong amount all produced a signature that verified.
  The server now asks the gateway what actually happened and credits only a
  captured payment for the exact amount its order was created for.
- **New Razorpay webhook (`POST /api/payment/webhook`).** Razorpay confirms
  payments server-to-server, which is what credits a customer whose browser or
  network dropped out between paying and returning to the portal — previously
  that money was taken and never appeared in the ledger. Deliveries are
  signature-verified against a **new Webhook Secret** in Settings → Payments;
  until that secret is saved the endpoint accepts nothing, so upgrading changes
  no behaviour until the webhook is deliberately configured.
- **Production installs refuse to start when misconfigured.** A server started
  with `NODE_ENV=production` now exits immediately, listing every problem, if it
  is still carrying the demo Razorpay credentials, the default `1234` admin PIN,
  the mock gold-price provider, no webhook secret, no https public URL, or a
  contradictory environment name. Previously such an install started normally
  and only failed at the moment a real customer tried to pay.
- **Invoices are priced by the server, not the till.** The gold rate and metal
  value on a saved invoice now always come from the store's own active rate for
  the selected purity; the browser's figures are used only to detect that the
  on-screen preview has gone stale, in which case the cashier is told to
  reprint. Invoice dates are likewise taken from the server clock, so a
  workstation with a wrong clock can no longer file a sale into the wrong year.
- **Ledger identifiers are now cryptographically random** rather than derived
  from `Math.random()`, which was both collision-prone at volume and guessable.
- **The customer portal now requires a password.** Previously, typing *any*
  10-digit number into `customer.html` opened that customer's full advance
  ledger, balance and deposit history, and allowed depositing against their
  account. There was no credential of any kind. Customers now register (or are
  issued a login at the counter) and sign in with a password hashed using
  Node's built-in `crypto.scryptSync` — no new dependency, no plaintext stored.
- **Four endpoints that were public are now gated.** `GET /api/advances/lookup`
  and `POST /api/advances` require an **admin** session (they can name any
  customer's phone, so they are cashier actions); `POST /api/payment/order` and
  `POST /api/payment/verify` require a **customer** session. Customers read and
  write their own records through the new `/api/customer/*` routes instead.
- **Customer-facing routes are scoped to the session, never to a phone in the
  request.** A deposit posted from the portal is credited to the phone on the
  bearer token; a `customerPhone` supplied in the body is ignored. The
  customer's name likewise comes from their account, which also removes the
  customer-supplied-name path behind the stored-XSS fix in 1.0.1.
- **Replayed gateway payments no longer double-credit.** `POST
  /api/payment/verify` now returns the original deposit when it sees a
  `razorpay_payment_id` already present in the ledger, instead of appending a
  second row.
- **Brute-force protection on customer sign-in**, mirroring the admin PIN
  limiter added in 1.0.1: five wrong passwords lock the account with an
  escalating 30s→15min cooldown (persisted, so a restart does not clear it),
  plus an in-memory per-IP cooldown against credential stuffing across many
  accounts. Sign-in responses are identical for "no such account" and "wrong
  password", so the endpoint cannot be used to discover which mobile numbers
  belong to the store's customers.
- **Stored credentials are no longer sent to the browser.** `GET /api/settings`
  returned `settings.json` verbatim, putting the Razorpay key secret, the SMTP
  password and the admin PIN into the Settings page — readable in DevTools and
  captured by any HAR or screen recording. The route is admin-gated, so this
  was exposure rather than an open door, but the credentials had no reason to
  leave the server at all. They are now masked as `••••••••` on the way out;
  the Settings screen posts the mask back untouched and the server restores
  the stored value, so saving an unrelated field cannot overwrite a secret.
  Retyping a field still replaces it normally, and an unconfigured credential
  stays blank so "not set" and "set but hidden" remain distinguishable.
- **The Level-2 diagnostics export no longer carries live credentials.**
  Settings inside the encrypted support bundle are masked the same way,
  following the precedent already set for `customer_auth.json`: diagnosing a
  tenant needs to know whether SMTP and Razorpay are *configured*, never what
  the values are.
- **`npm audit` is clean.** nodemailer `6.x` → `9.x` clears eight advisories
  including SMTP command injection via `envelope.size` and CRLF header
  injection; node-cron `3.x` → `4.x` clears a transitive `uuid` buffer bounds
  check. Both are major-version bumps and were verified against this
  codebase's actual usage before landing; no application code changed.

### Added

- **Returns & Refunds tab.** Refund part or all of a filed invoice and print a
  **CREDIT NOTE** for it. The refund is priced from the invoice itself — the
  gold rate, making charge, discount and GST it was sold under — never from
  today's rate, so a return months later gives back exactly what was charged
  rather than whatever the market has done since. Returns can be **partial by
  weight**: an invoice can come back 6g today and the rest next week, the desk
  always measures against what is left, and however an invoice is split up the
  refunds add back to its billed total to the paise. Refund the customer in
  **cash**, or as **gold credit** that lands in their account and is spendable
  against their next bill immediately.

  Only the store can issue a return — there is no way to raise one from the
  customer portal — but customers **see** theirs on their phone the moment it
  is filed, listed in their history against the invoice it came from. A gold
  refund shows up as return credit in their balance and in the Money Worth in
  Gold panel; a cash refund is listed without touching the balance, because it
  was handed over the counter.

  Filed invoices are never rewritten by a return, so reprints still reproduce
  the original document exactly. Invoices from before this version recorded a
  tax breakdown are refunded pro-rata with the itemisation marked *not
  recorded* rather than invented. Summary report emails now show gross sales,
  returns and net revenue whenever a period contains a refund.
- **Reprint Invoice tab.** Find any filed invoice by its number, the customer's
  phone, their name, or a date range, and print a second copy stamped
  **DUPLICATE — REPRINT**. Every figure is the one written to the ledger when
  the sale was saved — a reprint is never re-priced against the current gold
  rate or tax settings, so a duplicate handed over months later still matches
  the customer's original slip and the books. Invoices filed before this
  version recorded a tax breakdown print their filed total with the tax line
  marked *not recorded* rather than as ₹0.00.
- `POST /api/customer/register` (self-service), `/login`, `/logout`,
  `GET|PATCH /api/customer/me`, `/password/change`, `/password/forgot`,
  `/password/reset`, `GET|POST /api/customer/advances`.
- **Counter-issued logins** — `POST /api/customer-accounts/issue-login`
  (admin) returns a one-time temporary password for the store to hand over,
  and `GET /api/customer-accounts` lists who has a portal login. Reissuing for
  an existing account is confirmation-gated (`409 CONFIRMATION_REQUIRED`,
  the same pattern as lowering the invoice sequence) because it signs the
  customer out of every device.
- **Password reset by email** — a single-use 10-character code, valid 30
  minutes, sent through the tenant's existing SMTP configuration via a new
  reusable `sendMailIfConfigured()` in `emailReporter.js`. Degrades with a
  clear message when the store has not configured SMTP. A code rather than a
  reset link, deliberately: building a link server-side would mean trusting the
  caller-controlled `Host` header, which would let a forged request mail a real
  customer a valid token pointing at somebody else's site.
- **Account tab in the portal** — edit name/email, set email notification
  preference, change password.
- **"Customer Logins" tab in the admin terminal.** The two counter-issued-login
  endpoints above shipped without any screen behind them, so issuing a login to
  a customer who already had deposit history — the only supported way for such a
  customer to get one — was not actually possible from the app. The tab lists
  every portal login with its state (active, temporary password not yet
  changed, or locked out and for how long), issues and resets logins, and shows
  the one-time temporary password in the page rather than in a dismissible
  alert.
- **Pending-deposit approval queue** in the Advances tab, showing each claimed
  transfer with its reference and how long it has been waiting, plus
  `GET /api/advances/pending` and `POST /api/advances/:id/approve|reject`.
- New `backend/data/payment_orders.json`, seeded on boot — what each payment
  order was created for. Pruned automatically (24-hour retention); the advance
  ledger remains the permanent record.
- New `backend/data/customer_auth.json`, seeded on boot. Excluded from the
  Level-2 diagnostics export bundle: a support export should never carry
  credential material off the tenant's machine, even encrypted. Only scrypt
  hashes and SHA-256 hashes of session/reset tokens are ever written to it.

### Changed

- **Customer sessions survive a server restart** (30-day expiry, up to 5
  devices), unlike admin sessions which remain in-memory. A cashier can retype
  a PIN; a customer on a phone should not be signed out every time the store's
  server restarts for a nightly update.
- The portal's onboarding screen (first/last name, DOB, anniversary) is gone —
  the name now comes from the account at registration. The DOB and anniversary
  fields were never persisted anywhere, so no data is lost.
- **A manual-UPI deposit is now a claim, not a credit** (this closes the gap
  this section previously listed as outstanding). Submitting a UPI reference
  from the portal records the deposit as **pending**: the customer sees the
  amount acknowledged as "awaiting the store's confirmation", but it adds
  nothing to their balance and cannot be redeemed against a bill until a
  cashier approves it. Previously an authenticated customer could type any
  amount with any invented reference and immediately hold spendable credit.
  Approve/reject lives in the Advances tab; rejecting requires a reason and the
  row is kept for the record rather than deleted.
- **Payment amounts are bound to the order the store created.** Razorpay's
  signature covers `order_id|payment_id` only — the amount is not in the signed
  text — so `POST /api/payment/verify` used to credit whatever `amount` the
  caller put in the request body. A customer could create a ₹100 order, pay it,
  and post back ₹500,000. Orders are now persisted at creation with the
  customer and the amount, and verification credits the **stored** amount,
  ignoring the body entirely. An order can also only be verified by the
  customer who opened it, and an unrecognised order id is refused.
- **A payment reference can only be used once.** The same UTR submitted twice
  is refused (case- and whitespace-insensitive), so one real transfer cannot be
  claimed repeatedly across several plausible-looking rows.
- **Deposit rows gained a `status` field.** Existing rows without one are
  treated as approved, so no tenant's balances change on upgrade — this is
  additive and backward-compatible.

### Fixed

- **"Print Invoice" printed a blank page.** The print stylesheet hid every tab
  panel except one identified by a name that no longer existed, which meant it
  hid the invoice it was supposed to print. Both the Billing Desk and the new
  Reprint tab now print the invoice sheet, with the sidebar, the input column
  and every button left off the customer's copy.
- **A forgotten customer password no longer needs a trip to the store.**
  "Forgot password?" used to refuse to open at all unless the store had set up
  email, dismissing the customer with a message and no next step. It now always
  opens and explains the situation in place. Self-service signup requires an
  email address, since an account without one can never be reset by its owner,
  and a customer whose account has no email on file is prompted to add one the
  next time they sign in. Store owners see, on the SMTP settings screen itself,
  whether customer password reset is currently working — it previously read as
  a reporting-only setting, so a store that skipped it had no way to know it had
  also switched off every customer's reset.
- **A partial customer phone number no longer reaches the ledger as a failed
  save.** Typing fewer than ten digits and pressing Save produced a generic
  "Failed to save invoice" that named no field. The Billing Desk now flags the
  phone box itself before sending anything, and no invoice number is consumed.
  Leaving the field empty still files a cash sale as before.
- **The Dashboard's "Outstanding Advances" tile, the Advances tab's
  per-customer balances, and the server's own ledger calculation each summed
  the advances file separately.** They now share one set of helpers in
  `frontend/js/lib/billingMath.js`, so a deposit awaiting approval cannot show
  up as spendable credit in one place while being excluded in another. The
  customer portal's Gold Appreciation panel uses the same rule, so the grams it
  reports match the balance shown above it.

## [1.2.0] — 2026-08-07

### Added
- **Tax Mode Configuration:** Added Tax Mode (Inclusive/Exclusive) to System Settings, with automatic recalculation of taxable values versus total amounts on the Billing Desk.
- **Default Discount Configuration:** Added a Default Discount (%) setting (capped at 99%, integers only) in System Settings.
- **Settings schema migration on boot** (`migrateSettings()` in `backend/db.js`)
  — an existing tenant's `settings.json` is now brought up to the current
  template every time the server starts: keys added since their install are
  filled in with defaults, retired keys are deleted, and narrowed enums are
  normalized. Existing values always win; the file is only rewritten when
  something actually changed. Previously a key added to the template only ever
  reached brand-new installs (see Fixed).
- **`test.bat`** now runs both suites (integration + billing arithmetic) and
  exits non-zero if either fails.
- **Dev/Sandbox/Live deployment pipeline** — `GET /api/health` on `backend`
  and `licensing_server`; per-environment PM2 configs
  (`deploy/ecosystem.{dev,sandbox,live,licensing-nonprod,licensing-live}.config.cjs`);
  a shared `deploy/remote-deploy.sh`; three GitHub Actions workflows
  (`cd-dev.yml`, `cd-sandbox.yml`, `cd-live.yml`) with a manual-approval gate
  before Live. This is the platform owner's own internal promotion pipeline,
  separate from the existing per-tenant manual update process. See
  `deploy/README.md` §8. Not yet exercised end-to-end — no VPS/domain
  provisioned yet.
- **`deploy/provision-pipeline.sh`** — one idempotent, root-run command that
  performs all of `deploy/README.md` §8.2 on a fresh Ubuntu VPS: base packages
  and Node 20, the low-privilege `deploy` user and CI public key, `ufw`, the 5
  git checkouts under the exact directory names `cd-*.yml` hardcodes, their 5
  `.env` files (correct ports, per-environment licensing URLs, freshly
  generated `ADMIN_SECRET`s), 5 PM2 apps with boot persistence, signing-key
  distribution, 5 Nginx vhosts, and Let's Encrypt certs — then health-checks
  all five and prints the GitHub secret/variable values to set. Existing
  `.env` files and certificates are never overwritten on a re-run.
- **Automated billing-arithmetic coverage** — `backend/test_billing_math.js`,
  57 checks over the invoice money pipeline: discount-before-tax ordering, GST
  Inclusive vs Exclusive, advance redemption and re-clamping, the
  bi-directional making-charge %/₹ conversion, and NaN/blank-input hardening.
  Two sections pin the invoice fixes above: §9 adds the printed rows the way a
  customer would and asserts they reach the Grand Total across both modes, six
  slabs, five discounts and an advance; §10 asserts no returned figure carries
  sub-paise precision. Expected values are worked out by hand from the inputs
  rather than by re-running the production formula, and the suite was
  mutation-tested (four deliberate breakages — wrong discount order, inclusive
  multiply-instead-of-divide, missing advance cap, discount skipping the making
  charge — each produced failures). Run via `npm test` in `backend/`, which
  also runs the pre-existing `test_suite.js`; both exit non-zero on failure.
  This replaces the "eyeball the preview" items in `docs/TESTING_CHECKLIST.md`
  §3, now marked **[math automated]** and reduced to confirming UI wiring.

### Changed
- **Billing math extracted to `frontend/js/lib/billingMath.js`** — the invoice
  pipeline previously lived inline in `BillingDesk.recalculateSummaryOnly()`,
  interleaved with DOM writes and therefore untestable outside a browser. It is
  now a pure, DOM-free module that the component consumes; arithmetic behavior
  is unchanged. `frontend/package.json` was added solely to mark the frontend
  sources as ES modules so Node can import them — browsers ignore it.
  `backend/server.js` imports the same module for its authoritative recompute
  (see Fixed), so the cashier's preview and the persisted ledger run identical
  code. It lives under `frontend/` deliberately: `release_pipeline.js` and
  `updateEngine.js` both ship and replace `backend/` and `frontend/` as a
  pair, so an update can never leave the two sides on different copies of the
  math.
- **Billing Desk Lockdowns:** The GST Tax Slab and Discount fields in the Billing Desk are now frozen. The Tax Slab strictly follows the system settings, and the Discount can only be toggled (Applied/Removed) based on the default discount configuration rather than manually entered.
- **UI Layout Enhancements:** Implemented sticky "Excel-like freeze" headers and toolbars for the Dashboard and Advances screens. Fit the billing layout into 1 page by reducing line spaces and removing unnecessary top rows.
- **Tax Slab Standardization:** Converted the Tax Slab input in Settings to a dropdown menu with standard Indian GST rates (0%, 3%, 5%, 12%, 18%, 28%).
- **Currency Selection:** Upgraded the Currency field in Settings to a dropdown menu featuring major options (INR, USD, EUR, GBP, AED, SGD).
- **Gold API Simplification:** Removed paid API providers (GoldAPI, Metals.dev) and the associated API Key field from the Gold Rate Source settings, keeping only the free Yahoo Finance and Mock providers.
- **Gold API removal completed in the backend** — the UI dropped the paid
  providers, but `priceEngine.js` still branched on `goldapi`/`metalsdev` with
  `settings.goldApiKey`, and both settings templates still seeded that key.
  Those branches and the key are gone; a tenant carrying a legacy provider
  value is normalized to `public` (the working keyless source) rather than
  silently falling through to mocked prices, and the now-unused API key is
  deleted from their `settings.json` by the boot migration.
- **Single canonical settings template** (`backend/defaultSettings.js`) — the
  default settings object was maintained by hand in two places (`db.js` and
  `release_pipeline.js`) that had already drifted apart. Both now derive from
  one exported template; the release build only overrides the two Razorpay
  demo keys it must blank. Adding a settings key is now a one-line change that
  reaches fresh installs, release bundles, and existing tenants alike.
- **Dashboard Cleanup:** Removed the "Purity Mix - Lifetime Revenue Share" chart from the Dashboard as requested.

### Fixed
- **Deployed backends would have rejected every license activation and every
  release.** `backend/keys/license_public.pem` and `release_public.pem` are
  tracked files, while the licensing server's matching private keys are
  gitignored — so a licensing server deployed to a real VPS generates a brand
  new keypair on first boot, and no backend on that server has the public half
  that matches it. Worse, the `git reset --hard` in `deploy/remote-deploy.sh`
  reverted any hand-corrected public key on the next deploy. Signing keys are
  now pinned in `/opt/gold-pos/keys/<checkout>/`, outside every checkout, and
  `remote-deploy.sh` re-applies them immediately after the reset. Found while
  writing `provision-pipeline.sh`; never hit in production because no VPS has
  been provisioned yet.
- **Settings Validation:** Added a real-time keystroke listener to the Default Discount setting to strictly prevent typing numbers over 99 or using decimals.
- **Billing Desk no longer renders `₹NaN`:** a blank or non-numeric weight /
  making-charge field previously propagated `NaN` through the summary rows and
  the Grand Total. The extracted math module coerces non-finite inputs to 0.
- **Making charge with no metal value:** editing the ₹ making-charge box before
  entering a weight left the percentage boxes showing a stale value. The
  conversion now reports the percentage as undecided and leaves those boxes
  untouched until a weight exists.
- **`taxMode` and `defaultDiscountPercent` were never in any settings
  template.** Both keys were read by `BillingDesk.js` and written by
  `SettingsManager.js`, but were absent from `db.js`'s `defaultSettings` and
  from the release bundle's template — so a fresh install and every existing
  tenant read `undefined` for both until somebody happened to open Settings
  and press Save. Both are now in the canonical template, and the new boot
  migration back-fills them for tenants who never did.
- **The server no longer trusts the client's `totalAmount`.** `POST /api/sales`
  validated that the submitted total was a finite non-negative number but
  never recomputed it, so the entire inclusive/exclusive tax and
  percentage-discount pipeline existed only in the browser — a stale cached
  bundle, or settings changed underneath an open tab, would persist a wrong
  total to the permanent ledger. The route now recomputes every money field
  from the shared `billingMath.js` module using the **server's own** tax slab
  and tax mode, and stores that; `makingChargeAmount` and `discountPercent`
  gained the validation the other numeric fields already had. A divergence
  logs a `SALE_TOTAL_MISMATCH` line and returns `totalCorrected: true`, on
  which the Billing Desk tells the cashier to reprint rather than letting the
  printed slip disagree with what was filed. The route is admin-gated, so this
  is a data-integrity fix, not a closed attack surface.
- **An inclusive-GST invoice did not add up.** With Tax Mode set to
  `Inclusive`, the Metal Value and Making Charges rows printed gross of tax
  while the Grand Total was the tax-inclusive price, so the tax appeared twice:
  a customer adding the printed lines got a figure too high by exactly the tax
  amount. The arithmetic was always self-consistent — this was what the invoice
  *displayed*. An invoice that prints a tax line must state the lines above it
  net of that tax, so in inclusive mode each line is now carved down by the
  same factor applied to the total and labelled `(net of GST)`; a **Taxable
  Value** subtotal was added so the two halves visibly reconcile. Exclusive
  mode is unchanged (its rows already summed). `computeInvoiceTotals` returns
  the per-line figures as `components`, with the metal line absorbing the
  rounding residual so `metal + making − discount === taxableAmount` holds to
  the paise at every slab. The gross figures remain available (and are still
  what the item table quotes) as `components.grossMetalValue` /
  `grossMakingCharge`.
- **Money is now settled to paise at the point it is computed.** Totals were
  carried at full float precision, so a routine bill could produce a
  `totalAmount` of `94180.625` — not an amount anyone can pay, display, or
  file. `computeInvoiceTotals` now rounds every figure it returns, once, at the
  source, so the cashier's preview, the printed slip, the POSTed payload and
  the stored ledger record all quote the identical number instead of each
  rounding independently. In inclusive mode the tax is taken as the *remainder*
  after carving out the rounded taxable value rather than being rounded on its
  own, which guarantees `taxableAmount + taxAmount` reconstructs the quoted
  price exactly. `server.js` already rounded on write, so **records already in
  `sales_*.json` are untouched and no historical data was rewritten**; those
  rows keep whatever precision they were stored with, and only the in-flight
  figures change.
- **`taxMode` was matched case-sensitively.** Only the exact string
  `'Inclusive'` selected inclusive pricing — a `settings.json` holding
  `inclusive` (hand-edited, restored from a backup, or written by an older
  build) silently billed *Exclusive*, adding the slab on top of a price that
  already contained it and overcharging by the tax. Matching now runs through a
  shared `normalizeTaxMode()` helper and is case- and whitespace-insensitive;
  anything unrecognised still falls back to `Exclusive`, which never
  understates tax collected. Both `billingMath.js` and `server.js` resolve the
  mode through it, so the two halves can no longer end up in different modes,
  `POST /api/settings` canonicalises the value on write, and the Settings
  dropdown reads it back through the same helper so a legacy value preselects
  the mode actually being billed.
- **`test.bat` never ran anything.** It killed whatever held port 5000, printed
  "Server has stopped unexpectedly", and exited.

### Fixed (second stress-testing pass, targeting the extension/update-engine/licensing-server surface added in 1.1.0)
- **Critical:** `licensing_server`'s admin auth (now also the gate on
  publishing code releases that auto-apply to every tenant) had zero
  brute-force protection — confirmed 335 req/s sustained with no lockout —
  and used a non-constant-time string comparison. Added the same IP-keyed
  lockout as the POS admin PIN (5 failures → 30s, doubling to 15 min),
  `crypto.timingSafeEqual` for the comparison, and a startup warning if the
  documented default `ADMIN_SECRET` was never changed.
- **High:** `updateEngine.js`'s zip extraction (`Expand-Archive` on
  Windows) correctly refuses a path-traversal ("zip-slip") entry like
  `../../../evil.txt` — confirmed via a hand-crafted malicious archive, no
  file ever landed outside the destination — but did so as a
  non-terminating warning, so `execSync` did not throw and the engine would
  have applied a silently-partial extraction as if it were a clean success.
  Fixed by forcing `$ErrorActionPreference = 'Stop'` (and `-ErrorAction
  Stop` on `unzip`'s Linux path), confirmed end-to-end in an isolated
  sandbox: the malicious release now fails atomically and rolls back
  completely (not even the legitimate entries in the same archive are
  applied). Also added an independent, tool-agnostic path-escape check in
  `copyTreeExcludingProtected()` as a second layer, rather than relying
  solely on the extraction tool's own protection.
- **High:** stored XSS in the `licensing_server` admin dashboard — release
  `version`/`channel` (new in 1.1.0) and pre-existing license
  `licenseKey`/`customerName` fields were rendered via unescaped
  `innerHTML`, and `deleteKey()` was invoked via an interpolated
  `onclick="...('${licenseKey}')"` string (a second, attribute/JS-context
  injection point). Fixed with output-escaping plus switching the Revoke
  button to a `data-key` attribute and a real event listener.
- **Medium:** `POST /api/admin/releases` accepted any string for
  `version`/`downloadUrl`/`sha256` with no format validation. Added
  semver, `http(s)://`, and 64-hex-char checks respectively — closes the
  XSS vector above at the input layer too, not just on output.

## [1.1.0] — 2026-07-17

### Added
- **Extension/plugin architecture** (`backend/extensions/`, `frontend/js/extensions/`)
  — defined hook points so a tenant's own hired developer can customize their
  instance without ever touching core files. See `docs/THIRD_PARTY_DEVELOPER_GUIDE.md`.
- **Signed release registry** in `licensing_server` — releases are published
  with a version, channel, changelog, download URL, and SHA-256, then
  RSA-signed with a dedicated release-signing keypair (independent of the
  license-signing key) so a POS client can cryptographically verify a release
  actually came from the platform owner before ever applying it.
- **Tiered update engine** (`backend/updateEngine.js`) — daily check against
  the release registry; `security`-channel releases auto-apply (verify →
  backup → snapshot → swap code → restart), everything else surfaces as a
  reviewable "Update available" banner with a manual "Apply Update Now" action
  in Settings → License & Subscription.
- Daily automated detection job (`.github/workflows/daily-checks.yml`) —
  runs the integration test suite and a dependency vulnerability audit once a
  day and on every push; this is detection only, it never deploys anything by
  itself.

## [1.0.1] — 2026-07-17

### Fixed (security & reliability hardening, found via live stress testing)
- **Critical:** the licensing gate ran ahead of static file serving, so once
  a license expired the entire frontend (including the JS that renders the
  license-activation overlay) returned a raw `402` JSON error with no
  in-app recovery path. Gate now only applies to `/api/*` calls.
- **Critical:** stored XSS — `customerName`/`customerPhone` submitted through
  the public `POST /api/advances` endpoint were rendered unescaped via
  `innerHTML` in the admin Dashboard and Advances tabs, allowing a crafted
  "customer name" to execute in the admin's authenticated session and steal
  the session token. Fixed with output-escaping plus a proper 10-digit phone
  regex (the old check only verified string length).
- **High:** the admin PIN login endpoint had no rate limiting — the full
  4-digit keyspace was brute-forceable in under a minute. Added an
  IP-keyed lockout (5 failures → 30s, doubling up to 15 minutes).
- **High:** a transient Windows file-rename contention (`EPERM`) on the
  atomic JSON writer was silently swallowed by every caller, which under
  concurrent load produced a real duplicate invoice ID. `writeJSON()` now
  retries transient lock contention, and every write-then-respond call site
  checks the result and fails loudly instead of reporting false success.
- **Medium:** `POST /api/sales` and `POST /api/advances` accepted and
  permanently persisted negative, non-numeric, `Infinity`, or entirely empty
  transaction data while still consuming a real sequential invoice number.
  Added server-side validation (finite positive numbers, valid purity enum,
  10-digit phone, name length caps, sane amount ceiling).

## [1.0.0] — 2026-07-13

Initial release. Full single-tenant Gold Business POS: gold price auto-sync
with per-carat manual overrides, cashier billing desk with bi-directional
making charges, customer advances ledger, Razorpay + UPI QR payments,
RSA-signed SaaS licensing with 7-day offline grace, rolling backups, admin
dashboard, and Level-1/Level-2/black-box diagnostics exports. Full detail in
`docs/PROJECT_PLAN.md`.
