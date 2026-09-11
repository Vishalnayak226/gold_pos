# Invariant traceability matrix

Closes `docs/TESTING_CHECKLIST.md` §24c's "machine-checkable invariant matrix" item and is the
"rule → code owner → automated test" artefact `docs/ENGINEERING_EXCELLENCE_PROGRAM.md` Phase A
calls for. One row per money/stock workflow named in that checklist item: sale, tender split,
advance redemption, return, exchange, void, payment webhook, stock adjustment, day reconciliation.

**Methodology.** Every cell below was verified by reading the cited source at the cited line, not
inferred from naming or from prior documentation. Where a workflow has a real, verified gap (no
owning service, no audit entry, no dedicated test), that is recorded as a gap, not silently
closed. Verified 2026-09-09 against `phase-21-payment-verification-and-production-guard`.

## Summary

| Workflow | Owning code | Atomic boundary | Test evidence | Known gap |
|---|---|---|---|---|
| Sale | `saleService.js#createSale` | `inTransaction` at `:354` | `test_concurrency.js` §1 (40-way), `test_http.js` money paths | Config-drift window (settings/rates read before `:354`) — closed by Phase 2.3 |
| Tender split | `saleService.js#recordSuppliedTenders` (`:871`) | inside sale's `:354` transaction | `test_billing_math.js`, `test_http.js` tender tests | None found |
| Advance redemption | `saleService.js#createSale` (`:393-406`, `:608-654`) + `advanceRepository.js` | inside sale's `:354` transaction | `test_concurrency.js` §2 (10-way balance race) | None found |
| Return | `returnService.js#createReturn` | `inTransaction` at `:104` | `test_repositories.js` legacy/idempotency cases | No crash-injection or multi-till concurrency test — Phase 2.1/2.2 |
| Exchange | Two mechanisms — `oldGoldService.js#recordExchange` (old-gold-for-credit), and `returnService.js`/`saleService.js` (return-credit exchange-redemption) | own `inTransaction` per mechanism | none dedicated | Old-gold: same pre-transaction config-drift window as sale — Phase 2.3. Return-credit: no concurrent double-redemption test — Phase 2.2 |
| Void | `saleService.js#voidSale` | `inTransaction` at `:764` | none dedicated | No crash-injection or concurrent-void test — Phase 2.1/2.2 |
| Payment webhook | `paymentService.js#creditCapturedPayment`/`claimWebhookEvent` + `server.js:4144` route | `inTransaction` at `paymentService.js:145` | `test_repositories.js:798-837` (sequential replay/claim) | No concurrent-webhook-delivery test, no test of the `server.js:4029` await gap — Phase 2.1/2.4 |
| Stock adjustment | `inventoryRepository.js#recordAdjustment`, called directly from `server.js:3064` | `assertInTransaction` guard (`inventoryRepository.js:20`) + route wraps in `repo.inTransaction` | none dedicated | **No owning service** (route → repository direct); refusals are plain `Error`, not a `DomainRefusal` with a stable `code` — see Cross-cutting findings |
| Day reconciliation | `cashShiftRepository.js#openShift`/`closeShift`, called directly from `server.js:3467`/`3491` | `assertInTransaction` guard (`cashShiftRepository.js:20`) + route wraps in `repo.inTransaction` | none dedicated | **No owning service**; **not recorded in the audit hash chain** — fixed in this pass, see below |

## Sale

- **Owning code**: `backend/services/saleService.js#createSale` (`:218`).
- **Boundary units**: weight in milligrams (`weightMilligrams()`, e.g. `:567`), money in paise
  (`toPaise()` throughout, e.g. `:570-584`), rate in paise/gram (`ratePaisePerGram()`, `:568`).
- **Authorization**: none at the sale level (any signed-in operator may bill); a discount above
  `settings.discountApprovalThreshold` requires approval inline (`:305-330`, not re-verified in
  this pass — pre-existing, unchanged).
- **Atomicity**: `inTransaction(() => {...})` opens at `:354` and covers stock/lot checks, invoice
  + line + tender inserts, advance redemption, exchange-credit consumption, and the audit record —
  all in one SQLite transaction.
- **Retry/replay**: `input.idempotencyKey` — `invoices.findByIdempotencyKey()` is checked before
  the transaction (`:226-227`) and again in the `catch` on a unique-constraint race (`:719-720`),
  so a duplicate submission returns the original invoice rather than erroring or duplicating.
- **Audit actor**: `audit.record({ action: 'SALE_ISSUED', actorUserId, ... })` at `:670-690`,
  inside the same transaction as the invoice it describes.
