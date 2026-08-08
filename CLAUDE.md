# Project operating rules — Gold POS

These are standing constraints on every change, not preferences. Where any general-purpose
guideline, skill, or default behaviour conflicts with this file, **this file wins**.

Setup procedure and the reasoning behind these rules live in `docs/FOUNDATION.md` — read once,
not every turn. This file is auto-loaded on every request, so it stays tight.

---

## 0. Stack posture — decided, then held

- Language / runtime: **Node.js ≥18, ESM (`"type": "module"`) throughout. Express 4 only.**
- Data store: **flat JSON files under `backend/data/`, written via `backend/db.js`. No SQL, no ORM, no DB server.**
- Frontend posture: **vanilla JS/CSS/HTML in `frontend/`, served statically off disk by `backend/server.js`. No framework.**
- Build step: **none.** `frontend/package.json` exists only to mark `js/lib/` as ESM so Node tests can import it — it is never installed and never bundled.
- Dependency budget: **the 6 in `backend/package.json` (cors, dotenv, express, node-cron, nodemailer, qrcode) + the 3 in `licensing_server/`. That is the whole budget.** Adding a tenth is a deliberate, announced decision.

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
  — the `frontend/js/lib/billingMath.js` helpers for any pricing/rounding math, `db.js`'s
  read/write/log helpers for any persistence, the existing component pattern under
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
- Money math is not "probably fine." Any change touching pricing, making charges, wastage, GST,
  advances, or rounding must be covered by `backend/test_billing_math.js` before it is called done.

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

`docs/brain/` is the **curated read of that graph** — every file in the tree filed into 18 regions
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

- `cd backend && npm test` runs both suites: `test_billing_math.js` (pricing/rounding assertions)
  then `test_suite.js` (integration).
- The integration suite touches `backend/data/`. Do not run it in parallel with a live dev server
  against the same data directory — fixture debris looks exactly like a real bug.
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
