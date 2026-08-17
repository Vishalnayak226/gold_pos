/**
 * ==========================================================================
 * Runtime shape checking for request bodies.
 *
 * THIS IS THE SETTINGS VALIDATOR'S ENGINE, LIFTED OUT — NOT A SECOND ONE.
 * `validateSettingsPatch()` in `defaultSettings.js` proved the shape of this
 * problem on `POST /api/settings`: declare each field's type in a table, check
 * it at the one write choke point, and hand back the CANONICAL value so what
 * gets stored has the right type rather than merely a checked one. That last
 * half is the part that matters — rejecting `"10"` is not the fix while a
 * stringified good value still gets through and turns `start + 1` into string
 * concatenation. Every rule type here behaves exactly as it did there, and
 * `validateSettingsPatch()` now calls into this file, so there is one
 * implementation to keep correct (CLAUDE.md §1).
 *
 * WHAT THIS DOES NOT DO. It checks *shape*: types, ranges, lengths, patterns,
 * presence. It does not check business rules — whether a phone number is one we
 * know, whether a password is strong enough, whether an amount is affordable.
 * Those live where they already live (`customerAuth.js`, the services), and
 * duplicating them here would create exactly the second source of truth this
 * file exists to avoid. Shape first so a handler can trust `typeof`; meaning
 * afterwards, where the meaning is known.
 *
 * NO IMPORTS, DELIBERATELY. `defaultSettings.js` is the one module a test suite
 * may import statically, because it is side-effect-free and has no path to
 * `db.js` — and it now depends on this file. Keeping this module pure preserves
 * that property. Do not import `db.js` here (CLAUDE.md §8).
 * ==========================================================================
 */

/** Human label for an expected type, used in the refusal message. */
export function describeRule(rule) {
    if (rule.type === 'enum') return `one of ${rule.values.join(', ')}`;
    if (rule.type === 'boolean') return 'true or false';
    if (rule.type === 'integer') return `a whole number between ${rule.min} and ${rule.max}`;
    if (rule.type === 'number') return `a number between ${rule.min} and ${rule.max}`;
    if (rule.patternHint) return `text (${rule.patternHint}), at most ${rule.maxLength} characters`;
    return `text of at most ${rule.maxLength} characters`;
}

/**
 * Checks `source` against a table of field rules.
 *
 * A rule is `{type, ...}` where type is 'number' | 'integer' | 'string' |
 * 'enum' | 'boolean', plus `required: true` to refuse an absent value. Keys
 * absent from the table are ignored and passed through untouched by the caller
 * — this validates the fields it knows about and does not pretend to be a
 * whitelist.
 *
 * @param {object} source the object to check, usually `req.body`
 * @param {Record<string, object>} rules
 * @returns {{ok: true, values: object}|{ok: false, error: string, field?: string}}
 */
