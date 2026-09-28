# Invariant traceability matrix

Closes `docs/TESTING_CHECKLIST.md` §24c's "machine-checkable invariant matrix" item and is the
"rule → code owner → automated test" artefact `docs/ENGINEERING_EXCELLENCE_PROGRAM.md` Phase A
calls for. One row per money/stock workflow named in that checklist item: sale, tender split,
advance redemption, return, exchange, void, payment webhook, stock adjustment, day reconciliation.

**Methodology.** Every cell below was verified by reading the cited source at the cited line, not
inferred from naming or from prior documentation. Where a workflow has a real, verified gap (no
owning service, no audit entry, no dedicated test), that is recorded as a gap, not silently
closed. Verified 2026-09-09 against `phase-21-payment-verification-and-production-guard`.
**Re-verified 2026-09-13**: the Phase 2.1/2.2/2.3/2.4 adversarial tests this matrix named as
missing were added on 2026-09-11 (`test_concurrency.js` §§3b/6, `test_http.js` "Gateway await
gap") and one true gap this re-pass found — a genuinely concurrent webhook-delivery race, as
opposed to the sequential replay `test_repositories.js` already proved — was closed the same
session (`test_concurrency.js` §3, "20 concurrent deliveries of the same webhook event id credit
the customer exactly once"). Confirmed by running the new checks, not by re-reading old prose.
The two design-decision gaps below (stock adjustment / day reconciliation owning no service) are
unchanged and still open.

**Updated 2026-09-16 (two passes).** First pass — the structural half of both design-decision gaps
is closed: `backend/services/stockService.js` and `backend/services/reconciliationService.js` now
sit between their routes and `inventoryRepository.js`/`cashShiftRepository.js`, matching every
money-moving workflow above. Stock adjustment's negative-balance refusal, its zero-delta refusal,
and a missing-item/missing-lot refusal now carry a `DOMAIN_CODE` (`STOCK_ADJUSTMENT_NEGATIVE`,
`STOCK_ADJUSTMENT_ZERO`, `STOCK_ITEM_NOT_FOUND`, `STOCK_LOT_NOT_FOUND`); day reconciliation's state
guards do too (`CASH_SHIFT_ALREADY_OPEN`, `CASH_SHIFT_NOT_FOUND`, `CASH_SHIFT_ALREADY_CLOSED`).
**NOT done, and deliberately not**: no new authorization gate. `requireAdminSession` is still the
only check on either workflow — whether stock adjustment or a large-variance shift close should
require an approver remains the real, unresolved product decision this matrix already named, and
adding one was out of scope for a structural extraction.

Second pass, same day — closed the remaining named-but-untested gaps: the gateway's
`PAYMENT_AMOUNT_MISMATCH`/`PAYMENT_CREDIT_PERSIST_FAILED` codes and advance's
`DUPLICATE_REFERENCE` (wired into `domainCodes.js` 2026-09-07, never asserted — see the Payment
webhook section) each gained a `test_http.js` check, and stock adjustment's "resubmission is
untested either way" line became "tested and confirmed as current, accepted behaviour" (see Stock
adjustment section). No code changed in this second pass — test coverage only.

Verified after both passes: `node test_http.js` alone, 136/136 (up from 129 at the start of the
day — three checks from the first pass, four more from the second) and full `npm test` (all
eleven suites), both green, exit code 0.

## Summary

| Workflow | Owning code | Atomic boundary | Test evidence | Known gap |
|---|---|---|---|---|
| Sale | `saleService.js#createSale` | `inTransaction` at `:354` | `test_concurrency.js` §1 (40-way), `test_http.js` money paths | Config-drift window (settings/rates read before `:354`) — closed by Phase 2.3 |
| Tender split | `saleService.js#recordSuppliedTenders` (`:871`) | inside sale's `:354` transaction | `test_billing_math.js`, `test_http.js` tender tests | None found |
| Advance redemption | `saleService.js#createSale` (`:393-406`, `:608-654`) + `advanceRepository.js` | inside sale's `:354` transaction | `test_concurrency.js` §2 (10-way balance race) | None found |
| Return | `returnService.js#createReturn` | `inTransaction` at `:104` | `test_repositories.js` legacy/idempotency cases, `test_concurrency.js` §4b (crash) + §3b (10-way race) | None found — Phase 2.1/2.2 closed 2026-09-11 |
| Exchange | Two mechanisms — `oldGoldService.js#recordExchange` (old-gold-for-credit), and `returnService.js`/`saleService.js` (return-credit exchange-redemption) | own `inTransaction` per mechanism | `test_concurrency.js` §6 (old-gold config-drift), §3b (10-way exchange-credit race) | None found — Phase 2.2/2.3 closed 2026-09-11 |
| Void | `saleService.js#voidSale` | `inTransaction` at `:764` | `test_concurrency.js` §4b (crash) + §3b (10-way race) | None found — Phase 2.1/2.2 closed 2026-09-11 |
| Payment webhook | `paymentService.js#creditCapturedPayment`/`claimWebhookEvent` + `server.js:4144` route | `inTransaction` at `paymentService.js:145` | `test_repositories.js:798-837` (sequential replay/claim), `test_concurrency.js` §3 (20-way concurrent delivery race, added 2026-09-13), `test_http.js` "Gateway await gap" (session revoked mid-await), plus dedicated `PAYMENT_AMOUNT_MISMATCH`/`PAYMENT_CREDIT_PERSIST_FAILED` checks (added 2026-09-16) | None found — Phase 2.1/2.4 closed |
| Stock adjustment | `stockService.js#openLot`/`adjustLot` (added 2026-09-16), calling `inventoryRepository.js` | `assertInTransaction` guard (`inventoryRepository.js:20`) + service wraps in `inTransaction` | `test_http.js` "opening a lot for a missing item…" / "adjusting a lot past zero…" / "resubmitting an identical stock adjustment…" | None found — owning service and `DomainRefusal` codes added 2026-09-16. Still open: no approver gate (product decision, not a gap) |
| Day reconciliation | `reconciliationService.js#openShift`/`closeShift` (added 2026-09-16), calling `cashShiftRepository.js` | `assertInTransaction` guard (`cashShiftRepository.js:20`) + service wraps in `inTransaction` | `test_http.js` "opening and closing a cash shift…" / "reopening or misclosing a cash shift…" | None found — owning service and `DomainRefusal` codes added 2026-09-16. Still open: no approver gate on a large-variance close (product decision, not a gap) |

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
- **Config-drift window, closed 2026-09-11**: `getSettings()` (`:231`) and `getActiveGoldRates()`
  (`:257`) are both read **before** the `:354` transaction opens, deliberately, so every line on
  one invoice prices off one snapshot instead of a mid-invoice change landing between lines. That
  guarantee depends on each dep being called exactly once per request, which
  `test_concurrency.js` §6 ("a multi-line sale reads settings and gold rates exactly once, never
  per line") now asserts with a call-counting spy — proof the drift window cannot widen even
  across a future change, not just a reading of the current code.

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
- **Closed 2026-09-11**: `test_concurrency.js` §4b crashes a return at three points
  (`after-creditnote`, `after-line`, `after-apply`) and proves the setup invoice is left `issued`
  with no orphaned credit note; §3b races ten tills against the same 1g line and proves exactly
  one return succeeds.

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
- **Config-drift window, closed 2026-09-11**: `getSettings()` (`:63`) and `getActiveGoldRates()`
  (`:96`) are both read **before** `inTransaction` opens at `:120` — the identical pre-transaction
  read window documented for `saleService.js` above, and closed the same way:
  `test_concurrency.js` §6's "an old-gold exchange reads settings and gold rates exactly once"
  proves the single-read guarantee holds here too.

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
- **Closed 2026-09-11**: `test_concurrency.js` §3b races ten tills to redeem the same exchange
  credit note and proves exactly one wins, the same shape as the existing advance-balance race.

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
- **Closed 2026-09-11**: `test_concurrency.js` §4b crashes a void just before its audit record and
  proves the invoice is left `issued`; §3b races ten tills to void the same invoice and proves
  exactly one succeeds.

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
- **Closed 2026-09-11/13**: `test_repositories.js:798-837` still proves replay/claim
  **sequentially, in one process** — now joined by `test_concurrency.js` §3, which races 20 real
  child processes claiming the identical event id and proves exactly one wins the
  `payment_events` unique-index insert and credits the ledger, the same "real contention needs
  real processes" pattern as the other document races. Separately, the async-await gap —
  **`fetchRazorpayPayment`/`razorpayRequest` (`server.js:3721-3789`, hardcoded
  `hostname: 'api.razorpay.com'`) are never mocked in an HTTP suite, so no test previously reached
  the `authorized`/`created`/`not-captured` gateway-status branches (`:4054-4072`) or the
  `await fetchRazorpayPayment(...)` gap at `:4029`** — is closed by `test_http.js`'s "Gateway
  await gap" check, which installs a controllable local double for the gateway call, suspends a
  real `/api/payment/verify` request inside it, revokes the customer's session while the request
  is still open, and proves the eventual credit still lands exactly once on the right account.
- **Closed 2026-09-16**: the `PAYMENT_AMOUNT_MISMATCH` and `PAYMENT_CREDIT_PERSIST_FAILED` codes
  returned from `creditCapturedPayment()` (`:107-135`, `:222-232`) were wired into
  `domainCodes.js` on 2026-09-07 but had no dedicated test. `test_http.js` now asserts
  `PAYMENT_AMOUNT_MISMATCH` at the real `/api/payment/verify` HTTP boundary, reusing the "Gateway
  await gap" fixture's local Razorpay double to report a captured amount that does not match the
  stored order. `PAYMENT_CREDIT_PERSIST_FAILED` is asserted by calling
  `creditCapturedPayment()` directly with a hand-built order carrying a null `customerPhone` —
  `payment_orders`/`advance_accounts` both make that column `NOT NULL`, so no order any real
  checkout can create ever reaches this function in a state that fails to persist; a direct call
  is the only way to reach that branch at all. `DUPLICATE_REFERENCE`
  (`advanceService.js:101-104`) also gained an HTTP check, submitting the same deposit reference
  twice through `/api/advances`.

## Stock adjustment

- **Owning code**: **`backend/services/stockService.js#openLot`/`adjustLot`** (added 2026-09-16).
  The routes (`server.js:3089` `POST /api/inventory/lots`, `server.js:3120`
  `POST /api/inventory/lots/:id/adjust`) call the service, which calls
  `inventory.openLot()`/`recordAdjustment()` (`inventoryRepository.js:150`/`243`).
- **Boundary units**: milligrams (`weightDeltaMg`), enforced as a non-zero integer at
  `inventoryRepository.js:245-247` and pre-checked in `stockService.js#adjustLot` before the
  repository is ever called.
- **Authorization**: `requireAdminSession` only (`server.js:3089,3120`) — any signed-in operator
  may adjust stock; **no approver gate, unchanged on purpose** — see Cross-cutting findings.
- **Atomicity**: `assertInTransaction('recordAdjustment')` (`inventoryRepository.js:244`) makes the
  repository itself refuse to run outside a transaction, and `stockService.js` wraps every call in
  `inTransaction()`.
- **Retry/replay**: none — an adjustment has no idempotency key. Resubmitting an identical
  adjustment request creates a second movement, which is arguably correct (each physical count is
  its own fact) rather than a bug. **Tested 2026-09-16** (`test_http.js` "resubmitting an
  identical stock adjustment is not deduped…") to lock in that this is current, accepted behaviour
  rather than merely asserted in prose — unchanged, not fixed.
- **Audit actor**: `actor_user_id` column on the movement row (`inventoryRepository.js:263`) plus,
  as of 2026-09-16, an `audit.record()` call in `stockService.js` for both `STOCK_LOT_OPENED` and
  `STOCK_ADJUSTED` — closing the gap noted below.
- **Historical projection**: on-hand weight is `SUM(weight_delta_mg)` over append-only movements
  (append-only per the repository's file header) — a stock adjustment cannot be edited, only
  offset by a further movement.
- **Fixed 2026-09-16**: the negative-balance, zero-delta, missing-item and missing-lot refusals now
  throw `DomainRefusal` with `DOMAIN_CODE.STOCK_ADJUSTMENT_NEGATIVE` /
  `STOCK_ADJUSTMENT_ZERO` / `STOCK_ITEM_NOT_FOUND` / `STOCK_LOT_NOT_FOUND` from `stockService.js`,
  instead of the route catching a bare `inventoryRepository.js` `Error` with no `code` — matching
  the principle already applied to every other workflow (`TESTING_CHECKLIST.md:1201`, closed
  2026-09-07). Covered by `test_http.js` (two new checks, 2026-09-16).

## Day reconciliation (cash shift)

- **Owning code**: **`backend/services/reconciliationService.js#openShift`/`closeShift`** (added
  2026-09-16). The routes (`server.js:3523` `POST /api/cash-shifts/open`, `server.js:3551`
  `POST /api/cash-shifts/:id/close`) call the service, which calls
  `cashShifts.openShift()`/`closeShift()` (`cashShiftRepository.js:93`/`119`).
- **Boundary units**: paise (`openingFloatPaise`, `countedCashPaise`, `expectedPaise`,
  `variancePaise`), all enforced as non-negative integers at `cashShiftRepository.js:95-96,121-122`.
- **Authorization**: `requireAdminSession` only (`server.js:3523,3551`) — opening/closing a shift
  needs no approver gate, unchanged on purpose — see Cross-cutting findings.
- **Atomicity**: `assertInTransaction` guards both repository functions
  (`cashShiftRepository.js:20-22`); `reconciliationService.js` wraps each in `inTransaction()`.
- **Retry/replay**: `getOpenShift()` refuses a second open while one is already open
  (`cashShiftRepository.js:98-100`); `closeShift` refuses a shift that isn't `open`
  (`:126`) — state-guarded the same way void is, not idempotency-keyed. As of 2026-09-16 both
  guards are pre-checked in the service and surfaced as `DomainRefusal`
  (`CASH_SHIFT_ALREADY_OPEN`/`CASH_SHIFT_NOT_FOUND`/`CASH_SHIFT_ALREADY_CLOSED`) rather than a
  bare repository `Error`.
- **Historical projection**: "expected cash" is **never stored until close** — always recomputed
  fresh from the ledger over `[opened_at, closed_at]` (file header, `:6-12`); closing freezes that
  one computation (`expectedCashAsOf`, `:56-62`) rather than trusting a maintained running total,
  so a bug in a *later* transaction can never retroactively corrupt an already-closed shift's
  figures.
- **Fixed 2026-09-13**: `audit.record()` on both open and close (`CASH_SHIFT_OPENED`/
  `CASH_SHIFT_CLOSED`), moved into `reconciliationService.js` unchanged on 2026-09-16 when the
  service was extracted.

## Cross-cutting findings (item 3: "every permanent record has an owning service/repository...")

1. **Fixed 2026-09-16 — stock adjustment and day reconciliation now have an owning service.**
   `backend/services/stockService.js` and `backend/services/reconciliationService.js` sit between
   their routes and the repository, matching every money-moving workflow above. **Deliberately
   NOT done**: no new approver gate on either workflow. Whether stock adjustment should require an
   approver the way a refund does, or a large-variance shift close should, is a real product
   decision this matrix names but does not make — a structural extraction is not the place to
   invent new authorization policy.
2. **Fixed 2026-09-16 — stock adjustment refusals now carry a `DOMAIN_CODE`.** See above.
3. **Cash-shift open/close were missing from the audit hash chain** — fixed directly in this pass
   (Phase 4), since it's a small, additive, two-line-per-route change with no design decision
   attached, unlike finding 1.
4. **The config-drift window in `saleService.js`/`oldGoldService.js`** (settings/rates read before
   the transaction opens) and **the payment-verify async await gap** were both real and both
   previously untested. Closed 2026-09-11 by `test_concurrency.js` §6 and `test_http.js`'s
   "Gateway await gap" check; the one further gap this matrix's 2026-09-13 re-pass surfaced — a
   genuinely concurrent (not merely sequential-replay) webhook-delivery race — was closed the same
   session by `test_concurrency.js` §3.
