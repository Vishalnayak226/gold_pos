# Runbooks — Gold POS

Procedures for things that go wrong, and for the periodic checks that stop them
going wrong quietly. Each one is written to be followed under pressure by
somebody who did not write the code.

**Conventions.** Commands run from the repository root unless stated. `<tenant>`
means that install's data directory (`backend/data/` by default, or whatever
`GOLD_POS_DATA_DIR` points at). Anything that writes is called out before the
step, not after it.

Related: `deploy/README.md` (deployment and rollback), `docs/GO_LIVE_CHECKLIST.md`
(first-time provisioning), `docs/AUDIT_AND_PII.md` (what the trail holds and who
may read it).

---

## Contents

**Secrets**
1. [Rotating the secret-vault key](#1-rotating-the-secret-vault-key)
2. [Recovering from a lost or wrong vault key](#2-recovering-from-a-lost-or-wrong-vault-key)

**Evidence**
3. [Proving the audit trail has not been altered](#3-proving-the-audit-trail-has-not-been-altered)

**Backup and recovery**
4. [Monthly restore drill](#4-monthly-restore-drill)
5. [Restoring a tenant from a backup](#5-restoring-a-tenant-from-a-backup)

**Daily operation**
6. [Day open and day close](#6-day-open-and-day-close)
7. [Payment mismatch](#7-payment-mismatch)
8. [Duplicate or missing invoice number](#8-duplicate-or-missing-invoice-number)
9. [Gold rate outage](#9-gold-rate-outage)
10. [Connectivity loss](#10-connectivity-loss)
11. [Lost or stolen counter device](#11-lost-or-stolen-counter-device)
12. [Offboarding a tenant](#12-offboarding-a-tenant)

---

## 1. Rotating the secret-vault key

**When:** on a schedule (annually is a reasonable default until somebody sets a
policy), whenever an operator with server access leaves, and immediately after
any suspected exposure of the environment.

**What it touches:** `<tenant>/settings.json` only. The ledger is untouched —
no credential lives in it.

**The server must be stopped.** A running process holds the old key in memory
and will write a value back under it, leaving one document encrypted under two
keys. There is no recovery from that except restoring a backup.

```bash
# 1. Stop the service.
pm2 stop gold-pos          # or: Restart_Server.bat / Ctrl-C on a dev box

# 2. Rehearse. Writes nothing; proves every secret re-encrypts and reads back.
cd backend
node rotateSecretKey.js --generate-new --dry-run

# 3. Rotate for real. Prints the NEW key — it is not stored anywhere else.
npm run key:rotate

# 4. Put the printed value in the environment BEFORE starting again.
#    On a VPS this is backend/.env; under systemd it is the unit's Environment=.
#    GOLD_POS_SECRET_KEY=<the 64 hex characters it printed>

# 5. Start, and confirm.
pm2 start gold-pos
curl -fsS localhost:5000/api/ready
```

**Confirm it worked** by signing in at the admin desk. A wrong key does not
corrupt anything — it fails to decrypt, loudly, and the PIN will simply not
verify.

**Then delete the pre-rotation backup** the tool wrote beside `settings.json`
(`settings.json.pre-rotation-<timestamp>`). It is still readable with the OLD
key, so leaving it there keeps the old key meaningful. It is gitignored, never
committed — but it is still on the disk that gets stolen.

> **Production has no fallback, on purpose.** With `NODE_ENV=production` and no
> `GOLD_POS_SECRET_KEY`, the server refuses to start and says so as a numbered
> blocker. Outside production it writes a development keyfile into the data
> directory instead — convenient, and worth nothing as a control, because it
> sits in the directory it is protecting.

---

## 2. Recovering from a lost or wrong vault key

**Symptom:** the server refuses to start with a `GOLD_POS_SECRET_KEY` blocker,
or logs `Could not decrypt the secret at "<field>"`.

**First, establish which case this is.**

```bash
grep -o 'encv1\$' <tenant>/settings.json | wc -l
```

- **0** — the document is still plaintext. This is not a key problem; the
  message is coming from somewhere else. Check that `GOLD_POS_SECRET_KEY`, if
  set, is 64 hex characters.
- **more than 0** — the secrets are sealed and the key in the environment is not
  the one that sealed them.

**If you have the old key** (a password manager, the deploy secret store, the
terminal scrollback from the last rotation), put it back in the environment and
start. Then rotate properly using runbook 1.

**If the key is genuinely gone, the sealed credentials are gone.** That is the
control working as designed — nothing in the tree can decrypt without it. The
ledger is unaffected: no money record is encrypted. Recover the *configuration*
by re-entering it:

```bash
# 1. Keep the unopenable document for reference, then start from the template.
mv <tenant>/settings.json <tenant>/settings.json.locked-<date>

# 2. Set a fresh key in the environment.
cd backend && node rotateSecretKey.js --generate      # put the value in .env

# 3. Start. getDefaultSettings() rebuilds the document, and
#    migratePinsToHashes() establishes the documented default master PIN.
pm2 start gold-pos
```

Then re-enter, at the Settings screen: company identity and GST number, Razorpay
key id **and secret**, the Razorpay webhook secret, SMTP host/user/**password**,
tax slabs, invoice prefix and — critically — **the invoice sequence, set to
continue the existing series, not to restart it.** Read the last invoice number
off the ledger first:

```bash
cd backend && node -e "
process.env.GOLD_POS_DATA_DIR='<tenant>';
const r = await import('./repositories/index.js');
console.log(r.unsafeDatabaseHandle().prepare('SELECT invoice_number FROM invoices ORDER BY issued_at DESC LIMIT 1').get());
r.closeDb();
"
```

Every operator must then be re-added and will need a new PIN, and anyone
enrolled in TOTP must re-enrol. **Non-recoverable by design:** the old PIN
hashes and TOTP secrets.

---

## 3. Proving the audit trail has not been altered

**When:** on request from an auditor, an accountant or an insurer; after any
suspected tampering; and as step 4 of the monthly restore drill.

The trail is append-only by trigger *and* hash-chained. The triggers stop the
application rewriting history; the chain is what answers a third party, because
a trigger can be dropped by anyone holding the database file.

```bash
cd backend
npm run audit:verify
```

Read the output carefully — three lines matter:

- **`Internally consistent`** — no row has been edited or removed *without the
  hashes after it being recomputed too*.
- **`Events predating chain`** — events written before migration 005. They carry
  no hashes and **are not covered.** They are counted rather than hidden,
  because backfilling them would hash whatever they say now, which proves
  nothing about what they said then.
- **`Head hash`** — the value that makes this worth having.

**The check that actually settles a dispute** compares against a head hash that
already left the building:

```bash
node verifyAuditChain.js --expect-head <hash from an earlier export>
```

Somebody holding the database *can* edit a row and recompute every hash after
it; the chain will then verify against itself. It cannot reproduce a head hash
already in an auditor's hands. So: **export the trail periodically and send it
somewhere you do not control.** Admin desk → Audit Trail → Export, or:

```
GET /api/audit/export        (approver session required)
```

Every export is itself an audited event, so the act of taking evidence is part
of the evidence.

---

## 4. Monthly restore drill

**When:** first business day of each month. Takes about five minutes.
**Owner:** whoever holds the on-call rota. Record the date and result below the
procedure in this file, or in the tenant's operations log.

A backup nobody has restored is a hypothesis.

```bash
cd backend

# Restores the most recent snapshot into a temp directory and interrogates it.
# Never touches the live install.
npm run backup:verify
```

Nine checks run. All must pass:

| Check | What a failure means |
|---|---|
| snapshot contains files / the ledger | the backup job is writing an empty or partial snapshot |
| SQLite `integrity_check` | the file was copied while being written, or the disk is failing |
| fully migrated | the snapshot predates a migration — restoring it onto this build would migrate on first boot |
| holds business records | a successful restore of nothing |
| invoices sum to their lines | the books did not survive the copy |
| audit chain verifies | the trail was truncated or altered in the snapshot |
| settings decrypt | **the snapshot is unopenable on this host** — see below |
| settings carry the store identity | the configuration did not come across |

> **The one people get wrong.** Snapshots contain `settings.json` with its
> credentials **encrypted**, and never contain the key. That is deliberate — a
> stolen backup yields no credentials. It also means a restore onto a host
> without `GOLD_POS_SECRET_KEY` produces a perfectly intact ledger that nobody
> can log into. **Store the vault key somewhere separate from the backups, and
> confirm you can still read it as part of this drill.**

Use `npm run restore:drill` instead to keep the restored copy for inspection;
it prints where it left it. Delete it afterwards — it is a full copy of the
tenant's books.

---

## 5. Restoring a tenant from a backup

**This overwrites live data. Take a copy of the current state first, even if you
believe it is worthless — it is the only thing that makes this reversible.**

```bash
# 0. Verify the snapshot you intend to restore BEFORE destroying anything.
cd backend && node verifyBackup.js --backup ../backups/backup_<YYYY-MM-DD>

# 1. Stop the service.
pm2 stop gold-pos

# 2. Set the current state aside.
mv <tenant> <tenant>.before-restore-$(date +%Y%m%d-%H%M%S)

# 3. Put the snapshot in place.
mkdir -p <tenant> && cp ../backups/backup_<YYYY-MM-DD>/* <tenant>/

# 4. Confirm the vault key in the environment is the one this snapshot was
#    sealed with. If it is not, stop and read runbook 2 first.

# 5. Start, and check readiness rather than assuming.
pm2 start gold-pos
curl -fsS localhost:5000/api/ready
```

**Then, before trading:** sign in, confirm the last invoice number matches what
the shop believes it issued, and check the advances balance for one known
customer. Any sale made between the snapshot and now is gone and must be
re-entered — the invoice numbers it consumed will be reissued, so the series
stays contiguous.

---

## 6. Day open and day close

**Open.** Confirm the process is up (`/api/ready` returns 200 — `/api/health`
only proves the process is alive, not that the ledger is open). Check today's
gold rate is present and dated today; if the sync failed, set the override
before the first sale rather than after.

**Close.** Take the day's totals from the admin desk. Reconcile cash in the
drawer against the cash tender total, and the card/UPI totals against the
gateway's own dashboard — not against this system's record of them, which is
the thing being checked. Any manual-UPI claim still `pending` at close is money
the shop has not confirmed receiving: it stays pending, it is not balance, and
it should be chased before it is approved.

---

## 7. Payment mismatch

**Symptom:** the gateway says captured; the POS shows no credit. Or the amounts
differ.

1. Find the order: admin desk → Advances → the customer, or query
   `payment_orders` by `provider_order_id`.
2. **Check the webhook first.** `/api/payment/webhook` is the source of truth
   and is exempt from the licence gate precisely so a lapsed licence cannot
   discard money already taken. Look in `error.log` for a signature failure —
   the usual cause is a `razorpayWebhookSecret` that was rotated at the gateway
   and not here.
3. A payment the gateway reports as `authorized` but not `captured` is **not**
   credited, by design. It waits for capture. This is correct behaviour, not a
   bug.
4. An amount mismatch is recorded as `status: 'mismatched'` and deliberately
   credits nothing. Resolve it with the gateway, then credit by hand as a
   counter deposit with the reference in the note — never by editing the row.

**Never** adjust a balance by editing the database. Every legitimate correction
has a route, and each one writes an audit row naming who made it.

---

## 8. Duplicate or missing invoice number

Duplicates are prevented by a unique index, and a number consumed by a failed
sale is **rolled back rather than burned**, so the series stays contiguous.

If a number appears to be missing, check in this order:

1. Was there a return or cancellation? A credit note references the invoice; the
   invoice itself is never deleted.
2. `npm run audit:verify` — a gap in the audit chain and a gap in the invoice
   series together mean something removed rows directly.
3. Query `document_sequences` for the current value. If somebody changed
   `invoiceSeqStart` in Settings mid-year, the change is pushed through to the
   allocator (and refused unless confirmed when it would lower the series).

---

## 9. Gold rate outage

The price sync runs on a schedule and can fail — the provider is a public API
with no contract behind it.

A sale is **refused with 503 rather than priced against a stale or zero rate.**
That is deliberate: an invoice priced wrongly is worse than a sale delayed by a
minute.

**To keep trading:** Settings → override the rate for the affected purities with
the day's rate from the usual source, and note in the day log that rates were
manual. Each affected line records `rate_source: 'manual'`, so the audit answers
*which* items were priced by hand. Clear the override once the sync recovers.

---

## 10. Connectivity loss

The POS is a local process with a local database and keeps trading through an
internet outage. What stops working:

- **Rate sync** — see runbook 9.
- **Online payments and manual-UPI verification** — take cash, or record the
  claim as pending and confirm when connectivity returns.
- **Licence handshake** — there is an offline grace period. It does not expire
  the moment the link drops. If the grace period is genuinely exhausted the desk
  says so explicitly.
- **Emailed reports** — they queue and are not lost.

---

## 11. Lost or stolen counter device

1. **End the sessions.** Admin desk → Staff & Roles → the operator → sign out
   all sessions. Deactivating them ends every live session in the same request.
2. **Change the master PIN**, since a shared PIN on a lost device is a shared
   PIN in someone else's hands.
3. **If the device held the data directory** (a full install, not a browser),
   treat it as a data breach of the ledger. The credentials in `settings.json`
   are encrypted at rest and the key is in the environment, not the directory —
   so those are safe **only if the key was not also on that device.** On a
   single-box install it was. Rotate it: runbook 1.
4. Re-enrol TOTP for any operator whose device is gone.

---

## 12. Offboarding a tenant

1. Export their data while the install still works: a full backup directory, plus
   an audit-trail export for the record.
2. Confirm with them, in writing, what they have received and what will be
   destroyed.
3. Deactivate the licence at the licensing server.
4. Destroy the data directory **and every backup snapshot of it**, and delete the
   vault key from wherever it is stored. Deleting the key without deleting the
   backups leaves ciphertext nobody can read, which is not the same as deletion
   and should not be described as such to the tenant.

---

## Drill log

Record each monthly restore drill here. An unrecorded drill did not happen.

| Date | Snapshot tested | Result | Run by |
|---|---|---|---|
| _(none recorded yet)_ | | | |
