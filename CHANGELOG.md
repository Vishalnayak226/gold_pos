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

### Added
- **Dev/Sandbox/Live deployment pipeline** — `GET /api/health` on `backend`
  and `licensing_server`; per-environment PM2 configs
  (`deploy/ecosystem.{dev,sandbox,live,licensing-nonprod,licensing-live}.config.cjs`);
  a shared `deploy/remote-deploy.sh`; three GitHub Actions workflows
  (`cd-dev.yml`, `cd-sandbox.yml`, `cd-live.yml`) with a manual-approval gate
  before Live. This is the platform owner's own internal promotion pipeline,
  separate from the existing per-tenant manual update process. See
  `deploy/README.md` §8. Not yet exercised end-to-end — no VPS/domain
  provisioned yet.

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
