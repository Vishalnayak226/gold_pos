import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readJSON, writeJSON, writeJSONTransaction, logError, logTelemetry, newId, DATA_DIR } from './db.js';
import { redactSettings, OPERATOR_ROLES } from './defaultSettings.js';
import { getActiveGoldRates, syncGoldPrice, initPriceScheduler } from './priceEngine.js';
import { encryptLevel2Payload } from './cryptoHelper.js';
import https from 'https';
import crypto from 'crypto';
import { checkLicenseGate, syncLicenseStatus, isLicenseValid } from './licenseChecker.js';
import { initBackupScheduler, createBackup } from './backupEngine.js';
import { assertProductionReady } from './productionGuard.js';
import { checkForUpdates, applyPendingUpdate, initUpdateScheduler } from './updateEngine.js';
import {
    requireAdminSession, requireApprover, verifyAdminPin, createAdminSession, destroyAdminSession,
    loginRateLimiter, recordLoginResult, roleCanApprove, listOperators, SYSTEM_ACTOR, OWNER_ACTOR,
    ensureAuthSalt, hashPin, migrateStoredPins,
    generateTotpSecret, verifyTotp, totpEnrolmentUri, generateRecoveryCodes, consumeRecoveryCode,
    listAdminSessions, revokeAdminSessionByHandle, revokeSessionsForActor, revokeSessionsForRosterChange
} from './adminAuth.js';
import {
    requireCustomerSession, requireEstablishedCustomer, customerLoginRateLimiter,
    loginCustomer, destroyCustomerSession, destroyAllCustomerSessions,
    createCustomerAccount, setCustomerPassword, updateCustomerProfile,
    issueResetToken, consumeResetToken, findAccount, accountExists,
    publicAccountView, verifyPassword, validatePasswordStrength,
    generateTemporaryPassword, isValidPhone, CUSTOMER_PASSWORD_MIN_LENGTH
} from './customerAuth.js';
import { initReportScheduler, sendSummaryReport, sendMailIfConfigured } from './emailReporter.js';
import { logBlackBoxEvent, exportBlackBoxEnvelope } from './blackBoxLogger.js';
import { loadExtensions, fireHook } from './extensions/index.js';
// Shared invoice arithmetic — the exact module the Billing Desk renders its
// preview from, so the persisted ledger and the cashier's screen can never
// drift apart. Lives under frontend/ because release_pipeline.js and
// updateEngine.js ship and replace backend/ and frontend/ as a pair.
import {
    computeInvoiceTotals, normalizeTaxMode, round2, round3, toPaise, fromPaise, computeMetalValue,
    computeReturnRefund, saleLines,
    ADVANCE_STATUS, normalizeAdvanceStatus, summarizeAdvanceLedger, summarizeAdvanceLiability
} from '../frontend/js/lib/billingMath.js';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 5000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MOCK_RAZORPAY_KEY_ID = 'rzp_test_xxxxxx';
const MOCK_RAZORPAY_SECRET = 'rzp_test_xxxxxx_secret';
const MOCK_PAYMENTS_ENABLED = !IS_PRODUCTION;

// Sanity ceiling for a single advance deposit/redemption amount (10 crore
// INR) — not a business rule, just a guard against fat-finger/malicious
// extreme values (e.g. 1e308) that would otherwise sit permanently in the
// ledger and distort balance arithmetic.
const MAX_SANE_AMOUNT = 100000000;

// Same idea for a single invoice's gold weight. 100kg of gold on one counter
// slip is not a business rule being enforced, it is a typo or a probe being
// rejected before it reaches the money math.
const MAX_SANE_WEIGHT_GRAMS = 100000;

// Purity as the invoice states it → the key that purity's rate lives under in
// getActiveGoldRates(). Declared once because /api/sales reads both the rate
// and its provenance ('auto' or a manual Settings override) through it.
const PURITY_RATE_KEY = { '24K': 'price24K', '22K': 'price22K', '18K': 'price18K' };

// Trust the loopback reverse proxy (Nginx, see deploy/nginx.conf.template) so
// req.ip resolves the real client IP from X-Forwarded-For instead of always
// reading 127.0.0.1 — required for the admin-login rate limiter (adminAuth.js)
// to key lockouts per real caller instead of globally locking every user.
app.set('trust proxy', 'loopback');

// Browser hardening. This frontend is normally same-origin; deployments that
// intentionally split it onto another origin must list that exact origin (or
// origins, comma-separated) in CORS_ORIGINS.
const allowedCorsOrigins = new Set(
    (process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
);
app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedCorsOrigins.has(origin));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600
}));
app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
            // Inline handlers remain in the legacy HTML. Keep them working
            // while still enforcing the rest of the CSP boundary.
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https://*.razorpay.com'],
            frameSrc: ["'self'", 'https://*.razorpay.com'],
            // Safari upgrades localhost subresources too, which breaks the
            // HTTP-only local development server.
            upgradeInsecureRequests: IS_PRODUCTION ? [] : null
        }
    }
}));
// The Razorpay webhook signature is an HMAC over the EXACT bytes the gateway
// sent. JSON.parse + re-serialise does not round-trip those bytes (key order,
// number formatting, unicode escapes all shift), so a parsed body can never be
// verified. This must therefore sit BEFORE express.json(): body-parser marks
// the request as already-read, and the JSON parser below then skips it, leaving
// req.body as the raw Buffer the signature check needs.
app.use('/api/payment/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '5mb' }));

// Track simple API response time telemetry
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        logTelemetry(`${req.method}_${req.originalUrl}`, duration, `Status: ${res.statusCode}`);
        // Black-box flight recorder: same request shape, technical fields only
        // (no query string, no body) so error frequency, slow endpoints, and
        // memory trends can be aggregated offline without ever seeing PII.
        logBlackBoxEvent('HTTP_REQUEST', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: duration,
            heapUsedMB: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
        });
    });
    next();
});

/**
 * GET /api/health
 * Public, unauthenticated liveness check — used by CI post-deploy smoke
 * tests and uptime monitoring to confirm this specific environment's
 * process is up and serving the expected commit, independent of license
 * state (exempted in checkLicenseGate).
 */
app.get('/api/health', (req, res) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
    res.json({
        status: 'ok',
        version: pkg.version,
        env: process.env.ENV_NAME || process.env.NODE_ENV || 'unknown'
    });
});

// Protect all POS cashier routes with licensing gate
app.use(checkLicenseGate);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../frontend')));

/* ==========================================================================
   API Routes: Admin Session Authentication
   ========================================================================== */

/**
 * POST /api/admin/login
 * Verifies the admin PIN server-side and issues a bearer session token.
 * Replaces the old client-only PIN check.
 */
app.post('/api/admin/login', loginRateLimiter, (req, res) => {
    const { pin, totpCode, recoveryCode } = req.body || {};
    // The PIN both authenticates AND names the person: each operator
    // configured in Settings has their own, and the master PIN resolves to the
    // store owner. See resolveActor() in adminAuth.js.
    const resolved = verifyAdminPin(pin);
    if (!resolved) {
        recordLoginResult(req, false);
        logTelemetry('ADMIN_LOGIN_FAILED', 0);
        return res.status(401).json({ error: 'Incorrect PIN' });
    }
    const { actor, mfa } = resolved;

    /* SECOND FACTOR. Only for an operator who has enrolled one — enrolment is
       the switch, so turning it on for one manager does not disturb anyone else.

       A wrong code counts as a FAILED LOGIN against the rate limiter. Otherwise a
       correct PIN would buy unlimited guesses at a 6-digit code, and the second
       factor would be weaker than the first. */
    let mfaUsed = false;
    if (mfa.enabled) {
        const submittedTotp = String(totpCode || '').trim();
        const submittedRecovery = String(recoveryCode || '').trim();

        if (!submittedTotp && !submittedRecovery) {
            // Deliberately NOT counted as a failed attempt: the PIN was right and
            // the browser simply has not been asked for a code yet.
            return res.status(401).json({
                error: 'MFA_CODE_REQUIRED',
                message: `${actor.name} has two-factor authentication enabled. Enter the 6-digit code from your authenticator app.`
            });
        }

        if (submittedTotp && verifyTotp(submittedTotp, mfa.secret)) {
            mfaUsed = true;
        } else if (submittedRecovery) {
            const settingsFile = path.join(DATA_DIR, 'settings.json');
            const settings = readJSON(settingsFile, {});
            const consumed = consumeRecoveryCode(submittedRecovery, settings.authSalt, mfa.recoveryCodes);
            if (consumed.ok) {
                // Single use: the surviving codes are written back before the
                // session is issued, so a replay of the same code cannot work
                // even if two attempts arrive together.
                const row = (settings.operators || []).find(op => op && op.id === actor.id);
                if (row) {
                    row.recoveryCodes = consumed.remainingHashes;
                    if (!writeJSON(settingsFile, settings)) {
                        logError(`Could not record use of a recovery code for ${actor.name}; refusing the login rather than allowing a reusable code.`);
                        return res.status(500).json({ error: 'Could not complete sign-in. Please retry.' });
                    }
                }
                mfaUsed = true;
                logTelemetry('ADMIN_LOGIN_RECOVERY_CODE', 0,
                    `${actor.name} used a recovery code; ${consumed.remainingHashes.length} left`);
            }
        }

        if (!mfaUsed) {
            recordLoginResult(req, false);
            logTelemetry('ADMIN_LOGIN_MFA_FAILED', 0, `${actor.name} (${actor.role})`);
            return res.status(401).json({
                error: 'MFA_CODE_INVALID',
                message: 'That code is not valid. Check your authenticator app, or use a recovery code.'
            });
        }
    }

    recordLoginResult(req, true);
    const token = createAdminSession(actor, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        mfaUsed
    });
    logTelemetry('ADMIN_LOGIN_SUCCESS', 0, `${actor.name} (${actor.role})${mfaUsed ? ' +MFA' : ''}`);
    // The desk shows who is signed in and hides controls their role cannot
    // use, so the identity goes back with the token rather than the browser
    // having to ask a second time.
    res.json({
        success: true,
        token,
        actor,
        canApprove: roleCanApprove(actor.role),
        mfaUsed
    });
});

/**
 * GET /api/admin/me
 * Who the bearer token belongs to. The Billing Desk reads this on reload so a
 * restored session still knows whose name goes on the next invoice.
 */
app.get('/api/admin/me', requireAdminSession, (req, res) => {
    const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
    res.json({
        actor: req.actor,
        canApprove: roleCanApprove(req.actor.role),
        mfaUsed: req.adminSession.mfaUsed === true,
        // So the desk can explain a refusal before the cashier hits it.
        requireMfaForApprovers: settings.requireMfaForApprovers === true,
        refundApprovalThreshold: round2(settings.refundApprovalThreshold || 0)
    });
});

/* ==========================================================================
   API Routes: second factor and live sessions

   Both are about the credential rather than the configuration, which is why
   they are their own routes and not fields on POST /api/settings:

   - Enrolment must PROVE the operator holds the secret before it is trusted,
     which a settings form cannot do.
   - A live session is not persisted configuration at all. It is in-memory state,
     and writing it into settings.json to edit it would be nonsense.
   ========================================================================== */

/**
 * POST /api/admin/mfa/begin
 * Issues a fresh TOTP secret and the QR payload to scan. Nothing is enabled yet
 * — the secret is returned and NOT stored, so an abandoned enrolment leaves no
 * half-configured operator behind.
 */
app.post('/api/admin/mfa/begin', requireAdminSession, async (req, res) => {
    try {
        const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
        const targetId = String((req.body || {}).operatorId || req.actor.id);

        // Anyone may enrol THEMSELVES. Enrolling somebody else is an owner action:
        // it would otherwise let a manager stand up a second factor on a
        // colleague's account and hold the secret.
        if (targetId !== req.actor.id && req.actor.role !== 'owner') {
            return res.status(403).json({
                error: 'OWNER_REQUIRED',
                message: 'Only the owner can set up two-factor authentication for someone else.'
            });
        }
        const operator = (settings.operators || []).find(op => op && op.id === targetId);
        if (!operator) {
            return res.status(400).json({
                error: 'NOT_A_NAMED_OPERATOR',
                message: 'Two-factor authentication belongs to a named person. The shared master PIN cannot carry one — add yourself to Settings → Staff & Roles first.'
            });
        }

        const secret = generateTotpSecret();
        const uri = totpEnrolmentUri(secret, operator.name, settings.companyName);
        res.json({
            success: true,
            operatorId: targetId,
            secret,
            uri,
            // Rendered server-side with the qrcode package already in the budget,
            // so the browser needs no library and the secret is not put into an
            // <img src> pointing at a third party.
            qrDataUri: await QRCode.toDataURL(uri, { margin: 1, width: 220 })
        });
    } catch (err) {
        logError('MFA enrolment could not be started: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not start two-factor setup.' });
    }
});

/**
 * POST /api/admin/mfa/enrol
 * Confirms enrolment by requiring a live code from the secret just issued, then
 * stores it and hands back ten single-use recovery codes.
 *
 * The code requirement is the point: it proves the authenticator app is actually
 * configured. Storing a secret without it is how a store locks itself out.
 */
app.post('/api/admin/mfa/enrol', requireAdminSession, (req, res) => {
    try {
        const { operatorId, secret, code } = req.body || {};
        const targetId = String(operatorId || req.actor.id);
        if (targetId !== req.actor.id && req.actor.role !== 'owner') {
            return res.status(403).json({ error: 'OWNER_REQUIRED', message: 'Only the owner can enrol someone else.' });
        }
        if (!secret || !verifyTotp(code, String(secret))) {
            return res.status(400).json({
                error: 'MFA_CODE_INVALID',
                message: 'That code does not match. Check the app has finished adding the account, then enter the current 6-digit code.'
            });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        const authSalt = ensureAuthSalt(settings);
        const operator = (settings.operators || []).find(op => op && op.id === targetId);
        if (!operator) {
            return res.status(400).json({ error: 'NOT_A_NAMED_OPERATOR', message: 'That operator no longer exists.' });
        }

        const recovery = generateRecoveryCodes(authSalt);
        operator.totpSecret = String(secret);
        operator.mfaEnabled = true;
        operator.recoveryCodes = recovery.hashes;

        if (!writeJSON(settingsFile, settings)) {
            return res.status(500).json({ error: 'Could not save the two-factor setup. Please retry.' });
        }

        logTelemetry('ADMIN_MFA_ENROLLED', 0, `${operator.name} (${operator.role})`);
        res.json({
            success: true,
            operatorId: targetId,
            // The ONLY time these are ever readable. They are stored as hashes,
            // so this response cannot be reproduced later.
            recoveryCodes: recovery.plain
        });
    } catch (err) {
        logError('MFA enrolment failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not complete two-factor setup.' });
    }
});

/**
 * POST /api/admin/mfa/disable
 * Removes an operator's second factor.
 *
 * Requires the CURRENT PIN of whoever is asking, because otherwise an unattended
 * signed-in terminal is a one-click way to strip the very control that was meant
 * to protect it.
 */
app.post('/api/admin/mfa/disable', requireAdminSession, (req, res) => {
    try {
        const { operatorId, pin } = req.body || {};
        const targetId = String(operatorId || req.actor.id);
        if (targetId !== req.actor.id && req.actor.role !== 'owner') {
            return res.status(403).json({ error: 'OWNER_REQUIRED', message: 'Only the owner can turn off someone else\'s two-factor authentication.' });
        }

        const confirmed = verifyAdminPin(pin);
        if (!confirmed || confirmed.actor.id !== req.actor.id) {
            return res.status(401).json({
                error: 'PIN_REQUIRED',
                message: 'Enter your own PIN to confirm turning off two-factor authentication.'
            });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        const operator = (settings.operators || []).find(op => op && op.id === targetId);
        if (!operator) {
            return res.status(400).json({ error: 'NOT_A_NAMED_OPERATOR', message: 'That operator no longer exists.' });
        }

        operator.mfaEnabled = false;
        delete operator.totpSecret;
        delete operator.recoveryCodes;
        if (!writeJSON(settingsFile, settings)) {
            return res.status(500).json({ error: 'Could not save the change. Please retry.' });
        }

        // The sessions that passed the old factor no longer represent what this
        // store requires, so they end here.
        const ended = revokeSessionsForActor(targetId, { exceptToken: req.adminToken });
        logTelemetry('ADMIN_MFA_DISABLED', 0, `${operator.name}; ${ended} session(s) ended`);
        res.json({ success: true, sessionsRevoked: ended });
    } catch (err) {
        logError('Disabling MFA failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not turn off two-factor authentication.' });
    }
});

/**
 * GET /api/admin/sessions
 * Every live admin sign-in. Approver-gated — who is currently on the terminals is
 * exactly the sort of thing a cashier should not be able to enumerate.
 *
 * Tokens are never included; each row carries an opaque handle instead.
 */
app.get('/api/admin/sessions', requireAdminSession, requireApprover, (req, res) => {
    res.json({ results: listAdminSessions(), currentHandle: currentSessionHandle(req) });
});

/**
 * POST /api/admin/sessions/revoke
 * Ends one live session by its handle.
 */
app.post('/api/admin/sessions/revoke', requireAdminSession, requireApprover, (req, res) => {
    const handle = String((req.body || {}).handle || '').trim();
    if (!handle) return res.status(400).json({ error: 'A session handle is required.' });

    // Ending your own session from this screen would just be a confusing logout.
    if (handle === currentSessionHandle(req)) {
        return res.status(400).json({
            error: 'CANNOT_REVOKE_OWN_SESSION',
            message: 'That is this browser\'s own sign-in. Use Logout instead.'
        });
    }
    const ended = revokeAdminSessionByHandle(handle, { exceptToken: req.adminToken });
    if (!ended) return res.status(404).json({ error: 'That sign-in is no longer active.' });

    logTelemetry('ADMIN_SESSION_REVOKED', 0, `by ${req.actor.name} (${req.actor.role})`);
    res.json({ success: true });
});

/** The handle of the caller's own session, so a screen can mark it "this one". */
function currentSessionHandle(req) {
    return crypto.createHash('sha256').update(req.adminToken || '').digest('hex').slice(0, 16);
}

/**
 * POST /api/admin/logout
 * Invalidates the given session token.
 */
app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    destroyAdminSession(token);
    res.json({ success: true });
});

/* ==========================================================================
   API Routes: Customer Identity & Session Authentication

   Everything under /api/customer/ is scoped to the phone on the session —
   never a phone taken from the body or query string. Before this existed,
   typing any 10-digit number into customer.html opened that customer's whole
   ledger, which is the hole this closes. See backend/customerAuth.js.
   ========================================================================== */

/**
 * Whether the store already holds business records against this phone.
 * Self-service registration is refused for such numbers so that an outsider
 * cannot register a number they don't own and inherit an existing customer's
 * deposit history; those customers get their login issued at the counter
 * instead (POST /api/customer-accounts/issue-login).
 */
function phoneHasStoreHistory(phone) {
    const advances = readJSON(path.join(DATA_DIR, 'advances.json'), []);
    return advances.some(a => a.customerPhone === phone);
}

