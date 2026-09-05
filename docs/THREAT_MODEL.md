# Gold POS threat model and security release gates

**Status:** baseline established 2026-09-03. This is a living release artifact;
it is not evidence that a live merchant deployment is approved.

## Security objective

Protect the integrity and availability of the financial ledger, stock ledger,
customer balances, payment confirmations, credentials and personal data. A
counter must fail safely: a security or diagnostic failure must never silently
change money, stock, identity, or an immutable audit fact.

## Assets, actors and trust boundaries

| Asset | Principal threats | Required control/evidence |
| --- | --- | --- |
| Sales, returns, advances, stock and audit chain | Cashier error, privileged misuse, forged/replayed request, database/ransomware loss | Server-side recalculation, atomic transactions, RBAC, append-only audit/black-box trail, encrypted backup and restore drill |
| Customer identity, balances and PII | Account takeover, phone enumeration, IDOR, data exfiltration | Scoped customer sessions, rate limits/lockouts, generic registration response, redaction, purpose/retention approval |
| Owner/manager authority and settings | Stolen PIN/device, session replay/fixation, insider privilege escalation | Named roles, owner-only configuration, session revocation, MFA for money-release roles before live launch |
| Payments and webhooks | Spoofed signature, duplicate/out-of-order event, amount mismatch | Provider signature verification, idempotency, tenant/order binding, sandbox replay and reconciliation evidence |
| Browser and API boundary | XSS, CSRF, CORS abuse, malformed/oversized body, hostile headers | CSP, CSRF protection, exact origin policy, validation/body limits, safe DOM rendering, generic client errors |
| Host, keys and backups | VPS compromise, SSH theft, key leakage, dependency compromise, disk exhaustion | TLS/firewall/non-root deployment, secrets outside Git, off-host encrypted backups, vulnerability/SBOM gate, bounded diagnostics |

## Adversary scenarios that must be rechecked for every release

1. An untrusted internet client submits malformed, oversized, cross-origin or
   replayed requests and tries every API identifier from another tenant/customer.
2. A cashier workstation is stolen while signed in, or a cashier attempts an
   owner-only action through a direct API call.
3. A malicious or compromised manager changes settings, payment details, roles,
   price inputs or backup destinations to redirect value or expose secrets.
4. A payment webhook is forged, duplicated, delayed or associated with the wrong
   order/customer.
5. A browser page receives attacker-controlled customer/item/error text and tries
   to execute it in the operator's session.
6. A dependency, CI workflow, release bundle, VPS or backup medium is compromised.
7. The log volume fills or becomes read-only during a peak counter period.

## Implemented baseline in this codebase

- Security headers, CSP, explicit CORS, CSRF controls, request/body limits,
  request IDs and client-error redaction are enforced in the API layer.
- Customer and admin sessions are scoped; money/configuration routes use role
  checks and documented rate limits. Payment flows use verification and duplicate
  protection.
- Financial database commits and audit facts remain durable; only operational
  telemetry/black-box diagnostics use the bounded asynchronous writer. The writer
  exposes queued, dropped and failed counts and backs off on an unavailable volume.
- The dependency lock now overrides transitive `qs` to 6.16.0, resolving the
  currently reported audit advisories without adding a runtime package.

## Non-negotiable launch gates

- A fresh `npm audit --omit=dev --audit-level=moderate` is clean and the lockfile
  is installed with `npm ci` in CI/deployment.
- The automated authorization, anti-replay, redaction and route suites pass. A
  separate independent penetration test exercises the deployed public endpoint.
- An external deployment check proves TLS, headers, cookies, CORS, firewall and
  no default/test credentials. The evidence records the exact release identifier.
- A restore drill on a separate host validates encrypted backup, audit chain and
  financial totals; recovery-key custody is documented and separated.
- CA, payment-provider and privacy launch gates in `TESTING_CHECKLIST.md` §23b
  are signed off. Security controls cannot replace legal approval.

## Required change record

For each new route or financial workflow, record: assets touched; caller and
trust boundary; abuse cases; server-side authorization/validation; logging and
privacy impact; automated test; operational alert; and an accountable owner.
Unchecked execution evidence lives in `TESTING_CHECKLIST.md` §23d.
