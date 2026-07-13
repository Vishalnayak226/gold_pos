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
