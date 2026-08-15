/**
 * ==========================================================================
 * Customer Identity & Session Authentication
 *
 * Closes the hole the phone-only customer portal shipped with: typing any
 * 10-digit number into customer.html opened that customer's full ledger, with
 * no credential of any kind. Every customer-facing read/write is now scoped to
 * the phone on the *session*, never a phone supplied by the caller.
 *
 * Mirrors backend/adminAuth.js deliberately (bearer tokens, escalating
 * lockout) so there is one authentication idiom in this codebase, with three
 * differences that the customer side genuinely needs:
 *
 *   1. Passwords, not a shared PIN — hashed with Node's built-in
 *      crypto.scryptSync. No new dependency, no plaintext, ever.
 *   2. Sessions survive a restart. Admin sessions are in-memory because a
 *      cashier is standing at the terminal and can retype a PIN; a customer
 *      on a phone should not be logged out every time the store's server
 *      restarts (nightly update applies, PM2 restarts). Only the SHA-256 of
 *      each token is persisted, so the file itself never yields a live
 *      session if it leaks.
 *   3. Lockout is tracked per account (persisted) *and* per source IP
 *      (in-memory), because a customer account is attacked by name in a way
 *      a single-terminal admin PIN is not.
 * ==========================================================================
 */

import crypto from 'crypto';
import { logError, logTelemetry } from './db.js';
import * as repo from './repositories/index.js';



// 30 days: long enough that a customer checking a passbook once a month is
// not re-authenticating every visit, short enough to bound a stolen token.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Multi-device is normal (phone + a family member's tablet); past this the
// oldest session is dropped, so a token list can never grow without bound.
const MAX_SESSIONS_PER_ACCOUNT = 5;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// scrypt work factors. N=16384/r=8 needs ~16MB per hash, inside Node's 32MB
// default maxmem, and costs ~50-100ms on the low-end VPS this deploys to —
// deliberately slow enough to make offline cracking of a leaked file painful.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;

// A single IP trying many different accounts is credential stuffing, which
// per-account lockout alone does not stop. Kept in memory (like adminAuth's)
// — an attacker restarting our server to clear it has bigger levers already.
const IP_MAX_FAILED = 20;
const IP_LOCKOUT_MS = 15 * 60 * 1000;
const ipFailures = new Map(); // ip -> { count, lockedUntil }

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

/* ==========================================================================
   Storage
   ========================================================================== */

/* THE ONE PAIR EVERY ACCOUNT OPERATION IN THIS FILE GOES THROUGH.
 *
 * Twenty-odd call sites below read the whole account set, change one thing in
 * it, and write it back. That shape came from `customer_auth.json` being a
 * single document, and it is exactly why the cutover is two functions rather
 * than twenty: the repository speaks the same legacy account shape — including
 * `sessions[]` — so everything above this line is unchanged.
 *
 * What DID change is the guarantee underneath. `writeJSON` rewrote the entire
 * file on every session issue and every failed-login counter bump;
 * `saveAccounts` upserts inside one transaction. The all-or-nothing property
 * the callers rely on is the same, without the rewrite-the-world cost being
 * load-bearing.
 */
function readAccounts() {
    const context = repo.dataStoreContext();
    const accounts = repo.customers.loadAccounts(context.tenantId);
    return Array.isArray(accounts) ? accounts : [];
}

function writeAccounts(accounts) {
    const context = repo.dataStoreContext();
    return repo.customers.saveAccounts(context.tenantId, accounts);
}

/** Phone masked for logs — telemetry should never carry a full number. */
function maskPhone(phone) {
    const s = String(phone || '');
    return s.length >= 4 ? `******${s.slice(-4)}` : '******';
}

export function isValidPhone(phone) {
    return typeof phone === 'string' && /^\d{10}$/.test(phone);
}

export function findAccount(phone) {
    if (!isValidPhone(phone)) return null;
    return readAccounts().find(a => a.phone === phone) || null;
}

export function accountExists(phone) {
    return findAccount(phone) !== null;
}

