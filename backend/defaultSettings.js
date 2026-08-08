/**
 * ==========================================================================
 * Canonical settings template — the ONE definition of every settings key
 * the platform reads.
 *
 * Deliberately a standalone, side-effect-free module so that all three
 * consumers share the same object instead of hand-maintaining their own
 * copies (which is exactly how `taxMode` / `defaultDiscountPercent` ended up
 * readable by the UI but missing from every template):
 *   - backend/db.js        — seeds a fresh install and merges forward on boot
 *   - release_pipeline.js  — writes the clean production settings.json
 *   - (indirectly) every tenant, via migrateSettings() on the next boot
 *
 * Adding a new key here is all that is required: fresh installs get it, and
 * existing tenants receive it on their next server start.
 * ==========================================================================
 */

export const DEFAULT_SETTINGS = {
    companyName: "Universal Gold POS Ltd",
    address: "100 Gold Plaza, Retail District",
    phone: "9999999999",
    gstNumber: "29AABCDE1234F1Z",
    goldTaxSlab: 3.0,
    // 'Exclusive' — GST is added on top of the discounted value.
    // 'Inclusive' — the discounted value already contains GST, which is
    // back-calculated out of it. See frontend/js/lib/billingMath.js.
    taxMode: "Exclusive",
    // Integer percent, 0-99. 0 disables the Billing Desk's discount toggle.
    defaultDiscountPercent: 0,
    invoicePrefix: "GOLD",
    invoiceSeqStart: 1,
    reportEmail: "reports@goldpos.com",
    // Report emails (backupEngine's daily/monthly summaries) are skipped
    // gracefully whenever host/user/pass are blank — see emailReporter.js.
    smtp: {
        host: "",
        port: 587,
        secure: false,
        user: "",
        pass: "",
        fromName: ""
    },
    // Only 'public' (keyless Yahoo Finance) and 'mock' are supported. The
    // paid GoldAPI.io / Metals.dev providers and their API-key field were
    // removed in 1.2.0 — migrateSettings() normalizes any legacy value.
    goldApiProvider: "public",
    // Demo/mock placeholders. Mock checkout only activates on this EXACT pair
    // (see /api/payment/order and /api/payment/verify in server.js) — any other
    // non-empty value (including a tenant's real Razorpay test/sandbox key) is
    // sent to the real Razorpay API instead of being intercepted.
    razorpayKeyId: "rzp_test_xxxxxx",
    razorpayKeySecret: "rzp_test_xxxxxx_secret",
    upiId: "",
    adminPin: "1234",
    overrideGoldPrice: {
        active: false,
        price24K: 0.0,
        price22K: 0.0,
        price18K: 0.0
    },
    currency: "INR"
};

/**
 * Keys that used to exist in the template and must be actively removed from
 * a tenant's settings.json, rather than merely left out of new installs.
 * `goldApiKey` held a paid-provider API secret that nothing reads any more.
 */
export const RETIRED_SETTINGS_KEYS = ['goldApiKey'];

/** Settings objects that are merged key-by-key rather than replaced wholesale. */
export const NESTED_SETTINGS_KEYS = ['smtp', 'overrideGoldPrice'];

export const SUPPORTED_GOLD_PROVIDERS = ['public', 'mock'];

/** Fresh deep copy, so callers can never mutate the shared template. */
export function getDefaultSettings() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}
