# AI Handover: Gold Business POS (SaaS Platform)

This document contains key architectural details, non-negotiable design guidelines, and developer context for the completed **Gold Business POS** SaaS platform. Any incoming AI agent or developer must strictly adhere to these instructions.

> **Fresh session: read §0 only.** The rest of this file is ~5k tokens of reference you almost
> never need up front. Standing rules live in root `CLAUDE.md` (auto-loaded); the reasoning
> behind them lives in `docs/FOUNDATION.md`.

---

## 0. Version Control & Handover Status

*Keep this section current whenever a unit of work finishes. Absolute dates only.*

- **Latest commit:** `5f99916` — Phase 20.1: customer identity/auth, shared billing math,
  hardening (2026-08-08). Committed on branch `phase-20.1-customer-auth`, **not yet merged into
  `main`** and not pushed — `main` is still at `e4999bc` (Phase 19).
- **Uncommitted in tree (as of 2026-08-08):** nothing. The whole Phase 20.1 working set — all 50
  paths, including `backend/customerAuth.js`, `backend/defaultSettings.js`,
  `backend/test_billing_math.js`, `frontend/js/lib/billingMath.js`, `docs/brain/`,
  `docs/FOUNDATION.md` and root `CLAUDE.md` — went into `5f99916`.
- **Servers:** not running (start with `Restart_Server.bat` → :5000; licensing server → :6060).
- **Concurrent-session risk:** this tree sees edits from the user and other agents. Run
  `git status`/`git diff` and stage only files you reviewed — never `git add -A`.
- **Last unit of work:** Phase 20.1 — customer identity & authentication (2026-08-08). The
  customer portal now requires a password; `/api/customer/*` is session-scoped; four
  previously-public endpoints are gated. Verified live (53 API + 20 post-restart + 29 Playwright
  checks, all green, `backend/data/` restored byte-identical). See `CHANGELOG.md` [Unreleased],
  `docs/SCHEME_MODULE_PLAN.md` §20.1, `docs/TESTING_CHECKLIST.md` §12.
- **Next session should start with:** deciding whether `phase-20.1-customer-auth` merges into
  `main` (both suites were green at commit time — 57 billing checks + 6 integration tests). The
  scheme module's remaining phases
  (20.2 onward) are still blocked on the seven product decisions in `SCHEME_MODULE_PLAN.md` §7;
  `PRODUCTION_READINESS_ROADMAP.md` Phase 0 is the unblocked queue.

---

## 1. Directory Structure Layout

The standard project folder hierarchy is organized as follows:

```
├── backend/                       # Client POS Express Backend Application
│   ├── keys/                      # Public keys folder
│   │   ├── developer_public.pem   # Developer public key for Level 2 exports
│   │   ├── license_public.pem     # Central licensing authority public key
│   │   └── release_public.pem     # Release-signing public key (verifies updateEngine.js downloads) — §7
│   ├── extensions/                # Tenant customization surface — never touched by an update. §6
│   │   ├── index.js                #   loader/hook-dispatcher (core file, IS updated by patches)
│   │   └── *.extension.js          #   tenant drop-ins (NOT touched by patches) — see README.md
│   ├── data/                      # Atomic JSON databases
│   │   ├── settings.json          # GST tax rates, overrides, Razorpay credentials
│   │   ├── license.json           # Local licensing status cache (also holds pendingRelease/lastAppliedRelease — §7)
│   │   ├── advances.json          # Customer advances credits ledger
│   │   └── sales_YYYY.json        # Partitioned annual transaction databases
│   ├── logs/                      # Error and telemetry flat logs
│   ├── backups/                   # Dated rolling database snapshots (7-day retention)
│   ├── _rollback/, _staging/      # updateEngine.js scratch dirs (pre-apply snapshot / download+extract) — §7
│   ├── db.js                      # Atomic file writers, logTelemetry, and logError
│   ├── priceEngine.js             # Yahoo Finance XAU sync cron and overrides manager
│   ├── cryptoHelper.js            # RSA-4096 / AES-256-GCM diagnostics export envelope
│   ├── licenseChecker.js          # RSA verification and 7-day grace checks
│   ├── backupEngine.js            # Daily backups cron scheduler and pruner
│   ├── updateEngine.js            # Signed release verification, tiered auto/manual apply, rollback — §7
│   ├── server.js                  # Main API router routing payments, sales, and analytics
│   └── test_suite.js              # Assert-driven system integration test suite
│
├── frontend/                      # Client POS Frontend Application
│   ├── css/
│   │   └── app.css                # PDF print-ledger vanilla style rules (100vh lock)
│   ├── js/
│   │   ├── components/
│   │   │   └── BillingDesk.js     # Cashier checkout, bi-directional rounding, looked-up advances
│   │   ├── extensions/index.js    # Tenant frontend customization surface, never touched by an update — §6
│   │   ├── app.js                 # Navigation controller and boot licensing checker
│   │   └── qrGenerator.js         # Offline canvas UPI QR code drawer
│   ├── index.html                 # POS cashier central single-page interface
│   └── customer.html              # Customer mobile portal (Razorpay payments and ledger lists)
│
├── licensing_server/              # Central SaaS Licensing Microservice (Serverless ready)
│   ├── keys/
│   │   ├── license_private.pem    # Central RSA private key for signing activation tokens
│   │   ├── license_public.pem     # Backup public key file
│   │   └── release_private.pem    # Release-signing private key — signs every published release manifest. §7
│   ├── data/
│   │   ├── licenses.json          # Central tenant licenses database
│   │   └── config.json            # latestVersion + full signed release registry — §7
│   ├── server.js                  # Express licensing endpoints and admin HTML dashboard (incl. "Publish Release")
│   └── README.md                  # Deploy guide (Cloudflare Workers / Vercel KV)
│
├── developer_doomsday_keys/       # Scratch directory (Developer-only offline keys)
│   └── developer_private.pem      # RSA private key used to decrypt Level 2 exports
│
├── .github/workflows/             # daily-checks.yml (detection-only, never deploys — §7) +
│                                   # cd-dev.yml/cd-sandbox.yml/cd-live.yml (owner's internal
│                                   # Dev->Sandbox->Live pipeline, SSH+PM2, Live gated on manual
│                                   # approval — deploy/README.md §8, PROJECT_PLAN.md §5.14)
├── dist/                          # Generated clean production build assets folder
├── release_pipeline.js            # Root bundle release script generating release zip files
├── Restart_Server.bat             # Kills anything on port 5000, then relaunches backend/server.js
├── CHANGELOG.md                   # Semver history + release-channel policy — §7
└── docs/                          # Documentation (this file, PROJECT_PLAN.md, BRD.md, LEDGER.md, credentials.md,
                                    # THIRD_PARTY_DEVELOPER_GUIDE.md)
```

---

## 2. Core Security & Licensing Flows

### A. Asymmetric Licensing Handshake
1. The Central Licensing Server holds a secure RSA-2048 Private Key (`license_private.pem`).
2. When the POS client requests license validation (`POST /api/license/verify`), the server compiles a state payload (including expiry dates, suspended/active states, and fingerprints) and signs it with the Private Key.
3. The client receives the payload and its signature. It cryptographically verifies the signature against the local `license_public.pem` key. This prevents client bypasses via local `hosts` redirects.
4. **Internet Grace Period:** If the licensing server is unreachable, the client checks `license.json`'s `lastHandshakeTime`. The system is permitted to run for a **7-day offline grace period** before closing the cashier gate.

### B. Two-Tier Diagnostics
*   **Level 1 (Telemetry):** Technical profiles (latencies, errors, memory) contain zero customer details. Accessible in plain text by developers at `/api/diagnostics/telemetry`.
*   **Level 2 (Database Export):** Sensitive JSON databases are bundled on request, encrypted with an ephemeral AES-256 key, and packaged into an envelope where the AES key is encrypted using the Developer's RSA-4096 Public Key. Decryptable only offline by the developer's private key (`developer_private.pem`).
*   `backend/data/customer_auth.json` is deliberately **not** in the Level-2 bundle. A support export should never carry credential material off a tenant's machine, even encrypted. If you extend the bundle, keep it out.

### C. Two Session Systems, Deliberately Different (added 2026-08-08)
Both issue an opaque bearer token checked by an Express middleware; they differ where the two audiences differ.

| | Admin / cashier (`adminAuth.js`) | Customer (`customerAuth.js`) |
|---|---|---|
| Credential | One shared PIN from `settings.adminPin` | Per-account password, scrypt-hashed (`scrypt$N$r$p$hex` + separate salt) |
| Sessions | In memory, 12h, lost on restart | Persisted as SHA-256 hashes on the account record, 30 days, max 5 devices, survive a restart |
| Lockout | Per-IP, in memory | Per-account (persisted, survives a restart) **and** per-IP (in memory, against stuffing) |
| Middleware | `requireAdminSession` | `requireCustomerSession`; `requireEstablishedCustomer` additionally blocks a counter-issued temporary password from doing anything but changing itself |

