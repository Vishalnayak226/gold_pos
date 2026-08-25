/**
 * ==========================================================================
 * Admin Session Authentication — and WHO is at the counter
 *
 * Real server-side session tokens for the admin/cashier terminal, replacing
 * the old client-only PIN check. Sessions are in-memory (cleared on server
 * restart) — acceptable for a single-process local/tenant deployment.
 *
 * A session now carries an IDENTITY, not just "is authenticated". Until this,
 * every admin route was gated by one anonymous PIN, so a sale, a discount, a
 * counter rate override and a cash refund were all filed with nobody attached
 * — there was no way to ask who took a decision, and no way to require that a
 * manager (rather than whoever is standing there) approved a money claim.
 *
 * The PIN is what identifies the person. Each operator configured in Settings
 * has their own, so submitting it both authenticates AND names the actor; the
 * legacy single `adminPin` still works and resolves to the store owner, which
 * is what keeps every existing install logging in unchanged.
 * ==========================================================================
 */

import crypto from 'crypto';
import { logTelemetry, logError } from './db.js';
import { readSettings, writeSettings } from './settingsStore.js';
import { OPERATOR_ROLES, APPROVER_ROLES } from './defaultSettings.js';
import { createBoundedMap } from './rateLimit.js';
import { parseCookies } from './cookies.js';

/** Cookie names for the admin session transport. Exported so server.js can set/clear them. */
export const ADMIN_SESSION_COOKIE = 'gp_admin_sess';
export const ADMIN_CSRF_COOKIE = 'gp_admin_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* ==========================================================================
   PIN HASHING

   PINs used to sit in settings.json in the clear — the master one always had,
   and the per-operator ones inherited that when the roster was added. Anyone who
   could read a backup, a support export, or the tenant's disk could read every
   credential on the terminal.

   Hashed with scrypt in the SAME self-describing `scrypt$N$r$p$<hex>` format
   customerAuth.js already uses for customer passwords, so this project has one
   password-hashing mechanism rather than two, and the work factors can be raised
   later without invalidating a stored PIN.

   ONE TENANT-WIDE SALT, deliberately, and this is the load-bearing design
   choice. A login supplies only a PIN — no username — so with a per-operator
   salt the server would have to try every operator's salt in turn: 50 operators
   × ~100ms of scrypt is a five-second login, which is not a real option. Hashing
   the submitted PIN once against the tenant salt turns the lookup into a map
   hit.

   What that costs, stated plainly: two operators with the same PIN would produce
   the same hash. That is not a weakness here because duplicate PINs are already
   forbidden outright (mergeOperators refuses them, and the shared salt is what
   makes detecting a duplicate cheap and exact). The per-tenant salt still defeats
   precomputed rainbow tables, which is what a salt is for.

   What it does NOT fix: a 4-digit PIN is only a 10,000-value keyspace, so an
   attacker holding the settings file can grind it offline in about twenty minutes
   whatever the KDF. Longer PINs are the mitigation; the UI allows up to 8 and the
   Settings copy asks for 6+. The lockout in this file is what defends the live
   endpoint.
   ========================================================================== */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/**
 * The shipped default master PIN.
 *
 * Not a secret — it is documented, and productionGuard refuses to boot a
 * production process still using it. Stated here because this is the module that
 * seeds it; productionGuard has its own copy for its own check.
 */
export const DEFAULT_ADMIN_PIN = '1234';

/**
 * The tenant's PIN salt, created on first use and persisted.
 *
 * Generated rather than configured, and never sent to a browser: it is part of
 * the credential store, not of the configuration a shop edits.
 */
export function ensureAuthSalt(settings) {
    if (typeof settings.authSalt === 'string' && settings.authSalt.length >= 32) {
        return settings.authSalt;
    }
    settings.authSalt = crypto.randomBytes(16).toString('hex');
    return settings.authSalt;
}

