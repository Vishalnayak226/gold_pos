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
 *
 * `validation.js` is the only thing this imports, and it is pure — this module
 * must stay free of any path to `db.js`, because it is the one module a test
 * suite may import statically (CLAUDE.md §8).
 * ==========================================================================
 */

import { validateAgainstRules } from './validation.js';

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
    // Ops alerts (payment/webhook failures, ledger drift, backup/rate/TLS
    // problems — see alerting.js) go here; falls back to reportEmail when
    // blank, since a store with one inbox still needs to receive them.
    alertEmail: "",
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
    publicUrl: "",
    /* Archive-then-prune for audit_events. Off by default: the trail behaves
       exactly as it always has, growing forever, until a tenant turns this
       on. auditRetentionDays is a placeholder long enough to be safe for
       common record-keeping practice — NOT a legal determination; the real
       figure is a tax/company-law and insurer question. See
       docs/AUDIT_AND_PII.md §5 and backend/auditRetention.js. */
    auditRetentionEnabled: false,
    auditRetentionDays: 2555,
    /* Wastage. Off by default: no invoice line has ever carried a wastage
       charge, and disabled means it still never will — every line prices
       exactly as it did before this existed. When enabled, EVERY line is
       charged uniformly using this store-wide mode and percentage; a sale
       request can never supply its own (backend/services/saleService.js).
       'weight_uplift' bills extra grams; 'making_charge_percent' and
       'separate_line' both charge a percentage of the making charge and
       differ only in how the invoice DISPLAYS the line, never in cost. */
    wastageEnabled: false,
    wastageMode: "weight_uplift",
    wastagePercent: 0,
    /* Point-in-time recovery: frequent local snapshots (backend/pitr.js). Off
       by default — the once-nightly backup stays the only recovery point
       until this is turned on. pitrIntervalMinutes below 5 has no effect: the
       scheduler itself only ticks every 5 minutes. Off-site shipping is a
       separate, unbuilt follow-on — see backend/pitr.js's header. */
    pitrEnabled: false,
    pitrIntervalMinutes: 15,
    pitrRetentionHours: 24,
    /* Nightly off-site copy. The destination is a mounted/synchronised
       directory (NAS, encrypted removable disk, rclone mount, SMB volume).
       Keeping transport outside the POS avoids storing cloud credentials or
       adding a provider SDK; the copied snapshot is hash-verified here. */
    offsiteBackupEnabled: false,
    offsiteBackupPath: "",
    offsiteBackupRetentionDays: 30,
    /* Old-gold exchange (backend/services/oldGoldService.js). Off by default
       — the route answers 404, exactly as if it never existed. The credit
       posts as an ordinary advance deposit; no GST/RCM treatment is computed
       here, which stays an unresolved legal question — see
       PRODUCTION_READINESS_ROADMAP.md Phase 5 §4. */
    oldGoldExchangeEnabled: false,
    oldGoldDeductionPercent: 5,
    /* Gold savings schemes (backend/services/goldSchemeService.js). Off by
       default — the routes 404 as though the module never existed. Terms
       below are an ENGINEERING PLACEHOLDER (an "11 installments + 1 free"
       structure typical of Indian gold-scheme practice), retunable per
       scheme, not a legally reviewed product — real terms and Indian
       legal/CA review of customer-money treatment, advertising,
       cancellation and nomination rules still gate enabling this for a
       live tenant. See PRODUCTION_READINESS_ROADMAP.md Phase 6. */
    goldSchemeEnabled: false,
    goldSchemeInstallmentCount: 11,
    goldSchemeBonusInstallments: 1,
    goldSchemeDefaultGraceDays: 30,
    goldSchemeEarlyClosurePenaltyPercent: 0
};

/**
 * Keys that used to exist in the template and must be actively removed from
 * a tenant's settings.json, rather than merely left out of new installs.
 * `goldApiKey` held a paid-provider API secret that nothing reads any more.
 */
export const RETIRED_SETTINGS_KEYS = ['goldApiKey'];

