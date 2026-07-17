# Project Plan: SaaS Gold Business POS

This document outlines the architecture, features, implementation roadmap, and finalized configurations for the web-based **Gold Business POS**. 

---

## 1. Executive Summary & Feasibility

This project is a lightweight, responsive, web-based SaaS point of sale (POS) system tailored for gold retailers. It inherits the core performance philosophies (low memory footprint, local-first file-based database backups) of high-speed desktop tools but adapts it for SaaS multi-tenancy, custom gold calculations, and customer advances.

### Technical Feasibility & Integration Decisions
*   **Gold API Provider:** **Yahoo Finance (Keyless)**. Synchronizes daily price rates for XAU USD futures and uses Open Exchange Rates (`open.er-api.com`) to calculate localized price per gram rates without needing private keys.
*   **Purity Pricing:** **Independent Rates**. The system maintains independent rates and manual overrides for 24K, 22K, and 18K carats individually.
*   **Payment Gateway:** **Razorpay Online Checkout**. Integrated in the mobile customer portal with backend HMAC-SHA256 signature verification. Reverts to manual UPI QR canvas codes if credentials are not configured.
*   **Licensing Host:** **Serverless (Cloudflare Workers)**. The central licensing control panel is built using a portable DB adapter, designed for zero-maintenance hosting on Cloudflare Workers and KV.

---

## 2. Core Functional Specifications

### A. Gold Price Management
*   **Auto-Sync:** Daily midnight gold rate fetches using keyless public providers.
*   **Carat Overwrites:** Store managers can manually overwrite prices for 24K, 22K, or 18K carats independently inside settings. Override states are evaluated per carat.

### B. POS Billing Desk
*   **Grams calculations:** Multiplies weight by the active purity rate.
*   **Bi-directional Making Charges:** Links percentage inputs (restricted between `1-100%`) and flat currency values in real-time with bi-directional state binding.
*   **Discounts & Advances:** Allows cashiers to lookup customer details by phone, verify outstanding advance balances, deduct applied advances from the bill total, and apply manual discounts.

### C. Customer Advances Portal
*   **Secure Mobile Login:** Customers log in using validated 10-digit mobile numbers.
*   **Ledger Histories:** Displays responsive high-contrast tables showing deposit and redemption lists.
*   **Double Checkout Routing:** Runs checkout via Razorpay popup, or displays canvas-drawn UPI QR code overlays for manual transaction ID entries.

### D. Diagnostics & Telemetry
*   **Level 1 (Telemetry):** Technical metrics (memory usage, CPU, API latencies) containing zero customer data.
*   **Level 2 (Cryptographic Recovery Lock):** Encrypted transaction database bundles packaged with AES-256-GCM + RSA-4096 envelope, decryptable only offline by the developer's private key.

---

## 3. Implemented Roadmap & Progress

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

## 4. Platform Compilation & Verification Status

*   **Release Package:** Compiled at `C:\Users\ABCD\Documents\Antigravity Projects\Web POS\gold_pos_release.zip`.
*   **Integration Tests:** All 4 core test blocks passed successfully with 0 exceptions.
*   **handover Details:** Detailed configurations and deployment commands are preserved in `ai_handover.md`.

---

## 5. Roadmap to SaaS-Ready Deployment (Phase 9 series — Planned)

Phases 1-8 above produced a working single-tenant Gold Business POS. This section captures the agreed roadmap to take it to a paid, multi-tenant, cloud-hosted SaaS product, benchmarked against architectural patterns from the reference desktop POS ("RetailFlow Barcode & Sales Desk") but kept on this project's existing buildless vanilla JS/Express/JSON foundation.

### 5.1 Locked-in Architectural Decisions
*   **Stack:** Remain buildless vanilla JS/Express/JSON — no React/Vite migration. Matches the "20-year proof, zero dependency rot" and "ultra light" requirements; a build-tooled stack would work against both.
*   **Hosting Model:** True cloud hosting — one always-on instance per tenant on the tenant's own server/cloud account, browser-accessible from anywhere (not a LAN-only desktop-shell app).
*   **Release Model:** ~~Manual, version-flagged releases only; no unattended auto-updater~~ — **superseded in Phase 18 (2026-07-17)** by explicit platform-owner direction: releases are now tiered. `security`-channel releases auto-apply on every tenant's daily check (signature-verified, backed up, rolled back on any failure — see §5.14/Phase 18 and `docs/ai_handover.md` §7). `feature`/`patch`-channel releases remain manual — a human still clicks "Apply Update Now" per tenant, preserving the original "platform owner controls the pace" intent for anything non-urgent.
*   **Customer Mobile App:** A real native Android app, distributed via Play Store. Recommended v1 approach is a Capacitor wrapper around the existing `customer.html` portal (reuses the tested UI, ships fastest, upgradeable to a full native rewrite later if needed).