export function validateAgainstRules(source, rules) {
    const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
    const values = {};

    for (const [key, rule] of Object.entries(rules)) {
        const present = Object.prototype.hasOwnProperty.call(input, key);
        const raw = present ? input[key] : undefined;

        /* An explicit null or undefined means "not supplied". For a patch that
           means "leave it alone"; for a required field it is the same failure
           as omitting the key, which is what a client sending `{phone: null}`
           actually did. */
        if (!present || raw === null || raw === undefined) {
            if (rule.required) {
                return { ok: false, field: key, error: `"${key}" is required and must be ${describeRule(rule)}.` };
            }
            continue;
        }

        const refuse = () => ({ ok: false, field: key, error: `"${key}" must be ${describeRule(rule)}.` });

        if (rule.type === 'number' || rule.type === 'integer') {
            /* Deliberately NOT Number(raw): that turns [], '' and true into
               numbers, which is the coercion that caused this whole class of
               bug. Only a real number, or a string that is entirely a number. */
            const isNumericString = typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw));
            if (typeof raw !== 'number' && !isNumericString) return refuse();
            const n = Number(raw);
            if (!Number.isFinite(n)) return refuse();
            if (rule.type === 'integer' && !Number.isInteger(n)) return refuse();
            if (n < rule.min || n > rule.max) return refuse();
            values[key] = n;
            continue;
        }

        if (rule.type === 'boolean') {
            if (typeof raw === 'boolean') { values[key] = raw; continue; }
            // Accept the two strings a form actually sends, nothing else. "yes"
            // and 1 are not booleans; guessing at them is how a checkbox ends up
            // permanently on.
            if (raw === 'true' || raw === 'false') { values[key] = raw === 'true'; continue; }
            return refuse();
        }

        if (rule.type === 'enum') {
            if (typeof raw !== 'string') return refuse();
            const needle = raw.trim().toLowerCase();
            const match = rule.values.find(v =>
                rule.caseInsensitive ? v.toLowerCase() === needle : v === raw.trim());
            if (!match) return refuse();
            values[key] = match;
            continue;
        }

        /* Strings. An object, array or number here is a client bug, not a value
           to stringify — `[object Object]` written into a permanent invoice
           number is exactly what this refuses. */
        if (typeof raw !== 'string') return refuse();
        const text = rule.preserveWhitespace ? raw : raw.trim();

        if (rule.required && text.length === 0) {
            return { ok: false, field: key, error: `"${key}" is required and must be ${describeRule(rule)}.` };
        }

        /* AN EMPTY OPTIONAL STRING MEANS "NOT SUPPLIED", NOT "INVALID".
           A browser form posts every field it owns, so an untouched input
           arrives as `""` — and a pattern like `^[A-Za-z0-9-]+$`, which quite
           reasonably demands at least one character, then refuses it. That is
           not hypothetical: the admin login form always sends `totpCode: ""`
           and `recoveryCode: ""`, so the first version of this rule table
           400'd EVERY ordinary sign-in. `npm test` missed it because the HTTP
           suite posts only `{pin}`; the Playwright journeys, which drive the
           real form, caught it. Skipping here rather than loosening each
           pattern to allow empty keeps the fix at the one choke point. */
        if (text.length === 0) continue;

        if (text.length > rule.maxLength) return refuse();
        if (rule.minLength && text.length < rule.minLength) return refuse();
        if (rule.pattern && !rule.pattern.test(text)) return refuse();
        values[key] = text;
    }

    return { ok: true, values };
}

/**
 * Express middleware refusing a body that does not match `rules`.
 *
 * On success the canonical values are written back over `req.body`, so a
 * handler reading `req.body.amount` gets the number 500 whether the client sent
 * `500` or `"500"` — the same guarantee `POST /api/settings` already relies on.
 * Fields the table does not mention are left exactly as they arrived: this is
 * a shape check, not a whitelist, and stripping unknown keys would silently
 * break every handler that reads one.
 *
 * @param {Record<string, object>} rules
 */
export function validateBody(rules) {
    return function validateBodyMiddleware(req, res, next) {
        const result = validateAgainstRules(req.body, rules);
        if (!result.ok) {
            return res.status(400).json({
                error: 'INVALID_BODY',
                field: result.field,
                message: result.error,
                requestId: req.id
            });
        }
        Object.assign(req.body, result.values);
        return next();
    };
}

/* --------------------------------------------------------------------------
   Shared field rules.

   Declared once and composed per route, so "a phone number is at most 20
   characters of digits and separators" has one definition rather than six that
   drift. Business meaning still belongs to the module that owns it — these say
   only what a well-formed value LOOKS like.
   -------------------------------------------------------------------------- */

/** Loose on purpose: `isValidPhone()` in customerAuth.js owns what is dialable. */
export const PHONE_RULE = { type: 'string', maxLength: 20, pattern: /^[0-9+\-\s()]+$/, patternHint: 'digits and phone punctuation only' };

/** Password strength is `validatePasswordStrength()`'s job; this caps the scrypt input. */
export const PASSWORD_RULE = { type: 'string', maxLength: 200, minLength: 1, preserveWhitespace: true };

/** A numeric one-time code — TOTP, or a reset code. Never coerced to a number: leading zeros are significant. */
export const CODE_RULE = { type: 'string', maxLength: 32, pattern: /^[A-Za-z0-9-]+$/, patternHint: 'letters, digits and hyphens' };

export const NAME_RULE = { type: 'string', maxLength: 120 };
export const EMAIL_RULE = { type: 'string', maxLength: 200 };
