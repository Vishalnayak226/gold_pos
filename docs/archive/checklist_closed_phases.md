# Archive — PROJECT_PLAN closed-Phase checklists, Phases 1–18

Write-once. Moved out of `docs/PROJECT_PLAN.md` on 2026-08-08 under the rule in
`docs/archive/README.md`. Never append here.

Two blocks were moved: the old §3 "Implemented Roadmap & Progress" (a Phase 1–8
summary that duplicated §6) and the §6 "Done" sections for Phases 1–18.

Phases 19 and 20.1 stayed in the live §6 — Phase 19's pipeline has never run against
a real VPS, and Phase 20.1 is current work. The "Blocked on Inputs From Platform
Owner" list also stayed live: every item on it is still outstanding.

---

## Former §3 — Implemented Roadmap & Progress (Phases 1–8)

All phases have been fully completed and tested:

*   **Phase 1: Baseline Architecture & Setup** (Complete)
    *   Set up Express routers, package metadata, and single-page viewport containers.
*   **Phase 2: Database & Core Logger Layer** (Complete)
    *   Built atomic file writers, error logs, and system telemetry databases.
*   **Phase 3: Gold pricing auto-sync engine** (Complete)
    *   Integrated daily cron schedulers and currency conversion math.
*   **Phase 4: Asymmetric Cryptographic Envelope** (Complete)
    *   Exposed Level-1 diagnostics and Level-2 encrypted backup pullers.
*   **Phase 5: Store Manager POS Billing Desk** (Complete)
    *   Built cashier billing interfaces, bi-directional charges, and lookups.
*   **Phase 6: Customer Advances Portal** (Complete)
    *   Built customer dashboards, UPI QR canvas generators, and billing intakes.
*   **Phase 7: SaaS Licensing & Remote Release Pipeline** (Complete)
    *   Built central licensing control panels, 7-day grace gates, backups cron, and build compilers.
*   **Phase 8: Verification & System Integration Testing** (Complete)
    *   Created `backend/test_suite.js` to run and pass tests for conversion precision, rounding, licensing limits, and cryptographic decryptions. Generated walkthrough reports.

---

## Former §6 — Completion Checklist, closed Phases 1–18

### Done (Phases 1-8)
- [x] Express server + static frontend hosting — `backend/server.js`
- [x] Atomic JSON read/write layer with error/telemetry logging — `backend/db.js`
- [x] Daily midnight gold price auto-sync (Yahoo Finance + FX conversion) — `backend/priceEngine.js`
- [x] Per-carat manual override always takes priority over auto-synced rate — `backend/priceEngine.js: getActiveGoldRates()`
- [x] Level-1 plaintext diagnostics + Level-2 RSA-4096/AES-256-GCM encrypted DB export — `backend/cryptoHelper.js`
- [x] Cashier Billing Desk: gram × rate, bi-directional making-charge %, GST, manual discount — `frontend/js/components/BillingDesk.js`
- [x] Customer Advances: deposit (mandatory 10-digit phone), redemption at billing, balance lookup
- [x] Customer Portal: Gold Appreciation Calculator, Razorpay + UPI QR fallback — `frontend/customer.html` *(the phone-only login this originally shipped with was replaced by real password authentication in Phase 20.1, 2026-08-08)*
- [x] SaaS Licensing: RSA-signed activation handshake, 7-day offline grace, license-lock overlay
- [x] Rolling 7-day JSON backups — `backend/backupEngine.js`
- [x] Central `licensing_server/` with admin dashboard, key issue/suspend/revoke
- [x] Integration test suite — `backend/test_suite.js`
- [x] Release packaging script — `release_pipeline.js`
- [x] Documentation consolidated into a single `docs/` folder (merged former `doc/` content, 2026-07-13)

