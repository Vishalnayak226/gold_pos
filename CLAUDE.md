# Project operating rules — Gold POS

These are standing constraints on every change, not preferences. Where any general-purpose
guideline, skill, or default behaviour conflicts with this file, **this file wins**.

Setup procedure and the reasoning behind these rules live in `docs/FOUNDATION.md` — read once,
not every turn. This file is auto-loaded on every request, so it stays tight.

---

## 0. Stack posture — decided, then held

- Language / runtime: **Node.js ≥24, ESM (`"type": "module"`) throughout. Express 4 only.** The floor
  is 24 (not 20) because `node:sqlite` is only stable and flag-free from 24 — see ADR-001.
- Data store: **SQLite, via the stdlib `node:sqlite`, one database file per tenant. No ORM, no DB
  server, and no new dependency — it is in the standard library.** All access goes through
  `backend/repositories/`; **no SQL string appears above that seam**, because the seam is what keeps
  the documented move to PostgreSQL a swap rather than a rewrite (ADR-001 §3).
  - **Config stays JSON on purpose.** `settings.json` and `license.json` are configuration, not
    ledger, and keep their existing mechanism — `defaultSettings.js` + `migrateSettings()`, the
    additive migration path §1 already mandates. Do not move them into SQL.
    - **A settings key that the billing pipeline reads MUST declare its type** in
      `SETTINGS_FIELD_RULES` (`defaultSettings.js`), which `POST /api/settings` enforces and
      canonicalises through `validateSettingsPatch()`. **The rule engine moved to
      `backend/validation.js` on 2026-08-17** and is shared with request-body schemas — one
      implementation, two entry points. Add a *rule*, never a second validator, and keep
      `validation.js` free of any path to `db.js` so `defaultSettings.js` stays statically
      importable from a suite (§8). These keys are read downstream with plain JS
      coercion, so a wrong *type* does not fail — it bills wrongly: a stringified `invoiceSeqStart`
      made `startSeq + 1` a string **concatenation** (10 → 101 → 1011, destroying the sequential
      invoice series), a non-numeric `goldTaxSlab` read as `Number(x) || 0` and silently charged
      **0% GST**, and an object `invoicePrefix` stamped `[object Object]` into permanent invoice
      numbers. Fixed 2026-08-13; regression-tested in `test_http.js` §"Settings TYPE validation".
  - **NO CREDENTIAL MAY EVER SIT IN `DEFAULT_SETTINGS`.** `getDefaultSettings()` is merged over a
    tenant's `settings.json` on *every* boot, so a secret in the template is re-added immediately
    after anything deletes it — which is exactly how a plaintext `adminPin: "1234"` silently
    resurrected itself beside the hash that had just replaced it. Credentials are **seeded**, not
    merged: `migratePinsToHashes()` in `backend/adminAuth.js` owns `authSalt`, `adminPinHash` and
    every `operators[].pinHash`, hashes any plaintext it finds, deletes it, and establishes the
    documented default only when no hash exists at all. That function is the single writer.
  - **PINs and TOTP secrets are scrypt-hashed, in the one shared `scrypt$N$r$p$<hex>` format**
    `customerAuth.js` already uses. One tenant-wide `authSalt` is deliberate — a PIN-only login has
    no username to look a per-user salt up by, so a per-operator salt would mean one scrypt call
    per operator per attempt. The consequence (equal PINs hash equally) is safe *only because*
    duplicate PINs are refused outright; do not relax that check.
  - **THE LEDGER IS SQL. The JSON ledger is gone** (cut over 2026-08-15). `advances`, `sales_*`,
    `returns_*`, `customer_auth`, `payment_orders` and `payment_events` are tables now, and
    `server.js` reaches them only through `backend/repositories/` and `backend/services/`. The
    files may still sit in a tenant's `backend/data/` — they are the rollback path, and
    `initialiseLedger()` in `server.js` imports them once on the first boot after the upgrade —
    but **nothing reads them at runtime.** Add **no new** JSON ledger document and **no new**
    `readJSON`/`writeJSON` caller for ledger data; the only legitimate `readJSON` callers left are
    `settings.json` and `license.json`, which are configuration.
  - **Two identity systems meet at `users.ensureActorUser()`.** Operators are configuration
    (`settings.json`), while every accountability column is a foreign key into `users`. A route
    resolves one to the other via `resolveActorUserId(req.actor)` before writing. **Never default
    a ledger write to the owner user id to make a foreign key resolve** — `advanceService` gates
    posting a claim on `users.isApprover()`, and `owner` passes it, so that shortcut silently
    grants every cashier the approval right the control exists to withhold.
  - **A sale record is BOTH shapes at once, on purpose.** It carries `lines[]` (per item: purity,
    weight, rate, making charge, discount, and that line's allocated share of the taxable value and
    GST) *and* the flat scalar rollup it always had. The rollup is what keeps every pre-multi-line
    reader working; `lines` is what the invoice actually is. Read it through `saleLines()` in
    `frontend/js/lib/billingMath.js` — never branch on `Array.isArray(sale.lines)` at a call site.
    Two invariants hold and are asserted in `test_billing_math.js` §16:
    **the per-line figures always sum exactly to the header**, and **a one-line invoice prices to
    the paise exactly as it did before lines existed.** Both are easy to break and neither is
    visible without the tests.
  - **`purity: 'MIXED'` and `goldPricePerGram: 0`** on the rollup mean "this invoice has more than
    one of these". They are not sentinels to test for — they are what an honest answer looks like
    when no single value exists. Do not "fix" them to line 1's value.