/**
 * POST /api/customer/register
 * Self-service signup, allowed only for a number with no existing store
 * history (see above). Returns a live session so the customer lands straight
 * in the portal.
 */
app.post('/api/customer/register', customerLoginRateLimiter, (req, res) => {
    try {
        const { phone, password, name, email } = req.body || {};
        if (!isValidPhone(phone)) {
            return res.status(400).json({ error: 'A valid 10-digit mobile number is required.' });
        }
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'Your name is required.' });
        }
        const pwError = validatePasswordStrength(password);
        if (pwError) return res.status(400).json({ error: pwError });

        if (accountExists(phone)) {
            return res.status(409).json({
                error: 'ACCOUNT_EXISTS',
                message: 'An account already exists for this mobile number. Please sign in, or use "Forgot password".'
            });
        }
        if (phoneHasStoreHistory(phone)) {
            return res.status(409).json({
                error: 'CLAIM_REQUIRES_STORE',
                message: 'This mobile number already has records with the store. For your security, please ask the store to set up your login at the counter.'
            });
        }

        const created = createCustomerAccount({ phone, password, name: String(name).trim(), email });
        if (!created.success) return res.status(400).json({ error: created.error });

        const login = loginCustomer(phone, password, req.ip);
        if (!login.success) return res.status(500).json({ error: login.error });

        res.json({ success: true, token: login.token, customer: publicAccountView(login.account) });
    } catch (err) {
        logError('Customer registration failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not create your account. Please retry.' });
    }
});

/**
 * POST /api/customer/login
 * Phone + password. Responses are deliberately identical for "no such
 * account" and "wrong password" so this cannot be used to discover which
 * mobile numbers are customers of the store.
 */
app.post('/api/customer/login', customerLoginRateLimiter, (req, res) => {
    try {
        const { phone, password } = req.body || {};
        const result = loginCustomer(phone, password, req.ip);
        if (!result.success) {
            const status = result.code === 'ACCOUNT_LOCKED' ? 429 : 401;
            return res.status(status).json({ error: result.code || 'INVALID_CREDENTIALS', message: result.error });
        }
        res.json({ success: true, token: result.token, customer: publicAccountView(result.account) });
    } catch (err) {
        logError('Customer login failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Sign-in failed. Please retry.' });
    }
});

/** POST /api/customer/logout — invalidates just this device's session. */
app.post('/api/customer/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    destroyCustomerSession(token);
    res.json({ success: true });
});

/** GET /api/customer/me — the signed-in customer's own profile. */
app.get('/api/customer/me', requireCustomerSession, (req, res) => {
    res.json({ customer: publicAccountView(req.customerAccount) });
});

/** PATCH /api/customer/me — name, email, and notification preferences. */
app.patch('/api/customer/me', requireEstablishedCustomer, (req, res) => {
    try {
        const { name, email, notifyEmail, notifyPush } = req.body || {};
        const result = updateCustomerProfile(req.customerPhone, { name, email, notifyEmail, notifyPush });
        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, customer: publicAccountView(result.account) });
    } catch (err) {
        logError('Customer profile update failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not save your profile. Please retry.' });
    }
});

/**
 * POST /api/customer/password/change
 * Requires the current password even though the session is already proven —
 * so a borrowed unlocked phone cannot be used to lock the real owner out.
 * Succeeding signs every device out, including this one.
 */
app.post('/api/customer/password/change', requireCustomerSession, (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!verifyPassword(currentPassword, req.customerAccount)) {
            return res.status(401).json({ error: 'Your current password is incorrect.' });
        }
        const result = setCustomerPassword(req.customerPhone, newPassword);
        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, message: 'Password updated. Please sign in again.' });
    } catch (err) {
        logError('Customer password change failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not change your password. Please retry.' });
    }
});

/**
 * POST /api/customer/password/forgot
 * Emails a short, single-use reset code to the address on the account. The
 * response is identical whether or not the account exists — the only failure
 * it will admit to is the store not having configured SMTP at all, which is
 * a store-level fact and leaks nothing about any customer.
 */
app.post('/api/customer/password/forgot', customerLoginRateLimiter, async (req, res) => {
    const GENERIC_OK = {
        success: true,
        message: 'If an account with that mobile number and a registered email exists, a reset code has been sent to it.'
    };
    try {
        const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
        if (!settings.smtp || !settings.smtp.host || !settings.smtp.user || !settings.smtp.pass) {
            return res.status(400).json({
                error: 'EMAIL_UNAVAILABLE',
                message: 'This store has not enabled password reset emails yet. Please contact the store to have your password reset at the counter.'
            });
        }

        const { phone } = req.body || {};
        if (!isValidPhone(phone)) return res.json(GENERIC_OK);

        const account = findAccount(phone);
        if (!account || !account.email) return res.json(GENERIC_OK);

        const issued = issueResetToken(phone);
        if (!issued) return res.json(GENERIC_OK);

        await sendMailIfConfigured({
            to: account.email,
            subject: `Password reset code — ${settings.companyName || 'Gold Savings Portal'}`,
            html: `
                <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto; color:#1e293b;">
                    <h2 style="border-bottom:2px solid #0f172a; padding-bottom:10px;">Password reset</h2>
                    <p style="font-size:14px;">Enter this code in the portal to set a new password:</p>
                    <p style="font-family:monospace; font-size:26px; letter-spacing:3px; font-weight:bold; background:#f1f5f9; padding:14px; text-align:center; border-radius:6px;">${issued.code}</p>
                    <p style="font-size:13px; color:#64748b;">This code expires in 30 minutes and can only be used once. If you did not request it, you can safely ignore this email — your password has not changed.</p>
                </div>
            `
        });

        res.json(GENERIC_OK);
    } catch (err) {
        logError('Customer password reset request failed: ' + err.message, err.stack);
        res.json(GENERIC_OK);
    }
});

/** POST /api/customer/password/reset — completes the reset with the emailed code. */
app.post('/api/customer/password/reset', customerLoginRateLimiter, (req, res) => {
    try {
        const { phone, code, newPassword } = req.body || {};
        if (!isValidPhone(phone)) {
            return res.status(400).json({ error: 'A valid 10-digit mobile number is required.' });
        }
        const result = consumeResetToken(phone, code, newPassword);
        if (!result.success) return res.status(400).json({ error: result.error });
        res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
    } catch (err) {
        logError('Customer password reset failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not reset your password. Please retry.' });
    }
});

/**
 * GET /api/customer/advances
 * The signed-in customer's own balance and ledger. The session-scoped
 * replacement for the portal's old GET /api/advances/lookup?phone= call.
 */
app.get('/api/customer/advances', requireEstablishedCustomer, (req, res) => {
    try {
        res.json(computeAdvanceLedger(req.customerPhone));
    } catch (err) {
        logError('Customer advance lookup failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to load your balance.' });
    }
});

/**
 * GET /api/customer/returns
 * The customer's own returns, newest first. Session-scoped: the phone comes
 * off the bearer token, never the query string, so this cannot be used to read
 * somebody else's refunds by typing their number.
 *
 * READ-ONLY BY DESIGN. There is no matching POST. Raising a return is a
 * counter decision (see the Returns section above) — this route exists so the
 * refund shows up on the customer's phone the moment the store files it, which
 * is the whole point of them having the portal.
 *
 * The fields returned are the customer's own copy of the credit note. Cashier
 * notes are deliberately excluded: they are internal remarks about the
 * condition of returned goods, not correspondence.
 */
app.get('/api/customer/returns', requireEstablishedCustomer, (req, res) => {
    try {
        const rows = readReturnRecords()
            .filter(r => r && r.customerPhone === req.customerPhone)
            .map(r => ({
                id: r.id,
                timestamp: r.timestamp,
                originalInvoiceId: r.originalInvoiceId,
                purity: r.purity,
                weightGrams: r.weightGrams,
                refundAmount: r.refundAmount,
                refundMode: r.refundMode,
                closesInvoice: !!r.closesInvoice
            }));
        res.json({ returns: rows });
    } catch (err) {
        logError('Customer returns lookup failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to load your returns.' });
    }
});

/**
 * POST /api/customer/advances
 * Manual-UPI deposit submitted from the portal. Phone and name come from the
 * account, never the body — which also removes the customer-supplied-name
 * route that produced the stored-XSS finding in 1.0.1.
 */
app.post('/api/customer/advances', requireEstablishedCustomer, (req, res) => {
    try {
        const { amount, referenceId } = req.body || {};
        if (!referenceId || !String(referenceId).trim()) {
            return res.status(400).json({ error: 'A transaction reference ID is required.' });
        }
        const result = recordAdvanceDeposit({
            customerPhone: req.customerPhone,
            customerName: (req.customerAccount && req.customerAccount.name) || 'Regular Customer',
            amount,
            paymentMethod: 'UPI',
            referenceId: String(referenceId).trim().slice(0, 100),
            // PENDING, not approved. Nothing here has been verified: the customer
            // has typed an amount and a reference they assert they sent. Crediting
            // that instantly made the portal a self-service way to award yourself
            // an arbitrary advance balance and redeem it against a real bill.
            status: ADVANCE_STATUS.PENDING
        });
        if (!result.success) {
            const status = result.code === 'DUPLICATE_REFERENCE' ? 409
                : result.error.startsWith('Failed to persist') ? 500 : 400;
            return res.status(status).json({ error: result.error, code: result.code });
        }
        res.json({
            success: true,
            id: result.deposit.id,
            deposit: result.deposit,
            status: result.deposit.status,
            message: 'Submitted for verification. Your balance updates once the store confirms the transfer.'
        });
    } catch (err) {
        logError('Customer advance deposit failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to submit your deposit.' });
    }
});

/* ==========================================================================
   API Routes: Customer Login Administration (store-side)

   Deliberately mounted at /api/customer-accounts rather than /api/admin/… —
   the license gate exempts everything under /api/admin so that activation
   still works on a locked system, and customer account management has no
   business staying open once a tenant's license lapses.
   ========================================================================== */

/**
 * GET /api/customer-accounts
 * Which customers have a portal login, and the state of each. Never returns
 * password hashes, session tokens, or reset codes.
 */
app.get('/api/customer-accounts', requireAdminSession, (req, res) => {
    try {
        const accounts = readJSON(path.join(DATA_DIR, 'customer_auth.json'), []);
        res.json(accounts.map(a => ({
            ...publicAccountView(a),
            activeSessions: (a.sessions || []).length,
            lockedUntil: a.lockedUntil || 0,
            updatedAt: a.updatedAt || 0
        })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
    } catch (err) {
        logError('Failed to list customer accounts: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to list customer logins' });
    }
});

/**
 * POST /api/customer-accounts/issue-login
 * Creates — or, with confirmDestructive, resets — a customer's portal login
 * at the counter, returning a one-time temporary password to hand over. This
 * is the only path by which a number that already has store history can get a
 * login, which is what stops an outsider claiming an existing customer's
 * ledger by self-registering their number.
 *
 * Resetting an existing account signs all of that customer's devices out, so
 * it is confirmation-gated the same way lowering the invoice sequence is.
 */
app.post('/api/customer-accounts/issue-login', requireAdminSession, (req, res) => {
    try {
        const { phone, name, email, confirmDestructive } = req.body || {};
        if (!isValidPhone(phone)) {
            return res.status(400).json({ error: 'A valid 10-digit mobile number is required.' });
        }

        const tempPassword = generateTemporaryPassword();
        const existing = findAccount(phone);

        if (existing) {
            if (!confirmDestructive) {
                return res.status(409).json({
                    error: 'CONFIRMATION_REQUIRED',
                    message: `${phone} already has a portal login. Reissuing sets a new temporary password and signs the customer out of every device. Resubmit with confirmDestructive: true after explicit user confirmation.`
                });
            }
            const reset = setCustomerPassword(phone, tempPassword, { mustChangePassword: true });
            if (!reset.success) return res.status(500).json({ error: reset.error });
            if (name !== undefined || email !== undefined) {
                updateCustomerProfile(phone, { name, email });
            }
            destroyAllCustomerSessions(phone);
            logTelemetry('CUSTOMER_LOGIN_REISSUED', 0, `Phone: ******${phone.slice(-4)}`);
            // hasEmail, not the address itself — the counter screen only needs
            // to know whether to tell this customer to add one, and echoing a
            // stored email back into the admin UI is data it does not need.
            // An account without one can never self-serve "Forgot password",
            // so the cashier is the last person able to head that off.
            return res.json({
                success: true, reissued: true, phone, tempPassword,
                hasEmail: !!(findAccount(phone) || {}).email
            });
        }

        const created = createCustomerAccount({
            phone,
            password: tempPassword,
            name: name || '',
            email: email || '',
            mustChangePassword: true
        });
        if (!created.success) return res.status(400).json({ error: created.error });
        res.json({
            success: true, reissued: false, phone, tempPassword,
            hasEmail: !!created.account.email
        });
    } catch (err) {
        logError('Issuing a customer login failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Could not issue a customer login. Please retry.' });
    }
});

/* ==========================================================================
   API Routes: Gold Price Engine
   ========================================================================== */

/**
 * GET /api/gold-price
 * Returns current rates for 24K, 22K, 18K. Automatically applies overrides if active.
 */
app.get('/api/gold-price', (req, res) => {
    try {
        const rates = getActiveGoldRates();
        res.json(rates);
    } catch (err) {
        logError('Error fetching gold price in API: ' + err.message, err.stack);
        res.status(500).json({ error: 'Internal pricing error' });
    }
});

/**
 * POST /api/gold-price/sync
 * Manually triggers a remote API price fetch/update
 */
app.post('/api/gold-price/sync', requireAdminSession, async (req, res) => {
    try {
        const updatedRates = await syncGoldPrice();
        res.json({ success: true, rates: updatedRates });
    } catch (err) {
        logError('Manual gold price sync API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Sync failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Settings Configuration
   ========================================================================== */

/**
 * Settings sent to the browser retain their public shape, but write-only
 * credentials are replaced with null plus a boolean configured indicator.
 * The indicators let the form distinguish "already configured" from "not
 * configured" without ever receiving the credential itself.
 */
function redactSettingsForBrowser(settings) {
    const safe = {
        ...settings,
        adminPin: null,
        adminPinHash: null,
        // The tenant PIN salt is credential material, not configuration.
        authSalt: null,
        adminPinConfigured: !!(settings.adminPinHash || settings.adminPin),
        razorpayKeySecret: null,
        razorpayKeySecretConfigured: !!settings.razorpayKeySecret,
        razorpayWebhookSecret: null,
        razorpayWebhookSecretConfigured: !!settings.razorpayWebhookSecret,
        smtp: {
            ...(settings.smtp || {}),
            pass: null,
            passConfigured: !!(settings.smtp && settings.smtp.pass)
        },
        /* An operator's credentials are write-only for exactly the same reason
           adminPin is — the roster renders from this response, and one cashier
           must never be handed another's PIN.

           Field by field, NOT `...op` with a few keys nulled: that spread is how
           a credential added later leaks by default. Anything not named here does
           not reach the browser. `recoveryCodesRemaining` is a count rather than
           the codes, because how many are left is what an owner needs to know and
           the codes themselves are single-use secrets. */
        operators: (Array.isArray(settings.operators) ? settings.operators : []).map(op => ({
            id: op.id,
            name: op.name,
            role: op.role,
            active: op.active !== false,
            pin: null,
            pinConfigured: !!(op && (op.pinHash || op.pin)),
            mfaEnabled: op.mfaEnabled === true,
            recoveryCodesRemaining: Array.isArray(op.recoveryCodes) ? op.recoveryCodes.length : 0
        }))
    };
    return safe;
}

/** Null or an absent key means "leave this write-only value unchanged". */
function preserveWriteOnlyValue(requested, current) {
    return requested === undefined || requested === null ? current : requested;
}

const OPERATOR_PIN_PATTERN = /^\d{4,8}$/;

/**
 * Validates an inbound operator roster and restores the PINs the browser was
 * never given, returning `{ok: true, operators}` or `{ok: false, error}`.
 *
 * MATCHED BY `id`, NOT BY POSITION. The Settings screen can add, remove and
 * reorder people in the same save that leaves everyone else's PIN masked, so
 * index 2 on the way in is not necessarily index 2 on disk — restoring
 * positionally would quietly move one cashier's PIN onto another cashier.
 *
 * PINS MUST BE UNIQUE, including against the legacy store `adminPin`. A PIN is
 * how this system decides who is at the counter (see resolveActor), so two
 * people sharing one does not merely weaken a credential, it makes the
 * attribution on every invoice they file a coin toss — which is the exact
 * problem the roster exists to remove.
 */
function mergeOperators(incoming, current, authSalt) {
    if (incoming === undefined) return { ok: true, operators: current.operators || [] };
    if (!Array.isArray(incoming)) {
        return { ok: false, error: 'Operators must be a list.' };
    }
    if (incoming.length > 50) {
        return { ok: false, error: 'A store may have at most 50 operators.' };
    }

    const storedById = new Map(
        (Array.isArray(current.operators) ? current.operators : [])
            .filter(op => op && op.id)
            .map(op => [op.id, op])
    );

    // The master PIN's hash, so an operator reusing it can be caught. Comparing
    // hashes works precisely because the tenant salt is shared — see the PIN
    // HASHING note in adminAuth.js.
    const masterHash = current.adminPinHash
        || (current.adminPin ? hashPin(current.adminPin, authSalt) : '');

    const operators = [];
    const seenHashes = new Map();
    const seenIds = new Set();

    for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') {
            return { ok: false, error: 'Each operator must be an object.' };
        }

        const name = String(raw.name || '').trim();
        if (!name) return { ok: false, error: 'Every operator needs a name.' };
        if (name.length > 60) return { ok: false, error: `Operator name "${name.slice(0, 20)}…" is too long (max 60 characters).` };

        const role = String(raw.role || '').trim().toLowerCase();
        if (!OPERATOR_ROLES.includes(role)) {
            return { ok: false, error: `"${name}" has an unknown role. Use one of: ${OPERATOR_ROLES.join(', ')}.` };
        }

        const id = String(raw.id || '').trim() || newId('OP');
        if (seenIds.has(id)) return { ok: false, error: 'Two operators cannot share an id.' };
        seenIds.add(id);

        const stored = storedById.get(id);

        /* Absent or null PIN means "keep what is on disk" — the same contract as
           every other write-only credential here. A supplied PIN is validated in
           the clear and then immediately hashed; the plaintext never leaves this
           function. A stored plaintext `pin` from an older build is hashed on the
           way through, so a save is also a migration. */
        let pinHash;
        if (raw.pin === undefined || raw.pin === null || String(raw.pin).trim() === '') {
            pinHash = (stored && stored.pinHash)
                || (stored && stored.pin ? hashPin(stored.pin, authSalt) : '');
            if (!pinHash) {
                return { ok: false, error: `"${name}" needs a PIN — an operator with no PIN cannot sign in.` };
            }
        } else {
            const pin = String(raw.pin).trim();
            if (!OPERATOR_PIN_PATTERN.test(pin)) {
                return { ok: false, error: `"${name}"'s PIN must be 4 to 8 digits.` };
            }
            pinHash = hashPin(pin, authSalt);
        }

        if (seenHashes.has(pinHash)) {
            return {
                ok: false,
                error: `"${name}" and "${seenHashes.get(pinHash)}" have the same PIN. Each operator needs their own, or the ledger cannot say which of them billed a sale.`
            };
        }
        if (masterHash && pinHash === masterHash) {
            return {
                ok: false,
                error: `"${name}"'s PIN is the same as the store's master PIN. Give them their own so their sales are filed under their name.`
            };
        }
        seenHashes.set(pinHash, name);

        /* Second-factor enrolment is NOT editable through this form. It is
           established by POST /api/admin/mfa/enrol (which proves the operator
           holds the secret by making them submit a live code) and cleared by
           POST /api/admin/mfa/disable. Carrying it across from disk here means a
           roster edit — renaming someone, changing a role — cannot silently drop
           the second factor, and a crafted settings payload cannot grant itself
           one. */
        operators.push({
            id,
            name,
            role,
            pinHash,
            active: raw.active !== false,
            mfaEnabled: !!(stored && stored.mfaEnabled),
            ...(stored && stored.totpSecret ? { totpSecret: stored.totpSecret } : {}),
            ...(stored && Array.isArray(stored.recoveryCodes) ? { recoveryCodes: stored.recoveryCodes } : {})
        });
    }

    return { ok: true, operators };
}

/**
 * GET /api/settings/public
 * Public-safe subset of settings for customer-facing pages (no secrets).
 */
app.get('/api/settings/public', (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        res.json({
            companyName: settings.companyName,
            upiId: settings.upiId || '',
            currency: settings.currency || 'INR',
            // Lets the portal state the password rule up front instead of
            // only failing the customer after they've typed one.
            passwordMinLength: CUSTOMER_PASSWORD_MIN_LENGTH,
            // Whether "Forgot password" can work at all on this tenant.
            passwordResetAvailable: !!(settings.smtp && settings.smtp.host && settings.smtp.user && settings.smtp.pass)
        });
    } catch (err) {
        logError('Error getting public settings: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve settings' });
    }
});