### Done — Must-Fix Hardening (Phase 9, 2026-07-13)
- [x] Fixed Razorpay mock-bypass key mismatch — aligned `backend/db.js` default template and `backend/data/settings.json` to the placeholder pair (`rzp_test_xxxxxx` / `rzp_test_xxxxxx_secret`) the mock-detection logic actually checks for. Any other non-empty key (a tenant's real test or live credentials) now correctly hits the real Razorpay API instead of being swallowed by the bypass.
- [x] Replaced the decorative QR canvas with a real, scannable QR encoder — `qrcode` npm package server-side (`GET /api/qrcode?data=`), `frontend/js/qrGenerator.js` now fetches and draws the real PNG. Added `upiId` to settings + a new public-safe `GET /api/settings/public` endpoint so `customer.html` can build a real `upi://pay?...` deep link instead of a hardcoded fake VPA; shows a clear "not configured" message if the tenant hasn't set a UPI ID yet instead of rendering a QR to nowhere.
- [x] Added real server-side admin session auth — `backend/adminAuth.js` (PIN verified server-side against `settings.adminPin`, random bearer token, 12h in-memory session), new `POST /api/admin/login` / `POST /api/admin/logout`, `frontend/js/app.js` exports an `adminFetch()` helper (auto-attaches the token, bounces to the lock screen on 401) used by `app.js` and `BillingDesk.js`.
- [x] Gated `GET/POST /api/settings`, `POST /api/gold-price/sync`, `GET/POST /api/sales`, `GET /api/diagnostics/telemetry`, and `GET /api/diagnostics/export` behind `requireAdminSession`. Customer-facing endpoints (`/api/gold-price`, `/api/advances*`, `/api/payment/*`, new `/api/settings/public`, `/api/qrcode`) intentionally remain public. Verified via curl: all six gated routes 401 without a token and 200 with one; login/logout/session-expiry round-trip confirmed; mock Razorpay order→verify→advance-deposit flow confirmed end-to-end.

### Done — Phase 10, 2026-07-13
- [x] Added `GET /api/advances` (list-all, sorted by date descending) behind `requireAdminSession` — `backend/server.js`.
- [x] Built `frontend/js/components/Dashboard.js`, wired as the default-landing tab: 4 stat tiles (Today's Revenue + invoice count, MTD Revenue + invoice count, Outstanding Advances total + customer count computed from the advances ledger, Active Gold Rate with Auto/Manual source badge), a lifetime purity-mix horizontal bar (24K/22K/18K revenue share, CVD-validated categorical colors, direct-labeled legend), and Recent Transactions / Recent Advance Deposits two-column lists (latest 5 each).
- [x] Refreshes on: initial load if already authenticated, right after PIN login, and every time the Dashboard nav tab is clicked — all reads go through the existing `adminFetch()` session wrapper.
- [x] Verified visually via a Playwright-driven headless Chromium session (installed ad hoc for this check): logged in with PIN 1234, confirmed all 4 tiles, the purity-mix bar (both single-segment and multi-segment cases, using demo sales added for the check), and both recent-activity lists render real data with no layout bugs. One pre-existing (not introduced here) console 401 noted: `BillingDesk.fetchSettings()` calls `adminFetch('/api/settings')` unconditionally on page load, before login — harmless (the 401 handler just reinforces the already-shown lock screen) but worth a cheap fix later.

### Done — Phase 11: Advances Module, 2026-07-13
- [x] Built `frontend/js/components/AdvancesManager.js` on the `advances-tab`: searchable customer list (phone/name, client-side filter) collapsed from the flat `/api/advances` ledger into one running-balance row per customer, an expandable per-customer ledger drill-down (every deposit/redemption, sorted newest-first), and a manual deposit entry form (Cash/UPI/Bank Transfer) posting to the existing public `POST /api/advances` — the missing browse/report counterpart to the redemption flow already in `BillingDesk.js`.
- [x] Refreshes on authenticated load, post-login, and nav-click into the tab (same pattern as the Dashboard).

### Done — Phase 12: Settings Expansion, 2026-07-13
- [x] Rebuilt the Settings tab as `frontend/js/components/SettingsManager.js` with a sub-nav: Store Profile (incl. the logo upload moved here), Gold Pricing & Overrides (incl. a "Sync Price Now" button wired to the existing `POST /api/gold-price/sync`), Billing & Invoice, Payment Gateway, Backup & Email Reports, License & Subscription (live status + re-sync). Removed the old `initSettingsLogic()` from `app.js` — fully superseded.
- [x] Real server-side destructive-action check: lowering `invoiceSeqStart` (risk of duplicate invoice numbers) now requires a `confirmDestructive: true` flag or `POST /api/settings` returns `409 CONFIRMATION_REQUIRED`; the client triple-confirms by requiring the user to type an exact phrase before resubmitting with the flag. Verified via curl: lowering without the flag → 409; with it → 200; restored to the correct value afterward.
- [x] Extended `backend/db.js`'s default settings template with `invoicePrefix`, `invoiceSeqStart`, and a structured (empty-by-default) `smtp` object shape for Phase 13.

### Done — Phase 13: Backup & Email Reports, 2026-07-13
- [x] New `backend/emailReporter.js` wires the previously-unused `nodemailer` dependency into Daily (7:00 AM cron) and Monthly (1st @ 7:30 AM cron) HTML summary emails (invoice count/revenue, advance deposits, outstanding total, latest backup folder). Gracefully skips (logs, returns `{success:false, reason}`, never throws) whenever SMTP host/user/pass or a recipient address aren't configured.
- [x] New admin-gated `POST /api/backup/run` (manual immediate snapshot) and `POST /api/reports/send-now` (manual Daily/Monthly send), both wired to buttons in Settings → Backup & Email.
- [x] **Verified the real send path, not just the graceful-skip path**: configured a disposable Ethereal Email test SMTP account (`nodemailer.createTestAccount()` — free, no real credentials needed) via the live `POST /api/settings` API, then called `POST /api/reports/send-now` for real → `{"success":true}`, confirming `emailReporter.js`'s actual send code works end-to-end through the real API, not just in isolation. Reverted settings back to the clean unconfigured state afterward and re-confirmed the graceful-skip path still returns correctly. Only the platform owner's real production SMTP credentials are still missing (see Blocked list) — the code path itself is now proven.

### Done — Phase 14: Cloud Deployment Packaging, 2026-07-13
- [x] `deploy/README.md` — full per-tenant provisioning runbook (PM2 + Nginx + Certbot), plus documents that the first-boot license activation flow needs no new code — the existing license-lock overlay (default `license.json` state is `inactive`) already *is* the first-boot setup flow.
- [x] `deploy/ecosystem.config.cjs` (PM2 process manager config, single-instance — the JSON-file DB layer isn't multi-writer safe) and `deploy/nginx.conf.template` (reverse proxy, TLS via `certbot --nginx`).
- [x] **Verified the PM2 config actually works, not just that it looks right on paper**: installed PM2, ran `pm2 start deploy/ecosystem.config.cjs` against this repo for real — it launched, served a real `GET /api/gold-price` request successfully, and wrote its configured log files (PM2 appends an instance-index suffix, e.g. `pm2-out-0.log`, which is expected PM2 behavior, not a config bug). Cleaned up (`pm2 delete` + `pm2 kill`) afterward.
- [x] Added the `dotenv` dependency to both `backend/` and `licensing_server/`, `import 'dotenv/config'` as the first line of each `server.js`, and `.env.example` in both.
- [x] Added a root `.gitignore` (`.env`, `node_modules/`, logs, backups, `dist/`, and every private-key `.pem` file) ahead of an eventual `git init`.
- [x] **Found and fixed a real, previously-undiscovered bug while testing this phase end-to-end**: the licensing server's default port (6000) is on the WHATWG Fetch spec's forbidden-port list (X11's reserved port) — Node's built-in `fetch()` refuses to connect to it (`TypeError: fetch failed`, cause `bad port`). This silently broke `backend/licenseChecker.js`'s handshake in *every* prior session since Phase 7 whenever both servers ran on their documented default ports (confirmed via `backend/logs/error.log` timestamps going back to the 2026-07-12 Phase 7 session). Moved the default to **6060** everywhere: `licensing_server/server.js`, `backend/licenseChecker.js`, both `.env.example` files, and `docs/credentials.md` / `docs/ai_handover.md` / `licensing_server/README.md`. Re-verified fixed on a fresh server boot: no "fetch failed" error, `license.json`'s `lastHandshakeTime` updates on every boot.

### Done — Phase 15: SaaS Control Plane Enhancements, 2026-07-13
- [x] Extended `licensing_server`'s license records with `billingCycle`, `amount`, `nextDueDate` (upsert form + admin dashboard table columns updated); added a platform-wide `data/config.json` (`latestVersion`) with public `GET /api/version` and admin `POST /api/admin/version`, plus a "Latest Published Version" control in the admin dashboard.
- [x] `backend/licenseChecker.js` now threads `billingCycle`/`amount`/`nextDueDate` from the signed verify payload into local `license.json`, and separately (best-effort, never blocks the license gate) polls `GET /api/version` to compute `updateAvailable`/`latestVersion`/`currentVersion` (read from `backend/package.json`).
- [x] Non-blocking "update available" sidebar banner in `frontend/js/app.js` — informational only, matches the locked-in manual/version-flagged release model; also surfaced in Settings → License & Subscription. Verified end-to-end: bumped the central `latestVersion` to 1.1.0 via the admin API, re-synced the POS client, confirmed the banner and Settings panel both correctly show "v1.1.0 available (running v1.0.0)".

### Done — Phase 16: Encrypted Black-Box Engine Log, 2026-07-13
- [x] New `backend/blackBoxLogger.js`: a dedicated RSA-4096 keypair (`backend/keys/blackbox_public.pem`, auto-generated on first boot — private half saved only to a new top-level `developer_blackbox_keys/` folder, independent of the Level-2 developer key so compromising one never unlocks the other).
- [x] Every HTTP request now also appends a scrubbed `{method, path, statusCode, durationMs, heapUsedMB}` line to `backend/logs/blackbox.log` (separate from the tenant-pullable Level-1 `telemetry.log`).
- [x] New admin-gated `GET /api/diagnostics/blackbox-export`, asymmetric-envelope encrypted the same way as the existing Level-2 export.
- [x] New standalone `developer_blackbox_keys/analyze_blackbox.js` — decrypts an exported envelope offline and prints an aggregated report. **Verified end-to-end**: exported a real envelope from a running server, decrypted and aggregated it correctly (11 events, 2 errors correctly attributed, memory trend 12.83→13.78MB).
- [x] Also wired the two pre-existing Diagnostics tab buttons that had been inert stubs since Phase 4/8 (`// Fetch telemetry code goes here`), plus the new black-box button — all three now call their real endpoints. Verified via Playwright: all three produce real output, zero console errors.

### Scaffold-only — Phase 17: Native Android Customer App, 2026-07-13
- [x] `mobile/` — Capacitor config (`server.url` pointing at the tenant's live `customer.html`), `package.json`, placeholder `www/index.html`, and a README covering setup, build steps, and Play Store requirements.
- [ ] **Cannot be built or run in this environment** — needs Android Studio, the Android SDK, and a JDK on a different machine. Genuinely a different-machine task, not a blocked-on-credentials one.
- [ ] Play Store submission blocked on platform-owner inputs regardless of where it's built.

### Two bugs found (and fixed) purely by testing end-to-end instead of trusting each piece in isolation
- [x] **Forbidden licensing port (6000 → 6060)** — see Phase 14 above. Re-verified live after the fix: fresh server boot shows no error, `lastHandshakeTime` updates correctly.
- [x] **Premature admin-gated fetches before login** — `AdvancesManager` and `SettingsManager` (this session's own new components) were calling `adminFetch()` unconditionally in their constructors, same root cause already flagged as pre-existing in `BillingDesk.fetchSettings()` back in the Phase 10 session. Fixed all three consistently (only fetch once a session token exists; refresh again on login). Re-verified live: a fresh pre-login page load now produces zero 401s (previously 3).

### Done — Phase 18: Security/Reliability Hardening (v1.0.1) & Tiered Auto-Update Platform (v1.1.0), 2026-07-17
- [x] **Live stress-testing pass found and fixed 5 real bugs**, all reproduced and re-verified against a running server (not just read from source): the license gate blocking static assets when a license goes invalid (bricking the entire app with no recovery UI); stored XSS via `customerName`/`customerPhone` in the public advances endpoint; zero admin-login rate limiting (full PIN keyspace brute-forceable in ~54s); unvalidated sales/advances data silently consuming real invoice numbers; and a genuine duplicate invoice ID caused by a transient Windows file-rename contention (`EPERM`) that every `writeJSON()` caller was silently swallowing. Full detail in `CHANGELOG.md` [1.0.1].
- [x] Explicitly disproved an initial hypothesis (JSON read-modify-write races under concurrent requests) via a 455-request mixed-load test rather than assuming it — Node's synchronous, non-`await`-interrupted handler bodies serialize this safely in a single-process deployment.
- [x] Extension/plugin architecture (`backend/extensions/`, `frontend/js/extensions/`) so a tenant's own hired developer can customize their instance without touching core files — see `docs/THIRD_PARTY_DEVELOPER_GUIDE.md` and `backend/extensions/README.md`.
- [x] Signed release registry (`licensing_server`) + tiered update engine (`backend/updateEngine.js`): `security`-channel releases auto-apply (RSA-signature-verified, SHA-256-checked, backed up, rolled back on any failure); `feature`/`patch`-channel releases require a human to click "Apply Update Now" in Settings → License & Subscription. This supersedes the "no unattended auto-updater" line in §5.1 above by explicit platform-owner direction, with the hard constraint (verified via an isolated-sandbox test, not just asserted) that data and tenant customizations are structurally never touched by an apply. Full architecture in `docs/ai_handover.md` §7.
- [x] Daily detection-only CI (`.github/workflows/daily-checks.yml`) — integration tests + dependency audit, never deploys anything itself.
- [x] Semver adopted properly; `CHANGELOG.md` added as the source of truth for what shipped in each version.
