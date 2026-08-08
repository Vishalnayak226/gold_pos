---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

Vendored from [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) (MIT). Where these conflict with this repo's `CLAUDE.md`, `CLAUDE.md` wins — see "Precedence" at the bottom.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Precedence in this repo

The upstream guidelines are general-purpose; this repo has its own standing principles in root
`CLAUDE.md` that were arrived at deliberately. Where they disagree, `CLAUDE.md` governs:

- **§1 "if something is unclear, stop and ask" does not override `CLAUDE.md` §3.** Routine,
  reversible dev-loop steps inside an already-approved task — restarting the dev server on :5000,
  running `npm test` / `test_billing_math.js`, curling local endpoints, adding an additive
  settings key — are executed without asking. "Ask" applies to genuine product ambiguity where
  different readings produce materially different work, not to execution mechanics.
- **§2 "no features beyond what was asked" does not override `CLAUDE.md` §2.** A module isn't done
  when it runs; the bar is that it's genuinely usable and documented end-to-end. Finishing the
  asked-for scope properly is not scope creep — *inventing adjacent scope* is.
- **§3 aligns with, and is sharpened by, `CLAUDE.md` §6.** This tree sees concurrent sessions:
  never `git add -A`, stage only files you reviewed.
- **§2/§3 align with `CLAUDE.md` §1** — no new frameworks, no new dependencies beyond the stated
  budget, additive data-shape changes only, reuse the existing pattern rather than adding a third
  way.
- **None of it overrides `CLAUDE.md` §5.** "Think before coding" does not license reading files
  broadly to build understanding. Orient through `graphify`, then grep, then read narrowly.
