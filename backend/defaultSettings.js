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
    // Signs the gateway's server-to-server callbacks. Razorpay generates this
    // independently of the API key pair when the webhook endpoint is registered
    // in their dashboard, so it is a THIRD credential, not a derivative of the
    // other two. Blank means POST /api/payment/webhook rejects every delivery —
    // deliberately fail-closed: an unverifiable callback that credits a ledger
    // is worse than no callback at all.
    razorpayWebhookSecret: "",
    upiId: "",
    /* THERE IS DELIBERATELY NO `adminPin` KEY HERE, and this is load-bearing.

       It used to hold the plaintext default "1234". That could not stay, because
       getDefaultSettings() is merged over a tenant's settings.json on every
       boot: migratePinsToHashes() would hash the PIN and delete the plaintext,
       and the very next boot would MERGE THE PLAINTEXT DEFAULT STRAIGHT BACK IN.
       The hashing would appear to work and quietly undo itself, leaving a
       resurrected "1234" on disk beside a hash of the real PIN.

       So the master credential now exists only as `adminPinHash`, and it is
       seeded — not merged — by migratePinsToHashes() in backend/adminAuth.js:
       that function hashes any plaintext it finds (the upgrade path for an
       existing tenant), and if no hash exists at all it establishes one from the
       documented default so a fresh install still opens with 1234. `authSalt` is
       likewise generated per tenant there and is absent here on purpose — a
       shared default salt would defeat the point of having one. */
    overrideGoldPrice: {
        active: false,
        price24K: 0.0,
        price22K: 0.0,
        price18K: 0.0
    },
    currency: "INR",
    /* Named people who work the counter — the reason a financial record can say
       WHO made it.

       Empty by default, and an empty list is a fully working configuration: the
       install falls back to `adminPin` above, which authenticates as the store
       owner (see resolveActor in backend/adminAuth.js). A store that wants
       per-cashier attribution — or the manager approval a manual-UPI deposit
       needs — adds people here, each with their own PIN.

       Shape: { id, name, role, pin, active }
       Roles are exactly the four the SQL schema already defines
       (backend/repositories/migrations/001_initial_schema.sql):
         owner    — full access, may approve money claims
         manager  — may approve money claims
         cashier  — bills and returns, may NOT approve
         auditor  — read-only
       Each operator's PIN is stored only as a scrypt `pinHash`; the plaintext
       `pin` an older build wrote is migrated away and deleted on the next boot.
       An operator may additionally enrol an authenticator app, which adds
       `mfaEnabled`, `totpSecret` and hashed `recoveryCodes` — none of which ever
       reach a browser. */
    operators: [],
    /* Require a second factor to release money.
       When true, approving or rejecting a customer's unverified deposit — and
       authorising a refund at or above the threshold below — needs a session that
       passed TOTP at sign-in, not merely an approving role. The shared master PIN
       cannot satisfy it (there is no person to enrol), which is deliberate: it is
       what moves a store onto named logins. Off by default so an existing install
       keeps working untouched. */
    requireMfaForApprovers: false,
    /* Refund value at or above which an owner/manager must authorise the refund.
       A cash refund is the one counter action that takes money out of the till on
       a cashier's own say-so. 0 disables the control — which is the previous
       behaviour, and therefore the default, so no existing store is surprised by
       a refusal it did not ask for. */
    refundApprovalThreshold: 0,
    // Origin this install is reachable at from the public internet, e.g.
    // "https://pos.example.com". Razorpay needs it to deliver webhooks, so a
    // production process without it can take money it will never hear back
    // about — assertProductionReady() (backend/productionGuard.js) refuses to
    // boot in that state. Blank is correct for a local/offline counter install.
    publicUrl: ""
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

export const SECRET_SETTINGS_KEYS = [
    'razorpayKeySecret', 'razorpayWebhookSecret', 'smtp.pass',
    // PINs are scrypt hashes now rather than plaintext, but a hash of a 4-digit
    // PIN is still a crackable credential — a 10,000-value keyspace falls to an
    // offline grind in minutes. So the hashes are masked out of the support
    // export too, alongside the tenant salt that would make that grind cheaper
    // still. `adminPin` stays listed because a settings.json restored from an old
    // backup can still contain one until the boot migration converts it.
    'adminPin', 'adminPinHash', 'authSalt',
    // `*` matches every index of an array. Operator credentials sit in the same
    // document as the company address and the Settings screen loads the whole
    // document — so they mask through this one mechanism rather than a second,
    // parallel rule that could be forgotten. `totpSecret` is the one that matters
    // most: it is a bearer secret, and anyone holding it can generate valid codes
    // forever.
    'operators.*.pin', 'operators.*.pinHash', 'operators.*.totpSecret'
];

/** Roles an operator may hold — the four the SQL schema defines. */
export const OPERATOR_ROLES = ['owner', 'manager', 'cashier', 'auditor'];

/**
 * Roles entitled to approve a money claim.
 *
 * Mirrors the `approvers` view in the SQL schema, which is the authority once
 * the ledger moves to SQLite. Stated once here so a new role cannot quietly
 * gain approval rights by being missed in a comparison somewhere.
 */
export const APPROVER_ROLES = ['owner', 'manager'];

/**
 * What the browser sees in place of a real secret.
 *
 * A run of U+2022 bullets, chosen for two reasons: it renders as an already-
 * masked field in both the password and plain-text inputs SettingsManager.js
 * uses, and it cannot be produced from a keyboard — so it can never collide
 * with a credential a tenant actually chose.
 */
export const REDACTED_SENTINEL = '••••••••';

/**
 * Every concrete path a (possibly wildcarded) secret path addresses in `obj`.
 *
 * `smtp.pass` resolves to itself. `operators.*.pin` resolves to
 * `operators.0.pin`, `operators.1.pin`, … for however many operators the tenant
 * has configured — so redaction covers a list whose length is not known until
 * runtime, without either loop needing to know that an array is involved.
 */
function expandPath(obj, dotted) {
    let paths = [[]];
    for (const key of dotted.split('.')) {
        const next = [];
        for (const prefix of paths) {
            if (key !== '*') {
                next.push([...prefix, key]);
                continue;
            }
            const node = getByPath(obj, prefix.join('.'));
            if (!Array.isArray(node)) continue;
            node.forEach((_, index) => next.push([...prefix, String(index)]));
        }
        paths = next;
    }
    return paths.map(parts => parts.join('.'));
}

function getByPath(obj, dotted) {
    if (dotted === '') return obj;
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
    for (const pattern of SECRET_SETTINGS_KEYS) {
        for (const dotted of expandPath(safe, pattern)) {
            const value = getByPath(safe, dotted);
            if (value === undefined || value === null) continue;
            setByPath(safe, dotted, String(value).length > 0 ? REDACTED_SENTINEL : '');
        }
    }
    return safe;
}

/*
 * There is deliberately NO unredactSettings() here.
 *
 * There used to be — a mirror of the above that swapped the mask back for the
 * stored credential on the way in — and nothing ever called it. The live write
 * path (POST /api/settings) masks with `null` + a `*Configured` flag and
 * restores through preserveWriteOnlyValue() in server.js instead, so a second
 * unredaction mechanism was one more way for the two to disagree about what a
 * masked field means. redactSettings() above is used by the support export,
 * which is one-way by definition: nothing is ever read back out of it.
 */