/**
 * GET /api/settings
 * Retrieves system configuration for the admin form. Credentials are
 * write-only: null means "not returned", while the adjacent *Configured flag
 * tells the form whether a stored value already exists.
 */
app.get('/api/settings', requireAdminSession, (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        res.json(redactSettingsForBrowser(settings));
    } catch (err) {
        logError('Error getting settings: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve settings' });
    }
});

/**
 * POST /api/settings
 * Updates system configurations.
 */
app.post('/api/settings', requireAdminSession, (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const currentSettings = readJSON(settingsFile, {});

        // Destructive-action guard: lowering the invoice sequence can produce
        // duplicate invoice numbers against already-issued invoices. Require
        // an explicit confirmDestructive flag (the frontend triple-confirms
        // with the user before setting it) instead of silently applying it.
        if (req.body.invoiceSeqStart !== undefined && currentSettings.invoiceSeqStart !== undefined) {
            const requested = parseInt(req.body.invoiceSeqStart);
            const current = parseInt(currentSettings.invoiceSeqStart);
            if (!isNaN(requested) && requested < current && !req.body.confirmDestructive) {
                return res.status(409).json({
                    error: 'CONFIRMATION_REQUIRED',
                    message: `Lowering the invoice sequence from ${current} to ${requested} can cause duplicate invoice numbers against already-issued invoices. Resubmit with confirmDestructive: true after explicit user confirmation.`
                });
            }
        }

        // Every PIN in this document is a scrypt hash, so the tenant salt has to
        // exist before anything can be hashed against it.
        const authSalt = ensureAuthSalt(currentSettings);

        // The operator roster carries login credentials and decides who can
        // approve money, so it is validated before anything is written rather
        // than merged through and trusted.
        const roster = mergeOperators(req.body.operators, currentSettings, authSalt);
        if (!roster.ok) {
            return res.status(400).json({ error: roster.error });
        }

        // A refund threshold and the MFA switch both gate money, so neither is
        // taken on trust from the payload.
        if (req.body.refundApprovalThreshold !== undefined) {
            const threshold = Number(req.body.refundApprovalThreshold);
            if (!Number.isFinite(threshold) || threshold < 0 || threshold > MAX_SANE_AMOUNT) {
                return res.status(400).json({
                    error: `The refund approval threshold must be between 0 and ${MAX_SANE_AMOUNT}. Use 0 to let any cashier refund any amount.`
                });
            }
        }
        if (req.body.requireMfaForApprovers !== undefined
            && typeof req.body.requireMfaForApprovers !== 'boolean') {
            return res.status(400).json({ error: 'requireMfaForApprovers must be true or false.' });
        }

        const newSettings = {
            ...currentSettings,
            ...req.body,
            authSalt,
            operators: roster.operators,
            requireMfaForApprovers: req.body.requireMfaForApprovers === undefined
                ? currentSettings.requireMfaForApprovers === true
                : req.body.requireMfaForApprovers === true,
            refundApprovalThreshold: req.body.refundApprovalThreshold === undefined
                ? round2(currentSettings.refundApprovalThreshold || 0)
                : round2(req.body.refundApprovalThreshold),
            razorpayKeySecret: preserveWriteOnlyValue(req.body.razorpayKeySecret, currentSettings.razorpayKeySecret),
            razorpayWebhookSecret: preserveWriteOnlyValue(req.body.razorpayWebhookSecret, currentSettings.razorpayWebhookSecret),
            smtp: req.body.smtp ? {
                ...(currentSettings.smtp || {}),
                ...req.body.smtp,
                pass: preserveWriteOnlyValue(req.body.smtp.pass, currentSettings.smtp && currentSettings.smtp.pass)
            } : currentSettings.smtp
        };
        delete newSettings.confirmDestructive; // request-only flag, never persisted
        // Response-only metadata must never be accepted back into settings.json.
        delete newSettings.adminPinConfigured;
        delete newSettings.razorpayKeySecretConfigured;
        delete newSettings.razorpayWebhookSecretConfigured;
        if (newSettings.smtp) delete newSettings.smtp.passConfigured;
        // mergeOperators rebuilds each row field by field, so the response-only
        // flags are already gone — asserted here so a future edit that loosens
        // that merge cannot start persisting them.
        newSettings.operators.forEach(op => {
            delete op.pinConfigured;
            delete op.recoveryCodesRemaining;
        });

        /* A master PIN supplied in the clear is hashed and the plaintext dropped.
           `preserveWriteOnlyValue` is not enough on its own here: it would happily
           persist a plaintext PIN, which is the thing being removed. */
        if (req.body.adminPin !== undefined && req.body.adminPin !== null && String(req.body.adminPin).trim() !== '') {
            const newPin = String(req.body.adminPin).trim();
            if (!OPERATOR_PIN_PATTERN.test(newPin)) {
                return res.status(400).json({ error: 'The store master PIN must be 4 to 8 digits.' });
            }
            newSettings.adminPinHash = hashPin(newPin, authSalt);
        } else {
            newSettings.adminPinHash = currentSettings.adminPinHash
                || (currentSettings.adminPin ? hashPin(currentSettings.adminPin, authSalt) : '');
        }
        // Whatever the payload or the old document carried, no plaintext PIN is
        // written back.
        delete newSettings.adminPin;

        // Store the tax mode in canonical form. Billing tolerates any casing,
        // but settings.json stays the single tidy source of truth that the
        // Settings dropdown reads back and preselects correctly.
        if (newSettings.taxMode !== undefined) {
            newSettings.taxMode = normalizeTaxMode(newSettings.taxMode);
        }

        // Ensure manual overrides maintain float structures
        if (newSettings.overrideGoldPrice) {
            newSettings.overrideGoldPrice.price24K = parseFloat(newSettings.overrideGoldPrice.price24K) || 0.0;
            newSettings.overrideGoldPrice.price22K = parseFloat(newSettings.overrideGoldPrice.price22K) || 0.0;
            newSettings.overrideGoldPrice.price18K = parseFloat(newSettings.overrideGoldPrice.price18K) || 0.0;
        }

        if (!writeJSON(settingsFile, newSettings)) {
            return res.status(500).json({ error: 'Failed to persist settings. Please retry.' });
        }

        /* Access follows the roster. Someone deactivated, removed, re-PINned or
           demoted has their live sessions ended right here — otherwise the
           credential would be gone while the access ran on for up to twelve
           hours, which is the whole gap a revocation control exists to close.

           The caller's own token is spared so an owner rotating their own PIN is
           not signed out mid-task. Done AFTER the write: revoking sessions for a
           roster change that failed to persist would lock people out on the
           strength of an edit that did not happen. */
        const revoked = revokeSessionsForRosterChange(
            currentSettings.operators, newSettings.operators, { exceptToken: req.adminToken }
        );

        // Extensions get the real document; the browser gets the masked one,
        // so the client's cached copy round-trips safely on the next save.
        fireHook('onSettingsUpdated', newSettings);
        res.json({
            success: true,
            settings: redactSettingsForBrowser(newSettings),
            // Reported so the Settings screen can say "2 sessions were signed
            // out" instead of the change looking like it did nothing.
            sessionsRevoked: revoked.ended,
            sessionsRevokedFor: revoked.reasons
        });
    } catch (err) {
        logError('Error updating settings: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

/* ==========================================================================
   API Routes: Sales & Customer Billing Desk
   ========================================================================== */

/**
 * Every sale on file, newest first, optionally narrowed to a set of years.
 *
 * Sales are partitioned one JSON file per year (sales_2026.json). Passing the
 * years a query actually spans means a date-bounded reprint search on a store
 * with a decade of history reads one file instead of ten. Omitting `years`
 * reads them all, which is what GET /api/sales has always done.
 */
function readSalesRecords(years = null) {
    return readLedgerPartitions('sales_', years);
}

/**
 * Every row of a year-partitioned ledger, newest first.
 *
 * Sales and returns are both filed one JSON file per year under the same
 * naming convention (sales_2026.json, returns_2026.json), for the same reason:
 * a store with a decade of history should read one file to answer a question
 * about one month. This is that read, written once rather than once per
 * ledger.
 *
 * @param {string} prefix   filename prefix, including the trailing underscore
 * @param {string[]|number[]|null} years  restrict to these years, or all
 */
function readLedgerPartitions(prefix, years = null) {
    const wanted = years ? new Set(years.map(String)) : null;
    let all = [];
    for (const f of fs.readdirSync(DATA_DIR)) {
        if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
        if (wanted && !wanted.has(f.slice(prefix.length, -'.json'.length))) continue;
        all = all.concat(readJSON(path.join(DATA_DIR, f), []));
    }
    return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

/**
 * Every return on file, newest first, optionally narrowed to a set of years.
 *
 * Note the asymmetry with sales: a return is filed under the year it HAPPENED,
 * not the year of the invoice it reverses. A January refund of a December sale
 * belongs in this January's books. So narrowing by year here answers "what did
 * we refund in that period", which is the question the accounts actually ask —
 * and it is why looking up how much of one invoice has been returned reads
 * every partition rather than just the invoice's own year.
 */
function readReturnRecords(years = null) {
    return readLedgerPartitions('returns_', years);
}

/**
 * How much of one invoice has already gone back — the number every further
 * return against it has to be measured against.
 *
 * Derived from the returns ledger on every read rather than stamped onto the
 * sale record. The filed invoice is immutable by design (it is what a reprint
 * must reproduce, see the Reprint Desk), and a mutable "returned so far"
 * counter living on it would be a second source of truth that can disagree
 * with the rows it is supposed to summarise.
 */
function summarizeInvoiceReturns(invoiceId, returns = readReturnRecords()) {
    const rows = returns.filter(r => r && r.originalInvoiceId === invoiceId);

    // Per line, because that is the level a return is priced and limited at. A
    // return row filed before invoices had lines carries no lineNumber and
    // belongs to line 1 — which is the only line such an invoice has.
    const byLine = new Map();
    for (const r of rows) {
        const lineNumber = Number(r.lineNumber) || 1;
        byLine.set(lineNumber, round3((byLine.get(lineNumber) || 0) + (Number(r.weightGrams) || 0)));
    }

    return {
        count: rows.length,
        returnedWeightGrams: round3(rows.reduce((sum, r) => sum + (Number(r.weightGrams) || 0), 0)),
        refundedAmount: round2(rows.reduce((sum, r) => sum + (Number(r.refundAmount) || 0), 0)),
        returnedByLine: byLine
    };
}

/**
 * A sale, with what has been returned against it attached — per line and in
 * total.
 *
 * Both the Reprint Desk and the Return Desk need this pairing — one to stamp a
 * duplicate that is no longer fully payable, the other to decide what is still
 * returnable — so the join happens once, here, instead of each screen
 * re-deriving it from two endpoints and rounding differently.
 *
 * `lineReturnState` is what lets the Return Desk offer only the lines that still
 * have weight on them. Without it a cashier picking from a multi-line invoice
 * would have to guess, and would learn a line was exhausted only by being
 * refused.
 */
function withReturnState(sale, returns) {
    const summary = summarizeInvoiceReturns(sale.id, returns);
    const lines = saleLines(sale);

    const lineReturnState = lines.map(line => {
        const returned = round3(summary.returnedByLine.get(line.lineNumber) || 0);
        const returnable = round3(Math.max(0, round3(line.weightGrams) - returned));
        return {
            lineNumber: line.lineNumber,
            description: line.description,
            purity: line.purity,
            weightGrams: line.weightGrams,
            goldPricePerGram: line.goldPricePerGram,
            makingChargePercent: line.makingChargePercent,
            makingChargeAmount: line.makingChargeAmount,
            discountPercent: line.discountPercent,
            returnedWeightGrams: returned,
            returnableWeightGrams: returnable,
            fullyReturned: returnable <= 0
        };
    });

    const returnableWeightGrams = round3(
        lineReturnState.reduce((total, l) => total + l.returnableWeightGrams, 0)
    );

    return {
        ...sale,
        returnedWeightGrams: summary.returnedWeightGrams,
        refundedAmount: summary.refundedAmount,
        returnCount: summary.count,
        returnableWeightGrams,
        fullyReturned: summary.count > 0 && returnableWeightGrams <= 0,
        lineReturnState
    };
}

/* ==========================================================================
   Ledger list responses — one clamp and one envelope for every ledger

   GET /api/sales, /api/returns and GET /api/advances each used to return the
   ENTIRE ledger as a bare array, and the screens that call them used to
   download a store's whole trading history on every tab open to render five
   rows and a revenue tile. On a store three years in, that is the largest
   response the server sends, it grows without bound, and it gets slower every
   day the business does well.

   /api/sales/lookup already had the answer — a clamped limit and a `truncated`
   flag — so this is that pattern lifted into one place and applied to all four.
   Two rules make it safe to page a ledger a screen was aggregating:

   1. AGGREGATES ARE COMPUTED SERVER-SIDE, OVER THE WHOLE MATCHED SET, and ride
      along beside the page. A client that receives 100 of 4,000 rows can no
      longer sum the page and call it this month's revenue — the figure it needs
      is handed to it, correct, without the history.
   2. THE ENVELOPE IS THE SAME EVERYWHERE: { results, total, truncated, limit }.
      A caller that forgets to check `truncated` at least cannot mistake the
      response for a complete array, which a bare (silently sliced) array
      invites.
   ========================================================================== */

const LEDGER_PAGE_DEFAULT = 100;
const LEDGER_PAGE_MAX = 500;

/**
 * Parses the `from` / `to` / `limit` triple every ledger list accepts.
 *
 * Returns `{ok: false, error}` on a malformed date rather than throwing, so
 * each route answers 400 with the same wording, and `years` — the only year
 * partitions a bounded range can touch — so a date-bounded query on a store
 * with a decade of history reads one file instead of ten.
 */
function parseLedgerQuery(query = {}, { defaultLimit = LEDGER_PAGE_DEFAULT, maxLimit = LEDGER_PAGE_MAX } = {}) {
    const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));

    // Dates arrive as YYYY-MM-DD from a native date input. `to` covers the
    // whole of its day: a cashier searching 1st–1st means that one day, not
    // the single instant of midnight.
    const from = query.from ? Date.parse(`${query.from}T00:00:00`) : null;
    const to = query.to ? Date.parse(`${query.to}T23:59:59.999`) : null;
    if ((from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) {
        return { ok: false, error: 'Dates must be in YYYY-MM-DD form.' };
    }
    if (from !== null && to !== null && from > to) {
        return { ok: false, error: 'The "from" date cannot be after the "to" date.' };
    }

    let years = null;
    if (from !== null || to !== null) {
        const firstYear = new Date(from ?? to).getFullYear();
        const lastYear = new Date(to ?? from).getFullYear();
        years = [];
        for (let y = firstYear; y <= lastYear; y++) years.push(y);
    }

    return { ok: true, from, to, years, limit };
}

/** Whether a row's timestamp falls inside a (possibly half-open) range. */
function withinRange(row, from, to) {
    const ts = (row && row.timestamp) || 0;
    if (from !== null && ts < from) return false;
    if (to !== null && ts > to) return false;
    return true;
}

/** The standard page envelope. `extra` carries each ledger's own aggregates. */
function pagedLedger(rows, limit, extra = {}) {
    return {
        results: rows.slice(0, limit),
        total: rows.length,
        truncated: rows.length > limit,
        limit,
        ...extra
    };
}

/**
 * GET /api/sales?from=&to=&limit=
 * A page of the sales ledger, newest first, with the period's totals attached.
 *
 * `totals` covers every row the filter matched, not the page — it is what the
 * Dashboard's revenue tiles read, and they must stay correct when the period
 * holds more invoices than one page returns.
 */
app.get('/api/sales', requireAdminSession, (req, res) => {
    try {
        const q = parseLedgerQuery(req.query);
        if (!q.ok) return res.status(400).json({ error: q.error });

        const matched = readSalesRecords(q.years).filter(s => withinRange(s, q.from, q.to));
        res.json(pagedLedger(matched, q.limit, {
            totals: {
                count: matched.length,
                totalAmount: round2(matched.reduce((sum, s) => sum + (Number(s.totalAmount) || 0), 0)),
                appliedAdvance: round2(matched.reduce((sum, s) => sum + (Number(s.appliedAdvance) || 0), 0)),
                weightGrams: round3(matched.reduce((sum, s) => sum + (Number(s.weightGrams) || 0), 0))
            }
        }));
    } catch (err) {
        logError('Error retrieving sales logs: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve sales' });
    }
});

/**
 * GET /api/sales/lookup?q=&from=&to=&limit=
 * Finds filed invoices for reprinting.
 *
 * Returns the STORED records untouched — no recomputation, no re-pricing
 * against today's gold rate or today's tax settings. A reprint is a second
 * copy of a document that already exists, so the only correct source for it is
 * what was written to the ledger at the time of sale. Re-deriving the figures
 * here would let a rate change or a Settings edit silently hand a customer a
 * "duplicate" that disagrees with both their original slip and the books.
 *
 * `q` matches an invoice ID, a customer phone, or a customer name; the cashier
 * has whichever of the three the customer can produce.
 *
 * Registered BEFORE any /api/sales/:id-shaped route would be — Express matches
 * in declaration order, and a parameterised route declared first would capture
 * the literal path 'lookup' as an id.
 */
const REPRINT_MAX_RESULTS = 200;

app.get('/api/sales/lookup', requireAdminSession, (req, res) => {
    try {
        const parsed = parseLedgerQuery(req.query, {
            defaultLimit: 50,
            maxLimit: REPRINT_MAX_RESULTS
        });
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        const { from, to, years, limit } = parsed;

        const q = String(req.query.q || '').trim().toLowerCase();
        const digitsOnly = q.replace(/\D/g, '');
        const results = readSalesRecords(years).filter(sale => {
            if (!withinRange(sale, from, to)) return false;
            if (!q) return true;
            return String(sale.id || '').toLowerCase().includes(q)
                || String(sale.customerName || '').toLowerCase().includes(q)
                || (digitsOnly.length > 0 && String(sale.customerPhone || '').includes(digitsOnly));
        });

        // Return state rides along on every hit. The Return Desk searches
        // through this same route — it is the same "find the invoice the
        // customer is holding" question — and needs to know what is still
        // returnable; the Reprint Desk needs it to stamp a duplicate of an
        // invoice that has since been refunded. The whole returns ledger is
        // read once here and shared across the page of results, rather than
        // once per row.
        const page = results.slice(0, limit);
        const returns = page.length > 0 ? readReturnRecords() : [];

        res.json({
            results: page.map(sale => withReturnState(sale, returns)),
            total: results.length,
            truncated: results.length > limit
        });
    } catch (err) {
        logError('Invoice reprint lookup failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to search invoices' });
    }
});

/* ==========================================================================
   Sale line items

   An invoice holds one or more items, each with its own purity, weight, rate,
   making charge and discount. It used to hold exactly one, as scalars on the
   record itself — which meant a customer buying bangles and a chain in one
   visit needed two invoice numbers, two GST documents and two of everything
   downstream, or a cashier averaged the two purities into one line and the
   books stopped describing what was actually sold.

   BOTH REQUEST SHAPES ARE ACCEPTED, permanently:
     - `lines: [{purity, weightGrams, makingChargeAmount, ...}, ...]`
     - the flat `purity` / `weightGrams` / `makingChargeAmount` fields, which
       are normalised into a single line here.
   The stored record carries `lines` AND the flat rollup fields, so every reader
   that has not been taught about lines keeps working unchanged. See saleLines()
   in frontend/js/lib/billingMath.js for the reading half of the same seam.
   ========================================================================== */

const VALID_PURITIES = ['24K', '22K', '18K'];
const MAX_INVOICE_LINES = 50;

/**
 * Validates one requested line and prices its metal at the STORE's rate.
 *
 * The rate is never taken from the request — same rule as the single-line path
 * it replaces, and for the same reason: recomputing tax and discount over a
 * client-supplied metal value only derives correct percentages of a number the
 * client chose. A tampered payload could bill 50 g of 22K at ₹1/g and the
 * stored invoice would be internally consistent and completely wrong.
 *
 * @returns {{ok: true, line: object}|{ok: false, error: string, status?: number}}
 */
function validateSaleLine(raw, index, activeRates) {
    const where = `Line ${index + 1}`;
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: `${where} is not a valid item.` };
    }

    const purity = raw.purity;
    if (!VALID_PURITIES.includes(purity)) {
        return { ok: false, error: `${where} needs a valid purity (24K, 22K, or 18K).` };
    }

    const weightGrams = Number(raw.weightGrams);
    if (!Number.isFinite(weightGrams) || weightGrams <= 0) {
        return { ok: false, error: `${where} needs a positive gold weight.` };
    }
    if (weightGrams > MAX_SANE_WEIGHT_GRAMS) {
        return { ok: false, error: `${where} exceeds the ${MAX_SANE_WEIGHT_GRAMS}g limit.` };
    }

    const makingChargeAmount = raw.makingChargeAmount === undefined ? 0 : Number(raw.makingChargeAmount);
    if (!Number.isFinite(makingChargeAmount) || makingChargeAmount < 0) {
        return { ok: false, error: `${where} has an invalid making charge.` };
    }

    // Descriptive only — makingChargeAmount is what the money math uses — but it
    // prints on the invoice, so it is validated rather than trusted through.
    const makingChargePercent = raw.makingChargePercent === undefined ? 0 : Number(raw.makingChargePercent);
    if (!Number.isFinite(makingChargePercent) || makingChargePercent < 0 || makingChargePercent > 100) {
        return { ok: false, error: `${where} has an invalid making charge percent.` };
    }

    const discountPercent = raw.discountPercent === undefined ? 0 : Number(raw.discountPercent);
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
        return { ok: false, error: `${where} has a discount outside 0–100%.` };
    }

    const rateKey = PURITY_RATE_KEY[purity];
    const ratePerGram = Number(activeRates[rateKey]);
    if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
        logError(`Refusing to bill ${purity}: the active gold rate is unusable (${activeRates[rateKey]}).`);
        return {
            ok: false,
            status: 503,
            error: 'The current gold rate is unavailable, so this invoice cannot be priced. Check the gold rate in Settings and retry.'
        };
    }

    return {
        ok: true,
        line: {
            lineNumber: index + 1,
            description: String(raw.description || '').trim().slice(0, 120),
            purity,
            weightGrams,
            goldPricePerGram: ratePerGram,
            // Provenance of the rate this line was priced at, so a later audit
            // can tell a synced market rate from a counter override without
            // having to guess from the number alone.
            goldRateSource: activeRates.sources[rateKey],
            metalValue: computeMetalValue(weightGrams, ratePerGram),
            makingChargePercent,
            makingChargeAmount: round2(makingChargeAmount),
            discountPercent,
            // What the cashier's screen quoted for this line, kept only to
            // detect and log a disagreement — never persisted as money.
            clientRate: Number(raw.goldPricePerGram)
        }
    };
}

