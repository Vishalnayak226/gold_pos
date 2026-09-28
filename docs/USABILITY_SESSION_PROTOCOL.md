# Manual Usability & Accessibility Session Protocol

Supports `docs/TESTING_CHECKLIST.md` §25b, item 4 ("Run independent manual usability/accessibility
sessions"). That item's owner is **Store manager + product** because it needs a real human body, real
assistive tech, and a real cashier — none of that is something an automated suite or an AI agent can
stand in for. This document is the script so those sessions are structured, repeatable, and produce a
defect list rather than a vague "went fine."

**This protocol does not close the checklist item by existing.** The item stays `[ ]` until someone
actually runs each session below against a real build and files the results.

---

## Before you start

- Use a build that has passed `npm test` and `npm run test:e2e` — don't spend a session finding bugs
  a green suite would already have caught.
- Seed a realistic tenant with `npm run seed` (refuses to touch `backend/data/` without `--force`, so
  it's safe to run against a scratch directory).
- One observer takes notes; one person drives (or is coached through) the session. Do not let the
  observer operate the input device for the keyboard-only, screen-reader, touch or scanner sessions —
  the point is to see where an unassisted user actually gets stuck.
- Every task list below covers the same five core flows so results are comparable across sessions:
  **(A)** admin login, **(B)** a cash sale with two line items and a discount, **(C)** a return against
  that sale, **(D)** changing one Settings value and saving, **(E)** the customer portal: check balance
  and view an invoice.

## Recording an observation

For every point where the driver hesitates, backtracks, asks "what do I do now," or does the wrong
thing before recovering, log one row:

| # | Session | Flow | What happened | Screen / component | Severity | Disposition |
|---|---------|------|----------------|---------------------|----------|--------------|
| 1 | Keyboard-only | B | Tab order jumped from qty field to the nav bar, skipping Save | BillingDesk | Blocker | Defect filed: #___ |

**Disposition is mandatory and must be one of:**
- **Defect filed** — reference the issue/commit that will fix it.
- **Explicit documented decision** — the behaviour is acceptable as-is; write the *why* here, not just
  "won't fix." (Example: "scanner beep on error is intentionally the OS default; no in-app sound layer
  exists in this budget — see CLAUDE.md §0 dependency budget.")

A session with zero rows either means the flow is genuinely solid, or the driver didn't push on it hard
enough — cross-check against the "known trouble spots to probe" list in each section below before
accepting a clean run.

---

## 1. Keyboard-only session

**Setup:** unplug the mouse/trackpad, or have the driver keep both hands away from it.

**Task:** complete flows A–E using only Tab, Shift+Tab, Enter, Space, Arrow keys and Escape.

**Known trouble spots to probe:**
- Every dialog (native `confirm()`/`alert()` and any custom overlay) — does Escape close it, and does
  focus return to the control that opened it, not to `<body>`?
- The billing line-item table — can a row's qty/rate be edited and the line removed without a mouse?
- Any icon-only button (×, edit pencil, etc.) — can it even be tabbed to, and is it clear from the
  focus ring alone which control is active?
- Tab order after a modal closes, after a table re-renders (e.g. after adding a cart line), and after
  a validation error appears.

## 2. Screen reader session

**Setup:** NVDA (Windows, free) or VoiceOver (macOS) running, screen usable but driver should
primarily listen rather than look.

**Task:** flows A, B, D, E (skip C unless time allows — it exercises mostly the same controls as B).

**Known trouble spots to probe:**
- Does every announced control have a name that makes sense out of context ("button" alone vs.
  "Remove line, button")?
- Is a validation error announced when it appears, or does the screen reader stay silent until the
  user happens to tab back onto the invalid field?
- Are dynamic updates (cart total changing, a new toast/alert) announced at all, or silent?
- Table structure — is the billing/return line table read as a table (row/column) or as a wall of
  unrelated text?

## 3. Contrast / large text session

**Setup:** OS-level "large text" or 200% browser zoom, plus a contrast checker (browser devtools'
built-in one is fine — no new tool needed).

**Task:** flows A, B, D, E at 200% zoom; then flow B again with OS large-text/high-contrast mode on.

**Known trouble spots to probe:**
- Does any layout break (overlapping controls, clipped text, a button that becomes unreachable) at
  200% zoom on the smallest supported phone width, not just desktop?
- Any text/background pair that reads as low-contrast by eye — confirm with devtools' contrast ratio
  against WCAG AA (4.5:1 normal text, 3:1 large text) before logging it as a defect.
- Does anything rely on color alone to convey state (a red vs. green amount with no icon/text
  difference)?

## 4. Touch session

**Setup:** an actual touchscreen device (tablet or touch laptop) — not a mouse pretending to be touch.

**Task:** flows A, B, C, D at the smallest supported phone width from `frontend/customer.html`'s
tested breakpoint (see the e2e mobile viewport for the exact figure the automated suite already
checks — reuse that number here rather than guessing a new one).

**Known trouble spots to probe:**
- Tap target size on the billing line-item row actions (edit/remove) — can a finger hit them reliably?
- Anything that only responds to `:hover` (a tooltip, an action that only appears on mouseover) and is
  therefore unreachable by touch.
- Numeric keypad correctness — does tapping a qty/rate/phone field bring up a numeric input method,
  not a full alphabetic keyboard?

## 5. Scanner session

**Setup:** a real barcode/QR scanner (acts as a fast keyboard-wedge input), against inventory items
that actually have `sku_code`/barcode values set.

**Task:** flow B, adding every line via scan instead of manual entry/search.

**Known trouble spots to probe:**
- Does a scan while focus is anywhere other than the intended barcode field do something wrong (get
  interpreted as keystrokes into the wrong input, e.g. typed into a search box and triggering a
  navigation)?
- Scanning an unknown/unrecognized code — is the failure message specific ("no item matches that
  code") or a generic error?
- Rapid sequential scans (several items back to back) — does every one land, or does the UI drop one
  while still rendering the previous line?

## 6. Plain-English cashier session

**Setup:** a real staff member (or the closest available proxy) who is comfortable with basic retail
tasks but not fluent in English idiom or software jargon. Do not coach them through wording — if they
ask what a label means, that's the finding.

**Task:** flows B and C, described to the driver only in terms of the real-world task ("a customer
wants to buy this and pay by card," "a customer is returning this item"), not in the app's own menu
language.

**Known trouble spots to probe:**
- Any label, error message or confirmation dialog whose wording the driver has to ask about.
- Whether the driver understands what a destructive confirmation is actually asking before confirming
  it (a "type LOWER SEQUENCE to confirm" style prompt is a known sharp edge — see
  `docs/TESTING_CHECKLIST.md` line ~552 — but that one is admin-only; check the cashier-facing
  confirmations too, e.g. void/return confirmations).
- Whether error recovery is self-evident (does the driver know what to do next after a red error
  banner, or do they get stuck)?

---

## After the sessions

1. Merge all session rows into one table, sorted by severity.
2. Every row needs its Disposition filled in before the session is considered closed — an unresolved
   "TBD" row means the session isn't done yet.
3. File defects the same way any other bug in this tree is tracked; link them from
   `docs/TESTING_CHECKLIST.md` §25b item 4 when it's finally checked off.
4. Update `docs/ai_handover.md` §0 with the date, who ran which session, and a link/reference to the
   defect list — per the standing documentation convention in root `CLAUDE.md` §4.
