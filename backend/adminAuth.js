/**
 * ==========================================================================
 * Admin Session Authentication
 * Real server-side session tokens for the admin/cashier terminal, replacing
 * the old client-only PIN check. Sessions are in-memory (cleared on server
 * restart) — acceptable for a single-process local/tenant deployment.
 * ==========================================================================
 */

import crypto from 'crypto';
import path from 'path';
import { readJSON, DATA_DIR, logTelemetry } from './db.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map(); // token -> createdAt timestamp

// Brute-force lockout: a 4-digit PIN is only a ~10,000-value keyspace, which
// is trivially exhaustible in under a minute against an unthrottled login
// endpoint. Track failed attempts per source IP with an escalating cooldown.
const MAX_FAILED_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30 * 1000; // 30s, doubles per additional failure past the threshold
const MAX_LOCKOUT_MS = 15 * 60 * 1000; // capped at 15 minutes
const failedAttempts = new Map(); // ip -> { count, lockedUntil }

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
 * Verifies a submitted PIN against the tenant-configured admin PIN.
 */
export function verifyAdminPin(pin) {
    const settingsFile = path.join(DATA_DIR, 'settings.json');
    const settings = readJSON(settingsFile, {});
    const configuredPin = settings.adminPin || '1234';
    return typeof pin === 'string' && pin === configuredPin;
}

/**
 * Express middleware guarding POST /api/admin/login: rejects with 429 while
 * the caller's key (IP) is in cooldown, and records/clears failures around
 * the actual verifyAdminPin() call performed by the route handler.
 */
export function loginRateLimiter(req, res, next) {
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
    if (success) clearFailedLogins(key);
    else recordFailedLogin(key);
}

/**
 * Issues a new random session token for an authenticated admin.
 */
export function createAdminSession() {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now());
    return token;
}

/**
 * Invalidates a session token (logout).
 */
export function destroyAdminSession(token) {
    if (token) sessions.delete(token);
}

/**
 * Checks whether a token maps to a live, unexpired session.
 */
export function isValidAdminSession(token) {
    if (!token || !sessions.has(token)) return false;
    const createdAt = sessions.get(token);
    if (Date.now() - createdAt > SESSION_TTL_MS) {
        sessions.delete(token);
        return false;
    }
    return true;
}

/**
 * Express middleware: rejects the request unless a valid
 * "Authorization: Bearer <token>" admin session header is present.
 */
export function requireAdminSession(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!isValidAdminSession(token)) {
        logTelemetry('ADMIN_SESSION_REJECTED', 0, `Path: ${req.path}`);
        return res.status(401).json({ error: 'ADMIN_SESSION_REQUIRED', message: 'Admin authentication required.' });
    }
    next();
}
