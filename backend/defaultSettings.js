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

/* ==========================================================================
   Secret redaction

   settings.json holds live credentials next to ordinary configuration, and
   the Settings screen loads the whole document to render its forms. That put
   the Razorpay secret, the SMTP password and the admin PIN into the browser —
   readable in DevTools, in any HAR capture, and in the Level-2 support export.

   Redaction lives here, beside the template that defines the keys, so a new
   secret is declared once and every emission point picks it up. Dotted paths
   address nested objects (see NESTED_SETTINGS_KEYS).
   ========================================================================== */

export const SECRET_SETTINGS_KEYS = ['razorpayKeySecret', 'adminPin', 'smtp.pass'];

/**
 * What the browser sees in place of a real secret.
 *
 * A run of U+2022 bullets, chosen for two reasons: it renders as an already-
 * masked field in both the password and plain-text inputs SettingsManager.js
 * uses, and it cannot be produced from a keyboard — so it can never collide
 * with a credential a tenant actually chose.
 */
export const REDACTED_SENTINEL = '••••••••';

function getByPath(obj, dotted) {
    return dotted.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function setByPath(obj, dotted, value) {
    const keys = dotted.split('.');
    const leaf = keys.pop();
    let node = obj;
    for (const key of keys) {
        if (node == null || typeof node[key] !== 'object' || node[key] === null) return false;
        node = node[key];
    }
    if (node == null) return false;
    node[leaf] = value;
    return true;
}

/**
 * Deep copy of `settings` with every secret masked, safe to send to a client.
 *
 * An unset credential stays an empty string rather than becoming a mask: the
 * Settings screen has to be able to show "SMTP is not configured yet" instead
 * of implying a password exists when none does.
 */
export function redactSettings(settings) {
    const safe = JSON.parse(JSON.stringify(settings ?? {}));
    for (const dotted of SECRET_SETTINGS_KEYS) {
        const value = getByPath(safe, dotted);
        if (value === undefined || value === null) continue;
        setByPath(safe, dotted, String(value).length > 0 ? REDACTED_SENTINEL : '');
    }
    return safe;
}

/**
 * The inverse, applied to an inbound settings payload before it is persisted.
 *
 * The Settings screen is a read-modify-write form: it renders whatever GET
 * returned and posts the fields back. Without this, saving an unrelated
 * section (say the company address) would write the literal mask over the
 * tenant's real SMTP password and silently break report emails. Any secret
 * that comes back still equal to the mask is restored from `current`; a field
 * the admin genuinely retyped no longer matches, so it saves normally.
 *
 * Mutates and returns `incoming`.
 */
export function unredactSettings(incoming, current) {
    for (const dotted of SECRET_SETTINGS_KEYS) {
        if (getByPath(incoming, dotted) !== REDACTED_SENTINEL) continue;
        const stored = getByPath(current, dotted);
        setByPath(incoming, dotted, stored === undefined || stored === null ? '' : stored);
    }
    return incoming;
}