/* Declared here rather than beside NESTED_SETTINGS_KEYS below because
   SETTINGS_FIELD_RULES needs it at module-evaluation time. */
export const SUPPORTED_GOLD_PROVIDERS = ['public', 'mock'];

/* ==========================================================================
   Settings TYPES — what each key is allowed to be

   POST /api/settings spreads the request body over the stored document. That
   spread used to be unguarded, and the settings that feed the billing pipeline
   are read with plain JS coercion downstream, so a wrong TYPE did not fail —
   it silently produced a wrong invoice:

     - `invoiceSeqStart: "10"` (a STRING, which is what a hand-edited file, an
       older client, or a restored backup can easily contain) made
       `settings.invoiceSeqStart = startSeq + 1` a string CONCATENATION.
       The sequence then ran 10 → 101 → 1011 → 10111, so the invoice numbers on
       a legally-relevant, strictly-sequential ledger grew exponentially and
       never repeated a real increment.
     - `invoiceSeqStart: "abc"` produced invoice `GOLD-000abc-26`, and slipped
       past the lower-the-sequence confirmation guard because that guard tests
       `!isNaN(parseInt(...))` and NaN simply skipped it.
     - `goldTaxSlab: "abc"` read back as `Number(...) || 0` — the store silently
       stopped charging GST while every screen still looked normal.
     - `goldTaxSlab: -50` was stored on each sale as `taxPercent: -50`, which is
       what a later return re-prices itself from.
     - `invoicePrefix: {}` stamped `[object Object]-000011-26` into the permanent
       ledger; an object with a non-callable `toString` made every single sale
       fail with a 500 until somebody hand-edited settings.json.

   So the types are declared HERE, beside the template that declares the keys —
   this module is already "the ONE definition of every settings key the platform
   reads", and a key's type is part of that definition. Validation runs at the
   one write choke point (POST /api/settings) rather than at each downstream
   read, so every present and future reader inherits it.

   Only keys with a MEANINGFUL type constraint are listed. Free-text fields the
   platform merely echoes (companyName, address, …) are coerced to strings and
   length-capped rather than pattern-matched; anything absent from this table is
   passed through unchanged, exactly as before.
   ========================================================================== */

const MAX_SETTINGS_TEXT = 500;

/**
 * Upper bound on the invoice sequence. Well beyond any real store's lifetime
 * output while still refusing a value that would overflow the 6-digit pad or
 * arrive from a typo like 1e21.
 */
const MAX_INVOICE_SEQ = 1000000000;

