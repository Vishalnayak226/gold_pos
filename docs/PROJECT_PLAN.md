# Project Plan: SaaS Gold Business POS

This document outlines the architecture, features, implementation roadmap, and finalized configurations for the web-based **Gold Business POS**. 

> **Production status note — 2026-08-07:** The completion checkboxes below
> record feature implementation history; they do not mean the system is ready
> for real customer money. A fresh audit found stop-ship issues in browser/API
> integration, payment binding/reconciliation, transactional persistence,
> identity, recovery, and test coverage. The authoritative go-live and
> future-proofing plan is
> **[`PRODUCTION_READINESS_ROADMAP.md`](PRODUCTION_READINESS_ROADMAP.md)**.
> Complete its Phase 0 and Phase 1 gates before a paying pilot or live
> Razorpay/customer-entered UPI flow. Rebase the Scheme plan on that
> transactional foundation instead of adding more JSON financial files.

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

**Phases 1–8 (baseline through integration testing) — closed.**
Archived → `docs/archive/checklist_closed_phases.md`

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

### 5.15 Phase 20 series: Gold Savings Scheme Module (planned 2026-08-07)
A monthly gold savings scheme (chit/plan) product layered onto the existing
platform: scheme master + branches, member enrollment with member numbers,
counter and online installment collection with the gold rate and gram weight
locked immutably per payment, an auditable passbook with per-installment
receipts, due/overdue reminders, maturity + bonus, and redemption back into the
Billing Desk. Benchmarked as a *feature inventory only* against a competitor
customer app the platform owner supplied screenshots of — no code, copy, layout,
or branding from it is reused, and the UI/UX is built fresh against this
project's own design language (§4.1 of the BRD).

Introduces `branches.json`, `schemes.json`, `enrollments.json`,
`scheme_payments.json`, and `customer_auth.json`; a real customer authentication
layer (**built 2026-08-08, Phase 20.1** — `customer.html`'s phone-only login was
unverified and had to be closed before member data ships); a new
`frontend/scheme.html` customer portal; and a
`Schemes` admin tab. Estimated ~12–14 sessions for the web platform, with a
demonstrable admin-side thin slice at ~4.

**Full design, 14-phase build checklist, effort table, open decisions, and
compliance flags: `docs/SCHEME_MODULE_PLAN.md`.**

**Status (2026-08-08): Phase 20.1 is done** — customer identity and
authentication, the one phase in the series that was never blocked on the §7
decisions because it is a security fix to what already ships, not a scheme
feature. Phase 20.0 (spec lock) still blocks 20.2 onward on the seven decisions
in §7 of that document.

---

## 6. Completion Checklist

Living tracker — update as each item lands. Verified against source as of 2026-08-08.

**Phases 1–18 — closed, every item verified.**
Archived → `docs/archive/checklist_closed_phases.md`

### Done — Phase 19: Dev/Sandbox/Live Pipeline, 2026-07-17
- [x] `GET /api/health` (public, license-gate-exempt) on both `backend/server.js` and `licensing_server/server.js` — reports `{status, version, env}` for post-deploy smoke tests and monitoring.
- [x] `deploy/ecosystem.base.cjs` factory + 5 per-environment PM2 configs (`ecosystem.dev/sandbox/live/licensing-nonprod/licensing-live.config.cjs`), each a distinct PM2 app name so all 5 processes coexist on one VPS. Existing single-tenant `deploy/ecosystem.config.cjs` left untouched.
- [x] `deploy/remote-deploy.sh` — shared, parameterized deploy script (`git reset --hard` + `npm ci` + `pm2 startOrRestart` + `pm2 save`) used identically by hand or from CI.
- [x] `deploy/README.md` §8 — full layout table, provisioning runbook, and day-to-day promotion flow for the pipeline.
- [x] Three GitHub Actions workflows (`cd-dev.yml`, `cd-sandbox.yml`, `cd-live.yml`) — test gate (existing `test_suite.js` + `npm audit` pattern) → SSH deploy → `/api/health` smoke test. `cd-live.yml` requires a GitHub Environment manual-approval gate before touching the platform owner's own Live instance.
- [ ] **Not yet exercised end-to-end** — no VPS/domain provisioned yet, so the workflows have not actually run against a live server. See Blocked list below.

### Done — Phase 20.1: Customer Identity & Authentication, 2026-08-08
- [x] Closed the customer portal's open door — typing any 10-digit number into `customer.html` used to return that customer's balance and full deposit history with no credential at all. New `backend/customerAuth.js`: scrypt hashing via built-in `crypto` (no new dependency), bearer sessions persisted as SHA-256 hashes so they survive a restart, per-account lockout (persisted) plus a per-IP credential-stuffing cooldown, and single-use emailed reset codes.
- [x] New `/api/customer/*` surface — register, login, logout, `me` (GET/PATCH), password change/forgot/reset, own-ledger read and deposit — with every route scoped to the phone on the session. A `customerPhone` in the request body is ignored.
- [x] Gated four previously-public endpoints: `GET /api/advances/lookup` + `POST /api/advances` to admin, `POST /api/payment/order` + `/verify` to a customer session. Moved `BillingDesk`'s advance lookup and `AdvancesManager`'s counter deposit off raw `fetch()` onto `adminFetch()`.
- [x] Existing customers get a login at the counter (admin `POST /api/customer-accounts/issue-login` → one-time temp password, forced change on first sign-in); self-service registration is refused for a number that already has store history, which is what prevents an outsider claiming an existing customer's ledger without an SMS gateway.
- [x] **Verified live:** 53-check API pass, 20-check post-restart pass, 29-check Playwright pass at 390px — all green, with `backend/data/` backed up first and diffed byte-identical afterwards. The reset email was captured by a throwaway local SMTP server, so the code that was tested is the one actually delivered.
- [ ] **Still open (not this phase's scope):** a manual-UPI deposit still posts real credit on an unverified, customer-typed reference string — tracked as a P0 in `docs/PRODUCTION_READINESS_ROADMAP.md` §3.

### Blocked on Inputs From Platform Owner
Step-by-step "how do I actually get this" instructions for every item below are in **`docs/GO_LIVE_CHECKLIST.md`** (2026-07-13) — each requires the platform owner's own identity/account/payment details and cannot be completed by an AI agent.
- [ ] VPS/cloud account for pilot deployment (Phase 14's runbook and PM2 config are verified-working; nothing to deploy *to* yet)
- [ ] Real SMTP credentials (Phase 13's send logic is verified end-to-end via a disposable test account; only real production creds are missing)
- [ ] Real or sandbox Razorpay credentials
- [ ] Pricing decision (monthly/yearly amount) — Phase 15's schema is ready to store it, needs the actual number(s)
- [ ] Play Store developer account + branding assets (icon, screenshots, privacy policy URL) — Phase 17's scaffold is ready, needs these plus a machine with Android Studio to build
- [ ] Domain name + a 2GB VPS for the Phase 19 dev/sandbox/live pipeline, plus the GitHub repo secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`) and variable (`PIPELINE_DOMAIN`) once that server exists — see `deploy/README.md` §8.2-8.4