- **Historical projection**: `rates.snapshotFor()` (`:498-507`) freezes the priced rate
  immutably; `purity: 'MIXED'` / `goldPricePerGram: 0` on the rollup when lines disagree
  (`:687-688`) is an honest answer, not a bug (CLAUDE.md §0).
- **Known gap — config drift**: `getSettings()` (`:231`) and `getActiveGoldRates()` (`:257`) are
  both read **before** the `:354` transaction opens. A settings/rate change landing in that window
  is baked into the invoice using the stale value, not the one current at commit. The existing
  comment at `:254-256` justifies this for *within-invoice* consistency (every line prices off one
  snapshot) but nothing currently proves behavior *across* a drift event. Phase 2.3 adds that test.

## Tender split

- **Owning code**: `saleService.js#recordSuppliedTenders` (`:871-943`), called at `:663-666`
  inside the sale's own transaction — not a separate workflow with its own boundary.
- **Boundary units**: paise (`amountPaise`).
- **Authorization**: none beyond the sale's own; a per-payment limit is enforced (`:914`).
- **Atomicity**: inherits the sale's `:354` transaction — a tender row cannot exist without its
  invoice.
- **Retry/replay**: covered by the sale's idempotency key; tenders are not separately replayable.
- **Audit actor**: `createdByUserId` on each tender row (`:931`); no separate audit entry (tenders
  are summarized inside `SALE_ISSUED`'s detail, not audited individually).
- **Historical projection**: tender rows are immutable once inserted; no update path exists.
- **Known gap**: none found.

## Advance redemption

- **Owning code**: **not** `advanceService.js` (which only owns deposits/review — confirmed by its
  export list: `recordDeposit`, `reviewDeposit`, `customerLedger`, `listLedger`, `listPending`,
  `phoneHasStoreHistory`). Redemption is spent inside `saleService.js#createSale`
  (`:393-406` the balance check, `:608-654` the entry + tender), and reversed inside
  `saleService.js#voidSale` (`:797-827`).
- **Boundary units**: paise; balance is `SUM(amount_paise)` over `advance_entries`, never a
  maintained counter (per the file header of `advanceRepository.js`).
- **Authorization**: none at redemption — `:634-637`'s comment states this deliberately: "A
  redemption is a cashier-side fact with no separate approval step." A *deposit* posted directly
  (not pending review) does require `users.isApprover()` — `advanceService.js:76`.
- **Atomicity**: the balance check at `:393-406` runs **inside** the sale's `:354` transaction,
  explicitly so `BEGIN IMMEDIATE`'s write lock serializes two tills redeeming the same balance
  (comment at `:387-392`).
- **Retry/replay**: no separate idempotency key; redemption is atomic with the sale that spends it,
  so the sale's own key covers it.
- **Audit actor**: `createdByUserId`/`approvedByUserId` both set to the billing cashier
  (`:633,637`); captured inside `SALE_ISSUED`'s audit entry (`appliedAdvance` in its `detail`,
  `:682`), not a separate audit action.