### 5.2 Already Correct — Verified, No Work Needed
*   Gram × active-purity-rate billing math (`BillingDesk.js`).
*   Manual gold-rate override always takes priority per carat (`priceEngine.js: getActiveGoldRates()`).
*   No vendor/barcode modules — confirmed out of scope for this product.
*   Customer name/phone optional at billing; phone already enforced mandatory on advance deposits (`POST /api/advances`).
*   Vendor-controlled licensing handshake with zero tenant-data visibility (`licenseChecker.js` + `licensing_server/`) — already more complete than the reference project's peer-to-peer sync model.

### 5.3 Phase 9: Must-Fix Hardening (before any paying client)
*   Fix Razorpay mock-bypass string mismatch between `server.js` and the live `settings.json` key.
*   Replace `qrGenerator.js`'s decorative pattern with a real QR encoder producing a valid `upi://pay?...` deep link.
*   Add real server-side session auth (token issued on PIN success, required on mutating endpoints) — the admin PIN is currently only checked client-side.
*   Auth-gate the currently-open `/api/diagnostics/telemetry` endpoint.

### 5.4 Phase 10: Dashboard
New default-landing dashboard tab computing KPIs client-side from already-fetched data (today/MTD revenue & invoice count, outstanding advances total, active gold rate with source badge, purity-mix breakdown, recent transactions, recent advance deposits). Requires one new endpoint, `GET /api/advances` (list-all).

### 5.5 Phase 11: Advances Module (Report & Browse)
Searchable customer list with running balances, full ledger drill-down, and manual deposit entry — the missing browse/report counterpart to the redemption flow already built into the Billing Desk.

### 5.6 Phase 12: Settings Expansion
Reorganize into tabs: Store Profile, Gold Pricing & Overrides, Billing/Tax & Invoice numbering, Payment Gateway, Backup & Email Reports, License/Subscription status. Adds a real server-side check behind any destructive/triple-confirmation actions.

### 5.7 Phase 13: Backup Email Reports
Wire the already-installed but unused `nodemailer` dependency into `backupEngine.js` for daily/monthly HTML summary emails.

### 5.8 Phase 14: Cloud Deployment Packaging
A repeatable per-tenant deploy runbook/script (Node + process manager + reverse-proxy TLS), env-based configuration, and a first-boot license activation flow. This is the phase that makes "ready to deploy" literally true.

### 5.9 Phase 15: SaaS Control Plane Enhancements
Extend `licensing_server/` license records with `billingCycle`, `amount`, `nextDueDate`, and a `latestVersion` flag; extend its admin dashboard with a tenant list and billing status. POS clients check `latestVersion` on boot and surface a non-blocking "update available" banner (manual push, not self-updating).

### 5.10 Phase 16: Encrypted "Black Box" Engine Log & Analyzer
A dedicated, PII-scrubbed structured event stream encrypted with its own RSA-4096 keypair (separate from the existing Level-2 developer key, so compromising one never unlocks the other). Exported only on request, decryptable only offline by the platform owner's private key, feeding an offline analyzer script that aggregates error frequency, slow endpoints, and memory trends into a scope-of-change punch list. The analyzer tool itself never ships to tenants.

### 5.11 Phase 17: Native Android Customer App
Capacitor-wrapped `customer.html` portal as the v1 native app (fast, reuses tested UI, real Play Store presence, push notifications addable later via plugin), with a full React Native rewrite available as a later option if needed.

### 5.12 Effort Estimate
Reflects focused AI-assisted build+review sessions, not a traditional team estimate.

| Phase | Effort |
|---|---|
| 9 — Security/QR fixes | 1 session |
| 10 — Dashboard | 1 session |
| 11 — Advances module | 1 session |
| 12 — Settings expansion | 1–1.5 sessions |
| 13 — Backup email reports | 1 session |
| 14 — Cloud deployment packaging | 1 session build + 1–2 real days for first live server/DNS/TLS |
| 15 — SaaS control plane | 1.5 sessions |
| 16 — Black-box analyzer | 1.5–2 sessions |
| **Subtotal (9–16, web platform)** | **~9–11 sessions ≈ 2–3 calendar weeks** including review cycles |
| 17 — Android (Capacitor path) | 1–2 sessions build + 1–3 real days Play Store review |
| 17 — Android (full native alternative) | 2–4x the above |

### 5.13 Inputs Needed From Platform Owner
*   VPS/cloud account access for the first pilot tenant deployment (Phase 14).
*   Real SMTP credentials for backup/report emails (Phase 13).
*   Real or sandbox Razorpay credentials to verify the fixed payment flow end-to-end (Phase 9/11).
*   Pricing decision (monthly vs. yearly amount) to seed the licensing schema (Phase 15).
*   Play Store developer account plus app name/icon/branding assets (Phase 17).

