# Project foundation — how this project is run

Read once, when you need it. Not standing rules — those live in root `CLAUDE.md`, which is
auto-loaded every turn. This file is the *setup procedure* and the *reasoning behind the rules*,
kept out of the cached prefix on purpose.

Adopted 2026-08-08 from the personal project-starter kit (`~/.claude/project-starter`), with the
token-discipline mechanism carried over from the ERP project.

---

## What is actually installed here

| Piece | Where | Cost per request | What it buys |
|---|---|---|---|
| Standing rules | `CLAUDE.md` (root) | ~2.5k tokens, **cached** | The rules exist in every session without being re-explained |
| Guard hooks | `.claude/settings.json` | ~90 tokens per `Read`/`Glob` | Enforces orient-before-read instead of merely requesting it |
| Knowledge graph | `graphify-out/` (gitignored) | 0 until queried | A few hundred tokens answers what a file sweep costs thousands to answer |
| Curated map | `docs/brain/` | 0 until grepped | One grep says where a thing lives *and* what it touches |
| Archive convention | `docs/archive/` | 0 | Closed history stops being re-read forever |
| `karpathy-guidelines` | `.claude/skills/` | one line in the skill listing | Behavioural defaults, subordinate to `CLAUDE.md` §10 |
| Handover §0 | `docs/ai_handover.md` | ~250 tokens read | A fresh session orients without reading a 5k-token doc |

Nothing here rewrites conversation history or post-processes context, on purpose — see
"Guard hooks" below for why that class of tool is rejected.

---

## Where the tokens actually go

Per-request cost is three things, and only two of them are worth optimising:

1. **The cached prefix** — system prompt + tool schemas + `CLAUDE.md` + skill listing. Billed at
   roughly a tenth of normal input price *as long as it does not change*. Editing `CLAUDE.md`
   mid-session, or adding an MCP server, invalidates it and re-bills the whole thing at full
   price. This is why §5 says batch edits to `CLAUDE.md` into one pass and add zero MCP servers.
2. **Conversation history** — every tool result stays in context for the rest of the session and
   is re-sent with every subsequent turn. A 15k-token whole-file read is not a 15k-token mistake;
   it is 15k tokens multiplied by every turn that follows it. **This is the dominant cost and the
   only one worth real discipline.**
3. **The user's own prompt** — negligible. Writing shorter prompts saves nothing meaningful.

So the mechanism is not "compress the prompt." It is: **never let a large thing enter context in
the first place**, and keep the cached prefix frozen while a session runs.

---

## The escalation ladder

Cheapest first. Never skip a rung upward without a reason.

1. `Grep` `docs/brain/BRAIN.md` for a region, filename, or symbol — one block, a few hundred
   tokens, tells you where a thing lives and what it touches.
2. `graphify explain "<symbol>"` — a few hundred tokens, precise on one symbol.
3. `graphify query "<question>" --context call --budget 1500` — relational questions.
4. `Grep` with `output_mode: files_with_matches`, a narrow `glob`, and a `head_limit` — locations only.
5. `Grep` with `output_mode: content` and `-C 3` — the specific lines.
6. `Read` with `offset`/`limit` around what grep found.
7. Whole-file `Read` — only for a file you have size-checked and know is small.

Raw browsing to "get a feel for the codebase" is not on the ladder. It is the single most
expensive thing a session can do and it is almost never what produced the answer.

---

## Guard hooks

Hooks are the only mechanism that *enforces* context discipline rather than requesting it — the
model can talk itself past a written rule, but a `PreToolUse` hook simply fires. Wired in
`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",        "hooks": [{ "type": "command", "command": "<abs path>\\graphify.exe hook-guard search" }] },
      { "matcher": "Read|Glob",   "hooks": [{ "type": "command", "command": "<abs path>\\graphify.exe hook-guard read" }] }
    ]
  }
}
```

The read guard injects a short reminder to orient through the graph before opening source; the
search guard steers ad-hoc shell searching toward indexed search. Use **absolute paths** — hooks
do not inherit a helpful `PATH`.

The general principle: **attack cost at the source, before the read happens.** Do not bolt on
anything that compresses or post-processes context after the fact. Rewriting earlier
conversation content changes the token prefix every turn, which defeats prompt caching and
plausibly costs more than it saves.

---

## The trackers

They answer different questions and must not be merged. The failure mode when you merge them is a
single file that is simultaneously too stale to plan from and too noisy to hand over.

**What is to be done** — `docs/TESTING_CHECKLIST.md`, `docs/GO_LIVE_CHECKLIST.md`,
`docs/PIPELINE_CHECKLIST.md`, `docs/PRODUCTION_READINESS_ROADMAP.md`.

