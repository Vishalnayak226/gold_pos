# Gold POS API compatibility policy

## Contract generation

Every HTTP response carries `X-Gold-POS-API-Version`. `GET /api/health` also
returns `apiVersion`. The current contract generation is **1**.

Within a generation, changes must be backward compatible:

- Add optional response fields and new endpoints; never rename, remove or
  change the meaning/type of an existing field.
- Preserve error `error` values once published. New financial, stock and
  authorization refusals should also expose an uppercase `code`; integrations
  should prefer that field when present and never parse operator prose. Legacy
  endpoints that already expose a machine code in `error` keep doing so; an
  optional `message` supplies operator guidance.
- Preserve authentication, pagination, filtering, money/weight units and
  webhook idempotency semantics. Changes to a financial calculation require a
  documented migration and explicit regression tests.
- Keep response JSON for unknown `/api/*` routes and malformed API bodies; do
  not make clients parse an HTML error page.

## Breaking change process

A breaking public API change requires a new contract generation, a compatibility
window, migration notes, a real HTTP regression suite for both versions, and a
documented retirement date approved by the product owner. Do not silently make
such a change behind a UI release.

Browser modules are first-party clients but follow the same rules. The server
remains the authority for money, stock, identity and permissions; the browser
may preview, never define, those facts.

## Stable domain-code registry

`backend/domainCodes.js` is the source of truth. These are additive contract-1
fields: do not change a value’s spelling or meaning. A code tells software
what happened; `message` tells an operator what to do.

| Code | Meaning |
| --- | --- |
| `APPROVER_REQUIRED` | The caller lacks the approval role for the requested money action. |
| `MFA_REQUIRED` | The operation requires an enrolled approver’s second factor. |
| `INSUFFICIENT_STOCK` | The named lot cannot satisfy the requested committed weight. |
| `INVOICE_NUMBER_REQUIRED` / `INVOICE_NOT_FOUND` | A void cannot identify an existing invoice. |
| `VOID_REASON_INVALID` | A void reason is absent, too short or too long. |
| `VOID_NOT_ALLOWED` | The invoice is not in the issued state required for a void. |
| `VOID_DATE_RESTRICTED` | The invoice belongs to an earlier business date; return/credit-note flow applies. |
| `VOID_AFTER_RETURN` | A recorded return makes voiding the original invoice unsafe. |
| `ADVANCE_REVERSAL_UNAVAILABLE` | The linked advance redemption cannot safely be reversed. |
| `VOID_ALREADY_PROCESSED` | A concurrent path already cancelled this invoice. |

The registry is intentionally incomplete while existing workflows are migrated
in small tested slices. Do not invent an unregistered code in a route; add it
to the registry, document its business meaning and add a service + HTTP proof.