export const SETTINGS_FIELD_RULES = {
    // Money/tax pipeline — the ones that silently produced wrong invoices.
    goldTaxSlab: { type: 'number', min: 0, max: 100 },
    defaultDiscountPercent: { type: 'number', min: 0, max: 99 },
    invoiceSeqStart: { type: 'integer', min: 1, max: MAX_INVOICE_SEQ },
    // Identity stamped into the permanent invoice number.
    invoicePrefix: { type: 'string', maxLength: 16, pattern: /^[A-Za-z0-9_-]*$/, patternHint: 'letters, digits, hyphen and underscore only' },
    taxMode: { type: 'enum', values: ['Inclusive', 'Exclusive'], caseInsensitive: true },
    goldApiProvider: { type: 'enum', values: SUPPORTED_GOLD_PROVIDERS },
    currency: { type: 'string', maxLength: 8 },
    // Free text that is echoed onto invoices, emails and the portal.
    companyName: { type: 'string', maxLength: MAX_SETTINGS_TEXT },
    address: { type: 'string', maxLength: MAX_SETTINGS_TEXT },
    phone: { type: 'string', maxLength: 40 },
    gstNumber: { type: 'string', maxLength: 40 },
    reportEmail: { type: 'string', maxLength: 200 },
    alertEmail: { type: 'string', maxLength: 200 },
    upiId: { type: 'string', maxLength: 120 },
    publicUrl: { type: 'string', maxLength: 300 },
    razorpayKeyId: { type: 'string', maxLength: 200 },
    auditRetentionEnabled: { type: 'boolean' },
    auditRetentionDays: { type: 'integer', min: 1, max: 36500 },
    wastageEnabled: { type: 'boolean' },
    wastageMode: { type: 'enum', values: ['weight_uplift', 'making_charge_percent', 'separate_line'] },
    wastagePercent: { type: 'number', min: 0, max: 25 },
    pitrEnabled: { type: 'boolean' },
    // Below 5 has no effect (the scheduler's own tick is fixed at 5 minutes)
    // but is not refused outright — a tenant lowering it from, say, 15 to 5
    // in stages should not be blocked at the boundary itself.
    pitrIntervalMinutes: { type: 'integer', min: 5, max: 1440 },
    pitrRetentionHours: { type: 'integer', min: 1, max: 720 },
    offsiteBackupEnabled: { type: 'boolean' },
    offsiteBackupPath: { type: 'string', maxLength: 1000 },
    offsiteBackupRetentionDays: { type: 'integer', min: 1, max: 3650 },
    oldGoldExchangeEnabled: { type: 'boolean' },
    oldGoldDeductionPercent: { type: 'number', min: 0, max: 100 },
    goldSchemeEnabled: { type: 'boolean' },
    goldSchemeInstallmentCount: { type: 'integer', min: 1, max: 60 },
    goldSchemeBonusInstallments: { type: 'integer', min: 0, max: 12 },
    goldSchemeDefaultGraceDays: { type: 'integer', min: 1, max: 365 },
    goldSchemeEarlyClosurePenaltyPercent: { type: 'number', min: 0, max: 100 }
};

/**
 * Type/range-check a settings patch before it is merged into settings.json.
 *
 * Returns the CANONICAL value for every key it validated — `"10"` comes back as
 * the number 10, `" inclusive "` as `'Exclusive'`-style canonical casing — so the
 * document on disk holds the right type rather than merely a checked one. That
 * is the half that actually fixes the string-concatenation bug: rejecting the
 * bad values is not enough while a *stringified* good value still gets stored.
 *
 * The engine moved to `validation.js` when request bodies needed the same
 * checks; this stays the settings-shaped entry point, and the rules table above
 * stays here beside the template that declares the keys. No rule in
 * SETTINGS_FIELD_RULES is `required`, which is what keeps this a *patch*
 * validator: an absent key means "leave it alone".
 *
 * @param {object} patch the request body
 * @returns {{ok: true, values: object}|{ok: false, error: string}}
 */
export function validateSettingsPatch(patch) {
    return validateAgainstRules(patch, SETTINGS_FIELD_RULES);
}

/** Settings objects that are merged key-by-key rather than replaced wholesale. */
export const NESTED_SETTINGS_KEYS = ['smtp', 'overrideGoldPrice'];

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
/**
 * Deep copy of `settings` with every secret value passed through `transform`.
 *
 * The one place that knows how to *find* a credential in this document. Both
 * things that need to act on every secret — redaction for the wire, and
 * encryption for the disk — run through here, so a newly declared key in
 * SECRET_SETTINGS_KEYS is picked up by both without either being edited.
 *
 * `transform` returning `undefined` leaves the value alone, which is what lets
 * the vault skip a value that is already in the state it wants.
 *
 * @param {object} settings
 * @param {(value: any, dotted: string) => any} transform
 */
export function mapSecretValues(settings, transform) {
    const copy = JSON.parse(JSON.stringify(settings ?? {}));
    for (const pattern of SECRET_SETTINGS_KEYS) {
        for (const dotted of expandPath(copy, pattern)) {
            const value = getByPath(copy, dotted);
            if (value === undefined || value === null) continue;
            const next = transform(value, dotted);
            if (next !== undefined) setByPath(copy, dotted, next);
        }
    }
    return copy;
}

export function redactSettings(settings) {
    return mapSecretValues(settings, value => (String(value).length > 0 ? REDACTED_SENTINEL : ''));
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
