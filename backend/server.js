import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readJSON, writeJSON, writeJSONTransaction, logError, logTelemetry, newId, DATA_DIR } from './db.js';
import { redactSettings } from './defaultSettings.js';
import { getActiveGoldRates, syncGoldPrice, initPriceScheduler } from './priceEngine.js';
import { encryptLevel2Payload } from './cryptoHelper.js';
import https from 'https';
import crypto from 'crypto';
import { checkLicenseGate, syncLicenseStatus, isLicenseValid } from './licenseChecker.js';
import { initBackupScheduler, createBackup } from './backupEngine.js';
import { assertProductionReady } from './productionGuard.js';
import { checkForUpdates, applyPendingUpdate, initUpdateScheduler } from './updateEngine.js';
import { requireAdminSession, verifyAdminPin, createAdminSession, destroyAdminSession, loginRateLimiter, recordLoginResult } from './adminAuth.js';
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
    computeReturnRefund,
    ADVANCE_STATUS, normalizeAdvanceStatus, summarizeAdvanceLedger
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
    const { pin } = req.body;
    if (!verifyAdminPin(pin)) {
        recordLoginResult(req, false);
        logTelemetry('ADMIN_LOGIN_FAILED', 0);
        return res.status(401).json({ error: 'Incorrect PIN' });
    }
    recordLoginResult(req, true);
    const token = createAdminSession();
    logTelemetry('ADMIN_LOGIN_SUCCESS', 0);
    res.json({ success: true, token });
});

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
        adminPinConfigured: !!settings.adminPin,
        razorpayKeySecret: null,
        razorpayKeySecretConfigured: !!settings.razorpayKeySecret,
        razorpayWebhookSecret: null,
        razorpayWebhookSecretConfigured: !!settings.razorpayWebhookSecret,
        smtp: {
            ...(settings.smtp || {}),
            pass: null,
            passConfigured: !!(settings.smtp && settings.smtp.pass)
        }
    };
    return safe;
}