### 5.14 Phase 19: Dev/Sandbox/Live Pipeline
A platform-owner-internal Development → Sandbox/Test → Live promotion
pipeline, separate from (and upstream of) the per-tenant manual update
process in §5.1/`deploy/README.md` §1-7. All three environments plus a
shared non-production `licensing_server` run on one VPS as isolated PM2
processes (`deploy/ecosystem.*.config.cjs`); `GET /api/health` on both
`backend/` and `licensing_server/` gives each a liveness/version probe.
Three GitHub Actions workflows (`cd-dev.yml`, `cd-sandbox.yml`,
`cd-live.yml`) gate on the existing `test_suite.js` + `npm audit` checks,
deploy over SSH via a shared `deploy/remote-deploy.sh` script, and smoke-test
`/api/health` post-deploy. Live deploys require manual approval via a GitHub
Environment protection rule — nothing reaches the platform owner's own
production/pilot instance unattended. See `deploy/README.md` §8 for the full
layout, provisioning runbook, and promotion flow.

**Inputs needed from platform owner for this phase:** a domain name and one
VPS (2GB RAM recommended) to provision the pipeline on, plus the repo
secrets/variables listed in `deploy/README.md` §8.4 once that server exists.

---

## 6. Completion Checklist

Living tracker — update as each item lands. Verified against source as of 2026-07-13.

### Done (Phases 1-8)
- [x] Express server + static frontend hosting — `backend/server.js`
- [x] Atomic JSON read/write layer with error/telemetry logging — `backend/db.js`
- [x] Daily midnight gold price auto-sync (Yahoo Finance + FX conversion) — `backend/priceEngine.js`
- [x] Per-carat manual override always takes priority over auto-synced rate — `backend/priceEngine.js: getActiveGoldRates()`
- [x] Level-1 plaintext diagnostics + Level-2 RSA-4096/AES-256-GCM encrypted DB export — `backend/cryptoHelper.js`
- [x] Cashier Billing Desk: gram × rate, bi-directional making-charge %, GST, manual discount — `frontend/js/components/BillingDesk.js`
- [x] Customer Advances: deposit (mandatory 10-digit phone), redemption at billing, balance lookup
- [x] Customer Portal: phone login, Gold Appreciation Calculator, Razorpay + UPI QR fallback — `frontend/customer.html`
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

### Done — Phase 19: Dev/Sandbox/Live Pipeline, 2026-07-17
- [x] `GET /api/health` (public, license-gate-exempt) on both `backend/server.js` and `licensing_server/server.js` — reports `{status, version, env}` for post-deploy smoke tests and monitoring.
- [x] `deploy/ecosystem.base.cjs` factory + 5 per-environment PM2 configs (`ecosystem.dev/sandbox/live/licensing-nonprod/licensing-live.config.cjs`), each a distinct PM2 app name so all 5 processes coexist on one VPS. Existing single-tenant `deploy/ecosystem.config.cjs` left untouched.
- [x] `deploy/remote-deploy.sh` — shared, parameterized deploy script (`git reset --hard` + `npm ci` + `pm2 startOrRestart` + `pm2 save`) used identically by hand or from CI.
- [x] `deploy/README.md` §8 — full layout table, provisioning runbook, and day-to-day promotion flow for the pipeline.
- [x] Three GitHub Actions workflows (`cd-dev.yml`, `cd-sandbox.yml`, `cd-live.yml`) — test gate (existing `test_suite.js` + `npm audit` pattern) → SSH deploy → `/api/health` smoke test. `cd-live.yml` requires a GitHub Environment manual-approval gate before touching the platform owner's own Live instance.
- [ ] **Not yet exercised end-to-end** — no VPS/domain provisioned yet, so the workflows have not actually run against a live server. See Blocked list below.

### Blocked on Inputs From Platform Owner
Step-by-step "how do I actually get this" instructions for every item below are in **`docs/GO_LIVE_CHECKLIST.md`** (2026-07-13) — each requires the platform owner's own identity/account/payment details and cannot be completed by an AI agent.
- [ ] VPS/cloud account for pilot deployment (Phase 14's runbook and PM2 config are verified-working; nothing to deploy *to* yet)
- [ ] Real SMTP credentials (Phase 13's send logic is verified end-to-end via a disposable test account; only real production creds are missing)
- [ ] Real or sandbox Razorpay credentials
- [ ] Pricing decision (monthly/yearly amount) — Phase 15's schema is ready to store it, needs the actual number(s)
- [ ] Play Store developer account + branding assets (icon, screenshots, privacy policy URL) — Phase 17's scaffold is ready, needs these plus a machine with Android Studio to build
- [ ] Domain name + a 2GB VPS for the Phase 19 dev/sandbox/live pipeline, plus the GitHub repo secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`) and variable (`PIPELINE_DOMAIN`) once that server exists — see `deploy/README.md` §8.2-8.4
