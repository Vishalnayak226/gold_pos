# Extensions — 3rd-Party Developer Contract

If you are a developer hired by a tenant (store owner) to customize their
Gold POS instance, **this folder is your entire scope of access.** You
should not need, and should not be given, the rest of the `backend/` or
`frontend/` source. Everything you can safely hook into is documented below.

## Rules (enforced, not just polite suggestions)

1. **Never edit files outside `backend/extensions/` and `frontend/js/extensions/`.**
   Core files (`server.js`, `db.js`, `licenseChecker.js`, `cryptoHelper.js`,
   `adminAuth.js`, anything in `keys/`) are off-limits. A platform update
   (see `docs/ai_handover.md` §7) overwrites everything *except* this
   folder and the `data/`/`logs/`/`keys/` directories — code placed outside
   the extensions folders will be silently lost on the next update.
2. **Hooks run after the fact.** Every hook fires *after* the sale/deposit/
   settings change is already saved to disk and the API has already
   responded to the cashier or customer. You are being notified, not asked
   for permission — you cannot block, delay, or modify the core transaction.
3. **Never read or write `backend/data/*.json` directly.** If you need
   data, use the same public/admin HTTP APIs the frontend uses
   (`GET /api/sales`, `GET /api/advances`, etc.) — going around them risks
   corrupting the atomic-write guarantees the core platform depends on.
4. **A broken extension can never take down the platform.** Every hook call
   is wrapped in a timeout (3s) and a try/catch by the loader. Throwing,
   hanging, or rejecting only logs an error to `backend/logs/error.log` —
   it will never crash the server or fail a sale.
5. **No extension can see other tenants' data.** This is a single-tenant
   deployment per instance — there is no cross-tenant data to leak, but the
   same rule (data never leaves this instance without the tenant's explicit
   configuration, e.g. a webhook URL they set up themselves) still applies
   to anything you build.

## Available hooks (`backend/extensions/*.extension.js`)

Create any file named `*.extension.js` in this folder. It must have a
default export — an object whose keys are hook names:

```js
// backend/extensions/my-custom.extension.js
export default {
    onSaleSaved(sale) {
        // sale: { id, purity, weightGrams, goldPricePerGram, metalValue,
        //         makingChargePercent, makingChargeAmount, taxPercent,
        //         discount, appliedAdvance, totalAmount, customerName,
        //         customerPhone, timestamp }
        // Example: forward every invoice to a tenant's own accounting webhook.
    },

    onAdvanceDeposit(deposit) {
        // deposit: { id, customerPhone, customerName, type: 'deposit',
        //            amount, paymentMethod, referenceId, timestamp }
    },

    onSettingsUpdated(settings) {
        // settings: the full settings object after a save (includes secrets
        // — treat this like any other admin-only data).
    },

    onServerBoot() {
        // Called once, after the extension is loaded at server startup.
        // Good place to set up your own scheduled jobs, register your own
        // Express routes on a *separate* port, etc. Do not attempt to
        // mutate the core Express app instance.
    }
};
```

Any subset of these may be implemented — omit what you don't need. Async
functions (returning a Promise) are fine; you have up to 3 seconds before
the hook is abandoned (and logged as a timeout).

## Available hooks (`frontend/js/extensions/index.js`)

If present, this single file is dynamically imported once, after the core
UI components (`BillingDesk`, `Dashboard`, `AdvancesManager`,
`SettingsManager`) are constructed. It must export a default `init(context)`
function:

```js
// frontend/js/extensions/index.js
export default function init(context) {
    // context: {
    //   billingDesk, dashboard, advancesManager, settingsManager,
    //   adminFetch,   // wrapped fetch() that attaches the admin session token
    //   logTelemetry  // writes to the on-screen diagnostics console
    // }
    // Example: add a custom widget into an existing tab's .panel-body,
    // or call adminFetch() against your own additional API routes.
}
```

A throwing `init()` is caught and logged to the browser console — it will
never break the core admin dashboard.

## What you're explicitly not given

- The license/crypto/admin-session modules, or any `.pem` key file.
- Direct filesystem access to `backend/data/`.
- The ability to change core billing math (gram × rate, GST, making
  charges) — that logic lives in `frontend/js/components/BillingDesk.js`
  and is intentionally outside the extension surface, since it's the part
  every tenant's invoices legally depend on being correct and consistent.

## For the platform owner: scoping a developer's access

Give a hired developer only this folder (and its frontend counterpart) —
ideally as its own small git repository the tenant/developer owns, not a
checkout of the full platform repo. Before granting any access:

1. Have them sign an NDA and a work-for-hire / IP-assignment agreement
   scoped to "code delivered into `extensions/`" — this is standard
   language a lawyer can draft quickly; it is **not** something to
   improvise without one, since the enforceability of "who owns this code"
   depends on jurisdiction and the specifics of the engagement.
2. Time-box and audit their access — a temporary deploy key or a
   collaborator invite on the small extensions-only repo, not standing
   access to your licensing server, RSA private keys, or other tenants'
   deployments.
3. Remember: no technical control (obfuscation, DRM) stops someone who
   already has source access to a repo from copying it. The real
   protection is (a) never handing out more than the extensions folder in
   the first place, and (b) the legal agreement from step 1.
