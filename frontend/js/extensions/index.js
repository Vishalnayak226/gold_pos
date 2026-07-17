/**
 * Frontend extension entry point — see backend/extensions/README.md for the
 * full contract. This file ships as a no-op by default; a tenant's own
 * developer can replace it to add custom UI without touching core files
 * under frontend/js/components/ or frontend/js/app.js.
 *
 * A platform update (see docs/ai_handover.md §7) never overwrites this file
 * once it has been customized — the update engine skips frontend/js/extensions/.
 */
export default function init(context) {
    // context: { billingDesk, dashboard, advancesManager, settingsManager,
    //            adminFetch, logTelemetry }
    // No-op by default.
}