- `[x]` means **verified**, not "code written". Say what verified it, on the same line.
- Bugs and scope decisions get recorded inline, next to the item that produced them.
- Anything needing a product call is marked `[needs design decision: ...]` and **left unstarted**.

**What was built** — `docs/LEDGER.md`. Index-style, one section per Phase, pointing back at the
checklists. Do not duplicate detail — duplicated detail diverges, and then neither copy is
trustworthy.

**Handover** — `docs/ai_handover.md` §0, kept near the top and greppable:

```markdown
## 0. Version Control & Handover Status
- Latest commit: <sha> — <subject>
- Uncommitted in tree: <files, or "none">
- Servers: <running on :5000 / :6060, or not running>
- Concurrent-session risk: <what another session may be touching>
- Next session should start with: <one line>
```

This file grows. Keeping §0 greppable is what lets a fresh session read *only* it.

**Archive** (`docs/archive/`) is write-once. Move closed Phases in; never append; never read one
unless you specifically need that closed history.

---

## The brain

A curated map of where things live: every file in the tree filed into 18 regions across 5 lobes.
`docs/brain/brain.map.json` is hand-edited; `BRAIN.md` and `brain.html` are generated by
`docs/brain/build-brain.mjs` (Node stdlib, no dependency). Full conventions in
[`brain/README.md`](brain/README.md).

Three inputs, deliberately: **the map** says which regions exist, **the working tree** (via
`git ls-files`, so `.gitignore` is honoured for free) says which files exist, and
**`graphify-out/graph.json`** says what calls what. Only the first is hand-written, so the
picture cannot drift from the code the way a hand-drawn diagram does.

Why it earns its keep at this size, when a bare file listing would not: it answers *what does
this touch* as well as *where does this live*. The wiring diagram showing every region writing
through Persistence, and the API router as the hub, is the orientation a new session would
otherwise buy with a dozen greps.

The property that keeps it honest is the **glob claim**: a new file in an existing area is picked
up with no map edit at all, and one that fits nothing is *named* by the redraw and fails
`--check`. Never replace the globs with an explicit file list — that is the whole mechanism.

Redraw after any change that adds, moves, or deletes files:

```bash
node docs/brain/build-brain.mjs --check
```

---

## Skills

Vendor into `.claude/skills/<name>/`, one directory each, with `SKILL.md` at its root.

| Skill | Source | Activation |
|---|---|---|
| `karpathy-guidelines` | [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | Default-on. Subordinate to `CLAUDE.md` §10. |
| `task-observer` | [Vishalnayak226/one-skill-to-rule-them-all](https://github.com/Vishalnayak226/one-skill-to-rule-them-all) | **Not installed here.** If added: opt-in only. |

**On `task-observer`:** it watches a session for patterns worth promoting into reusable skills,
logging to `skill-observations/` (gitignore it). Its own `SKILL.md` asks to be invoked at the
start of *every* session. **Do not honour that.** A mandatory session-start protocol plus periodic
checkpoint appends is a standing tax on the same budget the context rules exist to protect.
Invoke it deliberately: when asked for by name, at the end of a long phase where real methodology
was worked out, or during a retro. Not on ordinary build/fix/QA turns.

**Language servers** are worth installing where available (`typescript` covers this tree's JS).
They give real go-to-definition and find-references instead of grep sweeps, which is a token
*saving*. Check the plugin ships **without** an `.mcp.json` before adding it — an MCP server's
schemas ride on every request.

---

## Why the rules are shaped this way

Do not relax these without new information. Each cost real time to learn.

**Reuse the choke point.** The instinct is to fix a bug at the call site where it was found. The
correct move is almost always to find the one place every caller already passes through and fix it
there. Cheaper immediately, and it covers callers that do not exist yet.

**Additive data changes only.** Every tenant has JSON files on disk with real billing data. A
destructive reshape is fine until the first time it runs against one of those, at which point it
is the worst problem you have. `defaultSettings.js` already implements the merge-and-retire
pattern; use it rather than inventing a second migration story.

**No second way to do a thing.** Every parallel mechanism doubles the surface where a future fix
must be applied, and guarantees it eventually gets applied to only one of them.

**Never `git add -A`.** In a tree with concurrent sessions this commits another session's
half-finished work under your message. It is silent, and it is discovered later.

**"It loads" is not "it works."** A page that renders but dead-ends on its primary action is worse
than one that errors, because it reports as done and surfaces during the user's own testing.

**Establish which environment a report describes.** A tenant on an older release, the sandbox
deploy, and the local tree are three different programs. Reading local source to explain one of
the others produces confident, wrong, expensive answers.

**Absolute dates in tracked docs.** "Last week" is meaningless to the session that reads it two
months later, and worse than meaningless because it reads as if it means something.

**Verified, not written, earns `[x]`.** A checklist of unverified `[x]`s is not a status document,
it is an inventory of things that will turn out to be broken later.
