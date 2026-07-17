# Working With Third-Party Developers

Two different situations come up, and they need different scoping. Both are
covered here; both ultimately rely on the same principle: **no technical
measure (obfuscation, DRM, "encrypted" code) stops a developer who already
has source access from copying it.** The only real protections are (1)
never handing out more access than the task requires, and (2) a signed
legal agreement before any access is granted. Neither substitutes for the
other.

---

## Situation A — You (the platform owner) hire a developer to fix/extend the core platform

This is a contractor working on `backend/`, `frontend/`, or `licensing_server/`
themselves — the actual product, not a tenant's customization.

1. **Legal first, always.** An NDA plus a work-for-hire / IP-assignment
   agreement, signed before they see any code. Have a lawyer draft or review
   this — the enforceability of "the company owns everything they write"
   depends on jurisdiction and exact wording, and this is not something to
   improvise from a template found online.
2. **Work in a fork or feature branch, not on production.** They should
   never have your production `.env`, `licensing_server/keys/license_private.pem`,
   `backend/keys/*private*`, `developer_doomsday_keys/`, or
   `developer_blackbox_keys/`. Give them a checkout with those excluded (the
   existing `.gitignore` already keeps private keys and `.env` out of git —
   a fresh `git clone` of your repo to a contractor naturally excludes them
   as long as you never commit them, which you shouldn't).
3. **Review before merge.** Nothing they write reaches a live tenant until
   you've reviewed the diff and run `backend/test_suite.js` — this is
   exactly the human-approval gate the update engine (below) also enforces
   for non-security releases.
4. **Time-box and audit access.** A deploy key or repo collaborator invite
   scoped to the engagement, removed when it ends — not standing access to
   the licensing server admin panel or any tenant's live deployment.

## Situation B — A tenant hires their own developer to customize their instance only

This is the Shopify-Partner model: a merchant's developer builds against a
defined extension surface and never sees the platform's core source.

The platform already has this built in — see
[`backend/extensions/README.md`](../backend/extensions/README.md) for the
full technical contract (available hooks, safety guarantees, what's off
limits). In short:

- Give that developer **only** `backend/extensions/` and
  `frontend/js/extensions/` — ideally as their own small repo, not a
  checkout of the full platform.
- They build against documented hooks (`onSaleSaved`, `onAdvanceDeposit`,
  `onSettingsUpdated`, `onServerBoot` on the backend; `init(context)` on the
  frontend) — they cannot see or change core billing math, licensing, or
  crypto code.
- A broken or malicious extension cannot crash the platform or corrupt
  data — the loader isolates every hook call with a timeout and try/catch,
  and hooks only fire after data is already safely persisted.
- **Platform updates never touch these two folders** (see §7 of
  `ai_handover.md`) — so a tenant's customization survives every update you
  push, without you needing to know what's in it.
- The tenant should still have their own developer sign an NDA/IP agreement
  with *them* if they care who owns the extension code — that's between the
  tenant and their hire, not something the platform needs to arbitrate.

## What "non-hackable" actually means here

No claim of "unhackable" survives contact with a determined attacker — the
honest framing is defense-in-depth. As of this writing the platform has:
RSA-signed licensing handshakes, AES-256-GCM + RSA-4096 envelope encryption
for data exports, server-side admin session tokens with brute-force
lockout, output-escaped rendering (no stored XSS), server-side input
validation on all money-affecting endpoints, atomic + retry-safe database
writes, and a signed release registry so a compromised or spoofed update
source can never get malicious code auto-applied to a tenant (see
`docs/ai_handover.md` §7). What it does *not* have, and what remains the
tenant/host's responsibility: OS-level and network security (firewall,
SSH hardening, keeping Node and npm dependencies patched), and TLS
termination (already documented in `deploy/nginx.conf.template` +
certbot — this must actually be turned on for any real deployment).