- Frontend posture: **vanilla JS/CSS/HTML in `frontend/`, served statically off disk by `backend/server.js`. No framework.**
- Build step: **none.** `frontend/package.json` exists only to mark `js/lib/` as ESM so Node tests can import it — it is never installed and never bundled.
- Dependency budget: **the 7 runtime deps in `backend/package.json` (cors, dotenv, express, helmet, node-cron, nodemailer, qrcode) + the 3 in `licensing_server/`. That is the whole budget.** Adding another is a deliberate, announced decision.
  - **One devDependency**, `@playwright/test`, is exempt from that budget because it ships nowhere: it is not imported by any runtime file, not in the release bundle, and not needed by `npm test`. That exemption covers exactly this one package — a *runtime* dependency is still a permanent liability and still needs the argument.

Three separately-run Node processes, not one app: `backend/` (POS, :5000), `licensing_server/`
(central licensing + release publishing, :6060), `mobile/` (Capacitor wrapper, no logic of its own).

---

## 1. First principle: lightweight, future-proof, solid

- **No new third-party dependency** unless there is genuinely no reasonable way to do it with
  the stdlib or what is already vendored. Prefer a few extra lines of plain code over a new
  dependency. A dependency is a permanent liability; ten lines are not.
- **No new framework, bundler, or build step** beyond what §0 commits to.
- **Data-shape changes are additive and backward-compatible.** Every tenant already has JSON
  files on disk with real data in them. A new settings key goes through
  `backend/defaultSettings.js` (`getDefaultSettings` merge + `RETIRED_SETTINGS_KEYS`) — that is
  the migration mechanism this project already has. Never rewrite an existing record shape in a
  way that cannot be applied to a live `backend/data/` directory.
- **Reuse the existing pattern; never introduce a parallel third way to do the same thing.**
  Before building a mechanism, find the one this codebase already has for that job and extend it
  — the `frontend/js/lib/billingMath.js` helpers for any pricing/rounding math, the repository for
  that domain under `backend/repositories/` for any persistence, the existing component pattern under
  `frontend/js/components/` for any new screen. Two ways to do a thing is a bug that compounds.
- **Attach shared fixes at the single choke point every caller already runs through** — the one
  validator, the one error-response writer, the one client-side error handler — instead of
  sweeping every call site by hand. Cheaper now, and it covers every *future* caller too. If no
  choke point exists and the fix is genuinely cross-cutting, creating one is the correct move.
- **Delete before you add.** If a change makes existing code dead, remove it in the same change.

## 2. Second principle: complete, smooth, and documented end-to-end

- "It loads without an error" is not the bar. **Usable** is the bar: data renders, actions work,
  empty and error states are clear, nothing dead-ends.
- When doing a QA or completeness pass, **walk the user-facing docs' own steps literally, as a
  user would**, rather than assuming they are accurate. If reality has drifted from the doc, fix
  the doc. If the doc exposes a real gap, fix the app.