/* ==========================================================================
   Tenders — HOW the invoice was paid

   A sale used to record no payment method at all. Not "no split tender": no
   tender. Nothing on the record said whether a bill was settled in cash, on a
   card, or by UPI, which meant a cash-drawer close, a shift variance and a card
   settlement reconciliation were not features waiting to be built — they were
   arithmetic with no data to perform it on.

   Tenders are OPTIONAL on the request and additive on the record, because every
   invoice already on disk has none and must stay readable. When they are
   supplied they are checked hard: the posted tenders must sum to exactly the
   amount payable, or the invoice is refused. A tender list that does not add up
   to the bill is worse than no tender list, since it would reconcile against
   nothing while looking authoritative.

   Method vocabulary matches `tenders.method` in the SQL schema exactly, so the
   cutover is a copy rather than a translation.
   ========================================================================== */

const TENDER_METHODS = ['cash', 'card', 'upi', 'razorpay', 'advance', 'bank_transfer', 'other'];
const MAX_TENDERS = 10;

/**
 * Validates the tender list against the amount actually payable.
 *
 * `payable` is the total AFTER any advance redemption, because a redeemed
 * advance is not tendered at the counter — it was tendered when the customer
 * deposited it, and it appears on the record as `appliedAdvance`. Counting it
 * twice is exactly the reconciliation error this validation exists to prevent.
 */
function validateTenders(raw, payable) {
    if (raw === undefined || raw === null) return { ok: true, tenders: [] };
    if (!Array.isArray(raw)) {
        return { ok: false, error: 'Tenders must be a list.' };
    }
    if (raw.length === 0) return { ok: true, tenders: [] };
    if (raw.length > MAX_TENDERS) {
        return { ok: false, error: `An invoice may be split across at most ${MAX_TENDERS} tenders.` };
    }
    // Nothing left to pay — an invoice fully settled by a redeemed advance has
    // no counter tender, and recording a ₹0 one would just be a row that means
    // nothing.
    if (round2(payable) <= 0) return { ok: true, tenders: [] };

    const tenders = [];
    for (const [i, entry] of raw.entries()) {
        if (!entry || typeof entry !== 'object') {
            return { ok: false, error: `Tender ${i + 1} is not a valid payment.` };
        }
        const method = String(entry.method || '').trim().toLowerCase();
        if (!TENDER_METHODS.includes(method)) {
            return { ok: false, error: `Tender ${i + 1} has an unknown method. Use one of: ${TENDER_METHODS.join(', ')}.` };
        }

        /* A LONE TENDER WITH NO AMOUNT means "the whole bill, by this method".
           The desk sends that for the ordinary unsplit sale, and it matters
           because the server may legitimately price the invoice differently
           from the browser — a rate synced overnight, a tax slab edited
           mid-shift. The cashier's intent there was "the customer is paying the
           whole bill in cash", not "the customer is paying ₹4,532", so pinning
           the amount to the browser's stale total would refuse a sale the store
           genuinely wants to make.

           A cashier who has actually split the payment sends explicit amounts,
           and those must reconcile exactly — see the check below. */
        const amountOmitted = raw.length === 1
            && (entry.amount === undefined || entry.amount === null || entry.amount === '');
        const amount = amountOmitted ? payable : Number(entry.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return { ok: false, error: `Tender ${i + 1} needs a positive amount.` };
        }
        if (amount > MAX_SANE_AMOUNT) {
            return { ok: false, error: `Tender ${i + 1} exceeds the per-payment limit.` };
        }
        tenders.push({
            method,
            amount: round2(amount),
            // A card slip number, a UPI UTR, a cheque number — whatever the
            // reconciliation will be done against. Free text by necessity;
            // clamped, and never used as an identifier by this system.
            reference: String(entry.reference || '').trim().slice(0, 100)
        });
    }

    // Compared in integer paise, not rupees. Two rupee floats that both look
    // like the same amount need not be equal, and this is precisely the
    // comparison that must not be approximate.
    const tenderedPaise = tenders.reduce((total, t) => total + toPaise(t.amount), 0);
    const payablePaise = toPaise(payable);
    if (tenderedPaise !== payablePaise) {
        return {
            ok: false,
            error: `The payments recorded (₹${fromPaise(tenderedPaise)}) do not add up to the amount due (₹${fromPaise(payablePaise)}). `
                + 'Adjust the split so the two match.'
        };
    }

    return { ok: true, tenders };
}

/**
 * POST /api/sales
 * Saves a new Gold POS Sale, handles sequence numbering, and registers advance deductions if applied.
 */