/** Null or an absent key means "leave this write-only value unchanged". */
function preserveWriteOnlyValue(requested, current) {
    return requested === undefined || requested === null ? current : requested;
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

        const newSettings = {
            ...currentSettings,
            ...req.body,
            adminPin: preserveWriteOnlyValue(req.body.adminPin, currentSettings.adminPin),
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
        // Extensions get the real document; the browser gets the masked one,
        // so the client's cached copy round-trips safely on the next save.
        fireHook('onSettingsUpdated', newSettings);
        res.json({ success: true, settings: redactSettingsForBrowser(newSettings) });
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
    return {
        count: rows.length,
        returnedWeightGrams: round3(rows.reduce((sum, r) => sum + (Number(r.weightGrams) || 0), 0)),
        refundedAmount: round2(rows.reduce((sum, r) => sum + (Number(r.refundAmount) || 0), 0))
    };
}

/**
 * A sale, with what has been returned against it attached.
 *
 * Both the Reprint Desk and the Return Desk need this pairing — one to stamp a
 * duplicate that is no longer fully payable, the other to decide what is still
 * returnable — so the join happens once, here, instead of each screen
 * re-deriving it from two endpoints and rounding differently.
 */
function withReturnState(sale, returns) {
    const summary = summarizeInvoiceReturns(sale.id, returns);
    const returnableWeightGrams = round3(
        Math.max(0, round3(sale.weightGrams) - summary.returnedWeightGrams)
    );
    return {
        ...sale,
        returnedWeightGrams: summary.returnedWeightGrams,
        refundedAmount: summary.refundedAmount,
        returnCount: summary.count,
        returnableWeightGrams,
        fullyReturned: summary.count > 0 && returnableWeightGrams <= 0
    };
}

/**
 * GET /api/sales
 * Retrieves sales records combined across all partitioned files, sorted by date descending.
 */
app.get('/api/sales', requireAdminSession, (req, res) => {
    try {
        res.json(readSalesRecords());
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
        const q = String(req.query.q || '').trim().toLowerCase();
        const limit = Math.min(
            REPRINT_MAX_RESULTS,
            Math.max(1, parseInt(req.query.limit, 10) || 50)
        );

        // Dates arrive as YYYY-MM-DD from a native date input. `to` covers the
        // whole of its day: a cashier searching 1st–1st means that one day, not
        // the single instant of midnight.
        const from = req.query.from ? Date.parse(`${req.query.from}T00:00:00`) : null;
        const to = req.query.to ? Date.parse(`${req.query.to}T23:59:59.999`) : null;
        if ((from !== null && Number.isNaN(from)) || (to !== null && Number.isNaN(to))) {
            return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD form.' });
        }
        if (from !== null && to !== null && from > to) {
            return res.status(400).json({ error: 'The "from" date cannot be after the "to" date.' });
        }

        // Only the year partitions the range can touch.
        let years = null;
        if (from !== null || to !== null) {
            const firstYear = new Date(from ?? to).getFullYear();
            const lastYear = new Date(to ?? from).getFullYear();
            years = [];
            for (let y = firstYear; y <= lastYear; y++) years.push(y);
        }

        const digitsOnly = q.replace(/\D/g, '');
        const results = readSalesRecords(years).filter(sale => {
            const ts = sale.timestamp || 0;
            if (from !== null && ts < from) return false;
            if (to !== null && ts > to) return false;
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

/**
 * POST /api/sales
 * Saves a new Gold POS Sale, handles sequence numbering, and registers advance deductions if applied.
 */
app.post('/api/sales', requireAdminSession, (req, res) => {
    try {
        // Validate the core billing fields before consuming a real,
        // sequential, legally-relevant invoice number on garbage/empty data.
        const VALID_PURITIES = ['24K', '22K', '18K'];
        const { purity, weightGrams, totalAmount, customerName, customerPhone, appliedAdvance } = req.body;

        if (!VALID_PURITIES.includes(purity)) {
            return res.status(400).json({ error: 'A valid purity (24K, 22K, or 18K) is required.' });
        }
        const numWeight = Number(weightGrams);
        const numTotal = Number(totalAmount);
        const numAppliedAdvance = appliedAdvance === undefined ? 0 : Number(appliedAdvance);
        if (!Number.isFinite(numWeight) || numWeight <= 0) {
            return res.status(400).json({ error: 'A valid positive gold weight is required.' });
        }
        if (numWeight > MAX_SANE_WEIGHT_GRAMS) {
            return res.status(400).json({ error: `Gold weight exceeds the ${MAX_SANE_WEIGHT_GRAMS}g per-invoice limit.` });
        }
        if (!Number.isFinite(numTotal) || numTotal < 0) {
            return res.status(400).json({ error: 'A valid non-negative total amount is required.' });
        }
        if (!Number.isFinite(numAppliedAdvance) || numAppliedAdvance < 0) {
            return res.status(400).json({ error: 'Applied advance must be a valid non-negative amount.' });
        }
        const numMakingCharge = req.body.makingChargeAmount === undefined ? 0 : Number(req.body.makingChargeAmount);
        if (!Number.isFinite(numMakingCharge) || numMakingCharge < 0) {
            return res.status(400).json({ error: 'Making charge must be a valid non-negative amount.' });
        }
        const numDiscountPercent = req.body.discountPercent === undefined ? 0 : Number(req.body.discountPercent);
        if (!Number.isFinite(numDiscountPercent) || numDiscountPercent < 0 || numDiscountPercent > 100) {
            return res.status(400).json({ error: 'Discount percent must be between 0 and 100.' });
        }
        // Descriptive only — makingChargeAmount above is what the money math
        // uses — but it prints on the invoice, so it is validated rather than
        // trusted through to the ledger unchecked.
        const numMakingChargePercent = req.body.makingChargePercent === undefined ? 0 : Number(req.body.makingChargePercent);
        if (!Number.isFinite(numMakingChargePercent) || numMakingChargePercent < 0 || numMakingChargePercent > 100) {
            return res.status(400).json({ error: 'Making charge percent must be between 0 and 100.' });
        }
        if (customerPhone && !/^\d{10}$/.test(customerPhone)) {
            return res.status(400).json({ error: 'Customer phone must be exactly 10 digits if provided.' });
        }
        if (customerName && String(customerName).length > 200) {
            return res.status(400).json({ error: 'Customer name is too long (max 200 characters).' });
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

        /* The rate is the store's, not the browser's.

           goldPricePerGram and metalValue used to be taken from the request
           body and written to the ledger unchallenged, which made every other
           server-side recomputation below decorative: recomputing tax and
           discount over a client-supplied metal value just derives correct
           percentages of a number the client chose. A tampered payload could
           bill 50g of 22K at ₹1/g, and the stored invoice would be internally
           consistent and completely wrong.

           The rate now comes from the same getActiveGoldRates() the Billing
           Desk fetched to draw its preview — which is also what makes the
           manual override in Settings actually binding rather than advisory. */
        const activeRates = getActiveGoldRates();
        const rateKey = PURITY_RATE_KEY[purity];
        const numRate = Number(activeRates[rateKey]);
        if (!Number.isFinite(numRate) || numRate <= 0) {
            logError(`Refusing to bill ${purity}: the active gold rate is unusable (${activeRates[rateKey]}).`);
            return res.status(503).json({
                error: 'The current gold rate is unavailable, so this invoice cannot be priced. Check the gold rate in Settings and retry.'
            });
        }
        const numMetalValue = computeMetalValue(numWeight, numRate);

        // The cashier quoted a rate on screen. If the rate moved between then
        // and Save — an overnight sync, or an override edited mid-shift — the
        // server's figure is what gets filed, and the desk is told so it can
        // reprint rather than hand over a slip that disagrees with the ledger.
        const clientRate = Number(req.body.goldPricePerGram);
        const rateWasCorrected = Number.isFinite(clientRate) && Math.abs(clientRate - numRate) > 0.01;
        if (rateWasCorrected) {
            logError(
                `Sale rate mismatch — client billed ${purity} at ${clientRate}/g, server's active rate is ` +
                `${numRate}/g (source: ${activeRates.sources[rateKey]}). Persisting the server rate.`
            );
            logTelemetry('SALE_RATE_MISMATCH', 0, `client: ${clientRate}, server: ${numRate}`);
        }

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
            metalValue: numMetalValue,
            makingChargeAmount: numMakingCharge,
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
            purity,
            weightGrams: numWeight,
            goldPricePerGram: numRate,
            // Provenance of the rate this invoice was priced at, so a later
            // audit can tell a synced market rate from a counter override
            // without having to guess from the number alone.
            goldRateSource: activeRates.sources[rateKey],
            metalValue: numMetalValue,
            makingChargePercent: numMakingChargePercent,
            makingChargeAmount: round2(numMakingCharge),
            taxPercent: taxSlab,
            taxMode,
            taxableAmount: round2(totals.taxableAmount),
            taxAmount: round2(totals.taxAmount),
            discountPercent: numDiscountPercent,
            discount: round2(totals.discountAmount),
            appliedAdvance: round2(totals.appliedAdvance),
            totalAmount: serverTotal
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
                timestamp: Date.now()
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
 * GET /api/returns
 * The whole returns ledger, newest first. Admin-only.
 */
app.get('/api/returns', requireAdminSession, (req, res) => {
    try {
        res.json(readReturnRecords());
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
        const { invoiceId, weightGrams, refundMode, note } = req.body || {};

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
        const refund = computeReturnRefund({
            sale,
            returnWeightGrams: numWeight,
            alreadyReturnedGrams: priorReturns.returnedWeightGrams,
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
            purity: refund.purity,
            weightGrams: refund.weightGrams,
            originalWeightGrams: round3(sale.weightGrams),
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
            closesInvoice: refund.closesInvoice,
            note: String(note || '').trim().slice(0, 300)
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
                returnId
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
            remainingWeightGrams: refund.remainingWeightAfter
        });
    } catch (err) {
        logError('Error filing return: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to process the return: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Customer Advances Lookup
   ========================================================================== */

/**
 * GET /api/advances
 * Returns the full advances ledger (deposits + redemptions), sorted by date
 * descending. Admin-only — powers the Dashboard and Advances report tabs.
 */
app.get('/api/advances', requireAdminSession, (req, res) => {
    try {
        const advancesFile = path.join(DATA_DIR, 'advances.json');
        const advances = readJSON(advancesFile, []);
        advances.sort((a, b) => b.timestamp - a.timestamp);
        res.json(advances);
    } catch (err) {
        logError('Error retrieving advances ledger: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve advances ledger' });
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
    status = ADVANCE_STATUS.APPROVED, source = 'counter', invoiceId = '', returnId = ''
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
        timestamp: Date.now()
    };
}

function recordAdvanceDeposit({
    customerPhone, customerName, amount, paymentMethod, referenceId,
    status = ADVANCE_STATUS.APPROVED
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
        paymentMethod, referenceId: cleanReference, status
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
 * @returns {{success: boolean, error?: string, status?: number, deposit?: object}}
 */
function reviewPendingDeposit(depositId, decision, note) {
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
        reviewNote: String(note || '').trim().slice(0, 300)
    };
    advances[index] = reviewed;
    if (!writeJSONTransaction([{ filepath: advancesFile, data: advances }])) {
        return { success: false, status: 500, error: 'Failed to save the review. Please retry.' };
    }

    logTelemetry('REVIEW_ADVANCE_DEPOSIT', 0, `Deposit: ${depositId}, Decision: ${decision}, Amount: ${reviewed.amount}`);
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
        // body so this route can never be used to inject a pending row.
        const result = recordAdvanceDeposit({ ...(req.body || {}), status: ADVANCE_STATUS.APPROVED });
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
 * Credits a pending deposit once the cashier has confirmed the transfer landed
 * in the store's account. This is the point the money becomes spendable.
 */
app.post('/api/advances/:id/approve', requireAdminSession, (req, res) => {
    try {
        const result = reviewPendingDeposit(req.params.id, ADVANCE_STATUS.APPROVED, (req.body || {}).note);
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
 */
app.post('/api/advances/:id/reject', requireAdminSession, (req, res) => {
    try {
        const note = String((req.body || {}).note || '').trim();
        if (!note) {
            return res.status(400).json({ error: 'A reason is required when rejecting a deposit claim.' });
        }
        const result = reviewPendingDeposit(req.params.id, ADVANCE_STATUS.REJECTED, note);
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
    // FIRST, before any scheduler starts, any backup is written, or the port
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