- The bar is: **the user should find minimal changes needed when they test it themselves.**
- Money math is not "probably fine." Any change touching pricing, making charges, invoice lines,
  tenders, GST, advances, returns, or rounding must be covered by `backend/test_billing_math.js`
  before it is called done.
  - **Wastage is not in this list because it does not exist.** There is no wastage field, helper,
    setting or test anywhere in the tree; it was named here before it was ever built. It is a
    planned SKU-catalogue attribute — see `docs/PRODUCTION_READINESS_ROADMAP.md` Phase 5 — and
    stays out of this rule until somebody scopes it. Corrected 2026-08-12.

## 3. Third principle: take full control of routine execution

Once a plan or task is approved, execute it end-to-end **without pausing to ask permission for
routine, reversible dev-loop steps**: starting/stopping a dev server (`Restart_Server.bat`, or
`node backend/server.js`), running `npm test` / `node test_suite.js` / `node test_billing_math.js`,
curling local endpoints to verify, adding an additive settings key. Do them and report results.

This does **not** loosen §6 (git safety). Force-push, `reset --hard`, deleting anything under
`backend/data/` or `backups/`, publishing a release, committing or pushing unasked, and anything
touching shared or remote state still require explicit confirmation.

---

## 4. Documentation conventions — keep in sync without being asked

Update every one that applies whenever a unit of work finishes, without waiting to be asked.

- **`docs/LEDGER.md`** — *what was built.* Chronological build record, one section per Phase.
  Index-style: point at the checklist rather than duplicating detail.
- **`docs/TESTING_CHECKLIST.md`** / **`docs/GO_LIVE_CHECKLIST.md`** / **`docs/PIPELINE_CHECKLIST.md`**
  — *what is to be done.* `[ ]`/`[x]` per item. Mark `[x]` only once **actually verified** (tests
  run + live check where the item calls for it), and say on the line what verified it. Items
  needing a product call are marked `[needs design decision: ...]` and left unstarted — guessing
  here produces work that gets thrown away.
- **`docs/ai_handover.md`** — *handover snapshot.* Its **§0 "Version Control & Handover Status"**
  is the first thing a fresh session reads, and normally the *only* thing: latest commit, what is
  uncommitted, server state, concurrent-session risk. Keep it current. Read §0 only — grep for
  the heading, then `Read` with `offset`/`limit`.
- **`CHANGELOG.md`** — user-visible releases only, not internal work.

**Archive closed history** into `docs/archive/` when a Phase closes rather than letting
`LEDGER.md` grow without bound. Never append to an archive; never read one unless you
specifically need that closed history.

**Dates are absolute.** Never write "last week" or "recently" in a tracked doc — write the date.

---

## 5. Context discipline

A single careless whole-file read can consume more budget than an hour of careful work.
These are hard rules.

- **Never read these whole. Grep for the line, then `Read` with `offset`/`limit`:**
  `backend/server.js` (~15k tokens), `frontend/customer.html` (~15k), `docs/LEDGER.md` (~11k),
  `frontend/js/components/SettingsManager.js` (~9k), `licensing_server/server.js` (~9k),
  `frontend/js/components/BillingDesk.js` (~9k), `docs/PROJECT_PLAN.md` (~8k),
  `backend/test_billing_math.js` (~7k), `docs/PRODUCTION_READINESS_ROADMAP.md` (~7k),
  `docs/SCHEME_MODULE_PLAN.md` (~6k), `docs/brain/BRAIN.md` (~6k), `docs/ai_handover.md` (~5k).
  Same rule for any file over ~1,500 lines — check size before reading.
- **Never read at all:** any `package-lock.json`, `graphify-out/graph.json` (~140k tokens),
  `graphify-out/graph.html` (~130k), anything in `dist/`, `backups/`, or `backend/data/`.
  Query the graph through `graphify`; never open its raw output.
- **Cheap orientation path, in order:** `docs/brain/BRAIN.md` (grepped, never read whole) →
  `graphify explain "<symbol>"` → `Grep` → targeted `Read`. Raw file browsing is the last resort,
  never the first move.
- **Grep with `head_limit` and a narrow `glob`/`type`.** Prefer `files_with_matches` when you only
  need locations. An unbounded content grep across this tree dumps tens of thousands of tokens.