- **Historical projection**: `reversesEntryId` (used by void's reversal at `:818`) makes a reversed
  redemption traceable to the entry it reverses without mutating either row.
- **Known gap**: none found — `test_concurrency.js:260-279` already proves the exact race this row
  depends on ("a balance cannot be spent twice by racing tills").

## Return

- **Owning code**: `backend/services/returnService.js#createReturn` (`:62`).
- **Boundary units**: milligrams (`Math.round(refund.weightGrams * 1000)`, `:234`), paise
  (`toPaise()` throughout).
- **Authorization**: `deps.authorizeRefund(refund.refundAmount)` at `:172-186`, applied to the
  server-priced amount (not a client-supplied one), after pricing — so the threshold can't be
  evaded by proposing a smaller number and refunding more.
- **Atomicity**: `inTransaction(() => {...})` opens at `:104`; header/lines/prior-returns are
  re-read **inside** it (`:109-111`) specifically so two simultaneous returns each see the other's
  work rather than both starting from "nothing returned yet."
- **Retry/replay**: `input.idempotencyKey` checked before (`:78-79`) and after
  (`:372-373`) the transaction, same pattern as sale.
- **Audit actor**: `audit.record({ action: 'RETURN_FILED', ... })` at `:314-334`, inside the
  transaction.
- **Historical projection**: `invoices.applyReturnToLine()` (`:252`) increments a running
  `returned_weight_mg` counter guarded by a `CHECK` constraint — an over-return is schema-level
  impossible, not just application-level checked. Non-itemised refunds store `0` (not a guessed
  split) on GST-bearing columns, with `itemised = 0` telling the projection to report "unknown"
  rather than "zero" (`:236-240`).
- **Known gap**: no crash-injection coverage (a kill after the credit note insert but before the
  advance-ledger deposit has never been tested) and no multi-till concurrent-return test. Phase
  2.1/2.2.

## Exchange

Two distinct mechanisms in this codebase both legitimately called "exchange" — both verified,
neither should be read as *the* one exchange workflow to the exclusion of the other.

### Old-gold exchange (`oldGoldService.js#recordExchange`)

The purpose-built mechanism: a customer trades in old gold, the store values it net of a declared
deduction, and posts the credit as an ordinary advance deposit (explicitly "NOT A NEW REDEMPTION
MECHANISM" per the file's header, `:8-13` — it reuses `advance_entries` rather than inventing a
second ledger).

- **Boundary units**: milligrams (`grossWeightMg`/`netWeightMg`, `:165,167`), paise
  (`creditAmountPaise`, `:169`), basis points for the deduction (`deductionBp`, `:166`).
- **Authorization**: `users.isApprover()` gate (`:70-72`) — "crediting a customer's spendable
  balance is cash-equivalent, the same bar a posted counter advance deposit already needs"
  (`:15-17`). Feature-flagged off by default (`settings.oldGoldExchangeEnabled`, `:64-66`).
- **Atomicity**: `inTransaction` at `:120` covers the advance-entry deposit, the exchange-fact row,
  and the audit record together.
- **Retry/replay**: no idempotency key — a resubmitted exchange creates a second credit. Not
  currently tested either way (same gap noted for stock adjustment).
- **Audit actor**: `audit.record({ action: 'OLD_GOLD_EXCHANGE_RECORDED', ... })` at `:175-190`,
  inside the transaction.
- **Historical projection**: `declaredPurity` vs. `testedPurity` are both stored (`:163-164`) —
  priced at tested, never declared, but the customer's claim is preserved for the record.
- **Known gap — config drift, same shape as sale**: `getSettings()` (`:63`) and
  `getActiveGoldRates()` (`:96`) are both read **before** `inTransaction` opens at `:120` — the
  identical pre-transaction-read window documented for `saleService.js`. Phase 2.3 covers both
  services with the same test.

### Return-credit exchange-redemption (`returnService.js` + `saleService.js`)

A return filed in exchange mode, later redeemed against a new sale — two code locations, two
transactions:

- **Issue** (`returnService.js:211-226`): `input.refundMode === 'exchange'` stores `refundMode:
  'gold'` on disk (a deliberate wire-compatibility mapping, per the comment at `:211-213`) and sets
  `isExchange: 1`, `exchangeInvoiceId: null` — a credit note that exists but has not yet been
  spent.
- **Redeem** (`saleService.js:474-489`, consumed at `:668`): `creditNotes.findByNumber()` loads the
  note; it is refused if `is_exchange !== 1` or `exchange_invoice_id` is already set (already
  spent), and the replacement sale's customer phone must match the original return's. Marking it
  spent (`creditNotes.attachExchangeInvoice(exchangeNote.id, invoiceId)`, `:668`) happens **inside**
  the redeeming sale's own `:354` transaction — so `BEGIN IMMEDIATE` serializes two attempts to
  redeem the same credit note exactly like the advance-balance race, and the loser sees
  `exchange_invoice_id` already set.
- **Boundary units / audit / projection**: inherit whichever transaction they're in (return's or
  sale's) — no separate mechanism.
- **Known gap**: the double-redemption defense above has never been exercised under real
  concurrency (only inferred from code reading). Phase 2.2 adds a two-till race on one exchange
  credit note, the same shape as the existing advance-balance race.

## Void

- **Owning code**: `saleService.js#voidSale` (`:751`).
- **Boundary units**: paise/milligrams, inherited from the invoice being voided.
- **Authorization**: none beyond same-day restriction (see below); no separate approval gate.
- **Atomicity**: `inTransaction(() => {...})` at `:764` covers the state check, stock-movement
  reversal, advance-redemption reversal, `cancelInvoice()`, and the audit record.
- **Retry/replay**: no idempotency key; instead the operation is guarded by state
  (`header.state !== 'issued'` → `VOID_NOT_ALLOWED`, `:767-769`), so a repeat void of an
  already-cancelled invoice is refused, not silently repeated.
- **Restrictions proven by code, not yet by adversarial test**: same-business-date only
  (`VOID_DATE_RESTRICTED`, `:771-775`), refused once any return exists against the invoice
  (`VOID_AFTER_RETURN`, `:777-780`), and the linked advance redemption must still be `posted`
  before it can be reversed (`ADVANCE_REVERSAL_UNAVAILABLE`, `:798-803`).
- **Audit actor**: `audit.record({ action: 'SALE_VOIDED', ... })` at `:830-842`.
- **Historical projection**: stock reversal uses `reversesMovementId` (`:790`) and the advance
  reversal uses `reversesEntryId` (`:818`) — both point back at what they undo instead of mutating
  it, so the original movement/entry stays exactly as it was recorded.
- **Known gap**: no crash-injection coverage and no concurrent-void test (two tills voiding the
  same invoice at once has never been exercised). Phase 2.1/2.2.

## Payment webhook

- **Owning code**: `backend/services/paymentService.js#creditCapturedPayment`/`claimWebhookEvent`,
  called from the route at `backend/server.js:4144`.
- **Boundary units**: paise (`capturedPaise`, `expectedPaise` — see the amount-mismatch refusal at
  `paymentService.js:104-112`).
- **Authorization**: none by session (Razorpay calls this server-to-server) — authenticity comes
  entirely from `server.js:4161-4175`'s HMAC-SHA256 signature check with `crypto.timingSafeEqual`.
- **Atomicity**: `inTransaction` at `paymentService.js:145` covers the advance-ledger credit; the
  webhook-event claim (`claimWebhookEvent`) is a separate, earlier atomic operation
  (`server.js:4191`) so a claimed-but-not-yet-credited event can be safely released
  (`releaseWebhookEvent`, `server.js:4250`) for Razorpay to legitimately retry on a genuine
  mid-credit failure, without being mistaken for a duplicate delivery.
- **Retry/replay**: two independent layers — the webhook-event id claim (`server.js:4187-4195`,
  `alreadySeen` → `{duplicate: true}`) stops a re-delivered webhook, and
  `idempotencyKey: `razorpay:${paymentId}`` (`paymentService.js:177`) stops the same *payment*
  being credited twice even via two different delivery paths (checkout verify vs. webhook).
- **Audit actor**: `audit.record()` at `paymentService.js:120` (mismatch) and `:192` (credit).
- **Historical projection**: `paymentRepository.js` stores the order intent read at credit time,
  never `req.body`'s claimed amount — "the server reads amount from stored intent" per that file's
  header — so a later dispute is answered from what was actually stored, not from whatever the
  request happened to say.
- **Known gap**: `test_repositories.js:798-837` proves replay/claim **sequentially, in one
  process**. Nothing proves it under two genuinely concurrent deliveries of the same event id (a
  real Razorpay retry-storm scenario). Separately — and this is the more interesting gap —
  **`fetchRazorpayPayment`/`razorpayRequest` (`server.js:3721-3789`, hardcoded
  `hostname: 'api.razorpay.com'`) are never mocked anywhere**, so every existing payment-verify
  test goes through the `isLocalMockPayment` bypass (`server.js:4006-4008`) and skips both the
  `authorized`/`created`/`not-captured` gateway-status branches (`:4054-4072`) and the
  `await fetchRazorpayPayment(...)` gap at `:4029` — the one place in this entire (deliberately
  synchronous) codebase where a concurrent request can genuinely run to completion while another
  request is suspended. Phase 2.1 (concurrent webhook claim) and Phase 2.4 (the await-gap
  session/permission test, which needs a small test-only seam to make the gateway host
  overridable) both target this.

## Stock adjustment

- **Owning code**: **no service layer** — `server.js:3064` (`POST /api/inventory/lots/:id/adjust`)
  calls `repo.inventory.recordAdjustment()` (`inventoryRepository.js:243`) directly, wrapped
  inline in `repo.inTransaction()` at the route. `openLot()` (`server.js:3034`,
  `inventoryRepository.js:150`) has the same shape.
- **Boundary units**: milligrams (`weightDeltaMg`), enforced as a non-zero integer at
  `inventoryRepository.js:245-247`.
- **Authorization**: `requireAdminSession` only (`server.js:3064`) — any signed-in operator may
  adjust stock; no approver gate, unlike a refund or discount.
- **Atomicity**: `assertInTransaction('recordAdjustment')` (`inventoryRepository.js:244`) makes the
  repository itself refuse to run outside a transaction — a real safety net even without a
  dedicated service — and the route wraps the call in `repo.inTransaction()`
  (`server.js:3071`).
- **Retry/replay**: none — an adjustment has no idempotency key. Resubmitting an identical
  adjustment request creates a second movement, which is arguably correct (each physical count is
  its own fact) but has never been tested either way.
- **Audit actor**: `actor_user_id` column on the movement row (`inventoryRepository.js:263`,
  `resolveActorUserId(req.actor)` at `server.js:3076`) — but **no `audit.record()` call** anywhere
  in the adjust route, unlike every money-workflow service.
- **Historical projection**: on-hand weight is `SUM(weight_delta_mg)` over append-only movements
  (append-only per the repository's file header) — a stock adjustment cannot be edited, only
  offset by a further movement.
- **Known gap**: negative-balance refusal (`inventoryRepository.js:253-254`) throws a plain
  `Error`, not a `DomainRefusal` with a `DOMAIN_CODE`. `server.js:3079-3082` catches it generically
  and returns `{ error: err.message }` with **no `code`** — inconsistent with the "centralize
  domain refusal codes at service boundaries" principle already applied to every other workflow
  (`TESTING_CHECKLIST.md:1201`, closed 2026-09-07). See Cross-cutting findings — recorded as a
  scoped follow-up rather than fixed speculatively in this pass, since a proper fix means
  extracting a `stockService.js`, which is a larger, separately-decided change.

## Day reconciliation (cash shift)

- **Owning code**: **no service layer** — `server.js:3467`/`3491` call
  `repo.cashShifts.openShift()`/`closeShift()` (`cashShiftRepository.js:93`/`119`) directly.
- **Boundary units**: paise (`openingFloatPaise`, `countedCashPaise`, `expectedPaise`,
  `variancePaise`), all enforced as non-negative integers at `cashShiftRepository.js:95-96,121-122`.
- **Authorization**: `requireAdminSession` only (`server.js:3467,3491`) — opening/closing a shift
  needs no approver gate.
- **Atomicity**: `assertInTransaction` guards both functions (`cashShiftRepository.js:20-22`); the
  route wraps each in `repo.inTransaction()`.
- **Retry/replay**: `getOpenShift()` refuses a second open while one is already open
  (`cashShiftRepository.js:98-100`); `closeShift` refuses a shift that isn't `open`
  (`:126`) — state-guarded the same way void is, not idempotency-keyed.
- **Historical projection**: "expected cash" is **never stored until close** — always recomputed
  fresh from the ledger over `[opened_at, closed_at]` (file header, `:6-12`); closing freezes that
  one computation (`expectedCashAsOf`, `:56-62`) rather than trusting a maintained running total,
  so a bug in a *later* transaction can never retroactively corrupt an already-closed shift's
  figures.
- **Known gap — fixed in this pass**: **no `audit.record()` call existed** for opening or closing a
  shift (confirmed by grepping every `audit.record` call site in `server.js` — none near
  `openShift`/`closeShift`), even though closing a shift is the one action in the whole system that
  can surface a cash variance. This was the one gap in this matrix small and additive enough to fix
  directly (Phase 4) rather than merely record: `server.js`'s open/close routes now call
  `repo.audit.record()` on success, mirroring the existing `CUSTOMER_ANONYMISED` pattern
  (`server.js:3264-3272`).

## Cross-cutting findings (item 3: "every permanent record has an owning service/repository...")

1. **Stock adjustment and day reconciliation have no owning service** — both go straight from an
   Express route to a repository call. This is not a correctness bug (the repository itself
   enforces the transaction boundary via `assertInTransaction`, and both write server-issued
   identity, integer boundary units, and an actor column), but it is a real inconsistency with
   every money-moving workflow, which all have a `DomainRefusal`-throwing service layer between
   the route and the repository. **Recorded as a scoped, named follow-up in
   `TESTING_CHECKLIST.md`**, not extracted speculatively here — deciding what a `stockService.js`/
   `reconciliationService.js` should own is a real design decision (e.g., should stock adjustment
   gain an approver gate the way a refund has one?), not a mechanical refactor.
2. **Stock adjustment refusals bypass the domain-code registry** (plain `Error`, no `code`) — see
   above. Same follow-up.
3. **Cash-shift open/close were missing from the audit hash chain** — fixed directly in this pass
   (Phase 4), since it's a small, additive, two-line-per-route change with no design decision
   attached, unlike finding 1.
4. **The config-drift window in `saleService.js`/`oldGoldService.js`** (settings/rates read before
   the transaction opens) and **the payment-verify async await gap** are both real and both
   previously untested. Phase 2 of this work closes both with new adversarial tests.