/**
 * The public projection of an account — everything the portal needs and
 * nothing a password/reset/session field would leak.
 */
export function publicAccountView(account) {
    if (!account) return null;
    return {
        phone: account.phone,
        name: account.name || '',
        email: account.email || '',
        mustChangePassword: !!account.mustChangePassword,
        notifyEmail: account.notifyEmail !== false,
        notifyPush: !!account.notifyPush,
        createdAt: account.createdAt || 0
    };
}

/* ==========================================================================
   Password hashing (scrypt, built-in crypto — no new dependency)
   ========================================================================== */

export function validatePasswordStrength(password) {
    if (typeof password !== 'string') return 'A password is required.';
    if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }
    return null;
}

/**
 * Returns `{ salt, passwordHash }`. The hash is self-describing
 * (`scrypt$N$r$p$<hex>`) so the work factors can be raised later without
 * invalidating every existing password.
 */
export function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P
    });
    return {
        salt,
        passwordHash: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${derived.toString('hex')}`
    };
}

/**
 * Constant-time password check against a stored account record. Reads the
 * work factors back out of the stored hash rather than assuming today's
 * constants, so old records keep verifying after a parameter bump.
 */
export function verifyPassword(password, account) {
    try {
        if (!account || typeof password !== 'string' || !account.passwordHash || !account.salt) return false;
        const parts = String(account.passwordHash).split('$');
        if (parts.length !== 5 || parts[0] !== 'scrypt') return false;

        const N = parseInt(parts[1], 10);
        const r = parseInt(parts[2], 10);
        const p = parseInt(parts[3], 10);
        const expected = Buffer.from(parts[4], 'hex');
        if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) return false;

        const derived = crypto.scryptSync(password, account.salt, expected.length, { N, r, p });
        return crypto.timingSafeEqual(derived, expected);
    } catch (err) {
        logError('Customer password verification failed: ' + err.message, err.stack);
        return false;
    }
}

/** Cryptographically random, human-typable temporary password (counter handover). */
export function generateTemporaryPassword() {
    // No 0/O/1/l/I — these get misread off a printed slip at the counter.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

/* ==========================================================================
   Sessions (persisted as SHA-256 hashes, indexed in memory)
   ========================================================================== */

const sessionIndex = new Map(); // tokenHash -> { phone, createdAt }
let sessionIndexLoaded = false;

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isSessionExpired(session) {
    return !session || (Date.now() - (session.createdAt || 0)) > SESSION_TTL_MS;
}

/**
 * Rebuilds the in-memory token index from disk. Called lazily on the first
 * session lookup after boot so a restart doesn't sign every customer out.
 */
function ensureSessionIndex() {
    if (sessionIndexLoaded) return;
    sessionIndexLoaded = true;
    try {
        readAccounts().forEach(account => {
            (account.sessions || []).forEach(session => {
                if (!isSessionExpired(session)) {
                    sessionIndex.set(session.tokenHash, { phone: account.phone, createdAt: session.createdAt });
                }
            });
        });
    } catch (err) {
        logError('Failed to rebuild customer session index: ' + err.message, err.stack);
    }
}

/**
 * Issues a session token for an already-authenticated account. Returns the
 * raw token — only its hash is ever written to disk.
 */
export function createCustomerSession(phone) {
    ensureSessionIndex();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const createdAt = Date.now();

    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);
    if (!account) return null;

    const live = (account.sessions || []).filter(s => !isSessionExpired(s));
    live.push({ tokenHash, createdAt });
    // Drop the oldest beyond the cap, and forget them in the index too.
    const kept = live.slice(-MAX_SESSIONS_PER_ACCOUNT);
    live.filter(s => !kept.includes(s)).forEach(s => sessionIndex.delete(s.tokenHash));
    account.sessions = kept;

    if (!writeAccounts(accounts)) {
        logError(`Failed to persist customer session for ${maskPhone(phone)} — login rejected rather than issuing a token the next restart would forget.`);
        return null;
    }

    sessionIndex.set(tokenHash, { phone, createdAt });
    return token;
}

/** Logout. Best-effort: an unknown/expired token is simply a no-op. */
export function destroyCustomerSession(token) {
    ensureSessionIndex();
    if (!token) return;
    const tokenHash = hashToken(token);
    const entry = sessionIndex.get(tokenHash);
    sessionIndex.delete(tokenHash);
    if (!entry) return;

    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === entry.phone);
    if (!account) return;
    account.sessions = (account.sessions || []).filter(s => s.tokenHash !== tokenHash);
    writeAccounts(accounts);
}

/** Invalidates every session for one account (password change/reset, admin reissue). */
export function destroyAllCustomerSessions(phone) {
    ensureSessionIndex();
    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);
    if (!account) return;
    (account.sessions || []).forEach(s => sessionIndex.delete(s.tokenHash));
    account.sessions = [];
    writeAccounts(accounts);
}

/** Resolves a raw bearer token to its owning phone, or null. */
export function resolveCustomerSession(token) {
    ensureSessionIndex();
    if (!token) return null;
    const entry = sessionIndex.get(hashToken(token));
    if (!entry) return null;
    if (isSessionExpired(entry)) {
        destroyCustomerSession(token);
        return null;
    }
    return entry.phone;
}

/* ==========================================================================
   Account lifecycle
   ========================================================================== */

/**
 * Creates a new customer login. `mustChangePassword` is set when the store
 * issued the password at the counter, so the portal forces a change before
 * showing any data.
 * @returns {{success: boolean, error?: string, account?: object}}
 */
export function createCustomerAccount({ phone, password, name = '', email = '', mustChangePassword = false }) {
    if (!isValidPhone(phone)) {
        return { success: false, error: 'A valid 10-digit mobile number is required.' };
    }
    const pwError = validatePasswordStrength(password);
    if (pwError) return { success: false, error: pwError };

    const accounts = readAccounts();
    if (accounts.some(a => a.phone === phone)) {
        return { success: false, error: 'An account already exists for this mobile number.' };
    }

    const { salt, passwordHash } = hashPassword(password);
    const account = {
        phone,
        name: String(name || '').slice(0, 200),
        email: String(email || '').slice(0, 200).toLowerCase(),
        passwordHash,
        salt,
        mustChangePassword: !!mustChangePassword,
        notifyEmail: true,
        notifyPush: false,
        resetTokenHash: null,
        resetExpires: 0,
        resetAttempts: 0,
        failedAttempts: 0,
        lockedUntil: 0,
        sessions: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    accounts.push(account);
    if (!writeAccounts(accounts)) {
        return { success: false, error: 'Could not save the new account. Please retry.' };
    }
    logTelemetry('CUSTOMER_ACCOUNT_CREATED', 0, `Phone: ${maskPhone(phone)}`);
    return { success: true, account };
}

/**
 * Replaces an account's password, clears any pending reset token, and signs
 * every existing device out — a password change must not leave a previously
 * stolen session alive.
 */
export function setCustomerPassword(phone, newPassword, { mustChangePassword = false } = {}) {
    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return { success: false, error: pwError };

    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);
    if (!account) return { success: false, error: 'No account found for this mobile number.' };

    const { salt, passwordHash } = hashPassword(newPassword);
    account.salt = salt;
    account.passwordHash = passwordHash;
    account.mustChangePassword = !!mustChangePassword;
    account.resetTokenHash = null;
    account.resetExpires = 0;
    account.resetAttempts = 0;
    account.failedAttempts = 0;
    account.lockedUntil = 0;
    (account.sessions || []).forEach(s => sessionIndex.delete(s.tokenHash));
    account.sessions = [];
    account.updatedAt = Date.now();

    if (!writeAccounts(accounts)) {
        return { success: false, error: 'Could not save the new password. Please retry.' };
    }
    logTelemetry('CUSTOMER_PASSWORD_CHANGED', 0, `Phone: ${maskPhone(phone)}`);
    return { success: true };
}

/** Updates the profile fields a customer is allowed to edit themselves. */
export function updateCustomerProfile(phone, { name, email, notifyEmail, notifyPush }) {
    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);
    if (!account) return { success: false, error: 'No account found for this mobile number.' };

    if (name !== undefined) account.name = String(name || '').slice(0, 200);
    if (email !== undefined) account.email = String(email || '').slice(0, 200).toLowerCase();
    if (notifyEmail !== undefined) account.notifyEmail = !!notifyEmail;
    if (notifyPush !== undefined) account.notifyPush = !!notifyPush;
    account.updatedAt = Date.now();

    if (!writeAccounts(accounts)) {
        return { success: false, error: 'Could not save your profile. Please retry.' };
    }
    return { success: true, account };
}

/* ==========================================================================
   Login, lockout, and password reset
   ========================================================================== */

function getIpLockoutRemaining(ip) {
    const entry = ipFailures.get(ip);
    if (!entry || !entry.lockedUntil) return 0;
    const remaining = entry.lockedUntil - Date.now();
    return remaining > 0 ? remaining : 0;
}

function recordIpFailure(ip) {
    const entry = ipFailures.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= IP_MAX_FAILED) {
        entry.lockedUntil = Date.now() + IP_LOCKOUT_MS;
        entry.count = 0;
    }
    ipFailures.set(ip, entry);
}

function clearIpFailures(ip) {
    ipFailures.delete(ip);
}

/**
 * Express middleware for the customer login route: rejects with 429 while the
 * caller's IP is in credential-stuffing cooldown.
 */
export function customerLoginRateLimiter(req, res, next) {
    const ip = req.ip || 'unknown';
    const remaining = getIpLockoutRemaining(ip);
    if (remaining > 0) {
        return res.status(429).json({
            error: 'TOO_MANY_ATTEMPTS',
            message: `Too many failed sign-in attempts from this device. Try again in ${Math.ceil(remaining / 60000)} minute(s).`
        });
    }
    next();
}

/**
 * Authenticates a phone + password pair.
 * @returns {{success: boolean, error?: string, code?: string, token?: string, account?: object}}
 */
export function loginCustomer(phone, password, ip = 'unknown') {
    if (!isValidPhone(phone)) {
        return { success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid mobile number or password.' };
    }

    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);

    // Deliberately identical response whether the account exists or the
    // password is wrong — otherwise this endpoint enumerates which mobile
    // numbers are customers of the store.
    if (!account) {
        recordIpFailure(ip);
        logTelemetry('CUSTOMER_LOGIN_FAILED', 0, `Phone: ${maskPhone(phone)}, reason: no-account`);
        return { success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid mobile number or password.' };
    }

    const lockRemaining = (account.lockedUntil || 0) - Date.now();
    if (lockRemaining > 0) {
        return {
            success: false,
            code: 'ACCOUNT_LOCKED',
            error: `Too many failed attempts. This account is locked for ${Math.ceil(lockRemaining / 1000)}s.`
        };
    }

    if (!verifyPassword(password, account)) {
        account.failedAttempts = (account.failedAttempts || 0) + 1;
        if (account.failedAttempts >= MAX_FAILED_ATTEMPTS) {
            const extra = account.failedAttempts - MAX_FAILED_ATTEMPTS;
            account.lockedUntil = Date.now() + Math.min(BASE_LOCKOUT_MS * Math.pow(2, extra), MAX_LOCKOUT_MS);
        }
        account.updatedAt = Date.now();
        writeAccounts(accounts);
        recordIpFailure(ip);
        logTelemetry('CUSTOMER_LOGIN_FAILED', 0, `Phone: ${maskPhone(phone)}, attempts: ${account.failedAttempts}`);
        return { success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid mobile number or password.' };
    }

    if (account.failedAttempts || account.lockedUntil) {
        account.failedAttempts = 0;
        account.lockedUntil = 0;
        account.updatedAt = Date.now();
        writeAccounts(accounts);
    }
    clearIpFailures(ip);

    const token = createCustomerSession(phone);
    if (!token) {
        return { success: false, code: 'SESSION_FAILED', error: 'Could not start a session. Please retry.' };
    }
    logTelemetry('CUSTOMER_LOGIN_SUCCESS', 0, `Phone: ${maskPhone(phone)}`);
    return { success: true, token, account: findAccount(phone) };
}

/**
 * Issues a single-use password reset code. Only its SHA-256 is stored, so a
 * leaked customer_auth.json cannot be used to complete a reset.
 *
 * Deliberately a short typable code rather than a link with a long token in
 * the query string: building a reset URL server-side means trusting some base
 * URL, and the only one available per-request is the Host header — which the
 * caller controls, so a forged Host would mail the real customer a valid
 * token pointing at an attacker's site. A code the customer types into the
 * portal they already have open removes that whole class of problem.
 * @returns {{code: string, expiresAt: number}|null} null when no such account
 */
export function issueResetToken(phone) {
    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);
    if (!account) return null;

    const code = generateResetCode();
    account.resetTokenHash = hashToken(code);
    account.resetExpires = Date.now() + RESET_TOKEN_TTL_MS;
    account.resetAttempts = 0;
    account.updatedAt = Date.now();
    if (!writeAccounts(accounts)) return null;

    return { code, expiresAt: account.resetExpires };
}

/** 10 chars from the unambiguous alphabet ≈ 2.5e17 combinations. */
function generateResetCode() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

/**
 * Completes a reset. The code is consumed on success, on expiry, and after
 * MAX_FAILED_ATTEMPTS wrong guesses — a short code is only safe because it
 * cannot be brute-forced within its 30-minute window.
 */
export function consumeResetToken(phone, code, newPassword) {
    const accounts = readAccounts();
    const account = accounts.find(a => a.phone === phone);
    if (!account || !account.resetTokenHash) {
        return { success: false, error: 'This reset code is invalid or has already been used.' };
    }
    if (Date.now() > (account.resetExpires || 0)) {
        account.resetTokenHash = null;
        account.resetExpires = 0;
        writeAccounts(accounts);
        return { success: false, error: 'This reset code has expired. Please request a new one.' };
    }

    const provided = Buffer.from(hashToken(String(code || '').trim().toUpperCase()), 'hex');
    const expected = Buffer.from(account.resetTokenHash, 'hex');
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
        account.resetAttempts = (account.resetAttempts || 0) + 1;
        if (account.resetAttempts >= MAX_FAILED_ATTEMPTS) {
            account.resetTokenHash = null;
            account.resetExpires = 0;
        }
        account.updatedAt = Date.now();
        writeAccounts(accounts);
        return { success: false, error: 'This reset code is invalid or has already been used.' };
    }

    return setCustomerPassword(phone, newPassword);
}

/* ==========================================================================
   Middleware
   ========================================================================== */

function bearerToken(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Express middleware: rejects unless a live customer session is presented,
 * and pins `req.customerPhone` from the *session* — route handlers must read
 * the phone from here and never from the body or query string.
 */
export function requireCustomerSession(req, res, next) {
    const phone = resolveCustomerSession(bearerToken(req));
    if (!phone) {
        logTelemetry('CUSTOMER_SESSION_REJECTED', 0, `Path: ${req.path}`);
        return res.status(401).json({
            error: 'CUSTOMER_SESSION_REQUIRED',
            message: 'Please sign in to continue.'
        });
    }
    req.customerPhone = phone;
    req.customerAccount = findAccount(phone);
    next();
}

/** Same, but additionally blocks a counter-issued temporary password from doing anything but changing itself. */
export function requireEstablishedCustomer(req, res, next) {
    requireCustomerSession(req, res, () => {
        if (req.customerAccount && req.customerAccount.mustChangePassword) {
            return res.status(403).json({
                error: 'PASSWORD_CHANGE_REQUIRED',
                message: 'Please set your own password before continuing.'
            });
        }
        next();
    });
}

export const CUSTOMER_PASSWORD_MIN_LENGTH = MIN_PASSWORD_LENGTH;
