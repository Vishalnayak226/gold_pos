# Archive — closed history, write-once

Closed Phases live here so the live trackers stay small enough to read. This directory is
**write-once**: move history in, never append to it, and never read a file here unless you
specifically need that closed Phase's detail.

## Why

`docs/LEDGER.md` and the checklists are read during ordinary work. Every closed Phase left in
them is weight carried into every session that greps them, forever. Moving a Phase out costs
nothing — it is still in git, still greppable, just no longer in the way.

## The rule

When a Phase closes **completely** — every item verified, nothing outstanding — move its section
out of the live tracker and into the matching file here, leaving one line behind:

```markdown
## Phase 12 — Advances ledger  (closed 2026-06-14)
Archived → `docs/archive/ledger_closed_phases.md`
```

Naming: `ledger_closed_phases.md`, `checklist_closed_phases.md`. One file per tracker, not one
per Phase — a directory of forty tiny files is its own kind of unreadable.

## Current state

First archival pass done 2026-08-08 — **Phases 1–18**, which are closed with every item verified:

| File | Holds | Moved out of |
|---|---|---|
| `ledger_closed_phases.md` | 23 ledger rows, 2026-07-12 → 2026-07-17 | `docs/LEDGER.md` (37 → 17 lines) |
| `checklist_closed_phases.md` | Old §3 Phase 1–8 summary + §6 Phase 1–18 "Done" sections | `docs/PROJECT_PLAN.md` (309 → 217 lines) |

**Phase 19 was deliberately left live** in both trackers: its deploy pipeline has never been
exercised against a real VPS, so the Phase is not closed. Phase 20 / 20.1 are current work.
`PIPELINE_CHECKLIST.md` was left untouched for the same reason — its "Done — code-side" items
all belong to the still-open Phase 19.

Next candidates, once they close: Phase 19 (needs the VPS run), then `PROJECT_PLAN.md` §5.3–5.11,
which is roadmap design text for Phases 9–17 and is now closed history too.