- **Keep the cached prefix stable.** The system prompt, this file, and tool definitions are
  prompt-cached across turns; changing any of them mid-session re-bills the whole prefix. So:
  **add no MCP servers** — their schemas ride along on *every* request, and this project
  deliberately has zero — and batch edits to this file into one pass rather than editing it
  repeatedly during a session.
- **Never re-read a file you just wrote or edited** to confirm it worked. The edit tools error on
  failure. A confirmation read is pure cost.
- **For a wide search across many files, use one subagent**, so the file dumps stay in its context
  and only the conclusion returns. Do not fan out long searches in the main thread.
- **Adding tooling:** acceptable only if it costs nothing in the cached prefix and adds no MCP
  server. Markdown skills pass. Proxies that rewrite conversation history fail — they change the
  token prefix every turn and defeat prompt caching, plausibly costing more than they save.

### graphify

A knowledge graph of this tree lives in `graphify-out/` (gitignored). A `PreToolUse` hook in
`.claude/settings.json` fires on every `Read`/`Glob`/`Bash` to enforce the orientation order above.

- Use graphify to **orient, not to conclude**. `graphify explain "<symbol>"` (cheap, precise),
  `graphify query "<question>"` (broader — narrow it with `--context call` and a low `--budget`,
  it over-fetches on hub files), `graphify path "<A>" "<B>"` for how two things connect.
- Always verify with `Grep`/`Read` before concluding, especially on an `[INFERRED]` edge — those
  are heuristic guesses. `[EXTRACTED]` edges are parsed from source and safe to trust.
- If an answer looks thin or contradicts the source, **the source wins**. Never let a graph gap
  cause a missed answer.
- There is no `graphify wiki` in the installed version — do not look for `graphify-out/wiki/`.
- `graphify-out/GRAPH_REPORT.md` (~3k tokens) is for broad architecture review only.
- Run `graphify update .` after changes that add, move, or delete files (AST-only, no API cost).

### The brain

`docs/brain/` is the **curated read of that graph** — every file in the tree filed into 19 regions
across 5 lobes, as Markdown (`BRAIN.md`) and as an interactive page (`brain.html`). Use it to
orient on *where something lives and what it touches* before grepping.

- **Grep `BRAIN.md` for the region or filename you need and read only that block.** It is a map;
  you do not read a map cover to cover.
- Redraw with `node docs/brain/build-brain.mjs` after any change that **adds, moves, or deletes**
  files. Add `--check` to fail on an unfiled file, `--skip-graph` to redraw without re-extracting.
- **Only `docs/brain/brain.map.json` is hand-edited.** `BRAIN.md` and `brain.html` are generated
  and must never be edited directly — the next redraw discards the edit.
- Adding a file usually needs no map edit at all: regions claim by **glob**, so a new file in an
  existing area is picked up automatically, and one that fits nothing is *named* by the redraw
  rather than silently missed. Never replace the globs with an explicit file list.
- `docs/brain/README.md` covers the four kinds of map edit and what the brain cannot see.

---

## 6. Shared-tree and git safety

Assume this tree sees **concurrent sessions and edits** from the user and other agents at all
times. Someone else's in-progress work may be sitting in the working tree right now.

- **Before staging or committing, always run `git status` and `git diff`, and add only the
  specific files you actually reviewed.** Never `git add -A`. Never `git add .`.
- Never `git commit` bare — it sweeps in whatever else is staged.
- **Commit or push only when explicitly asked.** If on `main`, branch first.
- Force-push, `reset --hard`, and history rewriting require explicit confirmation every time.
- Never commit anything under `developer_doomsday_keys/`, `developer_blackbox_keys/`,
  `licensing_server/keys/`, `docs/credentials.md`, or any `.env`. They are gitignored; keep it so.

---

## 7. Know which environment a report describes

When the user reports a bug, establish **which build they are looking at** before debugging.
Reading local source to explain deployed behaviour wastes the session and produces confident
wrong answers.

- **Local POS:** `Restart_Server.bat` from the project root (kills whatever holds :5000 first),
  or `node backend/server.js`. Admin desk at `http://localhost:5000/`, customer portal at
  `/customer.html`.