app.post('/api/sales', requireAdminSession, (req, res) => {
    try {
        // Validate the core billing fields before consuming a real,
        // sequential, legally-relevant invoice number on garbage/empty data.
        const { totalAmount, customerName, customerPhone, appliedAdvance } = req.body;

        const numTotal = Number(totalAmount);
        const numAppliedAdvance = appliedAdvance === undefined ? 0 : Number(appliedAdvance);
        if (!Number.isFinite(numTotal) || numTotal < 0) {
            return res.status(400).json({ error: 'A valid non-negative total amount is required.' });
        }
        if (!Number.isFinite(numAppliedAdvance) || numAppliedAdvance < 0) {
            return res.status(400).json({ error: 'Applied advance must be a valid non-negative amount.' });
        }
        const numDiscountPercent = req.body.discountPercent === undefined ? 0 : Number(req.body.discountPercent);
        if (!Number.isFinite(numDiscountPercent) || numDiscountPercent < 0 || numDiscountPercent > 100) {
            return res.status(400).json({ error: 'Discount percent must be between 0 and 100.' });
        }
        if (customerPhone && !/^\d{10}$/.test(customerPhone)) {
            return res.status(400).json({ error: 'Customer phone must be exactly 10 digits if provided.' });
        }
        if (customerName && String(customerName).length > 200) {
            return res.status(400).json({ error: 'Customer name is too long (max 200 characters).' });
        }

        /* The lines, priced at the store's rates.
           The flat single-item form is normalised into a one-line cart so there
           is exactly one code path below, whichever shape the request took. */
        const requestedLines = Array.isArray(req.body.lines) && req.body.lines.length > 0
            ? req.body.lines
            : [{
                purity: req.body.purity,
                weightGrams: req.body.weightGrams,
                goldPricePerGram: req.body.goldPricePerGram,
                makingChargeAmount: req.body.makingChargeAmount,
                makingChargePercent: req.body.makingChargePercent,
                discountPercent: req.body.discountPercent,
                description: req.body.description
            }];

        if (requestedLines.length > MAX_INVOICE_LINES) {
            return res.status(400).json({ error: `An invoice may hold at most ${MAX_INVOICE_LINES} items.` });
        }

        /* The rate is the store's, not the browser's — see validateSaleLine.
           Fetched once for the whole invoice so every line on one document is
           priced against the same snapshot, rather than a midnight sync landing
           between line 2 and line 3. */
        const activeRates = getActiveGoldRates();
        const saleLineItems = [];
        for (const [i, raw] of requestedLines.entries()) {
            const checked = validateSaleLine(raw, i, activeRates);
            if (!checked.ok) {
                return res.status(checked.status || 400).json({ error: checked.error });
            }
            saleLineItems.push(checked.line);
        }

        const totalWeight = round3(saleLineItems.reduce((total, l) => total + l.weightGrams, 0));
        if (totalWeight > MAX_SANE_WEIGHT_GRAMS) {
            return res.status(400).json({
                error: `The invoice totals ${totalWeight}g, over the ${MAX_SANE_WEIGHT_GRAMS}g per-invoice limit.`
            });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});

        // 0. Recompute the money server-side. The browser renders a live
        // preview with this same shared module, but what gets persisted to the
        // ledger is always the server's own arithmetic over the server's own
        // tax configuration — a stale cached bundle or a tampered payload can
        // no longer write a total that disagrees with the tax slab and tax
        // mode actually configured in Settings.
        const taxSlab = Number(settings.goldTaxSlab) || 0;
        // Canonicalised through the shared helper, so a settings.json written
        // by an older build, edited by hand, or restored from a backup with
        // 'inclusive' in it cannot leave the server billing Exclusive while
        // the browser bills Inclusive.
        const taxMode = normalizeTaxMode(settings.taxMode);

        // The cashier quoted a rate on screen, per line. If any of them moved
        // between then and Save — an overnight sync, or an override edited
        // mid-shift — the server's figure is what gets filed, and the desk is
        // told so it can reprint rather than hand over a slip that disagrees
        // with the ledger.
        const rateWasCorrected = saleLineItems.some(l =>
            Number.isFinite(l.clientRate) && Math.abs(l.clientRate - l.goldPricePerGram) > 0.01
        );
        if (rateWasCorrected) {
            for (const l of saleLineItems) {
                if (!Number.isFinite(l.clientRate) || Math.abs(l.clientRate - l.goldPricePerGram) <= 0.01) continue;
                logError(
                    `Sale rate mismatch — client billed line ${l.lineNumber} (${l.purity}) at ${l.clientRate}/g, ` +
                    `server's active rate is ${l.goldPricePerGram}/g (source: ${l.goldRateSource}). Persisting the server rate.`
                );
                logTelemetry('SALE_RATE_MISMATCH', 0, `client: ${l.clientRate}, server: ${l.goldPricePerGram}`);
            }
        }
        // `clientRate` was only ever needed for that comparison — it is not a
        // money field and must not reach the ledger.
        saleLineItems.forEach(l => { delete l.clientRate; });

        let advancesFile = null;
        let advances = null;
        let customerAdvanceBalance = 0;
        if (numAppliedAdvance > 0) {
            if (!customerPhone) {
                return res.status(400).json({ error: 'Customer phone is required when redeeming an advance.' });
            }
            advancesFile = path.join(DATA_DIR, 'advances.json');
            advances = readJSON(advancesFile, []);
            customerAdvanceBalance = computeAdvanceLedger(customerPhone, advances).balance;
            if (round2(numAppliedAdvance) > round2(customerAdvanceBalance)) {
                return res.status(400).json({
                    error: `Applied advance exceeds the customer's available balance of ${round2(customerAdvanceBalance)}.`
                });
            }
        }

        const totals = computeInvoiceTotals({
            lines: saleLineItems.map(l => ({
                metalValue: l.metalValue,
                makingChargeAmount: l.makingChargeAmount,
                discountPercent: l.discountPercent
            })),
            discountPercent: numDiscountPercent,
            taxSlab,
            taxMode,
            appliedAdvance: numAppliedAdvance,
            customerAdvanceBalance
        });

        // A mismatch means the client's math and the server's disagree — the
        // server's value is what gets stored either way, but it is worth a
        // loud log line: it is the signature of a stale cached frontend or a
        // settings change mid-session.
        const serverTotal = round2(totals.totalAmount);
        const totalWasCorrected = Math.abs(round2(numTotal) - serverTotal) > 0.01;
        if (totalWasCorrected) {
            logError(
                `Sale total mismatch — client submitted ${round2(numTotal)}, server computed ${serverTotal} ` +
                `(taxSlab ${taxSlab}%, taxMode ${taxMode}, discount ${numDiscountPercent}%). Persisting the server value.`
            );
            logTelemetry('SALE_TOTAL_MISMATCH', 0, `client: ${round2(numTotal)}, server: ${serverTotal}`);
        }

        // How the bill was settled, checked against what is actually payable.
        // Validated BEFORE the invoice number is consumed — a tender split that
        // does not add up must not burn a sequential, legally-relevant number.
        const tendered = validateTenders(req.body.tenders, serverTotal);
        if (!tendered.ok) {
            return res.status(400).json({ error: tendered.error });
        }

        // 1. Generate Incrementing Serial Invoice ID
        const prefix = settings.invoicePrefix || 'GOLD';
        const startSeq = settings.invoiceSeqStart || 1;
        const currentYearShort = new Date().getFullYear().toString().slice(-2);

        const invoiceId = `${prefix}-${startSeq.toString().padStart(6, '0')}-${currentYearShort}`;

        // The increment is committed together with the sale and any advance
        // redemption below; no invoice can exist in only one of those ledgers.
        settings.invoiceSeqStart = startSeq + 1;

        /* 2. Prepare the sale record — field by field, never `...req.body`.

           Spreading the body meant any key the client felt like sending landed
           in the permanent ledger: a `timestamp` of the client's choosing (so
           an invoice could be back- or post-dated from the browser, and the
           annual partition it was filed under argued with the date printed on
           it), a second copy of a money field under a name the recompute above
           does not cover, or simply unbounded junk inflating sales_YYYY.json.

           An allowlist inverts that. Money fields are the server's own
           arithmetic; descriptive fields are taken deliberately and clamped;
           anything else the client sends is dropped. */
        const now = Date.now();
        const sale = {
            id: invoiceId,
            // Server clock, always. The business date an invoice is filed under
            // is the store's, not the till browser's — a wrong workstation clock
            // (or a crafted payload) must not decide which year's ledger and
            // which tax period a sale belongs to.
            timestamp: now,
            customerName: customerName ? String(customerName).slice(0, 200) : 'Cash Sale',
            customerPhone: customerPhone || '',

            /* THE ITEMS. Each line's own purity, weight, rate, making charge and
               discount, with its allocated share of the invoice's taxable value
               and GST merged in from computeInvoiceTotals — so the rows on the
               printed invoice sum exactly to the total at the bottom. */
            lines: saleLineItems.map((l, i) => ({ ...l, ...totals.lines[i] })),

            /* THE ROLLUP, kept deliberately.

               These are the same scalar fields a single-line invoice has always
               carried, now describing the whole document. They are redundant
               with `lines` above and that is the point: every reader written
               before lines existed — the dashboard tile, the email report, a
               tenant's extension, an accountant's export — keeps working
               untouched, and reads the right figures for a multi-line invoice
               rather than the first line's.

               `purity` is the invoice's only when every line agrees on it;
               'MIXED' otherwise, because silently reporting line 1's purity for
               a mixed cart would be a wrong answer rather than a missing one. */
            purity: [...new Set(saleLineItems.map(l => l.purity))].length === 1
                ? saleLineItems[0].purity
                : 'MIXED',
            weightGrams: totalWeight,
            // A single-rate invoice states its rate; a mixed one has no single
            // rate to state, and 0 is how every downstream reader already
            // represents "not applicable" for this field.
            goldPricePerGram: [...new Set(saleLineItems.map(l => l.goldPricePerGram))].length === 1
                ? saleLineItems[0].goldPricePerGram
                : 0,
            // Provenance of the rates this invoice was priced at, so a later
            // audit can tell a synced market rate from a counter override
            // without having to guess from the number alone.
            goldRateSource: [...new Set(saleLineItems.map(l => l.goldRateSource))].join('+'),
            metalValue: round2(saleLineItems.reduce((t, l) => t + l.metalValue, 0)),
            makingChargePercent: [...new Set(saleLineItems.map(l => l.makingChargePercent))].length === 1
                ? saleLineItems[0].makingChargePercent
                : 0,
            makingChargeAmount: round2(saleLineItems.reduce((t, l) => t + l.makingChargeAmount, 0)),
            taxPercent: taxSlab,
            taxMode,
            taxableAmount: round2(totals.taxableAmount),
            taxAmount: round2(totals.taxAmount),
            discountPercent: numDiscountPercent,
            discount: round2(totals.discountAmount),
            appliedAdvance: round2(totals.appliedAdvance),
            totalAmount: serverTotal,

            /* HOW IT WAS PAID. Empty when the desk did not record a split, which
               is what every invoice filed before tenders existed looks like —
               so an empty list means "not recorded", never "paid nothing". When
               non-empty it is guaranteed to sum to totalAmount (validateTenders
               refuses the sale otherwise), which is what makes a cash-drawer
               close and a card settlement reconcilable against it. */
            tenders: tendered.tenders,
            /* WHO BILLED THIS. Taken from the session, never from the body —
               a client-supplied cashier name is worth nothing as an audit
               trail, since the whole point is to bind the record to the
               credential that was used.

               Every invoice used to be filed anonymously: one shared PIN
               gated the desk, so a discount, a counter rate override and the
               sale itself named nobody. Maps to invoices.created_by_user_id +
               the actor label in the SQL schema at cutover. */
            actor: req.actor
        };

        // 3. Save to partitioned annual file (e.g. sales_2026.json)
        const year = new Date().getFullYear();
        const salesFile = path.join(DATA_DIR, `sales_${year}.json`);
        const sales = readJSON(salesFile, []);
        sales.push(sale);
        // 4. Prepare Customer Advance Redemption in the same transaction.
        if (sale.appliedAdvance > 0 && sale.customerPhone) {
            advances.push({
                id: newId('RED'),
                customerPhone: sale.customerPhone,
                customerName: sale.customerName,
                type: 'redeem',
                amount: parseFloat(sale.appliedAdvance),
                invoiceId: invoiceId,
                timestamp: Date.now(),
                // Spending a customer's credit is a money movement, so it
                // carries the same signature as the invoice that spent it.
                actor: req.actor
            });
        }

        const transactionWrites = [
            { filepath: settingsFile, data: settings },
            { filepath: salesFile, data: sales }
        ];
        if (advancesFile && advances) transactionWrites.push({ filepath: advancesFile, data: advances });
        if (!writeJSONTransaction(transactionWrites)) {
            return res.status(500).json({
                error: 'Failed to persist the complete sale transaction. Nothing was saved; please retry.'
            });
        }

        logTelemetry('SAVE_SALE', 0, `Invoice: ${invoiceId}, Total: ${sale.totalAmount}`);
        fireHook('onSaleSaved', sale);
        // `totalCorrected` / `rateCorrected` let the cashier know the printed
        // preview no longer matches what was filed, instead of the two
        // silently diverging.
        res.json({
            success: true,
            invoiceId,
            sale,
            totalCorrected: totalWasCorrected,
            rateCorrected: rateWasCorrected
        });
    } catch (err) {
        logError('Error saving sale transaction: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to process sale transaction: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Returns & Refunds

   A return reverses part or all of a filed invoice. Three rules define the
   module, and every check below exists to hold one of them:

   1. THE STORE ISSUES RETURNS, NOBODY ELSE. Both routes are admin-gated.
      There is deliberately no customer-facing way to raise, request, or
      cancel one — a refund moves money out of the till, and that decision is
      made at the counter with the goods in hand. Customers SEE their returns
      (GET /api/customer/returns) and never initiate them.
   2. THE INVOICE IS NEVER REWRITTEN. Returns are their own year-partitioned
      ledger keyed by originalInvoiceId. The sale record stays exactly as
      filed, so a reprint still reproduces the original document, and "how
      much has come back" is always derived from the return rows themselves.
   3. THE REFUND IS PRICED BY THE OLD INVOICE, NOT BY TODAY. All of that
      arithmetic lives in computeReturnRefund() in billingMath.js, which the
      Return Desk previews with and this route re-runs authoritatively.
   ========================================================================== */

const REFUND_MODES = ['cash', 'gold'];

/**
 * GET /api/returns?from=&to=&limit=
 * A page of the returns ledger, newest first, with the period's refund total.
 * Admin-only. Same envelope and same clamp as GET /api/sales — see above.
 */
app.get('/api/returns', requireAdminSession, (req, res) => {
    try {
        const q = parseLedgerQuery(req.query);
        if (!q.ok) return res.status(400).json({ error: q.error });

        const matched = readReturnRecords(q.years).filter(r => withinRange(r, q.from, q.to));
        res.json(pagedLedger(matched, q.limit, {
            totals: {
                count: matched.length,
                refundAmount: round2(matched.reduce((sum, r) => sum + (Number(r.refundAmount) || 0), 0)),
                weightGrams: round3(matched.reduce((sum, r) => sum + (Number(r.weightGrams) || 0), 0))
            }
        }));
    } catch (err) {
        logError('Error retrieving returns ledger: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve returns' });
    }
});

/**
 * POST /api/returns
 * Files a return against an invoice and refunds it as cash or as gold credit.
 *
 * The client sends only WHICH invoice, HOW MUCH weight, and WHICH mode. Every
 * rupee is computed here from the stored sale record — the browser's preview
 * is a preview, exactly as it is on the Billing Desk, and a tampered or stale
 * payload cannot name its own refund figure.
 *
 * Gold mode credits the customer's advance ledger in the SAME transaction as
 * the return row, so the two can never exist apart. That is also why the row
 * is built through buildAdvanceDepositRow() and pushed here rather than going
 * through recordAdvanceDeposit(), which commits on its own.
 */
app.post('/api/returns', requireAdminSession, (req, res) => {
    try {
        const { invoiceId, weightGrams, refundMode, note, lineNumber } = req.body || {};

        const cleanInvoiceId = String(invoiceId || '').trim();
        if (!cleanInvoiceId) {
            return res.status(400).json({ error: 'An invoice number is required to file a return.' });
        }
        if (!REFUND_MODES.includes(refundMode)) {
            return res.status(400).json({ error: 'Refund mode must be either "cash" or "gold".' });
        }
        const numWeight = Number(weightGrams);
        if (!Number.isFinite(numWeight) || numWeight <= 0) {
            return res.status(400).json({ error: 'A valid positive return weight is required.' });
        }
        // Which item on the invoice is coming back. Optional on a single-line
        // invoice — computeReturnRefund resolves it — and required on a
        // multi-line one, which it enforces rather than guessing.
        const numLine = lineNumber === undefined || lineNumber === null ? null : Number(lineNumber);
        if (numLine !== null && (!Number.isInteger(numLine) || numLine < 1)) {
            return res.status(400).json({ error: 'Line number must be a positive whole number.' });
        }

        const sale = readSalesRecords().find(s => s && s.id === cleanInvoiceId);
        if (!sale) {
            return res.status(404).json({
                error: `No filed invoice ${cleanInvoiceId} exists. Only saved invoices can be returned against.`
            });
        }

        // Gold credit has to land in somebody's account, and this platform
        // keys every customer ledger on the phone number. A walk-in "Cash
        // Sale" filed without one can still be refunded — in cash, over the
        // counter, which is how it was paid.
        if (refundMode === 'gold' && !isValidPhone(sale.customerPhone)) {
            return res.status(400).json({
                error: 'This invoice has no customer phone number on it, so there is no account to credit. Refund it as cash, or re-file the sale against a customer.'
            });
        }

        const returns = readReturnRecords();
        const priorReturns = summarizeInvoiceReturns(cleanInvoiceId, returns);
        const state = withReturnState(sale, returns);

        // Prior returns are measured PER LINE — a line's remaining weight is its
        // own, and exhausting line 2 must not consume line 1's returnable
        // weight. `invoiceRemainingGrams` is the whole-invoice figure, which is
        // what the money true-up on the closing return keys on.
        const resolvedLine = numLine !== null
            ? numLine
            : (saleLines(sale).length === 1 ? 1 : null);
        const priorOnLine = resolvedLine === null
            ? 0
            : round3(priorReturns.returnedByLine.get(resolvedLine) || 0);

        const refund = computeReturnRefund({
            sale,
            returnWeightGrams: numWeight,
            lineNumber: numLine,
            alreadyReturnedGrams: priorOnLine,
            invoiceRemainingGrams: state.returnableWeightGrams,
            alreadyRefundedAmount: priorReturns.refundedAmount
        });
        if (!refund.ok) {
            return res.status(400).json({ error: refund.error });
        }
        if (!(refund.refundAmount > 0)) {
            return res.status(400).json({
                error: 'This return prices to a zero refund, so there is nothing to pay back. Check the weight entered.'
            });
        }

        /* APPROVAL THRESHOLD. A refund is the one counter action that takes money
           out of the till on the cashier's own say-so, and it was the obvious
           remaining insider-fraud gap once roles existed.

           Checked HERE, after the server has priced the refund, because the
           amount that matters is the one about to be filed — not one the client
           proposed. Zero disables the control, which is the previous behaviour
           and therefore the default: no existing store is surprised by a refusal
           it never configured.

           The MFA condition is the same one requireApprover applies, restated
           rather than shared because this is not a whole-route gate: a cashier
           may file small refunds all day, and only crossing the threshold turns
           this into an approver's decision. */
        const refundSettings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
        const threshold = round2(refundSettings.refundApprovalThreshold || 0);
        if (threshold > 0 && refund.refundAmount >= threshold) {
            if (!roleCanApprove(req.actor.role)) {
                logTelemetry('REFUND_APPROVAL_DENIED', 0,
                    `${req.actor.name} (${req.actor.role}) attempted ${refund.refundAmount} on ${sale.id}`);
                return res.status(403).json({
                    error: 'APPROVER_REQUIRED',
                    message: `A refund of ₹${refund.refundAmount} needs a manager or the owner to authorise it `
                        + `(this store's limit is ₹${threshold}). ${req.actor.name} is signed in as ${req.actor.role}.`
                });
            }
            if (refundSettings.requireMfaForApprovers === true && req.adminSession && !req.adminSession.mfaUsed) {
                logTelemetry('REFUND_APPROVAL_DENIED_NO_MFA', 0,
                    `${req.actor.name} (${req.actor.role}) attempted ${refund.refundAmount} on ${sale.id}`);
                return res.status(403).json({
                    error: 'MFA_REQUIRED',
                    message: `A refund of ₹${refund.refundAmount} is at or above this store's ₹${threshold} limit, `
                        + 'and this store requires two-factor authentication to authorise one. Sign in with your authenticator code.'
                });
            }
        }

        const returnId = newId('RET');
        const now = Date.now();
        // Filed under the year the refund HAPPENED — see readReturnRecords().
        const year = new Date(now).getFullYear();
        const returnsFile = path.join(DATA_DIR, `returns_${year}.json`);
        const yearRows = readJSON(returnsFile, []);

        // Field by field, never `...req.body` — same reasoning as POST
        // /api/sales: the client may name the invoice, the weight and the
        // mode, and nothing else reaches the permanent ledger.
        const returnRecord = {
            id: returnId,
            timestamp: now,
            originalInvoiceId: sale.id,
            originalTimestamp: sale.timestamp || null,
            customerName: sale.customerName || 'Cash Sale',
            customerPhone: sale.customerPhone || '',
            // WHICH ITEM came back. Load-bearing on a multi-line invoice: it is
            // what limits further returns against that line and what lets the
            // refund be re-priced at the right rate. A row without it reads as
            // line 1, which is correct for every invoice filed before lines.
            lineNumber: refund.lineNumber,
            description: refund.description,
            purity: refund.purity,
            weightGrams: refund.weightGrams,
            // The weight of the LINE being returned, not of the whole invoice —
            // it is what this return's share was computed against.
            originalWeightGrams: round3(
                (saleLines(sale).find(l => l.lineNumber === refund.lineNumber) || {}).weightGrams
            ),
            invoiceWeightGrams: round3(sale.weightGrams),
            // The rate the goods were SOLD at, restated on the credit note so
            // the customer can see the refund was not re-priced against today.
            goldPricePerGram: refund.goldPricePerGram,
            makingChargePercent: refund.makingChargePercent,
            discountPercent: refund.discountPercent,
            taxPercent: refund.taxPercent,
            taxMode: refund.taxMode,
            // Null on an invoice whose stored figures cannot be split — the
            // credit note then prints the refund total and says so, rather
            // than inventing a GST line. See computeReturnRefund().
            metalValue: refund.itemised ? refund.components.metalValue : null,
            makingChargeAmount: refund.itemised ? refund.components.makingChargeAmount : null,
            discount: refund.itemised ? refund.components.discountAmount : null,
            taxableAmount: refund.itemised ? refund.components.taxableAmount : null,
            taxAmount: refund.itemised ? refund.components.taxAmount : null,
            itemised: refund.itemised,
            refundAmount: refund.refundAmount,
            refundMode,
            closesLine: refund.closesLine,
            closesInvoice: refund.closesInvoice,
            note: String(note || '').trim().slice(0, 300),
            // WHO AUTHORISED THE REFUND. A cash refund moves money out of the
            // till, which makes it the single most fraud-sensitive write in the
            // system and the one that least tolerated being anonymous. From the
            // session, never the body — see POST /api/sales.
            actor: req.actor
        };

        const transactionWrites = [];
        let creditRow = null;

        if (refundMode === 'gold') {
            const advancesFile = path.join(DATA_DIR, 'advances.json');
            const advances = readJSON(advancesFile, []);
            creditRow = buildAdvanceDepositRow({
                customerPhone: sale.customerPhone,
                customerName: sale.customerName,
                amount: refund.refundAmount,
                paymentMethod: 'Return Credit',
                // Approved outright, not pending: unlike a customer's claim to
                // have sent a UPI transfer, this credit was created by the
                // store itself at the counter. There is nothing left to verify.
                status: ADVANCE_STATUS.APPROVED,
                source: 'return',
                invoiceId: sale.id,
                returnId,
                // The same person the return names — the credit and the refund
                // that created it are one counter decision.
                actor: req.actor
            });
            returnRecord.advanceCreditId = creditRow.id;
            returnRecord.lockedGoldRate22K = creditRow.lockedGoldRate22K;
            advances.push(creditRow);
            transactionWrites.push({ filepath: advancesFile, data: advances });
        }

        yearRows.push(returnRecord);
        transactionWrites.unshift({ filepath: returnsFile, data: yearRows });

        if (!writeJSONTransaction(transactionWrites)) {
            return res.status(500).json({
                error: 'Failed to persist the complete return. Nothing was saved; please retry.'
            });
        }

        logTelemetry(
            'SAVE_RETURN', 0,
            `Return: ${returnId}, Invoice: ${sale.id}, Weight: ${refund.weightGrams}g, ` +
            `Refund: ${refund.refundAmount} (${refundMode})`
        );
        fireHook('onReturnSaved', returnRecord);
        if (creditRow) fireHook('onAdvanceDeposit', creditRow);

        res.json({
            success: true,
            returnId,
            return: returnRecord,
            advanceCredit: creditRow,
            // What is left on the LINE just returned against…
            remainingWeightGrams: refund.remainingWeightAfter,
            // …and on the invoice as a whole, which is what the desk needs to
            // decide whether to offer another return against this bill at all.
            invoiceRemainingWeightGrams: round3(
                Math.max(0, state.returnableWeightGrams - refund.weightGrams)
            )
        });
    } catch (err) {
        logError('Error filing return: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to process the return: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Customer Advances Lookup
   ========================================================================== */

const ADVANCE_ROW_TYPES = ['deposit', 'redeem'];

/**
 * GET /api/advances?from=&to=&type=&limit=
 * A page of the advances ledger (deposits + redemptions), newest first, plus
 * the store's whole outstanding liability. Admin-only — powers the Dashboard
 * tile and the Advances tab.
 *
 * `summary` is deliberately computed over the ENTIRE ledger and ignores every
 * filter, because an advance balance is a lifetime running figure: what the
 * store owes a customer today is every deposit they ever made minus every
 * redemption, and a month's slice of that is not a balance. Only `totals`
 * describes the filtered period.
 */
app.get('/api/advances', requireAdminSession, (req, res) => {
    try {
        const q = parseLedgerQuery(req.query);
        if (!q.ok) return res.status(400).json({ error: q.error });

        // `type` narrows the page server-side. Without it, a screen wanting the
        // five most recent DEPOSITS had to over-fetch and filter, and could
        // still come back empty on a run of redemptions.
        const type = String(req.query.type || '').trim().toLowerCase();
        if (type && !ADVANCE_ROW_TYPES.includes(type)) {
            return res.status(400).json({ error: `Type must be one of: ${ADVANCE_ROW_TYPES.join(', ')}.` });
        }

        const advancesFile = path.join(DATA_DIR, 'advances.json');
        const advances = readJSON(advancesFile, []);
        advances.sort((a, b) => b.timestamp - a.timestamp);

        const matched = advances.filter(a =>
            withinRange(a, q.from, q.to) && (!type || (a && a.type === type))
        );
        res.json(pagedLedger(matched, q.limit, {
            summary: summarizeAdvanceLiability(advances),
            totals: {
                count: matched.length,
                depositAmount: round2(matched
                    .filter(a => a && a.type === 'deposit')
                    .reduce((sum, a) => sum + Math.abs(Number(a.amount) || 0), 0)),
                redeemedAmount: round2(matched
                    .filter(a => a && a.type === 'redeem')
                    .reduce((sum, a) => sum + Math.abs(Number(a.amount) || 0), 0))
            }
        }));
    } catch (err) {
        logError('Error retrieving advances ledger: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve advances ledger' });
    }
});

/**
 * GET /api/advances/customers?q=&limit=
 * One running-balance row per customer who has ever had an advance, newest
 * activity first. Admin-only — this is what the Advances tab lists.
 *
 * THE ROLLUP HAPPENS HERE, not in the browser. The Advances tab used to
 * download the entire ledger and collapse it per customer on the client, which
 * meant the tab could not be paged without silently reporting wrong balances:
 * a customer's spendable credit is every row they have ever had, so a page of
 * recent rows is not enough to compute it. Rolled up server-side, the browser
 * receives a bounded list of correct balances instead of unbounded history.
 *
 * Search is applied AFTER the rollup, so a cashier searching a phone number
 * matches on the customer, not on whichever of their rows happened to be in
 * the page.
 */
app.get('/api/advances/customers', requireAdminSession, (req, res) => {
    try {
        const limit = Math.min(LEDGER_PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || LEDGER_PAGE_DEFAULT));
        const q = String(req.query.q || '').trim().toLowerCase();

        const advances = readJSON(path.join(DATA_DIR, 'advances.json'), []);
        const byPhone = new Map();
        for (const row of advances) {
            if (!row) continue;
            const phone = row.customerPhone || '';
            if (!byPhone.has(phone)) byPhone.set(phone, { phone, name: '', lastActivity: 0, entries: [] });
            const c = byPhone.get(phone);
            c.lastActivity = Math.max(c.lastActivity, row.timestamp || 0);
            c.entries.push(row);
            // A deposit is the more authoritative "who this customer is" source
            // than a redemption, which copies the name off the sale.
            if (row.type === 'deposit' && row.customerName) c.name = row.customerName;
            else if (!c.name && row.customerName) c.name = row.customerName;
        }

        let customers = Array.from(byPhone.values()).map(c => {
            // The same summariser the tile, the portal and the redemption
            // lookup use — one rule for what counts as spendable credit.
            const summary = summarizeAdvanceLedger(c.entries);
            return {
                phone: c.phone,
                name: c.name,
                balance: summary.balance,
                pendingTotal: summary.pendingTotal,
                pendingCount: summary.pendingCount,
                entryCount: c.entries.length,
                lastActivity: c.lastActivity
            };
        });

        if (q) {
            const digits = q.replace(/\D/g, '');
            customers = customers.filter(c =>
                (digits.length > 0 && String(c.phone).includes(digits))
                || String(c.name || '').toLowerCase().includes(q)
            );
        }
        customers.sort((a, b) => b.lastActivity - a.lastActivity);

        res.json(pagedLedger(customers, limit, { summary: summarizeAdvanceLiability(advances) }));
    } catch (err) {
        logError('Error rolling up advance customers: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve advance customers' });
    }
});

/**
 * Computes one customer's advance balance and ledger history from the flat
 * advances.json file. Shared by the admin lookup (Billing Desk redemption)
 * and the session-scoped customer portal route so the cashier's screen and
 * the customer's screen can never show different balances.
 */
function computeAdvanceLedger(phone, advances = readJSON(path.join(DATA_DIR, 'advances.json'), [])) {
    const history = advances.filter(a => a.customerPhone === phone);
    // Shared with the Dashboard tile and the Advances tab rollup — a pending
    // deposit must not read as spendable credit in any of the three.
    const summary = summarizeAdvanceLedger(history);
    return {
        phone,
        balance: summary.balance,
        pendingTotal: summary.pendingTotal,
        pendingCount: summary.pendingCount,
        history
    };
}

/**
 * Appends a single deposit row to the advances ledger. This is the one write
 * path for every deposit source — counter entry, customer manual UPI, and
 * verified Razorpay — so the row shape and the locked-rate snapshot that the
 * Gold Appreciation calculator depends on are identical whichever door the
 * money came through.
 *
 * `status` is what separates money the store has actually seen from a
 * customer's unverified claim to have sent it:
 *   - counter entry and signature-verified Razorpay → 'approved' (the default)
 *   - customer-submitted manual UPI → 'pending', credited only once a cashier
 *     approves it at POST /api/advances/:id/approve
 * See ADVANCE_STATUS in frontend/js/lib/billingMath.js for how the balance
 * arithmetic treats each state.
 *
 * @returns {{success: boolean, error?: string, code?: string, deposit?: object}}
 */
/**
 * The shape of a deposit row in advances.json — built in exactly one place.
 *
 * Most deposits go through recordAdvanceDeposit(), which validates, checks the
 * reference for reuse, and commits on its own. A gold-mode refund cannot: its
 * credit row has to land in the SAME transaction as the return that created it
 * (POST /api/returns), or a crash between the two writes leaves either a
 * refund nobody was credited for or credit against a return that never
 * happened. So the row construction is split out here and both callers share
 * it, rather than the returns route growing a second, subtly-different idea of
 * what a deposit row looks like — which is how a field like
 * `lockedGoldRate22K` ends up missing on one code path and silently breaking
 * the customer portal's Gold Appreciation panel.
 *
 * `source` marks where the credit came from ('counter' by default,
 * 'return' for a refund). Additive: rows already on disk have no such field
 * and read as a counter deposit, which is what they are.
 */
function buildAdvanceDepositRow({
    customerPhone, customerName, amount, paymentMethod, referenceId,
    status = ADVANCE_STATUS.APPROVED, source = 'counter', invoiceId = '', returnId = '',
    actor = SYSTEM_ACTOR
}) {
    return {
        id: newId('ADV'),
        customerPhone,
        customerName: customerName || 'Regular Customer',
        type: 'deposit',
        amount: parseFloat(amount),
        paymentMethod: paymentMethod || 'UPI',
        referenceId: String(referenceId || '').trim(),
        status: normalizeAdvanceStatus({ type: 'deposit', status }),
        source,
        // Present only on a refund credit, so the customer portal and the
        // advances tab can say which invoice the credit came back from
        // instead of showing an unexplained deposit the customer never made.
        ...(invoiceId ? { invoiceId } : {}),
        ...(returnId ? { returnId } : {}),
        // Snapshotted at submission, NOT at approval: the customer's money moved
        // when they sent it, so the Gold Appreciation figure they were shown at
        // that moment is the one they are owed. A rate move during the approval
        // wait is the store's timing, not the customer's.
        lockedGoldRate22K: getActiveGoldRates().price22K,
        timestamp: Date.now(),
        /* WHO CREATED THIS ROW. Not who the money belongs to — who put it in the
           ledger. Defaults to SYSTEM_ACTOR because most callers are machinery: a
           signature-verified Razorpay capture, the webhook, a return credit
           filed by the store itself. A cashier keying a counter deposit passes
           their own session actor, so "the shop says this cash arrived" and
           "the gateway proved this transfer arrived" are distinguishable
           afterwards, which is the distinction the approval queue rests on.

           A CUSTOMER's own unverified UPI claim is neither: it is recorded with
           the system actor and status 'pending', and gains an `approvedBy` only
           when a manager releases it. */
        actor: { id: actor.id, name: actor.name, role: actor.role }
    };
}

function recordAdvanceDeposit({
    customerPhone, customerName, amount, paymentMethod, referenceId,
    status = ADVANCE_STATUS.APPROVED, actor = SYSTEM_ACTOR
}) {
    if (!isValidPhone(customerPhone)) {
        return { success: false, error: 'Valid 10-digit customer phone number required' };
    }
    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > MAX_SANE_AMOUNT) {
        return { success: false, error: 'Valid deposit amount required' };
    }
    if (customerName && String(customerName).length > 200) {
        return { success: false, error: 'Customer name is too long (max 200 characters).' };
    }

    const advancesFile = path.join(DATA_DIR, 'advances.json');
    const advances = readJSON(advancesFile, []);
    const cleanReference = String(referenceId || '').trim();

    // A payment reference identifies one real-world transfer, so it may appear
    // in the ledger exactly once. Without this, a customer could submit the
    // same UTR on three separate deposits and — since each row looks
    // individually plausible to whoever approves it — be credited three times
    // for one transfer. Enforced here rather than at the routes so every
    // present and future caller of this function inherits it.
    if (cleanReference) {
        const clash = advances.find(a =>
            a.type === 'deposit' && a.referenceId &&
            String(a.referenceId).trim().toLowerCase() === cleanReference.toLowerCase() &&
            normalizeAdvanceStatus(a) !== ADVANCE_STATUS.REJECTED
        );
        if (clash) {
            return {
                success: false,
                code: 'DUPLICATE_REFERENCE',
                error: `Reference "${cleanReference}" has already been submitted against deposit ${clash.id}. Each transaction reference can only be used once.`
            };
        }
    }

    const deposit = buildAdvanceDepositRow({
        customerPhone, customerName, amount: numAmount,
        paymentMethod, referenceId: cleanReference, status, actor
    });
    const resolvedStatus = deposit.status;

    advances.push(deposit);
    // Committed through the journalled path rather than a bare writeJSON so
    // advances.json has exactly one writer mechanism: /api/sales already
    // commits this same file inside a transaction when a sale redeems an
    // advance, and two different write mechanisms on one ledger is the kind of
    // parallel path that eventually loses a row.
    if (!writeJSONTransaction([{ filepath: advancesFile, data: advances }])) {
        return { success: false, error: 'Failed to persist advance deposit. Please retry.' };
    }

    logTelemetry('SAVE_ADVANCE_DEPOSIT', 0, `Amount: ${numAmount}, Method: ${deposit.paymentMethod}, Status: ${resolvedStatus}`);
    // Only settled money fires the deposit hook — an extension sending a
    // "deposit received" receipt must not fire on a claim awaiting approval.
    if (resolvedStatus === ADVANCE_STATUS.APPROVED) fireHook('onAdvanceDeposit', deposit);
    return { success: true, deposit };
}

/**
 * Moves a pending deposit to approved or rejected, in one read-modify-write so
 * a double-tapped Approve button cannot credit the same claim twice.
 *
 * `approver` is stamped onto the row and is the point of the whole pending
 * state: an unverified customer claim becomes spendable credit only when a named
 * person with an approving role says the transfer landed. Without a name on it,
 * "reconciled by a manager" was an aspiration rather than a record.
 *
 * @returns {{success: boolean, error?: string, status?: number, deposit?: object}}
 */
function reviewPendingDeposit(depositId, decision, note, approver = SYSTEM_ACTOR) {
    const advancesFile = path.join(DATA_DIR, 'advances.json');
    const advances = readJSON(advancesFile, []);
    const index = advances.findIndex(a => a.id === depositId && a.type === 'deposit');

    if (index === -1) {
        return { success: false, status: 404, error: 'No such deposit in the advances ledger.' };
    }
    const current = advances[index];
    const currentStatus = normalizeAdvanceStatus(current);
    if (currentStatus !== ADVANCE_STATUS.PENDING) {
        return {
            success: false,
            status: 409,
            error: `Deposit ${depositId} is already ${currentStatus} and cannot be reviewed again.`
        };
    }

    const reviewed = {
        ...current,
        status: decision,
        reviewedAt: Date.now(),
        reviewNote: String(note || '').trim().slice(0, 300),
        // Maps to advance_entries.approved_by_user_id, which the SQL schema
        // guards with CHECK (status <> 'posted' OR approved_by_user_id IS NOT
        // NULL) — no money claim may be posted anonymously.
        reviewedBy: { id: approver.id, name: approver.name, role: approver.role }
    };
    advances[index] = reviewed;
    if (!writeJSONTransaction([{ filepath: advancesFile, data: advances }])) {
        return { success: false, status: 500, error: 'Failed to save the review. Please retry.' };
    }

    logTelemetry(
        'REVIEW_ADVANCE_DEPOSIT', 0,
        `Deposit: ${depositId}, Decision: ${decision}, Amount: ${reviewed.amount}, By: ${approver.name} (${approver.role})`
    );
    // The hook deliberately fires here, on approval, rather than at submission:
    // this is the moment the credit becomes real for the customer.
    if (decision === ADVANCE_STATUS.APPROVED) fireHook('onAdvanceDeposit', reviewed);
    return { success: true, deposit: reviewed };
}

/**
 * GET /api/advances/lookup?phone=
 * Any customer's balance + ledger, by phone. Admin-only: this is the Billing
 * Desk's redemption lookup, where a cashier legitimately reads a customer's
 * account. Customers read their *own* ledger through the session-scoped
 * GET /api/customer/advances instead — before Phase 20.1 this route was
 * public, which is precisely what let anyone read any customer's history by
 * typing their phone number.
 */
app.get('/api/advances/lookup', requireAdminSession, (req, res) => {
    try {
        const { phone } = req.query;
        if (!isValidPhone(phone)) {
            return res.status(400).json({ error: 'Valid 10-digit phone number required' });
        }
        res.json(computeAdvanceLedger(phone));
    } catch (err) {
        logError('Error looking up customer advance balance: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to lookup customer balance' });
    }
});

/**
 * POST /api/advances
 * Counter deposit entry, keyed to any customer phone. Admin-only for the same
 * reason as the lookup above — a customer depositing through the portal posts
 * to POST /api/customer/advances, which can only ever credit their own phone.
 */
app.post('/api/advances', requireAdminSession, (req, res) => {
    try {
        // A cashier at the counter has seen the money, so a counter entry is
        // approved on arrival. `status` is pinned here rather than read from the
        // body so this route can never be used to inject a pending row — and
        // `actor` likewise, so the row names whoever's PIN opened this session
        // rather than whatever the payload claimed.
        const result = recordAdvanceDeposit({
            ...(req.body || {}),
            status: ADVANCE_STATUS.APPROVED,
            actor: req.actor
        });
        if (!result.success) {
            const status = result.code === 'DUPLICATE_REFERENCE' ? 409
                : result.error.startsWith('Failed to persist') ? 500 : 400;
            return res.status(status).json({ error: result.error, code: result.code });
        }
        res.json({ success: true, id: result.deposit.id, deposit: result.deposit });
    } catch (err) {
        logError('Error saving advance deposit transaction: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to submit advance deposit' });
    }
});