/** A PIN hashed against the tenant salt, in the shared self-describing format. */
export function hashPin(pin, authSalt) {
    const derived = crypto.scryptSync(String(pin), authSalt, SCRYPT_KEYLEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
    });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${derived.toString('hex')}`;
}

/**
 * Re-derives a submitted PIN using the work factors recorded IN a stored hash,
 * so a record written before a parameter bump still verifies.
 *
 * Returns null when the stored hash is unreadable, which callers treat as "no
 * match" rather than as "match".
 */
function derivePinLike(pin, authSalt, storedHash) {
    try {
        const parts = String(storedHash || '').split('$');
        if (parts.length !== 5 || parts[0] !== 'scrypt') return null;
        const N = parseInt(parts[1], 10);
        const r = parseInt(parts[2], 10);
        const p = parseInt(parts[3], 10);
        const expected = Buffer.from(parts[4], 'hex');
        if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return null;
        return {
            derived: crypto.scryptSync(String(pin), authSalt, expected.length, { N, r, p }),
            expected
        };
    } catch (err) {
        logError('PIN hash could not be read: ' + err.message, err.stack);
        return null;
    }
}

/** Constant-time check of a submitted PIN against one stored hash. */
export function verifyPinHash(pin, authSalt, storedHash) {
    const pair = derivePinLike(pin, authSalt, storedHash);
    if (!pair) return false;
    return crypto.timingSafeEqual(pair.derived, pair.expected);
}

/**
 * Upgrades any plaintext PIN in `settings` to a hash, in place.
 *
 * Runs on boot and on every settings save. This is the migration path §1
 * requires: a live tenant's settings.json already holds `adminPin: "1234"` and
 * operator rows with `pin`, and both must keep working across the upgrade
 * without anyone retyping anything. The plaintext key is DELETED once hashed —
 * leaving it would defeat the entire change.
 *
 * @returns {boolean} whether anything changed and needs persisting
 */
export function migratePinsToHashes(settings) {
    if (!settings || typeof settings !== 'object') return false;
    let changed = false;

    const saltBefore = settings.authSalt;
    const authSalt = ensureAuthSalt(settings);
    if (authSalt !== saltBefore) changed = true;

    if (typeof settings.adminPin === 'string' && settings.adminPin.length > 0) {
        // The upgrade path: an existing tenant's plaintext PIN keeps working,
        // now as a hash, with nobody retyping anything.
        settings.adminPinHash = hashPin(settings.adminPin, authSalt);
        delete settings.adminPin;
        changed = true;
    } else if (!settings.adminPinHash) {
        /* A fresh install. The default is SEEDED here rather than carried in
           DEFAULT_SETTINGS, because that template is merged over a tenant's
           settings on every boot — a plaintext default living there would be
           re-added immediately after this function deleted it, and the hashing
           would silently undo itself. See the note where adminPin used to be.

           productionGuard refuses to boot a production process still on it. */
        settings.adminPinHash = hashPin(DEFAULT_ADMIN_PIN, authSalt);
        changed = true;
    }

    if (Array.isArray(settings.operators)) {
        for (const op of settings.operators) {
            if (!op || typeof op.pin !== 'string' || op.pin.length === 0) continue;
            op.pinHash = hashPin(op.pin, authSalt);
            delete op.pin;
            changed = true;
        }
    }

    return changed;
}

/**
 * Boot-time hook: hashes any plaintext PIN on disk and writes it back once.
 *
 * Called from bootstrapServer(). Idempotent — after the first run there is no
 * plaintext left to convert, so it does nothing and writes nothing.
 */
export function migrateStoredPins() {
    /* Read through the store so a sealed document is opened before the hash
       migration inspects it. A null here means no settings file at all, which is
       a fresh install with nothing to migrate. */
    const settings = readSettings();
    if (!settings || Object.keys(settings).length === 0) return false;
    if (!migratePinsToHashes(settings)) return false;
    if (!writeSettings(settings)) {
        logError('Could not persist hashed PINs — settings.json was not written.');
        return false;
    }
    logTelemetry('ADMIN_PINS_HASHED', 0, 'plaintext PINs upgraded to scrypt hashes');
    return true;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> { createdAt, actor }

/**
 * The identity a legacy `adminPin` login resolves to.
 *
 * Deliberately the same id and role as the `owner` bootstrap row seeded by
 * backend/repositories/userRepository.js, so when the ledger moves to SQLite
 * these records join to a real user rather than to a string that means nothing.
 */
export const OWNER_ACTOR = Object.freeze({ id: 'owner', name: 'Store Owner', role: 'owner' });

/**
 * The identity used when no human is at the keyboard: a gateway-verified
 * payment, a scheduled job, a webhook. Separated from OWNER_ACTOR so an audit
 * can tell "a person approved this" from "a signature verified and the machine
 * posted it" — exactly the distinction the manual-UPI approval control exists
 * to make.
 */
export const SYSTEM_ACTOR = Object.freeze({ id: 'system', name: 'Automated Process', role: 'owner' });

/** Whether a role may approve a money claim. Mirrors the SQL `approvers` view. */
export function roleCanApprove(role) {
    return APPROVER_ROLES.includes(String(role || '').trim().toLowerCase());
}

/**
 * The configured operator roster, normalised and filtered to those who can
 * actually log in. An operator with no PIN is roster-only (their name exists,
 * they cannot authenticate), and an inactive one is excluded outright — that is
 * how somebody who has left the shop stops being able to bill without their
 * past invoices losing the name attached to them.
 */
export function listOperators(settings) {
    const rows = Array.isArray(settings && settings.operators) ? settings.operators : [];
    return rows
        .filter(op => op && op.active !== false)
        .map(op => ({
            id: String(op.id || '').trim(),
            name: String(op.name || '').trim(),
            role: OPERATOR_ROLES.includes(String(op.role || '').trim().toLowerCase())
                ? String(op.role).trim().toLowerCase()
                : 'cashier',
            pinHash: typeof op.pinHash === 'string' ? op.pinHash : '',
            mfaEnabled: op.mfaEnabled === true,
            totpSecret: typeof op.totpSecret === 'string' ? op.totpSecret : '',
            recoveryCodes: Array.isArray(op.recoveryCodes) ? op.recoveryCodes : []
        }))
        .filter(op => op.id && op.name && op.pinHash.length > 0);
}

/**
 * Which person a submitted PIN belongs to, or null if it belongs to nobody.
 *
 * Returns the identity and the person's SECOND-FACTOR MATERIAL as two separate
 * objects, and that separation is deliberate: `actor` is what goes into the
 * session, onto every financial record, and back to the browser, so it must
 * never carry a TOTP secret or a recovery-code hash. Callers pass `actor`
 * onward and use `mfa` only to decide what to challenge for, then drop it.
 *
 * ONE scrypt derivation per attempt, then a lookup — see the PIN HASHING note at
 * the top of this file for why the tenant salt is shared and what that does and
 * does not buy. Operators are matched BEFORE the master PIN so that a store which
 * has moved to named logins gets the named actor.
 *
 * @returns {{actor: {id,name,role}, mfa: {enabled: boolean, secret: string, recoveryCodes: string[]}}|null}
 */
export function resolveActor(pin, settings) {
    if (typeof pin !== 'string' || pin.length === 0) return null;
    if (!settings || typeof settings !== 'object') return null;

    const authSalt = typeof settings.authSalt === 'string' ? settings.authSalt : '';
    if (!authSalt) {
        // No salt means no hashed credential has ever been written. Refuse rather
        // than fall back to comparing plaintext: the fallback would quietly
        // undo the hashing for any tenant whose migration had not run.
        logError('Refusing an admin login: settings.json carries no authSalt, so no PIN can be verified.');
        return null;
    }

    for (const op of listOperators(settings)) {
        if (verifyPinHash(pin, authSalt, op.pinHash)) {
            return {
                actor: { id: op.id, name: op.name, role: op.role },
                mfa: { enabled: op.mfaEnabled, secret: op.totpSecret, recoveryCodes: op.recoveryCodes }
            };
        }
    }

    if (settings.adminPinHash && verifyPinHash(pin, authSalt, settings.adminPinHash)) {
        // The master PIN carries no second factor of its own — it is a shared
        // store credential, not a person, so there is nobody to enrol. That is
        // exactly why requiring MFA for approvals also pushes a shop off it and
        // onto named logins; see requireApprover.
        return {
            actor: { ...OWNER_ACTOR },
            mfa: { enabled: false, secret: '', recoveryCodes: [] }
        };
    }
    return null;
}

// Brute-force lockout: a 4-digit PIN is only a ~10,000-value keyspace, which
// is trivially exhaustible in under a minute against an unthrottled login
// endpoint. Track failed attempts per source IP with an escalating cooldown.
const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000; // 30s, doubles per additional failure past the threshold
const MAX_LOCKOUT_MS = 15 * 60 * 1000; // capped at 15 minutes

/* ip -> { count, lockedUntil }. Bounded, because a plain Map here only ever
   shed an entry on a *successful* login: every address that failed once and
   never returned stayed resident for the life of the process, so one request
   per new IP grew it indefinitely. Entries expire a full max-lockout after
   their last write, so the map drains on its own.

   THE TTL IS A DAY, NOT THE 15-MINUTE LOCKOUT CAP, AND THAT MATTERS. Expiring
   an entry resets its count, and the count is what makes the cooldown escalate.
   At a 15-minute TTL an attacker who waits out one lockout gets the full five
   free attempts back every time; at 24 hours the escalation stays effectively
   permanent for any realistic attack while the memory still bounds. The
   escalation policy below is unchanged — only the storage is shared. */
const failedAttempts = createBoundedMap({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 10000 });

/* GLOBAL BREAKER, ON TOP OF THE PER-IP ONE.
   Per-IP throttling is beaten by spreading guesses across many source
   addresses — a botnet or any IP-rotation capability empties a 4-8 digit PIN
   keyspace in minutes without any single IP ever crossing MAX_FAILED_ATTEMPTS.
   This counts failed admin logins tenant-wide, independent of source, and
   locks out ALL sign-in attempts for a short window once the aggregate
   crosses a threshold no legitimate run of typos should reach — a busy shop
   with several tills mistyping a PIN now and again will not come close to
   it, but a scripted distributed attempt will.

   Deliberately a plain fixed window rather than createBoundedMap: there is
   exactly one counter, tenant-wide, not one per key, so nothing here is
   unbounded. */
const GLOBAL_MAX_FAILURES = 100;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const GLOBAL_LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
let globalFailureWindow = { count: 0, windowStart: 0, lockedUntil: 0 };

function currentGlobalFailureWindow(now) {
    if (now - globalFailureWindow.windowStart > GLOBAL_WINDOW_MS) {
        globalFailureWindow = { count: 0, windowStart: now, lockedUntil: 0 };
    }
    return globalFailureWindow;
}

/** Remaining ms of a tenant-wide lockout, or 0 if none is in effect. */
export function getGlobalLoginLockoutRemaining() {
    const now = Date.now();
    const win = currentGlobalFailureWindow(now);
    return win.lockedUntil > now ? win.lockedUntil - now : 0;
}

function recordGlobalFailedLogin() {
    const now = Date.now();
    const win = currentGlobalFailureWindow(now);
    win.count += 1;
    if (win.count >= GLOBAL_MAX_FAILURES) {
        win.lockedUntil = now + GLOBAL_LOCKOUT_MS;
    }
}

// Test seam, mirroring createRateLimiter's .reset(): lets a suite start from
// a known state rather than depending on whatever earlier checks in the same
// process already spent.
export function resetGlobalLoginLockout() {
    globalFailureWindow = { count: 0, windowStart: 0, lockedUntil: 0 };
}

/**
 * Checks whether a given source key is currently locked out from login attempts.
 * Returns the remaining lockout time in ms, or 0 if not locked.
 */
export function getLoginLockoutRemaining(key) {
    const entry = failedAttempts.get(key);
    if (!entry || !entry.lockedUntil) return 0;
    const remaining = entry.lockedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}

function recordFailedLogin(key) {
    const entry = failedAttempts.get(key) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
        const extra = entry.count - MAX_FAILED_ATTEMPTS;
        entry.lockedUntil = Date.now() + Math.min(BASE_LOCKOUT_MS * Math.pow(2, extra), MAX_LOCKOUT_MS);
    }
    failedAttempts.set(key, entry);
}

function clearFailedLogins(key) {
    failedAttempts.delete(key);
}

/**
 * Verifies a submitted PIN and returns WHO it belongs to, or null.
 *
 * Replaces the old boolean: a login that only answers "yes" cannot tell the
 * ledger who is billing. Callers treat null as a failed login exactly as they
 * treated `false`. See resolveActor for the actor/mfa split.
 */
export function verifyAdminPin(pin) {
    const settings = readSettings();

    /* Upgrade any plaintext PIN here too, not only at boot.
       bootstrapServer() calls migrateStoredPins(), but a process that imports the
       app without booting it — every test suite does, via
       GOLD_POS_DISABLE_BOOTSTRAP — would otherwise reach resolveActor() with no
       salt and no hash, and refuse a correct PIN. Idempotent: once there is
       nothing plaintext left, this writes nothing. */
    if (migratePinsToHashes(settings)) {
        writeSettings(settings);
    }
    return resolveActor(pin, settings);
}

/* ==========================================================================
   SECOND FACTOR — TOTP (RFC 6238) and recovery codes

   A PIN is a short shared-format secret typed at a counter where other people
   can watch. For the roles that can release money — approve a customer's
   unverified deposit, authorise a refund over the threshold — a second factor is
   the difference between "someone knew the PIN" and "that person was there".

   Implemented against the stdlib: HMAC-SHA1 over a 30-second counter is the whole
   of TOTP, and `crypto` already provides it. No dependency was added, and the
   `qrcode` package already in the budget renders the enrolment QR.

   RECOVERY CODES ARE NOT OPTIONAL HERE. A shop owner whose phone is lost or
   reset must not be locked out of their own till — that failure mode is worse
   than the attack this defends against. Ten single-use codes are issued at
   enrolment, stored only as hashes, and each is consumed on use.
   ========================================================================== */

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
// One step of clock skew either side. A counter terminal's clock can drift, and
// refusing a code that was correct two seconds ago trains people to retype.
const TOTP_WINDOW_STEPS = 1;
const RECOVERY_CODE_COUNT = 10;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A fresh base32 TOTP secret, in the alphabet authenticator apps expect. */
export function generateTotpSecret() {
    const bytes = crypto.randomBytes(20); // 160 bits, per RFC 4226 §4
    let secret = '';
    for (const byte of bytes) secret += BASE32_ALPHABET[byte % 32];
    return secret;
}

function base32Decode(secret) {
    let bits = '';
    for (const ch of String(secret).toUpperCase().replace(/=+$/, '')) {
        const index = BASE32_ALPHABET.indexOf(ch);
        if (index === -1) continue;
        bits += index.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

/**
 * The code an authenticator app would be showing for this secret right now.
 *
 * Exported for the test suites, which need to present a valid code without
 * reimplementing the generator — a test that reimplements what it is testing
 * agrees with its own bugs. The generator's correctness is pinned separately
 * against the RFC 6238 published vectors.
 */
export function currentTotpCode(secret, now = Date.now()) {
    return totpAt(secret, Math.floor(now / 1000 / TOTP_STEP_SECONDS));
}

/** The TOTP code for one counter value. */
function totpAt(secret, counter) {
    const key = base32Decode(secret);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', key).update(buf).digest();
    // Dynamic truncation, RFC 4226 §5.3.
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Whether a submitted code is valid for this secret right now.
 *
 * Checks the neighbouring steps for clock drift, and compares in constant time
 * so a wrong code reveals nothing about how wrong it was.
 */
export function verifyTotp(code, secret, now = Date.now()) {
    const clean = String(code || '').replace(/\D/g, '');
    if (!secret || clean.length !== TOTP_DIGITS) return false;
    const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
    const submitted = Buffer.from(clean, 'utf8');
    let matched = false;
    for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift++) {
        const expected = Buffer.from(totpAt(secret, counter + drift), 'utf8');
        // Not short-circuited: every candidate is compared so the loop costs the
        // same whichever step matched.
        if (expected.length === submitted.length && crypto.timingSafeEqual(expected, submitted)) {
            matched = true;
        }
    }
    return matched;
}

/** The `otpauth://` URI an authenticator app scans. */
export function totpEnrolmentUri(secret, operatorName, storeName) {
    const issuer = encodeURIComponent(String(storeName || 'Gold POS').slice(0, 40));
    const label = encodeURIComponent(String(operatorName || 'operator').slice(0, 40));
    return `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}`
        + `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/**
 * Ten single-use recovery codes: the plaintext to hand over ONCE, and the hashes
 * to store. The plaintext is never persisted and cannot be shown again.
 */
export function generateRecoveryCodes(authSalt) {
    const plain = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
        // No 0/O/1/l/I — these are read off a printed slip at a counter.
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        let code = '';
        for (const byte of crypto.randomBytes(10)) code += alphabet[byte % alphabet.length];
        plain.push(`${code.slice(0, 5)}-${code.slice(5, 10)}`);
    }
    return { plain, hashes: plain.map(code => hashPin(code, authSalt)) };
}

/**
 * Consumes a recovery code if it matches an unused one.
 *
 * @returns {{ok: boolean, remainingHashes?: string[]}} the surviving hashes, so
 *          the caller can persist the consumption. A code that works once must
 *          never work twice.
 */
export function consumeRecoveryCode(code, authSalt, storedHashes) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean || !Array.isArray(storedHashes)) return { ok: false };
    const index = storedHashes.findIndex(hash => verifyPinHash(clean, authSalt, hash));
    if (index === -1) return { ok: false };
    const remainingHashes = storedHashes.filter((_, i) => i !== index);
    return { ok: true, remainingHashes };
}

/**
 * Express middleware guarding POST /api/admin/login: rejects with 429 while
 * the caller's key (IP) is in cooldown, and records/clears failures around
 * the actual verifyAdminPin() call performed by the route handler.
 */
export function loginRateLimiter(req, res, next) {
    const globalRemaining = getGlobalLoginLockoutRemaining();
    if (globalRemaining > 0) {
        return res.status(429).json({
            error: 'TOO_MANY_ATTEMPTS',
            message: `Too many failed PIN attempts across all sign-ins. Try again in ${Math.ceil(globalRemaining / 1000)}s.`
        });
    }
    const key = req.ip || 'unknown';
    const remaining = getLoginLockoutRemaining(key);
    if (remaining > 0) {
        return res.status(429).json({
            error: 'TOO_MANY_ATTEMPTS',
            message: `Too many failed PIN attempts. Try again in ${Math.ceil(remaining / 1000)}s.`
        });
    }
    req._loginRateLimitKey = key;
    next();
}

export function recordLoginResult(req, success) {
    const key = req._loginRateLimitKey || req.ip || 'unknown';
    if (success) {
        clearFailedLogins(key);
    } else {
        recordFailedLogin(key);
        recordGlobalFailedLogin();
    }
}

/**
 * Issues a new random session token bound to the person who logged in.
 *
 * The actor is captured HERE, at login, and never re-read from settings for the
 * life of the session. Deleting an operator from Settings must not retroactively
 * anonymise the invoices they are part-way through filing; it stops them logging
 * in again, which is the control that was actually wanted.
 */
export function createAdminSession(actor = OWNER_ACTOR, meta = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    // A separate, JS-readable value the browser echoes back as X-CSRF-Token on
    // every mutating request. The session token itself lives in an HttpOnly
    // cookie now and is never visible to page script, so it cannot serve this
    // role — see requireAdminSession's CSRF check below.
    const csrfToken = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
        createdAt: Date.now(),
        actor: { id: actor.id, name: actor.name, role: actor.role },
        // Recorded so the roster screen can say WHICH sign-in it is about to end.
        // A shop with one terminal per counter needs to tell them apart.
        ip: String(meta.ip || '').slice(0, 64),
        userAgent: String(meta.userAgent || '').slice(0, 200),
        mfaUsed: meta.mfaUsed === true,
        csrfToken
    });
    return { token, csrfToken };
}

/**
 * Invalidates a session token (logout).
 */
export function destroyAdminSession(token) {
    if (token) sessions.delete(token);
}

/* ==========================================================================
   SESSION REVOCATION

   Sessions live 12 hours and used to be reachable only by their own holder's
   logout. So removing somebody from the roster, or changing their PIN after they
   walked out with it, did nothing until their session aged out — the credential
   was gone but the access was not, which is the gap that makes a revocation
   control worth having at all.

   Two halves, and both matter:
     - AUTOMATIC, on any roster change that should end access (deactivated,
       removed, PIN rotated, role changed). Nobody has to remember.
     - DELIBERATE, from Settings → Staff & Roles, so an owner who sees an unknown
       sign-in can end it now rather than reason about why it exists.
   ========================================================================== */

/**
 * Every live session, newest first, with no token in the output.
 *
 * The token is the credential — listing it would turn a read-only screen into a
 * way to steal one. Each row is addressed by a short opaque handle instead.
 */
export function listAdminSessions() {
    const rows = [];
    for (const [token, session] of sessions.entries()) {
        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
            sessions.delete(token);
            continue;
        }
        rows.push({
            handle: sessionHandle(token),
            actor: session.actor,
            createdAt: session.createdAt,
            expiresAt: session.createdAt + SESSION_TTL_MS,
            ip: session.ip,
            userAgent: session.userAgent,
            mfaUsed: session.mfaUsed
        });
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** A stable, non-reversible handle for one session, safe to put in a page. */
function sessionHandle(token) {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Ends one session by its handle. Returns whether anything was ended. */
export function revokeAdminSessionByHandle(handle, { exceptToken = null } = {}) {
    for (const token of sessions.keys()) {
        if (sessionHandle(token) !== handle) continue;
        if (exceptToken && token === exceptToken) return false;
        sessions.delete(token);
        return true;
    }
    return false;
}

/**
 * Ends every session belonging to one operator. Returns how many were ended.
 *
 * `exceptToken` lets an owner rotate their OWN PIN without signing themselves
 * out mid-task, which is the difference between a control people use and one
 * they route around.
 */
export function revokeSessionsForActor(actorId, { exceptToken = null } = {}) {
    if (!actorId) return 0;
    let ended = 0;
    for (const [token, session] of sessions.entries()) {
        if (session.actor.id !== actorId) continue;
        if (exceptToken && token === exceptToken) continue;
        sessions.delete(token);
        ended++;
    }
    if (ended > 0) logTelemetry('ADMIN_SESSIONS_REVOKED', 0, `${ended} for actor ${actorId}`);
    return ended;
}

/**
 * Compares the roster before and after a save and ends the sessions of anyone
 * whose access should no longer be live.
 *
 * Called from POST /api/settings. The four triggers are deactivation, removal,
 * a rotated PIN and a changed role — a role change because a demoted manager's
 * open session would otherwise keep its approving role for up to 12 hours, which
 * is precisely the window the demotion was meant to close.
 */
export function revokeSessionsForRosterChange(previousOperators, nextOperators, { exceptToken = null } = {}) {
    const before = Array.isArray(previousOperators) ? previousOperators : [];
    const after = new Map(
        (Array.isArray(nextOperators) ? nextOperators : [])
            .filter(op => op && op.id)
            .map(op => [op.id, op])
    );

    let ended = 0;
    const reasons = [];
    for (const old of before) {
        if (!old || !old.id) continue;
        const now = after.get(old.id);
        let reason = null;
        if (!now) reason = 'removed from the roster';
        else if (now.active === false && old.active !== false) reason = 'deactivated';
        else if (now.pinHash !== old.pinHash) reason = 'PIN changed';
        else if (now.role !== old.role) reason = 'role changed';
        if (!reason) continue;

        const count = revokeSessionsForActor(old.id, { exceptToken });
        if (count > 0) {
            ended += count;
            reasons.push(`${old.name || old.id}: ${reason}`);
        }
    }
    return { ended, reasons };
}

/**
 * The live session behind a token, or null if there is none or it has expired.
 */
export function getAdminSession(token) {
    if (!token || !sessions.has(token)) return null;
    const session = sessions.get(token);
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);
        return null;
    }
    return session;
}

/**
 * Checks whether a token maps to a live, unexpired session.
 */
export function isValidAdminSession(token) {
    return getAdminSession(token) !== null;
}

/**
 * Express middleware: rejects the request unless the HttpOnly session cookie
 * names a live session — and, on a mutating method, unless the double-submit
 * CSRF token matches on all three of header, cookie and session.
 *
 * On success it attaches `req.actor` — the one place every admin route learns
 * who is making the request. Doing it here rather than per-route is what makes
 * "no financial record is filed anonymously" enforceable: a route added
 * tomorrow gets the identity without anyone remembering to wire it up.
 */
export function requireAdminSession(req, res, next) {
    const cookies = req.cookies || parseCookies(req.headers.cookie);
    const token = cookies[ADMIN_SESSION_COOKIE] || null;

    const session = getAdminSession(token);
    if (!session) {
        logTelemetry('ADMIN_SESSION_REJECTED', 0, `Path: ${req.path}`);
        return res.status(401).json({ error: 'ADMIN_SESSION_REQUIRED', message: 'Admin authentication required.' });
    }

    // CSRF: the session cookie rides along automatically with a forged
    // cross-site request, but the double-submit CSRF cookie does not — a
    // third-party page cannot read it (same-origin policy), so it cannot
    // reproduce this header. Safe methods are exempt; nothing they do mutates
    // state.
    if (!SAFE_METHODS.has(req.method)) {
        const csrfCookie = cookies[ADMIN_CSRF_COOKIE];
        const csrfHeader = req.headers['x-csrf-token'];
        if (!csrfHeader || csrfHeader !== csrfCookie || csrfHeader !== session.csrfToken) {
            logTelemetry('ADMIN_CSRF_REJECTED', 0, `Path: ${req.path}`);
            return res.status(403).json({ error: 'CSRF_TOKEN_INVALID', message: 'Your session needs to be refreshed. Please reload the page.' });
        }
    }

    req.actor = session.actor;
    // The session itself, for the few checks that need more than the identity —
    // requireApprover asks whether a second factor was used at sign-in. Kept off
    // `req.actor` so nothing that stamps an actor onto a ledger row can pick up
    // authentication metadata by accident.
    req.adminSession = session;
    req.adminToken = token;
    next();
}

/**
 * Express middleware, layered AFTER requireAdminSession: rejects the request
 * unless the logged-in person may approve a money claim.
 *
 * This is what makes "a manager reconciled the manual UPI deposit" a true
 * statement rather than a description of a control that does not exist. A
 * cashier can bill and refund all day; releasing an unverified customer claim
 * into a spendable balance is somebody else's signature.
 */
export function requireApprover(req, res, next) {
    if (!req.actor) {
        return res.status(401).json({ error: 'ADMIN_SESSION_REQUIRED', message: 'Admin authentication required.' });
    }
    if (!roleCanApprove(req.actor.role)) {
        logTelemetry('APPROVAL_DENIED', 0, `${req.actor.name} (${req.actor.role}) at ${req.path}`);
        return res.status(403).json({
            error: 'APPROVER_REQUIRED',
            message: `Approving a deposit needs a manager or the owner. ${req.actor.name} is signed in as ${req.actor.role}.`
        });
    }

    /* PRIVILEGED MFA. When the store has turned it on, the session behind a
       money-releasing action must have passed a second factor at sign-in — not
       merely hold an approving role.

       Enforced on the SESSION, not re-prompted per action: the factor proves who
       is at the terminal, and re-asking for a code on every approval would train
       a manager to leave the app authenticated on someone else's screen, which is
       the behaviour this is trying to prevent. */
    const settings = readSettings();
    if (settings.requireMfaForApprovers === true && req.adminSession && !req.adminSession.mfaUsed) {
        logTelemetry('APPROVAL_DENIED_NO_MFA', 0, `${req.actor.name} (${req.actor.role}) at ${req.path}`);
        return res.status(403).json({
            error: 'MFA_REQUIRED',
            message: req.actor.id === OWNER_ACTOR.id
                ? 'This store requires two-factor authentication to approve money. The shared master PIN cannot carry it — sign in as a named manager or owner with an authenticator app enrolled.'
                : `This store requires two-factor authentication to approve money, and ${req.actor.name} signed in without it. Enrol an authenticator app in Settings → Staff & Roles, then sign in again.`
        });
    }
    next();
}

/**
 * Express middleware, layered AFTER requireAdminSession: rejects the request
 * unless the signed-in actor holds one of the given roles.
 *
 * Distinct from requireApprover, which gates a MONEY action any manager-or-
 * owner may take. This gates SYSTEM-level actions — rewriting settings,
 * resetting a customer's portal login, pulling a diagnostics export, applying
 * a code update — where the caller states exactly which role(s) qualify,
 * rather than relying on the blanket "any authenticated operator" that
 * requireAdminSession alone leaves in place. Added for security-audit finding
 * C1: POST /api/settings had no role check at all, so any cashier session
 * could add itself as `owner` and take the whole system over in one request.
 */
export function requireRole(...allowedRoles) {
    const allowed = allowedRoles.map(r => String(r).trim().toLowerCase());
    return function (req, res, next) {
        if (!req.actor) {
            return res.status(401).json({ error: 'ADMIN_SESSION_REQUIRED', message: 'Admin authentication required.' });
        }
        if (!allowed.includes(String(req.actor.role || '').toLowerCase())) {
            logTelemetry('ROLE_DENIED', 0, `${req.actor.name} (${req.actor.role}) at ${req.path}, needs one of: ${allowed.join(', ')}`);
            return res.status(403).json({
                error: 'ROLE_REQUIRED',
                message: `This action needs the ${allowed.join(' or ')} role. ${req.actor.name} is signed in as ${req.actor.role}.`
            });
        }
        next();
    };
}