- **Local licensing server:** `node licensing_server/server.js` → `http://localhost:6060`.
  **Not :6000** — that port is on the WHATWG Fetch forbidden-port list and silently breaks
  `backend/licenseChecker.js`'s handshake. Moved 2026-07-13; do not move it back.
- **Deployed:** push to `develop` / `staging` / `main` triggers `cd-dev.yml` / `cd-sandbox.yml` /
  `cd-live.yml`, each running the test+audit gate then deploying over SSH via
  `deploy/remote-deploy.sh` and smoke-testing `GET /api/health`. Live needs a manual approval
  click. **Not yet exercised end-to-end — no VPS/domain provisioned as of 2026-07-17.** Runbook:
  `deploy/README.md` §8.
- **Tenant installs** run whatever release the tiered update engine last gave them, which is not
  the local tree. Ask for the version before debugging a tenant report.

---

## 8. Testing posture

- `cd backend && npm test` runs nine suites in order and exits non-zero on any failure:
  `test_billing_math.js` (pricing/rounding) → `test_schema.js` (migrations + every SQL constraint,
  asserted by attempting the violation) → `test_repositories.js` (the repository seam, the legacy
  wire-shape projections, pagination, the JSON importer) → `test_concurrency.js` (real OS processes:
  concurrent writers, crash injection, duplicate requests, migration drift) → `test_suite.js`
  (helper-level integration) → `test_routes.js` (routes + auth boundary) → `test_http.js` (money
  paths, Razorpay webhook, returns/refunds, multi-line invoices, tenders, actor identity, paged
  ledgers, PIN hashing, session revocation, TOTP, the refund threshold) →
  `test_production_guard.js` (fail-closed startup) → `test_alerting.js` (raiseAlert's per-code
  cooldown, stale-rate/ledger-drift/backup-freshness/error-rate-latency checks — Phase 3
  alerting, `backend/alerting.js`). **474 checks as of 2026-08-19**
  (145 + 43 + 90 + 16 + 11 + 29 + 107 + 17 + 16, in run order — `test_suite.js` is counted by the
  numbered tests it prints, not by an older tally that no longer matched anything).
  - **A GREEN `npm test` IS NOT PROOF A FORM STILL WORKS.** The HTTP suites post minimal bodies;
    a browser posts every field its form owns, including the empty ones. A body schema that
    refused `totpCode: ""` broke every admin sign-in on 2026-08-17 with all eight suites green —
    only Playwright, which drives the real form, caught it. **Run `npm run test:e2e` before
    calling anything that touches a request body, a form, or an auth path done.**
  - **`test_http.js` §"The operational boundary" must stay LAST in that file.** Its final check
    drains the app: `shutdown()` sets a process-wide flag and closes the ledger handle, so every
    readiness answer after it is 503. Add new checks above that section, not below it.
  - `test_concurrency.js` spawns child processes and is the slowest suite by far (~1–2 min). It is
    in `npm test` anyway, because the properties it asserts — one balance cannot be spent twice, a
    kill mid-sale leaves nothing behind — are not observable any other way.
  - **SECRETS IN `settings.json` ARE ENCRYPTED AT REST.** Every read and write of that document
    goes through `backend/settingsStore.js` — `readSettings()` / `writeSettings()` — which opens
    and seals via `backend/secretVault.js`. **Never add a raw `readJSON`/`writeJSON` call on
    settings.json again:** one reader that skips decryption hands Razorpay a string starting
    `encv1$` instead of the actual key, and one writer that skips encryption puts a live
    credential back in the clear and silently undoes the control for that field. `db.js#migrateSettings()` is the single deliberate
    exception — it merges the template and writes straight back, never touching a credential (no
    credential may sit in `DEFAULT_SETTINGS`, §0), so it round-trips ciphertext untouched, and
    keeping it on raw `readJSON` avoids an import cycle. A suite asserting on a settings value must
    open the vault first; `test_http.js`'s `readData()` and `test_routes.js`'s
    `readDiskSettings()` both show the pattern.
  - **A suite that opens the database must `closeDb()` before removing its temp directory.**
    Windows refuses to unlink a file with an open handle, so the `rmSync` in a `finally` throws
    EPERM — and that EPERM replaces whatever assertion actually failed, so the run reports a
    permissions problem and hides the real bug. `test_http.js` and `test_suite.js` both do this,
    and both treat the removal itself as best-effort for the same reason.