/**
 * GET /api/advances/pending
 * The counter's approval queue: every customer-submitted UPI deposit still
 * awaiting verification, oldest first so nobody's money sits at the bottom of
 * a stack indefinitely.
 */
app.get('/api/advances/pending', requireAdminSession, (req, res) => {
    try {
        const advances = readJSON(path.join(DATA_DIR, 'advances.json'), []);
        const pending = advances
            .filter(a => a.type === 'deposit' && normalizeAdvanceStatus(a) === ADVANCE_STATUS.PENDING)
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        res.json(pending);
    } catch (err) {
        logError('Error retrieving pending advance deposits: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve pending deposits' });
    }
});

/**
 * POST /api/advances/:id/approve
 * Credits a pending deposit once a manager has confirmed the transfer landed in
 * the store's account. This is the point the money becomes spendable.
 *
 * requireApprover, not just requireAdminSession: releasing an unverified
 * customer claim into a spendable balance is the one counter action a cashier
 * must not be able to take alone. That control is only meaningful now that a
 * session has a role at all — before, "manager approval" named a person who did
 * not exist in the system.
 */
app.post('/api/advances/:id/approve', requireAdminSession, requireApprover, (req, res) => {
    try {
        const result = reviewPendingDeposit(
            req.params.id, ADVANCE_STATUS.APPROVED, (req.body || {}).note, req.actor
        );
        if (!result.success) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, deposit: result.deposit });
    } catch (err) {
        logError('Error approving advance deposit: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to approve the deposit' });
    }
});

/**
 * POST /api/advances/:id/reject
 * Marks a claimed transfer as not received. The row is kept rather than deleted
 * — a rejected claim is exactly the history worth being able to look back on,
 * and a reason is required so the customer can be told something specific.
 *
 * Approver-gated for the same reason as approve: refusing a customer's claim
 * that they paid is as consequential a call as accepting it, and both belong to
 * whoever carries the reconciliation.
 */
app.post('/api/advances/:id/reject', requireAdminSession, requireApprover, (req, res) => {
    try {
        const note = String((req.body || {}).note || '').trim();
        if (!note) {
            return res.status(400).json({ error: 'A reason is required when rejecting a deposit claim.' });
        }
        const result = reviewPendingDeposit(req.params.id, ADVANCE_STATUS.REJECTED, note, req.actor);
        if (!result.success) return res.status(result.status).json({ error: result.error });
        res.json({ success: true, deposit: result.deposit });
    } catch (err) {
        logError('Error rejecting advance deposit: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to reject the deposit' });
    }
});

/* ==========================================================================
   API Routes: Razorpay Payment Gateway Integration
   ========================================================================== */

/**
 * One authenticated call to the Razorpay REST API over the native https
 * module. Every gateway interaction goes through here — order creation and
 * the capture confirmation below — so timeout, auth and error handling are
 * defined once instead of per call site.
 *
 * A timeout is mandatory rather than optional: without one, a gateway that
 * accepts the connection and then stalls holds the customer's verify request
 * open indefinitely, and Node's default socket timeout would not fire.
 *
 * @returns {Promise<object>} the parsed JSON body on 2xx
 */
