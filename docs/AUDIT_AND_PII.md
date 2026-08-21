# Audit trail and personal data — classification and handling

What this system stores about people, where it lives, who can read it, and how
long it is kept. Written for three readers who ask different questions: an
engineer deciding where a new field belongs, an operator answering a customer's
request about their data, and an auditor asking whether the trail can be trusted.

**Status.** Classification and access control are settled and implemented.
**Retention has a mechanism now (Phase 41, 2026-08-21), flagged off by default**
— see §5. The actual retention *period* is still an open legal question; the
mechanism exists so the day it is answered is a settings change, not a build.

Related: `docs/RUNBOOKS.md` §3 (proving the trail), `docs/adr/` (data store
decisions), `CLAUDE.md` §0 (which data lives in SQL and which in JSON).

---

## 1. Classification scheme

| Class | Meaning | Handling |
|---|---|---|
| **P0 — Public** | No personal content. Store configuration, rates, tax slabs. | No restriction. |
| **P1 — Business** | Identifies a transaction, not a person. Invoice numbers, amounts, purities, weights. | Admin session. |
| **P2 — Personal** | Identifies a living individual. Name, phone, email, address. | Admin session. Redacted from support exports. |
| **P3 — Credential** | Grants access if disclosed. PIN hashes, TOTP secrets, password hashes, API secrets, the tenant salt. | **Encrypted at rest**, never sent to a browser, never in an export, never logged. |
| **P4 — Accountability** | Names *who did what*. The audit trail. | Approver-only, append-only, hash-chained. |

The classes are ordered by what disclosure costs, not by how sensitive they
feel. A phone number (P2) is a nuisance if leaked; a TOTP secret (P3) is a
standing key to somebody's account.

---

## 2. Where each class actually lives

### P3 — Credentials

| Field | Location | Protection |
|---|---|---|
| `adminPinHash`, `operators[].pinHash` | `settings.json` | scrypt hash, then **AES-256-GCM at rest** |
| `authSalt` | `settings.json` | encrypted at rest (it cheapens an offline grind) |
| `operators[].totpSecret` | `settings.json` | encrypted at rest — a bearer secret, the worst thing here to lose |
| `razorpayKeySecret`, `razorpayWebhookSecret` | `settings.json` | encrypted at rest |
| `smtp.pass` | `settings.json` | encrypted at rest |
| `customers.password_hash` / `password_salt` | SQLite | scrypt hash |
| `customers.reset_token_hash` | SQLite | hash of a single-use, expiring code |

Encryption at rest is `backend/secretVault.js`; the key comes from
`GOLD_POS_SECRET_KEY` and **must not live in the data directory in production**
(`docs/RUNBOOKS.md` §1). Every field above is declared once in
`SECRET_SETTINGS_KEYS` (`defaultSettings.js`), which is what both redaction and
encryption walk — so a newly added credential is covered by both without either
being edited.

**A 4-digit PIN keyspace remains the weak point.** A hash of a 4-digit PIN falls
to an offline grind in minutes if both the file and the key are taken. Raising
the keyspace is `[needs design decision]` — it changes muscle memory at the
counter and needs a migration path for PINs already in use.

### P2 — Personal data

| Field | Location |
|---|---|
| `customers.full_name`, `phone`, `email` | SQLite `customers` |
| Customer name/phone denormalised onto invoices | SQLite `invoices` |
| Company address, GST number | `settings.json` (the business, not a person) |
| `audit_events.ip_address` | SQLite — personal data in most readings; see §4 |

### P4 — The audit trail

`audit_events`, written on every money path by `saleService`, `returnService`,
`advanceService` and `paymentService`. Each row carries the action, the entity,
a summary, the actor (both a `users` foreign key and a label), the IP address,
and a `detail_json` blob.

**`detail_json` is the field to watch.** It is free-form, and it is the easy
place to accidentally write a P3 value into a P4 record. Nothing currently does.
Before adding to it, check the value is not a credential — the trail is
approver-readable and exportable, so anything in it is disclosed to every
approver and to whoever receives an export.

---

## 3. Who can read what

| Surface | Gate |
|---|---|
| `GET /api/settings` | Admin session; every P3 field masked with a sentinel |
| Support / diagnostics export | `redactSettings()`; bounded to 500 rows per ledger |
| `GET /api/audit`, `/api/audit/verify`, `/api/audit/export` | Admin session **and** `requireApprover` |
| Customer portal | The customer's own session; their own records only |

