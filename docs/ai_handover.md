# AI Handover: Gold Business POS (SaaS Platform)

This document contains key architectural details, non-negotiable design guidelines, and developer context for the completed **Gold Business POS** SaaS platform. Any incoming AI agent or developer must strictly adhere to these instructions.

---

## 1. Directory Structure Layout

The standard project folder hierarchy is organized as follows:

```
├── backend/                       # Client POS Express Backend Application
│   ├── keys/                      # Public keys folder
│   │   ├── developer_public.pem   # Developer public key for Level 2 exports
│   │   └── license_public.pem     # Central licensing authority public key
│   ├── data/                      # Atomic JSON databases
│   │   ├── settings.json          # GST tax rates, overrides, Razorpay credentials
│   │   ├── license.json           # Local licensing status cache
│   │   ├── advances.json          # Customer advances credits ledger
│   │   └── sales_YYYY.json        # Partitioned annual transaction databases
│   ├── logs/                      # Error and telemetry flat logs
│   ├── backups/                   # Dated rolling database snapshots (7-day retention)
│   ├── db.js                      # Atomic file writers, logTelemetry, and logError
│   ├── priceEngine.js             # Yahoo Finance XAU sync cron and overrides manager
│   ├── cryptoHelper.js            # RSA-4096 / AES-256-GCM diagnostics export envelope
│   ├── licenseChecker.js          # RSA verification and 7-day grace checks
│   ├── backupEngine.js            # Daily backups cron scheduler and pruner
│   ├── server.js                  # Main API router routing payments, sales, and analytics
│   └── test_suite.js              # Assert-driven system integration test suite
│
├── frontend/                      # Client POS Frontend Application
│   ├── css/
│   │   └── app.css                # PDF print-ledger vanilla style rules (100vh lock)
│   ├── js/
│   │   ├── components/
│   │   │   └── BillingDesk.js     # Cashier checkout, bi-directional rounding, looked-up advances
│   │   ├── app.js                 # Navigation controller and boot licensing checker
│   │   └── qrGenerator.js         # Offline canvas UPI QR code drawer
│   ├── index.html                 # POS cashier central single-page interface
│   └── customer.html              # Customer mobile portal (Razorpay payments and ledger lists)
│
├── licensing_server/              # Central SaaS Licensing Microservice (Serverless ready)
│   ├── keys/
│   │   ├── license_private.pem    # Central RSA private key for signing activation tokens
│   │   └── license_public.pem     # Backup public key file
│   ├── data/
│   │   └── licenses.json          # Central tenant licenses database
│   ├── server.js                  # Express licensing endpoints and admin HTML dashboard
│   └── README.md                  # Deploy guide (Cloudflare Workers / Vercel KV)
│
├── developer_doomsday_keys/       # Scratch directory (Developer-only offline keys)
│   └── developer_private.pem      # RSA private key used to decrypt Level 2 exports
│
├── dist/                          # Generated clean production build assets folder
├── release_pipeline.js            # Root bundle release script generating release zip files
├── Restart_Server.bat             # Kills anything on port 5000, then relaunches backend/server.js
└── docs/                          # Documentation (this file, PROJECT_PLAN.md, BRD.md, LEDGER.md, credentials.md)
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

---

## 5. Frontend Implementation Notes & Gotchas

Details that aren't obvious from reading the API/architecture alone — merged in from an earlier parallel handover doc, verified against current source.

### A. Customer Portal (`customer.html`)
*   **Layout:** 100vh mobile-app layout with a fixed bottom tab bar (Profile, Deposit, Payment History). `body` is locked (`overflow: hidden`); only the inner `#portal-view` scrolls, to prevent layout clipping on mobile browsers.
*   **Gold Appreciation Calculator (Profile tab):** shows how much a customer's cash deposits have appreciated. On deposit, the backend snapshots that day's `lockedGoldRate22K` onto the advance record (see `getActiveGoldRates().price22K` in `POST /api/advances` and `POST /api/payment/verify`, `backend/server.js`). On profile view, the frontend fetches the *live* 22K rate and computes `Current Worth = (Deposit / Locked Rate) * Live Rate`.
*   **UI Alerts:** the global `window.alert` is overridden with a custom blurry modal overlay (success icon, etc.) instead of the native browser popup.
*   **Testing tip:** to see the Gold Appreciation Calculator move, manually lower `lockedGoldRate22K` on an existing entry in `backend/data/advances.json`, then reload the profile view.
*   **Razorpay mock behavior — caution:** the customer portal is written to expect an automatic mock-checkout bypass whenever `rzp_test_` keys are configured. **As of 2026-07-13 this is verified broken** — `backend/server.js` only mocks on the exact literal `rzp_test_xxxxxx`, and the live `settings.json` has a different test key, so real Razorpay calls are attempted and fail. Tracked as a must-fix in `PROJECT_PLAN.md` §5.3 (Phase 9).

### B. Admin POS Dashboard (`index.html`)
*   **Security:** hidden by default behind an Admin Terminal lock screen. PIN `1234` is hardcoded client-side in `frontend/js/app.js` (`initAdminAuth()`) — **this is UI-only enforcement, not real auth**; no server-side session/token currently gates the API routes beyond the license check. Also tracked as a must-fix in `PROJECT_PLAN.md` §5.3.
*   **Unlock/Session:** on success, sets `sessionStorage.adminAuthenticated = 'true'` and restores `appViewport.style.display = 'grid'`. **Must stay `'grid'`, not `'flex'` or `'block'`** — the viewport layout uses CSS Grid and other display values break it.
*   **Logout:** sidebar logout button clears `sessionStorage` and re-shows the lock screen.
*   **Diagnostics Tab:** telemetry/log-export tools live in their own `diagnostics-tab`, kept separate from the Settings tab.
*   **Settings & Gold Overrides:** opening the Settings tab auto-fetches the current live gold price to pre-fill the override inputs; saving POSTs to `/api/settings` and immediately refreshes the Billing Desk's rate via `window.billingDesk.fetchGoldRate()`.
*   **Making Charge dual-input UI:** the percentage is collected via two side-by-side inputs in the markup but parsed/combined into one `makingChargePercent` float inside `BillingDesk.js`; typing a flat ₹ amount reverse-calculates and re-splits the percentage across both boxes.