function razorpayRequest({ method, path: apiPath, body, keyId, keySecret, timeoutMs = 15000 }) {
    return new Promise((resolve, reject) => {
        const postData = body === undefined ? null : JSON.stringify(body);
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

        const request = https.request({
            hostname: 'api.razorpay.com',
            port: 443,
            path: apiPath,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`,
                ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
            }
        }, (response) => {
            let responseBody = '';
            response.on('data', (chunk) => responseBody += chunk);
            response.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(responseBody);
                } catch (e) {
                    return reject(new Error(`Razorpay returned an unparseable response (HTTP ${response.statusCode})`));
                }
                if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
                reject(new Error(parsed.error ? parsed.error.description : `Razorpay API error (HTTP ${response.statusCode})`));
            });
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error(`Razorpay API did not respond within ${timeoutMs}ms`));
        });
        request.on('error', (err) => reject(err));
        if (postData) request.write(postData);
        request.end();
    });
}

/** Creates a gateway order for an amount already converted to paise. */
function createRazorpayOrder(amountPaise, currency, keyId, keySecret) {
    return razorpayRequest({
        method: 'POST',
        path: '/v1/orders',
        body: {
            amount: amountPaise,
            currency,
            receipt: newId('RCPT')
        },
        keyId,
        keySecret
    });
}

/**
 * Asks Razorpay what actually happened to a payment.
 *
 * This is the only source of truth about whether money moved. The checkout
 * signature proves a payment id was issued against our order by our key — it
 * does NOT prove the payment was captured, and it carries no amount, so a
 * payment that was authorised and then failed, was refunded, or was captured
 * for a different amount produces an identical, perfectly valid signature.
 */
function fetchRazorpayPayment(paymentId, keyId, keySecret) {
    return razorpayRequest({
        method: 'GET',
        path: `/v1/payments/${encodeURIComponent(paymentId)}`,
        keyId,
        keySecret
    });
}

/* --------------------------------------------------------------------------
   Payment order records

   The gateway handshake spans two requests: the browser asks us to create an
   order, then comes back claiming it paid. Nothing tied those two halves
   together before, so /api/payment/verify had to believe req.body.amount —
   meaning a customer could create a ₹100 order, pay ₹100, and post back
   amount: 500000 to have half a lakh credited to their ledger. The signature
   could not catch it: Razorpay's HMAC covers order_id|payment_id only, with no
   amount in the signed text at all.

   Persisting what each order was actually FOR closes that. Verification reads
   the amount from this file and ignores the body's entirely.
   -------------------------------------------------------------------------- */

const PAYMENT_ORDERS_FILE = () => path.join(DATA_DIR, 'payment_orders.json');

// An order is a short-lived intent, not history worth keeping — the ledger is
// the permanent record. Keeping the file bounded stops an abandoned-checkout
// habit growing it without limit.
const PAYMENT_ORDER_TTL_MS = 24 * 60 * 60 * 1000;
const PAYMENT_ORDER_MAX_ROWS = 2000;

/* Amounts on the wire to Razorpay are integer paise, never rupees. A rupee
   float cannot represent every payable amount exactly (₹1234.35 is stored as
   1234.3499999999999), so comparing "what the gateway captured" against "what
   we recorded" in rupees means comparing two roundings and hoping they agree.
   In paise both sides are integers and the comparison is exact — which is the
   whole point of confirming capture at all. `amountPaise` is therefore the
   authoritative field on an order; `amount` is kept alongside it, in rupees,
   only so order rows written by earlier builds stay readable.

   toPaise/fromPaise live in frontend/js/lib/billingMath.js with the rest of
   this project's money arithmetic. */

/** When a stored order lapses, tolerating rows written before `expiresAt`. */
function paymentOrderExpiry(order) {
    return Number.isFinite(order.expiresAt)
        ? order.expiresAt
        : (order.createdAt || 0) + PAYMENT_ORDER_TTL_MS;
}

/** The authoritative paise amount of a stored order, tolerating legacy rows. */
function orderAmountPaise(order) {
    return Number.isInteger(order.amountPaise) ? order.amountPaise : toPaise(order.amount);
}

/**
 * Records what an order was created for, so verification has a server-side
 * amount to trust instead of the client's claim.
 * @returns {boolean} false if the record could not be persisted
 */
function recordPaymentOrder({ orderId, customerPhone, amountPaise, currency = 'INR' }) {
    const file = PAYMENT_ORDERS_FILE();
    const now = Date.now();
    const orders = readJSON(file, [])
        // Prune on write — an expired order intent has no further use, and this
        // is the only moment the file is already open. Rows written before
        // expiresAt existed fall back to their creation time plus the TTL.
        .filter(o => o && o.orderId &&
            paymentOrderExpiry(o) > now &&
            o.orderId !== orderId)
        .slice(-PAYMENT_ORDER_MAX_ROWS);

    orders.push({
        orderId,
        customerPhone,
        amountPaise,
        // Rupee mirror, for legacy readers and for logging only. Never compared
        // against a gateway figure — see the paise note above.
        amount: fromPaise(amountPaise),
        currency,
        status: 'created',
        createdAt: now,
        // Stored explicitly rather than left implicit in the prune arithmetic,
        // so the lifetime an order was actually issued under travels with the
        // row — changing PAYMENT_ORDER_TTL_MS then cannot retroactively expire
        // orders that were promised a longer life.
        //
        // Note what expiry deliberately does NOT do: it never refuses credit.
        // An expired order whose payment the gateway confirms as captured is
        // real money that really moved, and refusing it would strand the
        // customer rather than protect anyone. Expiry bounds how long an
        // *unpaid* intent is kept, nothing more; the capture confirmation in
        // /api/payment/verify is what actually authorises a credit.
        expiresAt: now + PAYMENT_ORDER_TTL_MS
    });
    return writeJSONTransaction([{ filepath: file, data: orders }]);
}

/** The stored order behind an order id, or null if we never created it. */
function findPaymentOrder(orderId) {
    return readJSON(PAYMENT_ORDERS_FILE(), [])
        .find(o => o && o.orderId === orderId) || null;
}

/**
 * Moves an order to a terminal state, linking it to the payment and, when the
 * money was credited, to the ledger row it produced.
 */
function settlePaymentOrder(orderId, status, { paymentId, depositId, note } = {}) {
    const file = PAYMENT_ORDERS_FILE();
    const orders = readJSON(file, []);
    const index = orders.findIndex(o => o && o.orderId === orderId);
    if (index === -1) return;
    orders[index] = {
        ...orders[index],
        status,
        ...(paymentId ? { paymentId } : {}),
        ...(depositId ? { depositId } : {}),
        ...(note ? { note } : {}),
        settledAt: Date.now()
    };
    writeJSONTransaction([{ filepath: file, data: orders }]);
}

/**
 * POST /api/payment/order
 * Initiates order with Razorpay. Returns orderId. Customer-session-gated: an
 * unauthenticated caller could otherwise mint orders against the store's
 * Razorpay account at will.
 *
 * The order is recorded against the session's phone before the id goes back to
 * the browser — that record is what binds the eventual payment to both a
 * customer and an amount.
 */
app.post('/api/payment/order', requireEstablishedCustomer, async (req, res) => {
    const startTime = Date.now();
    try {
        const { amount } = req.body;
        const numAmount = parseFloat(amount);
        if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > MAX_SANE_AMOUNT) {
            return res.status(400).json({ error: 'Valid amount is required' });
        }
        // Converted once, here, and used for the gateway call, the stored
        // record and the eventual capture comparison alike. Converting more
        // than once is how the three drift apart.
        const amountPaise = toPaise(numAmount);
        if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
            return res.status(400).json({ error: 'Valid amount is required' });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});

        const currency = settings.currency || 'INR';
        const keyId = settings.razorpayKeyId;
        const keySecret = settings.razorpayKeySecret;

        if (!keyId || !keySecret) {
            return res.status(400).json({ error: 'Razorpay API credentials are not configured in system settings.' });
        }

        if (IS_PRODUCTION && (keyId === MOCK_RAZORPAY_KEY_ID || keySecret === MOCK_RAZORPAY_SECRET)) {
            logError('Blocked Razorpay order creation because demo credentials are configured in production.');
            return res.status(503).json({ error: 'Razorpay production credentials are not configured.' });
        }

        // Local/demo checkout is never reachable in a production process.
        if (MOCK_PAYMENTS_ENABLED && keyId === MOCK_RAZORPAY_KEY_ID && keySecret === MOCK_RAZORPAY_SECRET) {
            const mockOrderId = 'order_mock_' + crypto.randomBytes(6).toString('hex');
            // Mock orders are persisted too, so the demo path exercises the same
            // amount-binding the real one does instead of diverging from it.
            if (!recordPaymentOrder({ orderId: mockOrderId, customerPhone: req.customerPhone, amountPaise, currency })) {
                return res.status(500).json({ error: 'Could not start the payment. Please retry.' });
            }
            logTelemetry('PAYMENT_ORDER_MOCKED', 0, `Order: ${mockOrderId}, Paise: ${amountPaise}`);
            return res.json({
                success: true,
                keyId,
                order: { id: mockOrderId, amount: amountPaise, currency }
            });
        }

        const order = await createRazorpayOrder(amountPaise, currency, keyId, keySecret);

        // Recorded BEFORE the id reaches the browser: an order the customer can
        // pay but that we have no record of would be unverifiable, and the
        // customer would be out of pocket with nothing to show for it.
        if (!recordPaymentOrder({ orderId: order.id, customerPhone: req.customerPhone, amountPaise, currency })) {
            logError(`Razorpay order ${order.id} was created at the gateway but could not be recorded locally — not returning it to the customer.`);
            return res.status(500).json({ error: 'Could not start the payment. Please retry.' });
        }

        logTelemetry('PAYMENT_ORDER_CREATED', Date.now() - startTime, `Order: ${order.id}, Paise: ${amountPaise}`);
        res.json({
            success: true,
            keyId,
            order
        });
    } catch (err) {
        logError('Error creating Razorpay order: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
    }
});

/* --------------------------------------------------------------------------
   Crediting a gateway payment

   Two independent paths end here: the browser calling /api/payment/verify
   after checkout, and Razorpay calling /api/payment/webhook server-to-server.
   They race by design — the webhook frequently lands first, and the browser
   path does not run at all if the customer closes the tab on the success
   screen, which is exactly why the webhook exists.

   So this is deliberately the ONE routine that turns a confirmed capture into
   ledger credit. Both callers arrive having already established the same two
   facts (this payment belongs to that stored order, and the gateway says it
   was captured for the order's exact amount); everything downstream of that —
   deduplication, the ledger row, settling the order — happens here once.
   -------------------------------------------------------------------------- */

/**
 * @param {object} args
 * @param {object} args.order       the stored payment order this payment settles
 * @param {string} args.paymentId   the gateway's payment id (the idempotency key)
 * @param {number} args.capturedPaise what the gateway reports it actually took
 * @param {string} args.source      'checkout' or 'webhook', for the audit trail
 * @returns {{ok: boolean, duplicate?: boolean, deposit?: object, status?: number, error?: string}}
 */
function creditCapturedPayment({ order, paymentId, capturedPaise, source }) {
    const expectedPaise = orderAmountPaise(order);

    // Exact integer comparison. A capture that does not match the order we
    // created is never credited on a guess in either direction: crediting the
    // larger figure would let a tampered checkout mint balance, and crediting
    // the smaller would quietly short a customer who really did pay more.
    if (!Number.isInteger(capturedPaise) || capturedPaise !== expectedPaise) {
        logError(
            `Razorpay payment ${paymentId} was captured for ${capturedPaise} paise but order ` +
            `${order.orderId} was created for ${expectedPaise} paise. Refusing to credit; manual reconciliation required.`
        );
        logTelemetry('PAYMENT_AMOUNT_MISMATCH', 0, `Order: ${order.orderId}, captured: ${capturedPaise}, expected: ${expectedPaise}`);
        settlePaymentOrder(order.orderId, 'mismatched', {
            paymentId,
            note: `captured ${capturedPaise} paise against an expected ${expectedPaise}`
        });
        return {
            ok: false,
            status: 409,
            error: 'The captured amount does not match this payment order. Please contact the store with your payment ID: ' + paymentId
        };
    }

    const account = findAccount(order.customerPhone);
    const result = recordAdvanceDeposit({
        customerPhone: order.customerPhone,
        customerName: (account && account.name) || 'Regular Customer',
        amount: fromPaise(expectedPaise),
        paymentMethod: 'Razorpay',
        // The gateway payment id doubles as the ledger's idempotency key — see
        // the duplicate-reference guard inside recordAdvanceDeposit. That guard
        // is what makes the checkout/webhook race safe rather than merely
        // unlikely: whichever arrives second is rejected as a duplicate.
        referenceId: paymentId,
        status: ADVANCE_STATUS.APPROVED
    });

    if (!result.success) {
        if (result.code === 'DUPLICATE_REFERENCE') {
            const existing = readJSON(path.join(DATA_DIR, 'advances.json'), [])
                .find(a => a.referenceId && String(a.referenceId).trim() === paymentId);
            logTelemetry('PAYMENT_CREDIT_DUPLICATE', 0, `PayId: ${paymentId}, via: ${source}`);
            return { ok: true, duplicate: true, deposit: existing || null };
        }
        // The money has already left the customer's account at this point, so
        // this is a reconciliation incident, not a retryable error.
        logError(`CRITICAL: Razorpay payment ${paymentId} was captured but the advance deposit failed to persist — customer ${order.customerPhone} paid but has no ledger credit. Manual reconciliation required.`);
        return {
            ok: false,
            status: 500,
            error: 'Payment captured but could not be recorded. Please contact support with your payment ID: ' + paymentId
        };
    }

    // Settled last: the ledger row above is the entry that matters, and a
    // failure to annotate the order must not fail a payment already credited.
    settlePaymentOrder(order.orderId, 'paid', { paymentId, depositId: result.deposit.id, note: source });
    logTelemetry('PAYMENT_CREDITED', 0, `Deposit: ${result.deposit.id}, PayId: ${paymentId}, via: ${source}`);
    return { ok: true, deposit: result.deposit };
}

/**
 * POST /api/payment/verify
 * Verifies the Razorpay checkout signature, CONFIRMS WITH THE GATEWAY that the
 * payment was actually captured for this order's amount, and logs the deposit
 * in advances.json. Customer-session-gated, and the deposit is always credited
 * to the *session's* phone — the body can no longer name whose account gets it.
 */
app.post('/api/payment/verify', requireEstablishedCustomer, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const customerPhone = req.customerPhone;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment details for verification' });
        }

        // Idempotency: a retried or replayed verify call (flaky mobile network,
        // a double-tapped handler, a captured request) must not credit the
        // same gateway payment twice.
        //
        // Deliberately ahead of the order lookup below: order records are pruned
        // after PAYMENT_ORDER_TTL_MS, so a late replay of a payment that WAS
        // credited must still be answered with its ledger row rather than the
        // "order not recognised" error a pruned lookup would produce.
        const alreadyRecorded = readJSON(path.join(DATA_DIR, 'advances.json'), [])
            .find(a => a.referenceId && a.referenceId === razorpay_payment_id);
        if (alreadyRecorded) {
            logTelemetry('PAYMENT_VERIFY_REPLAYED', 0, `PayId: ${razorpay_payment_id}`);
            return res.json({
                success: true,
                id: alreadyRecorded.id,
                duplicate: true,
                message: 'This payment was already recorded.'
            });
        }

        // The amount comes from the order WE created and stored, never from the
        // request body — see the payment order records block above for why the
        // signature cannot police this. req.body.amount is deliberately not
        // read here at all; the portal no longer sends it.
        const storedOrder = findPaymentOrder(razorpay_order_id);
        if (!storedOrder) {
            logTelemetry('PAYMENT_VERIFY_UNKNOWN_ORDER', 0, `Order: ${razorpay_order_id}`);
            return res.status(400).json({
                error: 'This payment order is not recognised. If you were charged, contact the store with your payment ID: ' + razorpay_payment_id
            });
        }
        // An order belongs to the customer who opened it. Without this a signed-in
        // customer could verify somebody else's order id and take the credit.
        if (storedOrder.customerPhone !== customerPhone) {
            logError(`Customer ${customerPhone} attempted to verify payment order ${razorpay_order_id}, which belongs to another customer.`);
            return res.status(403).json({ error: 'This payment order does not belong to your account.' });
        }
        const expectedPaise = orderAmountPaise(storedOrder);
        if (!Number.isSafeInteger(expectedPaise) || expectedPaise <= 0 || expectedPaise > MAX_SANE_AMOUNT * 100) {
            logError(`Payment order ${razorpay_order_id} carries an unusable stored amount (${storedOrder.amountPaise ?? storedOrder.amount}).`);
            return res.status(500).json({ error: 'This payment order is not in a verifiable state. Please contact the store.' });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        const keyId = settings.razorpayKeyId;
        const keySecret = settings.razorpayKeySecret;

        if (!keySecret) {
            return res.status(500).json({ error: 'Razorpay secret key is not configured' });
        }
        if (IS_PRODUCTION && keySecret === MOCK_RAZORPAY_SECRET) {
            logError('Blocked Razorpay verification because a demo secret is configured in production.');
            return res.status(503).json({ error: 'Razorpay production credentials are not configured.' });
        }

        // Verify SHA-256 HMAC signature
        const text = razorpay_order_id + "|" + razorpay_payment_id;
        const generated_signature = crypto
            .createHmac('sha256', keySecret)
            .update(text)
            .digest('hex');

        const signatureMatches = generated_signature.length === String(razorpay_signature).length &&
            crypto.timingSafeEqual(Buffer.from(generated_signature), Buffer.from(String(razorpay_signature)));
        const isLocalMockPayment = MOCK_PAYMENTS_ENABLED &&
            keySecret === MOCK_RAZORPAY_SECRET &&
            String(razorpay_order_id).startsWith('order_mock_');
        if (!signatureMatches && !isLocalMockPayment) {
            logTelemetry('PAYMENT_SIGNATURE_MISMATCH', 0, `Order: ${razorpay_order_id}`);
            return res.status(400).json({ error: 'Payment signature verification failed. Possible fraud attempt.' });
        }

        /* Ask the gateway what actually happened.

           A valid signature proves only that this payment id was issued against
           our order id by whoever holds our key secret. It says nothing about
           the outcome: an authorised-but-uncaptured payment, one that later
           failed, one already refunded, and one captured for a different amount
           all produce a signature that verifies perfectly. Razorpay's HMAC text
           is `order_id|payment_id` — there is no amount and no status in it to
           check. Until this call, "verified" meant "well-formed", and the
           store credited the customer on the strength of that. */
        let capturedPaise = expectedPaise;
        let gatewayStatus = 'captured';
        if (!isLocalMockPayment) {
            let payment;
            try {
                payment = await fetchRazorpayPayment(razorpay_payment_id, keyId, keySecret);
            } catch (lookupErr) {
                // Do NOT credit on a failed lookup. The webhook is the safety
                // net for exactly this case: if the payment really was captured,
                // Razorpay will tell us server-to-server and the credit lands
                // then, without the customer having to do anything.
                logError(`Could not confirm Razorpay payment ${razorpay_payment_id} with the gateway: ${lookupErr.message}`);
                logTelemetry('PAYMENT_CAPTURE_LOOKUP_FAILED', 0, `PayId: ${razorpay_payment_id}`);
                return res.status(503).json({
                    error: 'We could not confirm this payment with the gateway just now. If it succeeded it will be credited automatically within a few minutes — please check your balance shortly before retrying.',
                    pending: true
                });
            }

            gatewayStatus = String(payment.status || '').toLowerCase();
            capturedPaise = Number(payment.amount);

            // The payment must belong to the order we looked up, or an attacker
            // holding any valid (order, payment) pair could pair a ₹1 payment
            // with a ₹50,000 order.
            if (payment.order_id && payment.order_id !== razorpay_order_id) {
                logError(`Razorpay payment ${razorpay_payment_id} belongs to order ${payment.order_id}, not the claimed ${razorpay_order_id}.`);
                return res.status(400).json({ error: 'This payment does not belong to the stated payment order.' });
            }

            if (gatewayStatus === 'authorized' || gatewayStatus === 'created') {
                // Real money, not yet settled to the merchant. The webhook will
                // credit it on payment.captured; saying so is more honest than
                // either failing or crediting early.
                logTelemetry('PAYMENT_AWAITING_CAPTURE', 0, `PayId: ${razorpay_payment_id}, status: ${gatewayStatus}`);
                return res.status(202).json({
                    success: false,
                    pending: true,
                    message: 'Your payment has been authorised and is awaiting capture. It will appear in your balance automatically once the gateway settles it.'
                });
            }

            if (gatewayStatus !== 'captured') {
                logTelemetry('PAYMENT_NOT_CAPTURED', 0, `PayId: ${razorpay_payment_id}, status: ${gatewayStatus}`);
                settlePaymentOrder(razorpay_order_id, 'failed', { paymentId: razorpay_payment_id, note: `gateway status ${gatewayStatus}` });
                return res.status(400).json({
                    error: `This payment was not completed (gateway status: ${gatewayStatus}). Nothing has been credited.`
                });
            }
        }

        const credit = creditCapturedPayment({
            order: storedOrder,
            paymentId: razorpay_payment_id,
            capturedPaise,
            source: 'checkout'
        });
        if (!credit.ok) {
            return res.status(credit.status || 500).json({ error: credit.error });
        }

        logTelemetry('PAYMENT_VERIFIED_SUCCESS', 0, `Deposit: ${credit.deposit ? credit.deposit.id : 'n/a'}, PayId: ${razorpay_payment_id}`);
        res.json({
            success: true,
            id: credit.deposit ? credit.deposit.id : null,
            amount: credit.deposit ? credit.deposit.amount : fromPaise(expectedPaise),
            duplicate: !!credit.duplicate,
            message: credit.duplicate
                ? 'This payment was already recorded.'
                : 'Payment captured and logged successfully'
        });
    } catch (err) {
        logError('Error verifying Razorpay payment: ' + err.message, err.stack);
        res.status(500).json({ error: 'Verification failed: ' + err.message });
    }
});

/* ==========================================================================
   Razorpay webhook ingestion

   The checkout callback in the browser is a courtesy, not a guarantee. The
   customer's tab can close on the success screen, their phone can lose signal
   between the UPI app and the return redirect, or the handler can simply throw
   — and in every one of those cases the money has moved and the store's ledger
   never hears about it. The customer is then out of pocket with no balance,
   and the only trace is in Razorpay's dashboard.

   The webhook is the authoritative channel: Razorpay delivers it
   server-to-server, independently of the browser, and retries on any non-2xx
   for hours. Which means:

     - it must be idempotent (retries and duplicates are normal traffic, not
       error cases), keyed on the gateway's own event id;
     - it must tolerate out-of-order delivery — a payment.captured can arrive
       before, after, or instead of the browser's verify call;
     - it must answer 2xx for anything it has consciously decided not to act
       on, or Razorpay will redeliver it indefinitely. A 4xx here means "this
       delivery was not authentic", nothing else.
   ========================================================================== */

const PAYMENT_EVENTS_FILE = () => path.join(DATA_DIR, 'payment_events.json');
const PAYMENT_EVENT_MAX_ROWS = 5000;

/**
 * Records that a gateway event id has been seen, and reports whether it had
 * been seen already.
 *
 * Read-modify-write in one synchronous pass, like every other ledger writer
 * here — Node's run-to-completion semantics are what make that safe against
 * two concurrent retries of the same delivery (see the note in db.js).
 *
 * @returns {{alreadySeen: boolean, previous?: object}}
 */
function claimPaymentEvent(eventId, eventType) {
    const file = PAYMENT_EVENTS_FILE();
    const events = readJSON(file, []);
    const previous = events.find(e => e && e.eventId === eventId);
    if (previous) return { alreadySeen: true, previous };

    events.push({ eventId, eventType, receivedAt: Date.now() });
    writeJSONTransaction([{ filepath: file, data: events.slice(-PAYMENT_EVENT_MAX_ROWS) }]);
    return { alreadySeen: false };
}

/**
 * POST /api/payment/webhook
 *
 * Unauthenticated by session — the caller is Razorpay, not a browser — but not
 * unauthenticated: every delivery must carry an `x-razorpay-signature` that is
 * an HMAC-SHA256 of the raw request body under the webhook secret configured
 * in Settings. Without a configured secret the endpoint rejects everything,
 * because an endpoint that credits ledgers on an unverifiable POST is strictly
 * worse than one that does not exist.
 */
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
        const webhookSecret = settings.razorpayWebhookSecret;
        if (!webhookSecret) {
            logError('Razorpay webhook delivery rejected: no razorpayWebhookSecret is configured in Settings.');
            return res.status(503).json({ error: 'Webhook endpoint is not configured.' });
        }

        // express.raw() left this as a Buffer; anything else means the route
        // was reached without the raw parser and the signature cannot be
        // trusted, so refuse rather than verify something reconstructed.
        const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
        if (!rawBody || rawBody.length === 0) {
            return res.status(400).json({ error: 'Empty or unreadable webhook body.' });
        }

        const providedSignature = String(req.get('x-razorpay-signature') || '');
        const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
        const signatureMatches =
            providedSignature.length === expectedSignature.length &&
            crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
        if (!signatureMatches) {
            logError('Razorpay webhook delivery rejected: signature mismatch.');
            logTelemetry('WEBHOOK_SIGNATURE_MISMATCH', 0, '');
            return res.status(400).json({ error: 'Invalid webhook signature.' });
        }

        let event;
        try {
            event = JSON.parse(rawBody.toString('utf8'));
        } catch (parseErr) {
            return res.status(400).json({ error: 'Webhook body is not valid JSON.' });
        }

        // Razorpay sends the event id in a header; fall back to a digest of the
        // signed body so a delivery without one is still deduplicated rather
        // than being treated as new on every retry.
        const eventId = String(req.get('x-razorpay-event-id') || '') ||
            'sha-' + crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
        const eventType = String(event.event || 'unknown');

        const claim = claimPaymentEvent(eventId, eventType);
        if (claim.alreadySeen) {
            logTelemetry('WEBHOOK_REPLAYED', 0, `Event: ${eventId}, type: ${eventType}`);
            return res.json({ success: true, duplicate: true });
        }

        const entity = event.payload && event.payload.payment && event.payload.payment.entity;

        // Everything below returns 2xx even when it takes no action: these are
        // authentic deliveries we have consciously chosen not to act on, and a
        // non-2xx would have Razorpay redeliver them for hours.
        if (eventType !== 'payment.captured') {
            if (eventType === 'payment.failed' && entity && entity.order_id) {
                settlePaymentOrder(entity.order_id, 'failed', {
                    paymentId: entity.id,
                    note: (entity.error_description || 'payment.failed').slice(0, 200)
                });
            }
            logTelemetry('WEBHOOK_IGNORED', 0, `Event: ${eventId}, type: ${eventType}`);
            return res.json({ success: true, ignored: eventType });
        }

        if (!entity || !entity.id || !entity.order_id) {
            logError(`Razorpay webhook ${eventId} carried a payment.captured with no usable payment entity.`);
            return res.json({ success: true, ignored: 'malformed-entity' });
        }

        const storedOrder = findPaymentOrder(entity.order_id);
        if (!storedOrder) {
            // Not necessarily an attack: an order older than the retention
            // window prunes away, and this store may share a Razorpay account
            // with another product. Loud in the log, 2xx on the wire.
            logError(`Razorpay webhook ${eventId} referenced unknown payment order ${entity.order_id} (payment ${entity.id}). No credit applied.`);
            logTelemetry('WEBHOOK_UNKNOWN_ORDER', 0, `Order: ${entity.order_id}`);
            return res.json({ success: true, ignored: 'unknown-order' });
        }

        const credit = creditCapturedPayment({
            order: storedOrder,
            paymentId: entity.id,
            capturedPaise: Number(entity.amount),
            source: 'webhook'
        });

        if (!credit.ok) {
            // A 5xx here is the correct answer: the delivery was authentic and
            // we failed to apply it, so we want Razorpay's retry. The event id
            // claim is released so that retry is not swallowed as a duplicate.
            if (credit.status === 500) {
                releasePaymentEvent(eventId);
                return res.status(500).json({ error: 'Could not record the captured payment; please retry.' });
            }
            // An amount mismatch is a decision, not a failure — retrying it
            // would produce the same answer forever.
            return res.json({ success: true, ignored: 'amount-mismatch' });
        }

        logTelemetry('WEBHOOK_CAPTURED_CREDITED', 0, `Event: ${eventId}, PayId: ${entity.id}, duplicate: ${!!credit.duplicate}`);
        res.json({ success: true, duplicate: !!credit.duplicate });
    } catch (err) {
        logError('Error handling Razorpay webhook: ' + err.message, err.stack);
        // Deliberately 5xx: an unexpected fault should be retried by the
        // gateway rather than silently dropped.
        res.status(500).json({ error: 'Webhook processing failed.' });
    }
});

/** Undoes a claimPaymentEvent, so a delivery we failed to apply can be retried. */
function releasePaymentEvent(eventId) {
    const file = PAYMENT_EVENTS_FILE();
    const events = readJSON(file, []).filter(e => !e || e.eventId !== eventId);
    writeJSONTransaction([{ filepath: file, data: events }]);
}

/* ==========================================================================
   API Routes: Backups & Business Summary Reports
   ========================================================================== */

/**
 * POST /api/backup/run
 * Manually triggers an immediate rolling database snapshot (same routine
 * the 1:00 AM cron uses).
 */
app.post('/api/backup/run', requireAdminSession, (req, res) => {
    try {
        const result = createBackup();
        res.json(result);
    } catch (err) {
        logError('Manual backup trigger failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
});

/**
 * POST /api/reports/send-now
 * Manually sends a Daily or Monthly business summary email immediately
 * (rather than waiting for the 7:00 AM / monthly cron), so a tenant can
 * verify their SMTP configuration. Gracefully reports back if SMTP or a
 * recipient address isn't configured — never throws for that case.
 */
app.post('/api/reports/send-now', requireAdminSession, async (req, res) => {
    try {
        const period = req.body.period === 'Monthly' ? 'Monthly' : 'Daily';
        const result = await sendSummaryReport(period);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        logError('Manual report send failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Report send failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: QR Code Generation
   ========================================================================== */

/**
 * GET /api/qrcode?data=<text>
 * Renders a real, scannable QR code (PNG data URL) for arbitrary text —
 * used by the customer portal to encode a UPI payment deep link. Public:
 * the customer portal has no admin session to attach.
 */
app.get('/api/qrcode', async (req, res) => {
    try {
        const data = req.query.data;
        if (!data || typeof data !== 'string') {
            return res.status(400).json({ error: 'Query parameter "data" is required' });
        }
        const dataUrl = await QRCode.toDataURL(data, { margin: 1, width: 300 });
        res.json({ dataUrl });
    } catch (err) {
        logError('QR code generation failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

/* ==========================================================================
   API Routes: SaaS Licensing & Activation Gates
   ========================================================================== */

/**
 * GET /api/license/status
 * Returns current local licensing status and details.
 */
app.get('/api/license/status', (req, res) => {
    try {
        const licenseFile = path.join(DATA_DIR, 'license.json');
        const license = readJSON(licenseFile, { activated: false, status: 'inactive', expiryDate: null, lastHandshakeTime: 0 });
        res.json({
            isValid: isLicenseValid(),
            license
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read license status' });
    }
});

/**
 * POST /api/license/activate
 * Triggers an online sync to activate a new or existing license key configuration.
 */
app.post('/api/license/activate', async (req, res) => {
    try {
        const { licenseKey } = req.body;
        if (!licenseKey) {
            return res.status(400).json({ error: 'License key parameter is mandatory' });
        }

        const syncResult = await syncLicenseStatus(licenseKey);
        if (syncResult.success) {
            res.json({ success: true, license: syncResult.license });
        } else {
            res.status(400).json({ success: false, error: syncResult.error });
        }
    } catch (err) {
        res.status(500).json({ error: 'License activation failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Tiered Auto-Update Engine
   ========================================================================== */

/**
 * POST /api/admin/update/check
 * Manually triggers the same check the daily 2:00 AM scheduler runs:
 * verified `security`-channel releases auto-apply, anything else newer is
 * just recorded as pending for manual review.
 */
app.post('/api/admin/update/check', requireAdminSession, async (req, res) => {
    try {
        await checkForUpdates();
        const license = readJSON(path.join(DATA_DIR, 'license.json'), {});
        res.json({ success: true, pendingRelease: license.pendingRelease || null, lastAppliedRelease: license.lastAppliedRelease || null });
    } catch (err) {
        logError('Manual update check failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Update check failed: ' + err.message });
    }
});

/**
 * POST /api/admin/update/apply
 * Manually applies whatever release is currently pending (feature/patch
 * channel — security releases already auto-applied and never sit pending).
 * This is the human-approval gate for non-urgent releases.
 */
app.post('/api/admin/update/apply', requireAdminSession, async (req, res) => {
    try {
        const result = await applyPendingUpdate();
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        logError('Manual update apply failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Update apply failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Diagnostics & Telemetry
   ========================================================================= */

/**
 * GET /api/diagnostics/telemetry
 * Level 1 Diagnostics: Returns unencrypted technical logs (latency, CPU, memory, error logs).
 * Strictly contains zero customer-identifiable information.
 */
app.get('/api/diagnostics/telemetry', requireAdminSession, (req, res) => {
    try {
        const telemetryLogFile = path.join(__dirname, 'logs/telemetry.log');
        const errorLogFile = path.join(__dirname, 'logs/error.log');
        
        let telemetryLogs = [];
        let errorLogs = '';

        if (fs.existsSync(telemetryLogFile)) {
            const content = fs.readFileSync(telemetryLogFile, 'utf8');
            telemetryLogs = content.trim().split('\n').map(line => {
                try {
                    return JSON.parse(line);
                } catch (_) {
                    return { raw: line };
                }
            }).slice(-100); // return last 100 entries
        }

        if (fs.existsSync(errorLogFile)) {
            const content = fs.readFileSync(errorLogFile, 'utf8');
            errorLogs = content.split('----------------------------------------').slice(-15).join('----------------------------------------'); // return last 15 errors
        }

        res.json({
            status: "success",
            timestamp: new Date().toISOString(),
            metrics: {
                memory: process.memoryUsage(),
                uptime: process.uptime(),
                cpuUsage: process.cpuUsage()
            },
            telemetry: telemetryLogs,
            errors: errorLogs
        });
    } catch (err) {
        logError('Level-1 telemetry pull API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve telemetry logs' });
    }
});

/**
 * GET /api/diagnostics/export
 * Level 2 Diagnostics: Pulls database files encrypted with Developer's RSA-4096 Public Key.
 * Requires user request confirmation (simulated here). Decryptable only offline by developer.
 */
app.get('/api/diagnostics/export', requireAdminSession, (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const advancesFile = path.join(DATA_DIR, 'advances.json');

        // Retrieve transaction sales files
        const salesFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('sales_') && f.endsWith('.json'));
        const salesData = {};
        salesFiles.forEach(f => {
            salesData[f] = readJSON(path.join(DATA_DIR, f), []);
        });

        // Returns travel with the sales they reverse. A support bundle holding
        // only the sales side shows a ledger that overstates what the store
        // actually took, which is precisely the sort of discrepancy these
        // exports get pulled to explain.
        const returnsFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('returns_') && f.endsWith('.json'));
        const returnsData = {};
        returnsFiles.forEach(f => {
            returnsData[f] = readJSON(path.join(DATA_DIR, f), []);
        });

        // Pack sensitive databases together. Settings are masked even here:
        // diagnosing a tenant needs to know whether SMTP/Razorpay are
        // configured, never what the credentials are, and the mask preserves
        // exactly that distinction (empty string = unset). Keeps live tenant
        // credentials out of support bundles that get emailed around.
        const bundle = {
            timestamp: Date.now(),
            settings: redactSettings(readJSON(settingsFile, {})),
            advances: readJSON(advancesFile, []),
            sales: salesData,
            returns: returnsData
        };

        // Encrypt the bundle using asymmetric envelope
        const encryptedEnvelope = encryptLevel2Payload(JSON.stringify(bundle));
        
        res.json({
            status: "encrypted_lock",
            exportedAt: new Date().toISOString(),
            envelope: encryptedEnvelope
        });
    } catch (err) {
        logError('Level-2 secure export API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Data export failed: ' + err.message });
    }
});

/**
 * GET /api/diagnostics/blackbox-export
 * Encrypted export of the black-box flight-recorder log (HTTP request
 * shape: method/path/status/duration/memory — no customer data, no query
 * strings, no bodies). Uses its own RSA-4096 keypair, independent of the
 * Level-2 developer key — decryptable only offline via
 * developer_blackbox_keys/analyze_blackbox.js. Never ships to tenants.
 */
app.get('/api/diagnostics/blackbox-export', requireAdminSession, (req, res) => {
    try {
        const envelope = exportBlackBoxEnvelope();
        res.json({
            status: 'encrypted_lock',
            exportedAt: new Date().toISOString(),
            envelope
        });
    } catch (err) {
        logError('Black-box export API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Black-box export failed: ' + err.message });
    }
});

/* ==========================================================================
   Server Bootstrap & Scheduler Init
   ========================================================================== */

export { app };

/** Starts the HTTP listener. Exported so route tests can use an ephemeral port. */
export function startServer(port = PORT, host = '127.0.0.1') {
    const server = app.listen(port, host, () => {
        const address = server.address();
        const listeningPort = typeof address === 'object' && address ? address.port : port;
        console.log(`[Server] Gold POS backend running on port ${listeningPort}`);
        logTelemetry('SERVER_BOOTSTRAP', 0, `Listening on port ${listeningPort}`);
    });
    return server;
}

function bootstrapServer() {
    /* Before the guard, because the guard asks "is the master PIN still the
       default?" and can only answer that against the canonical stored form. This
       is also the moment a tenant upgrading from a build that kept PINs in
       plaintext has them hashed and the plaintext deleted — once, on the first
       boot after the upgrade, with nobody having to retype anything. */
    migrateStoredPins();

    // Then, before any scheduler starts, any backup is written, or the port
    // is bound: refuse to run a production process that is configured to take
    // money it cannot honour. Inert outside NODE_ENV=production.
    assertProductionReady();

    // Initialize pricing, backup, report-email, and update-check schedulers.
    initPriceScheduler();
    initBackupScheduler();
    initReportScheduler();
    initUpdateScheduler();

    // Trigger initial SaaS license sync & database backup on startup.
    syncLicenseStatus().catch(() => {
        console.warn('[Server] Initial license sync failed, operating under local grace checks.');
    });
    createBackup();

    // Load tenant-specific extensions and notify them the server has booted.
    loadExtensions().then(() => fireHook('onServerBoot', {}));
    return startServer();
}

// Tests import the real Express app but own its ephemeral listener and data.
if (process.env.GOLD_POS_DISABLE_BOOTSTRAP !== '1') bootstrapServer();