The audit trail is approver-only on purpose, and the reasoning is worth keeping:
the trail names who released money, which makes it the record a cashier under
suspicion most wants to read and has least business reading. It sits behind the
same gate as approving a claim, so "who may see the evidence" and "who may
create the thing being evidenced" are answered by one rule rather than two.

---

## 4. Integrity, and its honest limits

Since migration 001 the trail has been append-only by trigger. Since **005** each
event also carries `prev_hash` and `row_hash`, chaining every event to the one
before it.

**What that proves:** no row has been edited or removed unless every hash after
it was recomputed too.

**What it does not prove:** whoever holds the database file can drop the
triggers, edit a row, and recompute the whole tail. The chain will then verify
against itself. This is unavoidable for a chain stored beside the data it
describes, and pretending otherwise would be worse than not having it.

**What closes the gap:** the head hash, published in every export. Once a head
hash is in an auditor's hands, the rows behind it are pinned — a re-hashed chain
produces a different head. So the control is not the chain alone; it is the
chain plus **the habit of exporting it somewhere you do not control.**

**Events written before 005 carry no hashes and are not covered.** They are
counted and reported as such, never folded silently into the verified total.
Backfilling them was considered and rejected: hashing a row today proves nothing
about what it said last year, while looking authoritative.

**Clock.** `occurred_at` is the server's own clock; nothing in the trail is
signed by an external time source. On a single-shop install the practical risk
is a counter PC with a drifting clock, not a forged timestamp. NTP on the host
is the mitigation, and it belongs in provisioning rather than here.

---

## 5. Retention — mechanism built, period still unset

**Phase 41 (2026-08-21) built the archive-then-prune mechanism this section used
to say was worth building "once the period is known, and not before."** The
owner decided not to wait: the mechanism exists now, gated behind
`auditRetentionEnabled` (default `false`) in settings, and `auditRetentionDays`
(default `2555`, ~7 years) is an ENGINEERING PLACEHOLDER, not the legal
determination this section still calls for. Disabled — the default for every
existing and new install — audit_events grows forever exactly as it always has;
nothing added in Phase 41 changes behaviour until a tenant explicitly turns it
on. `[needs design decision: the real audit and personal-data retention
periods]` remains open — a business/legal question, not an engineering one, per
the three reasons below.

**How it works, briefly** (full detail in `backend/repositories/
auditRetentionRepository.js`): a nightly job prunes only a CONTIGUOUS PREFIX of
the chain — never the middle, never a gap — and records a checkpoint row
holding the last pruned row's hash and `chain_seq`. `verifyChain()` seeds
itself from that checkpoint automatically, so a pruned chain still verifies
instead of reporting a permanent gap, which is exactly the mechanism reason 2
below used to say was missing.

Three reasons, in order of weight:

1. **It is a legal question, not an engineering one.** How long a jeweller must
   retain records naming who approved a refund is a matter of Indian tax and
   company law and of what the tenant's own insurer requires. Picking a number
   here would be inventing store policy — the same reason the dual-control
   threshold and the PIN keyspace are held open.

2. **Deleting audit rows breaks the chain.** `trg_audit_events_no_delete` refuses
   a DELETE outright, and that trigger is load-bearing. A retention job would
   need a deliberate archive-then-prune path that records a checkpoint hash for
   the pruned range — otherwise verification reports a gap forever after, and a
   control that cries wolf gets ignored. That mechanism is worth building **once
   the period is known**, and not before.

3. **The competing pressure is real but weaker.** Data-minimisation duties argue
   for deleting personal data that is no longer needed. That argues for a policy,
   which is exactly what is missing — not for a default that quietly destroys
   records a tenant may be required to keep.

**What to decide, when somebody is in a position to:** the retention period for
audit events; the retention period for customer accounts after last activity;
and whether deletion means erasure or anonymisation (invoices must survive for
tax purposes even if the customer is forgotten, which argues for anonymisation
of the denormalised name and phone rather than deletion of the row).

Until then the system keeps everything, which is the recoverable mistake. The
other one is not.

---

## 6. For an engineer adding a field

1. **Which class?** If it grants access, it is P3 — add it to
   `SECRET_SETTINGS_KEYS` and it is redacted and encrypted automatically.
2. **Is it going into `audit_events.detail_json`?** Check it is not P3. That blob
   is approver-readable and leaves the building in exports.
3. **Does it identify a person?** Then it is in scope for whatever retention
   policy §5 eventually produces. Note it here so that decision is made with a
   complete list.
4. **Never add a second mechanism.** One walker finds every secret
   (`mapSecretValues`); one gate guards the trail (`requireApprover`); one
   validator shapes settings. A parallel path is how a field ends up covered by
   redaction but not encryption.