- **No suite touches `backend/data/`.** Each one that needs a database makes its own temp
  directory via `GOLD_POS_DATA_DIR`, so all of them are safe to run alongside a dev server on
  :5000. Keep it that way — fixture debris in a real ledger looks exactly like a real bug.
  **Set that env var at the TOP of a suite file, before anything imports `db.js`** — `db.js`
  resolves `DATA_DIR` once at import and ESM caches the module, so redirecting it inside a test
  function is too late and silently writes into the tenant's real ledger.
  - **A STATIC IMPORT IS ALREADY TOO LATE.** ESM hoists every `import` above the
    `process.env.GOLD_POS_DATA_DIR = …` line, so `import { x } from './adminAuth.js'` at the top of
    a suite pins that whole suite to the real `backend/data`. This is not hypothetical: on
    2026-08-13 exactly that import made `test_http.js` boot against the live tenant and migrate its
    `settings.json` before the 401 gave it away. Pull anything that reaches `db.js` in with a
    **dynamic `await import()`** placed after the env assignments — `test_http.js` and
    `test_routes.js` both show the pattern, and `test_routes.js` additionally *unsets* the vars
    afterwards because `GOLD_POS_DATA_DIR` outranks the `GOLDPOS_DATA_DIR` its child spawn passes.
  - Only `defaultSettings.js` is safe to import statically from a suite; it is side-effect-free by
    design and has no path to `db.js`. Keep it that way.
- **`npm run test:e2e` (Playwright) is deliberately NOT in `npm test`.** It needs an installed
  browser binary, and `npm test` must keep running on a bare checkout with nothing installed.
  One-off setup: `npm install && npx playwright install chromium`. **43 journeys as of
  2026-08-12** (cashier, customer portal at desktop + 390px mobile, reprint desk, return desk).
  - The Billing Desk's readiness signal for these specs is `#sales-tab[data-desk-ready="true"]`,
    set at the end of `BillingDesk.init()`. Do not go back to inferring readiness from a rendered
    figure — the invoice preview is a per-line table now and shows nothing until an item exists.
- `npm run seed` builds a deterministic, synthetic database to click through by hand. It refuses
  to write into `backend/data/` without `--force`.
- Money math changes still have to land in `test_billing_math.js` (§2) — including anything
  touching `toPaise`/`fromPaise`/`computeMetalValue`/`computeReturnRefund`/`saleLines`, which live in
  `frontend/js/lib/billingMath.js` with the rest of it, not in `server.js`.
- Record known-flaky, known-benign failures here by name with the reason. An unexplained red test
  trains everyone to ignore red tests.
  <!-- none recorded yet -->

## 9. Environment traps

- **Windows Controlled Folder Access** blocks freshly built binaries from writing under
  `Documents\` and reports it as "the system cannot find the file specified" — which looks like a
  missing directory and is not. Generate into `%TEMP%` and copy in with PowerShell.
- **Port 5000 stays bound** after an unclean Node exit. `Restart_Server.bat` handles it; a
  "port in use" error is not a code bug.
- **Port 6060, not 6000**, for the licensing server — see §7.
- Two shells are available and take different syntax: PowerShell (primary) and Bash. Do not mix
  `$env:VAR` and `export` in the same command.

---

## 10. Skills

Behavioural skills are a good default, but they are written for any repo and **this file was
written for this one — where they conflict, this file wins.** In particular:

- A skill's "if something is unclear, stop and ask" does **not** override §3. Routine reversible
  dev-loop steps inside an approved task are executed, not asked about. "Ask" is reserved for
  genuine product ambiguity where different readings produce materially different work.
- A skill's "no features beyond what was asked" does **not** override §2. Finishing the asked-for
  scope *properly* — usable, not merely running, and documented — is the bar. Inventing
  *adjacent* scope is what is out.
- "Surgical changes" and "simplicity first" sharpen §1 and §6; read them that way.

Installed:

- **`karpathy-guidelines`** — default-on. Think Before Coding, Simplicity First, Surgical
  Changes, Goal-Driven Execution. Subordinate to this file, per above.