The rule that matters: **every `/api/customer/*` handler reads the phone from `req.customerPhone`, which the middleware sets from the session.** Never from `req.body` or `req.query`. Routes that legitimately name an arbitrary customer's phone (`GET /api/advances/lookup`, `POST /api/advances`) are admin-gated instead, because that is a cashier action.

An existing customer cannot self-register: `POST /api/customer/register` refuses a number that already has store history (`409 CLAIM_REQUIRES_STORE`) and the store issues the login at the counter via `POST /api/customer-accounts/issue-login`. Without an SMS gateway, that is what stops a stranger claiming someone else's ledger. When an SMS provider is chosen, OTP verification replaces this restriction rather than layering on top of it.

---

## 3. Key Billing Math & Precision Rounding
*   **Gold Weight multiplication:**
    $$\text{Base Metal Value} = \text{Gold Weight (g)} \times \text{Purity Price (per gram)}$$
*   **Making Charge Bi-directional binding:**
    *   Percentage shifts (between `1` and `100`%):
        $$\text{Flat Charge} = \text{Math.round}(\text{Base Value} \times \text{Percentage} / 100 \times 100) / 100$$
    *   Flat currency charge shifts:
        $$\text{Percentage} = \text{Math.round}(\text{Flat Charge} / \text{Base Value} \times 100 \times 100) / 100$$
    *   This bi-directional synchronization is reactively bound on keyup/change listeners inside [BillingDesk.js](file:///c:/Users/ABCD/Documents/Antigravity%20Projects/Web%20POS/frontend/js/components/BillingDesk.js).

---

## 4. Operational Commands & Maintenance

### A. Running the POS Client
1. Navigate to `backend/` and boot the service:
   ```bash
   cd backend
   node server.js
   ```
   Or, from the project root, double-click/run `Restart_Server.bat` — it kills any process already bound to port 5000 before launching a fresh `node backend/server.js`, which is the safest way to restart after code changes.
2. The POS desk interface will run at `http://localhost:5000` (serves `frontend/` statically). Admin terminal is at `/`, customer portal at `/customer.html`.

### B. Running the Central Licensing Server
1. Navigate to `licensing_server/` and start the server:
   ```bash
   cd licensing_server
   node server.js
   ```
2. Dashboard runs at `http://localhost:6060` (moved off :6000 on 2026-07-13 — that port is on the WHATWG Fetch forbidden-port list and silently broke `backend/licenseChecker.js`'s fetch()-based handshake). Authenticate using the admin token from `ADMIN_SECRET` (see `licensing_server/.env.example`; local dev falls back to a default — see `docs/credentials.md`, not committed).

### C. Running Integration Tests
Verify all pricing formulas, rounding math, grace calculations, and RSA envelopes by executing the assert test suite:
```bash
cd backend
node test_suite.js
```

### D. Packaging a Platform Release
Execute the release pipeline script to compile clean assets into a distributable archive:
```bash
node release_pipeline.js
```
The output zip file is created at `gold_pos_release.zip`.

### E. Publishing a Release to the Tiered Update Engine
After packaging (§D above), host the zip somewhere reachable by tenants
(e.g. attach it to a GitHub Release, or any URL `fetch()` can download from),
compute its SHA-256, then publish it via the licensing server dashboard
(`http://localhost:6060` → "Publish Release" form) or directly:
```bash
curl -X POST http://localhost:6060/api/admin/releases \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{"version":"1.1.1","channel":"patch","changelog":"...","downloadUrl":"https://...","sha256":"..."}'
```
`channel` is `security` (auto-applies to every tenant on their next daily
check), `feature`, or `patch` (both surface as a manual "Apply Update Now"
banner). Full mechanism in §7 below.

### F. The Owner's Internal Dev/Sandbox/Live Pipeline
Separate from the per-tenant release process above — see
`deploy/README.md` §8 for the full runbook. Short version: push to
`develop`/`staging`/`main` on GitHub triggers `cd-dev.yml`/`cd-sandbox.yml`/
`cd-live.yml`, each of which runs the test+audit gate, then deploys over SSH
via `deploy/remote-deploy.sh` and smoke-tests `GET /api/health`. Live
requires a manual approval click (GitHub Environment protection). Not yet
exercised end-to-end as of 2026-07-17 — no VPS/domain provisioned yet.

---

## 5. Frontend Implementation Notes & Gotchas

Details that aren't obvious from reading the API/architecture alone — merged in from an earlier parallel handover doc, verified against current source.

### A. Customer Portal (`customer.html`)
*   **Authentication (Phase 20.1, 2026-08-08):** phone + password, not phone alone. Three views swap in the same container — `#auth-view` (Sign In / Create Account / Forgot panes), `#force-change-view` (a counter-issued temporary password cannot reach any data until it is replaced), and `#portal-view`. The session token lives in `localStorage` and every call goes through the local `customerFetch()` helper, which attaches the bearer and drops back to sign-in on a 401 — the customer-side counterpart of `adminFetch()` in `app.js`. Server side: `backend/customerAuth.js`, routes under `/api/customer/*`.
*   **Layout:** 100vh mobile-app layout with a fixed bottom tab bar (Profile, Deposit, History, Account). `body` is locked (`overflow: hidden`); only the inner `#portal-view` scrolls, to prevent layout clipping on mobile browsers.
*   **Gold Appreciation Calculator (Profile tab):** shows how much a customer's cash deposits have appreciated. On deposit, the backend snapshots that day's `lockedGoldRate22K` onto the advance record (see `getActiveGoldRates().price22K` in `POST /api/advances` and `POST /api/payment/verify`, `backend/server.js`). On profile view, the frontend fetches the *live* 22K rate and computes `Current Worth = (Deposit / Locked Rate) * Live Rate`.
*   **UI Alerts:** the global `window.alert` is overridden with a custom blurry modal overlay (success icon, etc.) instead of the native browser popup.
*   **Testing tip:** to see the Gold Appreciation Calculator move, manually lower `lockedGoldRate22K` on an existing entry in `backend/data/advances.json`, then reload the profile view.
*   **Razorpay mock behavior — caution:** the customer portal is written to expect an automatic mock-checkout bypass whenever `rzp_test_` keys are configured. **As of 2026-07-13 this is verified broken** — `backend/server.js` only mocks on the exact literal `rzp_test_xxxxxx`, and the live `settings.json` has a different test key, so real Razorpay calls are attempted and fail. Tracked as a must-fix in `PROJECT_PLAN.md` §5.3 (Phase 9).

### B. Admin POS Dashboard (`index.html`)
*   **Security:** hidden by default behind an Admin Terminal lock screen. As of Phase 9 (2026-07-13) the PIN is verified **server-side** (`backend/adminAuth.js`) against `settings.adminPin`, issuing a random bearer session token (`sessionStorage.adminToken`) required on every gated endpoint — the PIN is no longer client-only. As of the 2026-07-17 hardening pass, login attempts are also rate-limited (5 failures → 30s lockout, doubling up to 15 minutes) — see §6 below. (An earlier version of this doc described PIN checking as UI-only; that has been fixed and this note corrects it.)
*   **Unlock/Session:** on success, sets `sessionStorage.adminAuthenticated = 'true'` and restores `appViewport.style.display = 'grid'`. **Must stay `'grid'`, not `'flex'` or `'block'`** — the viewport layout uses CSS Grid and other display values break it.
*   **Logout:** sidebar logout button clears `sessionStorage` and re-shows the lock screen.
*   **Diagnostics Tab:** telemetry/log-export tools live in their own `diagnostics-tab`, kept separate from the Settings tab.
*   **Settings & Gold Overrides:** opening the Settings tab auto-fetches the current live gold price to pre-fill the override inputs; saving POSTs to `/api/settings` and immediately refreshes the Billing Desk's rate via `window.billingDesk.fetchGoldRate()`.
*   **Making Charge dual-input UI:** the percentage is collected via two side-by-side inputs in the markup but parsed/combined into one `makingChargePercent` float inside `BillingDesk.js`; typing a flat ₹ amount reverse-calculates and re-splits the percentage across both boxes.

---

## 6. Extension / Plugin Architecture (added 2026-07-17)

A tenant's own hired developer can customize their instance without ever
touching core files — see `backend/extensions/README.md` for the full
contract and `docs/THIRD_PARTY_DEVELOPER_GUIDE.md` for the broader
"working with 3rd-party developers" guidance (both the platform-owner and
tenant scenarios).

Summary for an incoming agent:
*   **Backend:** `backend/extensions/index.js` auto-discovers any
    `*.extension.js` file dropped into `backend/extensions/` and loads it
    at boot (`loadExtensions()`, called from `server.js` bootstrap). Hooks
    (`onSaleSaved`, `onAdvanceDeposit`, `onSettingsUpdated`, `onServerBoot`)
    fire via `fireHook()` **after** the core operation is already durably
    saved and the response already sent — fire-and-forget, wrapped in a
    3-second timeout and try/catch per extension, so a broken extension can
    never crash the server, block a response, or corrupt data.
*   **Frontend:** `frontend/js/extensions/index.js` (ships as a no-op stub)
    is dynamically imported once in `app.js` after core components are
    constructed, and receives `{ billingDesk, dashboard, advancesManager,
    settingsManager, adminFetch, logTelemetry }`.
*   **This is also the mechanism that makes the update engine (§7) safe for
    tenant customizations** — an applied release structurally never
    overwrites `backend/extensions/*.extension.js` or
    `frontend/js/extensions/` (see `PROTECTED_PATHS` /
    `isProtectedRelativePath()` in `backend/updateEngine.js`).

## 7. Tiered Auto-Update Engine (added 2026-07-17)

Supersedes the "no unattended auto-updater" line in `PROJECT_PLAN.md` §5.1
(now intentionally superseded by this system, per the platform owner's
explicit direction: security fixes may auto-deploy, but data must never be
touched and the manual/framework-stable release model otherwise stays).

**Versioning & channels** (`CHANGELOG.md`): semver (`MAJOR.MINOR.PATCH`).
Every release is published on one of three channels:
| Channel | Rollout |
|---|---|
| `security` | Auto-applied by every tenant's daily check |
| `feature` / `patch` | Surfaced as a banner; a human clicks "Apply Update Now" |

**Publishing a release** (platform owner, via the licensing server dashboard
at `http://localhost:6060`, "Publish Release" form): version, channel,
changelog, a `downloadUrl` (an already-hosted zip — e.g. the output of
`node release_pipeline.js` uploaded somewhere reachable by tenants), and its
SHA-256. The server signs `{version, channel, changelog, downloadUrl,
sha256, publishedAt}` with a **dedicated release-signing RSA-4096 keypair**
(`licensing_server/keys/release_private.pem` / `release_public.pem`,
auto-generated on first boot — deliberately separate from the
license-signing key, same compartmentalization pattern as the Level-2
developer key vs. the black-box key). The public half must be copied to
every POS client at `backend/keys/release_public.pem` (already done for
this repo's own client instance).

**Client side** (`backend/updateEngine.js`):
1.  Daily 2:00 AM check (`checkForUpdates()`, off-hours by design, same
    reasoning as the pricing/backup schedulers) fetches
    `GET /api/releases/latest?channel=security` from the licensing server
    and **verifies its RSA signature against the bundled
    `release_public.pem` before trusting anything about it** — a
    compromised or spoofed licensing server cannot get arbitrary code
    auto-applied to a tenant this way.
2.  A verified, newer `security` release is applied immediately
    (`applyUpdate()`); anything else newer is only ever recorded into
    `license.json.pendingRelease` for the Settings → License & Subscription
    "Apply Update Now" button (`POST /api/admin/update/apply`) — never
    applied without a human clicking it.
3.  `applyUpdate()` sequence: `createBackup()` (data safety net) →
    snapshot current code into `backend/_rollback/` (`snapshotTree()`) →
    download the release zip → **verify its SHA-256 matches the signed
    manifest before extracting anything** → extract to `backend/_staging/`
    → copy into place via `copyTreeExcludingProtected()`, which skips
    `backend/data/`, `backend/logs/`, `backend/backups/`, `backend/.env`,
    `backend/keys/`, `backend/extensions/*.extension.js`, and
    `frontend/js/extensions/` — **structurally, not just by convention**,
    this is what "a patch can never touch tenant data or customizations"
    actually means in code. Any failure at any step triggers
    `restoreFromRollback()` and leaves the tenant on the last-known-good
    version with nothing partially applied.
4.  Restart: under PM2 (`process.env.pm_id` set — see
    `deploy/ecosystem.config.cjs`), the process exits cleanly for PM2 to
    restart onto the new code. Outside PM2 (local/dev `node server.js`),
    it logs manual-restart instructions instead of force-exiting, since
    nothing would supervise a bare `node` process back to life.

**Verified end-to-end during this session**, in an isolated filesystem
sandbox (never against this repo's own live files): a manual `patch`-channel
apply, an automatic `security`-channel apply, and a deliberately-corrupted
release (wrong SHA-256) correctly rejected and rolled back — including
catching and fixing a real bug where the rollback snapshot step initially
copied nothing at all (its own destination path collided with the
live-tree protection filter; fixed by giving snapshotting its own simpler
copy function, `snapshotTree()`, entirely separate from
`copyTreeExcludingProtected()`).

**Daily detection (separate from deployment):**
`.github/workflows/daily-checks.yml` runs `backend/test_suite.js` and
`npm audit --audit-level=high` (both `backend/` and `licensing_server/`)
once a day and on every push. This only detects and reports — it never
publishes or applies anything. Turning a finding into a shipped release is
still: fix → review → publish via the dashboard above.
