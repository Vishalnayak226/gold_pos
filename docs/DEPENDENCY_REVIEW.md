# Gold POS dependency lifecycle review

CLAUDE.md §0 fixes the dependency budget at 7 runtime deps in `backend/package.json`
+ 2 in `licensing_server/package.json` (9 total; CLAUDE.md's own count of "the 3 in
`licensing_server/`" was stale — corrected 2026-09-17, see below) + one exempt
devDependency, `@playwright/test`. **This document is the review that budget
requires.** CLAUDE.md §1: "No new third-party dependency unless there is genuinely
no reasonable way to do it with the stdlib." Every runtime dependency below exists
because that bar was actually cleared — record it here, don't re-litigate it from
memory next time.

## Before adding a new runtime dependency

Fill in a new entry below **before** `npm install --save` lands in the same PR as
the code that uses it. This is the §24b "keep modules replaceable" gate: a
dependency without an exit plan is the one thing in this codebase that isn't.

- **Purpose.** What it does, in one sentence — not what it's called.
- **Why not the stdlib / what's already vendored.** The specific gap (`node:sqlite`,
  `node:crypto`, `node:http` etc. don't cover) that forced this.
- **Alternatives considered.** What was ruled out and why.
- **Lifecycle signal.** Last release date, maintainer count, open critical issues —
  checked at add time, not assumed.
- **Licence.** SPDX id. Must be permissive (MIT/BSD/ISC/Apache-2.0/MIT-0 — the
  existing budget is entirely these); anything copyleft needs an explicit call-out
  and sign-off before it lands.
- **Vulnerability posture.** `npm audit` clean at add time; who re-checks it
  (`audit:security` runs in CI — see `daily-checks.yml`).
- **Exit plan.** If this package is abandoned or a critical CVE lands unpatched,
  what replaces it — vendor the one function used, swap to stdlib, or fork. Stated
  *before* the dependency is needed, not improvised during an incident.
- **Blast radius.** Which files import it directly. A dependency imported from one
  module (e.g. `qrcode` only from the settings QR route) is a smaller liability
  than one threaded through the repository seam.

Update `CLAUDE.md` §0's dependency-budget line in the same PR — that line is the
count this document justifies, and the two must never drift apart again.

---

## Current runtime dependencies

### `backend/package.json`

| Package | Version (installed) | Licence | Purpose |
|---|---|---|---|
| `cors` | 2.8.6 | MIT | CORS header negotiation for the admin/customer API origins. |
| `dotenv` | 17.4.2 | BSD-2-Clause | Loads `.env` into `process.env` at boot. |
| `express` | 4.22.2 | MIT | HTTP routing/middleware — the whole server is one Express app (§0 pins Express 4). |
| `helmet` | 8.3.0 | MIT | Security response headers (CSP, HSTS, etc.) — see `docs/THREAT_MODEL.md`. |
| `node-cron` | 4.6.0 | ISC | Schedules the 5-minute alerting tick and daily backup/report jobs. |
| `nodemailer` | 9.1.1 | MIT-0 | SMTP delivery for alert/report emails. Patched for a high-sev advisory in `e8d7a93`. |
| `qrcode` | 1.5.4 | MIT | Renders the license-activation QR code in Settings. Single call site. |

**Why not stdlib for these:** Node has no built-in HTTP router, cron scheduler, SMTP
client, CORS/security-header middleware, or QR encoder — each gap is real, not a
convenience swap for a few lines of code (§1's bar). `node:sqlite` already covers
the one gap that used to need a dependency (better-sqlite3) — see ADR-001.

**Exit plans:**
- `express` — the highest blast radius (every route). No planned swap; Express 4 is
  a version-pinned, deliberate stack decision (§0), not treated as replaceable on
  short notice. A CVE here is patched in place, not exited.
- `cors`/`helmet` — both are thin header-setting middleware; either could be
  replaced by hand-written middleware (a few dozen lines) within a day if abandoned.
- `node-cron` — small surface (`schedule()`/`stop()`); a `setInterval`-based
  scheduler is a direct, low-risk replacement.
- `nodemailer` — SMTP is a documented protocol; a minimal hand-rolled SMTP client
  or swapping to a transactional-email HTTP API are both viable, planned only if
  the security posture changes (already patched once — 2026-09-16).
- `qrcode` — one call site (`SettingsManager`'s license QR). Smallest exit cost in
  the budget: vendor a single QR-encoding function or drop the feature to a link.

### `licensing_server/package.json`

| Package | Version (installed) | Licence | Purpose |
|---|---|---|---|
| `dotenv` | 17.4.2 | BSD-2-Clause | Loads `.env` into `process.env` at boot. |
| `express` | 4.22.2 | MIT | HTTP routing for the license-activation/release-publishing API. |

Everything else this process touches (`fs`, `path`, `crypto`, `url`) is Node
stdlib — license signing uses `node:crypto`, not a third-party crypto package.
Exit plans are identical to the `backend/` entries above (same packages).

### Exempt devDependency

| Package | Version (installed) | Licence | Purpose |
|---|---|---|---|
| `@playwright/test` | ^1.50.0 | Apache-2.0 | Drives `npm run test:e2e` (CLAUDE.md §8). Ships in no runtime bundle, not imported by any server file — exempt from the runtime budget by CLAUDE.md §0's own carve-out. |

No exit plan required: removing it only turns off `test:e2e`, which is already
optional (`npm test` never depends on it).

## Review cadence

`npm run audit:security` (both `backend/` and `licensing_server/`) runs in CI on
every pull request (`daily-checks.yml`) and must stay at 0 moderate-or-above
findings. `npm run sbom:dependencies` produces the full transitive tree on demand;
it is not committed (regenerate rather than let a committed SBOM drift stale).
There is no separate calendar cadence for *this* document — re-review an entry
when its package is touched (a version bump, a CVE, a replacement), not on a timer.

## Corrections to this document

- **2026-09-17:** CLAUDE.md §0 said "the 3 in `licensing_server/`"; the package
  only ever had 2 runtime dependencies (`dotenv`, `express` — verified against
  `licensing_server/package.json` and by grepping every import in the tree for a
  bare-specifier third module; none exists). Corrected in both this document and
  CLAUDE.md §0 in the same pass.
