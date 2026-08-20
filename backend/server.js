import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readJSON, logError, logTelemetry, newId, DATA_DIR } from './db.js';
import { readSettings, writeSettings } from './settingsStore.js';
import { redactSettings, OPERATOR_ROLES, validateSettingsPatch } from './defaultSettings.js';
import { getActiveGoldRates, syncGoldPrice, initPriceScheduler } from './priceEngine.js';
import { encryptLevel2Payload } from './cryptoHelper.js';
import https from 'https';
import crypto from 'crypto';
import { checkLicenseGate, syncLicenseStatus, isLicenseValid } from './licenseChecker.js';
import { initBackupScheduler, createBackup } from './backupEngine.js';
import { raiseAlert, recordRequestOutcome, initAlertScheduler } from './alerting.js';
import { assertProductionReady, assertVaultKeyReady } from './productionGuard.js';
import { checkForUpdates, applyPendingUpdate, initUpdateScheduler } from './updateEngine.js';
import {
    requireAdminSession, requireApprover, verifyAdminPin, createAdminSession, destroyAdminSession,
    loginRateLimiter, recordLoginResult, roleCanApprove, listOperators, OWNER_ACTOR,
    ensureAuthSalt, hashPin, migrateStoredPins,
    generateTotpSecret, verifyTotp, totpEnrolmentUri, generateRecoveryCodes, consumeRecoveryCode,
    listAdminSessions, revokeAdminSessionByHandle, revokeSessionsForActor, revokeSessionsForRosterChange,
    ADMIN_SESSION_COOKIE, ADMIN_CSRF_COOKIE, SESSION_TTL_MS as ADMIN_SESSION_TTL_MS
} from './adminAuth.js';
import {
    requireCustomerSession, requireEstablishedCustomer, customerLoginRateLimiter,
    loginCustomer, destroyCustomerSession, destroyAllCustomerSessions,
    createCustomerAccount, setCustomerPassword, updateCustomerProfile,
    issueResetToken, consumeResetToken, findAccount, accountExists,
    publicAccountView, verifyPassword, validatePasswordStrength,
    generateTemporaryPassword, isValidPhone, CUSTOMER_PASSWORD_MIN_LENGTH,
    CUSTOMER_SESSION_COOKIE, CUSTOMER_CSRF_COOKIE, SESSION_TTL_MS as CUSTOMER_SESSION_TTL_MS
} from './customerAuth.js';
import { parseCookies, serializeCookie, clearCookie } from './cookies.js';
import { initReportScheduler, sendSummaryReport, sendMailIfConfigured } from './emailReporter.js';
import { logBlackBoxEvent, exportBlackBoxEnvelope } from './blackBoxLogger.js';
import { createRateLimiter } from './rateLimit.js';
import {
    validateBody, PHONE_RULE, PASSWORD_RULE, CODE_RULE, NAME_RULE, EMAIL_RULE
} from './validation.js';
import { loadExtensions, fireHook } from './extensions/index.js';
/* The ledger. Every route below reaches persistence through these two modules
   and never through a SQL string of its own — ADR-001 §3, and the reason the
   documented move to PostgreSQL stays a swap rather than a rewrite. */
import * as repo from './repositories/index.js';
import * as saleService from './services/saleService.js';
import * as returnService from './services/returnService.js';
import * as advanceService from './services/advanceService.js';
import * as paymentService from './services/paymentService.js';
import { importLegacyJson, collectSource, formatReport } from './importLegacyJson.js';
// Shared invoice arithmetic — the exact module the Billing Desk renders its
// preview from, so the persisted ledger and the cashier's screen can never
// drift apart. Lives under frontend/ because release_pipeline.js and
// updateEngine.js ship and replace backend/ and frontend/ as a pair.
import { normalizeTaxMode, round2, round3, toPaise, fromPaise, ADVANCE_STATUS } from '../frontend/js/lib/billingMath.js';
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

/* --------------------------------------------------------------------------
   Request identity

   Every request carries one id, echoed on the response and stamped on every log
   line it produces. It is what turns "the till showed an error this morning"
   into a single grep, and it is the only thing a 500 hands back to the user —
   see the terminal error handler at the bottom of this file.

   AN INBOUND ID IS HONOURED BUT NEVER TRUSTED VERBATIM. A proxy or the mobile
   wrapper may already have one, and reusing it is what makes a trace span both
   hops. But the value goes straight into a log file, so an unvalidated header
   could inject newlines and forge whole log entries. The pattern below admits
   only characters that cannot break a line or a JSON string; anything else is
   discarded and a fresh id issued rather than sanitised, because a half-scrubbed
   id correlates to nothing anyway.
   -------------------------------------------------------------------------- */
const REQUEST_ID_HEADER = 'X-Request-Id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function resolveRequestId(req) {
    const supplied = req.headers['x-request-id'];
    return typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : newId('REQ');
}

/* --------------------------------------------------------------------------
   Abuse limits

   The login paths are NOT here. They already carry escalating credential
   lockouts (`loginRateLimiter`, `customerLoginRateLimiter`), and stacking a
   second policy on them would be the parallel mechanism §1 forbids. These
   limits cover what those cannot: endpoints where every request *succeeds* and
   the abuse is the volume — registering accounts, triggering emails, spending
   a payment gateway's quota, or making the server encrypt its whole ledger.

   The numbers are deliberately far above any real counter's usage and far
   below what makes the endpoint a useful weapon. Each one names its cost.
   -------------------------------------------------------------------------- */
const HOUR_MS = 60 * 60 * 1000;

/* The blanket ceiling. High, because a busy desk with several tabs open is
   legitimately chatty and this must never be the reason a sale cannot be
   filed — it is a stop on runaway automation, not a quota. */
const apiRateLimiter = createRateLimiter({
    name: 'api',
    windowMs: Number(process.env.API_RATE_WINDOW_MS) || 60 * 1000,
    max: Number(process.env.API_RATE_MAX) || 600,
    message: 'Too many requests. Please slow down and try again shortly.'
});

/* Exempt from the blanket limit, each for a different reason:
   - the probes, because monitoring polls them by design and rate-limiting them
     would make a healthy process look down and trigger a false failover;
   - the webhook, because Razorpay has ALREADY taken the customer's money by the
     time it calls, and a 429 would only lose our record of the payment. It is
     HMAC-signed, so leaving it unthrottled does not make it writable. */
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/api/health', '/api/ready', '/api/payment/webhook']);

/* --------------------------------------------------------------------------
   Body schemas for the unauthenticated surface

   These check SHAPE only — types, lengths, character classes — and run before
   the handler so it can trust `typeof`. What a value MEANS is still decided
   where it always was: `isValidPhone()` decides what is dialable,
   `validatePasswordStrength()` decides what is strong enough, the services
   decide what is affordable. Putting those here would create the second source
   of truth this mechanism exists to avoid (§1).

   The unauthenticated routes are the ones that get schemas first because they
   are the ones a stranger can reach. The money paths already validate
   exhaustively inside their services and are deliberately left alone rather
   than wrapped in a second, thinner check.
   -------------------------------------------------------------------------- */
const CUSTOMER_REGISTER_SCHEMA = {
    phone: { ...PHONE_RULE, required: true },
    password: { ...PASSWORD_RULE, required: true },
    name: NAME_RULE,
    email: EMAIL_RULE
};
const CUSTOMER_LOGIN_SCHEMA = {
    phone: { ...PHONE_RULE, required: true },
    password: { ...PASSWORD_RULE, required: true }
};
const CUSTOMER_FORGOT_SCHEMA = { phone: { ...PHONE_RULE, required: true } };
const CUSTOMER_RESET_SCHEMA = {
    phone: { ...PHONE_RULE, required: true },
    code: { ...CODE_RULE, required: true },
    newPassword: { ...PASSWORD_RULE, required: true }
};
const CUSTOMER_PROFILE_SCHEMA = {
    name: NAME_RULE,
    email: EMAIL_RULE,
    notifyEmail: { type: 'boolean' },
    notifyPush: { type: 'boolean' }
};
const CUSTOMER_PASSWORD_CHANGE_SCHEMA = {
    currentPassword: { ...PASSWORD_RULE, required: true },
    newPassword: { ...PASSWORD_RULE, required: true }
};
/* The PIN is a STRING and must stay one. Coerced to a number, "0421" becomes
   421 and a leading-zero PIN silently stops matching its own hash — so the rule
   is a string rule, and `preserveWhitespace` keeps it byte-for-byte what the
   operator typed rather than something trimmed on its way to scrypt. */
const ADMIN_LOGIN_SCHEMA = {
    pin: { type: 'string', maxLength: 64, minLength: 1, required: true, preserveWhitespace: true },
    totpCode: CODE_RULE,
    recoveryCode: CODE_RULE
};

/** Self-registration: the cost is a junk account and a row per attempt. */
const registerLimiter = createRateLimiter({
    name: 'customer-register',
    windowMs: HOUR_MS, max: 10,
    message: 'Too many accounts created from this device. Please try again later.'
});

/** Password reset: the cost is an email sent to an address we do not control. */
const passwordResetLimiter = createRateLimiter({
    name: 'password-forgot',
    windowMs: 15 * 60 * 1000, max: 5,
    message: 'Too many reset requests. Please wait a few minutes and try again.'
});

/** Deposit claims: the cost is manual reconciliation work for the store. */
const depositClaimLimiter = createRateLimiter({
    name: 'customer-deposit',
    windowMs: HOUR_MS, max: 20,
    message: 'Too many deposit submissions. Please contact the store if you need help.'
});

/** Payment orders: the cost is the gateway's own rate quota, which we do not own. */
const paymentOrderLimiter = createRateLimiter({
    name: 'payment-order',
    windowMs: HOUR_MS, max: 30,
    message: 'Too many payment attempts. Please wait a few minutes.'
});

/* Admin-gated but externally costly: a live gold-price provider call, an SMTP
   send, a full backup, and the encrypted exports that read the whole ledger.
   A stolen session should not be able to turn any of them into a firehose. */
const expensiveAdminLimiter = createRateLimiter({
    name: 'expensive-admin',
    windowMs: HOUR_MS, max: 12,
    message: 'This operation is rate limited. Please wait before running it again.'
});

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
    // Session auth is a cookie now, not a bearer header — the browser only
    // attaches it to a cross-origin fetch when the request opts in AND the
    // server echoes this back. Safe alongside an exact-origin allowlist
    // (never '*', which credentials:true forbids anyway).
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', REQUEST_ID_HEADER],
    // Without this a split-origin frontend cannot read the id back off the
    // response, which is the whole point of returning it — the browser hides
    // every header but a short safelist unless the server names it here.
    exposedHeaders: [REQUEST_ID_HEADER],
    maxAge: 600
}));
// Populates req.cookies for every route — the single place a Cookie header is
// parsed, mirroring how CORS/helmet are set up once here rather than per-route.
app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    next();
});

/**
 * Session-cookie attributes shared by both the admin and customer transports.
 *
 * `secure` is NOT hardcoded true: a browser silently drops a Secure cookie
 * over plain HTTP, which would break every local `http://localhost` dev
 * session outright. `req.secure` covers a real HTTPS request (including
 * behind a trust-proxy'd load balancer); IS_PRODUCTION covers the case where
 * that detection is wrong but the environment is known to be production.
 */
function cookieOpts(req, maxAgeMs, httpOnly) {
    return { maxAgeMs, httpOnly, sameSite: 'Lax', secure: IS_PRODUCTION || req.secure };
}

function setAdminSessionCookies(res, req, token, csrfToken) {
    res.setHeader('Set-Cookie', [
        serializeCookie(ADMIN_SESSION_COOKIE, token, cookieOpts(req, ADMIN_SESSION_TTL_MS, true)),
        serializeCookie(ADMIN_CSRF_COOKIE, csrfToken, cookieOpts(req, ADMIN_SESSION_TTL_MS, false))
    ]);
}

function clearAdminSessionCookies(res, req) {
    res.setHeader('Set-Cookie', [
        clearCookie(ADMIN_SESSION_COOKIE, cookieOpts(req, 0, true)),
        clearCookie(ADMIN_CSRF_COOKIE, cookieOpts(req, 0, false))
    ]);
}

function setCustomerSessionCookies(res, req, token, csrfToken) {
    res.setHeader('Set-Cookie', [
        serializeCookie(CUSTOMER_SESSION_COOKIE, token, cookieOpts(req, CUSTOMER_SESSION_TTL_MS, true)),
        serializeCookie(CUSTOMER_CSRF_COOKIE, csrfToken, cookieOpts(req, CUSTOMER_SESSION_TTL_MS, false))
    ]);
}

function clearCustomerSessionCookies(res, req) {
    res.setHeader('Set-Cookie', [
        clearCookie(CUSTOMER_SESSION_COOKIE, cookieOpts(req, 0, true)),
        clearCookie(CUSTOMER_CSRF_COOKIE, cookieOpts(req, 0, false))
    ]);
}
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
/* Request identity and response-time telemetry. One middleware because both are
   per-request bookkeeping, and this is the choke point every route runs through.

   IT SITS ABOVE THE BODY PARSERS DELIBERATELY. express.json() rejects malformed
   and oversized bodies by throwing, and that throw goes straight to the terminal
   error handler — so an id assigned after the parser is not yet assigned for
   exactly the requests most worth tracing. Caught by the suite: the 400 came
   back with `requestId: "unassigned"`. Parse time is inside the measured
   duration for the same reason. */
app.use((req, res, next) => {
    const startTime = Date.now();
    req.id = resolveRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, req.id);
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        recordRequestOutcome(res.statusCode, duration);
        logTelemetry(`${req.method}_${req.originalUrl}`, duration, `Status: ${res.statusCode}`, {
            requestId: req.id,
            method: req.method,
            // req.path, not originalUrl: the query string can carry a phone
            // number, and this field is the one meant to be aggregated on.
            path: req.path,
            statusCode: res.statusCode
        });
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

/* The blanket limit, applied by predicate rather than mounted at '/api' —
   mounting rewrites req.url for the duration of the handler, and the 404
   handler at the bottom of this file already had to learn that lesson. Sits
   above the body parsers so a flood is refused before anything is parsed. */
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (RATE_LIMIT_EXEMPT_PATHS.has(req.path)) return next();
    return apiRateLimiter(req, res, next);
});

// The Razorpay webhook signature is an HMAC over the EXACT bytes the gateway
// sent. JSON.parse + re-serialise does not round-trip those bytes (key order,
// number formatting, unicode escapes all shift), so a parsed body can never be
// verified. This must therefore sit BEFORE express.json(): body-parser marks
// the request as already-read, and the JSON parser below then skips it, leaving
// req.body as the raw Buffer the signature check needs.
app.use('/api/payment/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '5mb' }));

/**
 * GET /api/health
 * LIVENESS. Public and unauthenticated: is this process alive and serving the
 * commit we think it is? Nothing more — it deliberately touches no dependency,
 * so a restart supervisor reading it never kills a process for a fault that
 * restarting cannot fix (a pending migration, a full disk). "Should this
 * process be replaced?" is this endpoint; "should traffic be sent to it?" is
 * /api/ready below. Conflating them is how a database blip becomes a restart
 * loop. Exempt from checkLicenseGate.
 */
app.get('/api/health', (req, res) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
    res.json({
        status: 'ok',
        version: pkg.version,
        env: process.env.ENV_NAME || process.env.NODE_ENV || 'unknown'
    });
});

/* True from the moment a shutdown starts. Readiness flips first and the
   listener closes second, so a proxy stops sending new work while in-flight
   requests are still being finished — see shutdown() at the bottom. */
let draining = false;

/**
 * GET /api/ready
 * READINESS. Can this process serve a request end to end right now? 200 when
 * the ledger opens, answers a query and is fully migrated; 503 with the reason
 * otherwise, including while draining.
 *
 * A load balancer polls this to decide routing, and a deploy polls it to decide
 * whether the new build actually came up — which is why the failure body names
 * which check failed rather than just refusing. Public and unauthenticated for
 * the same reason /api/health is: the prober has no credentials. It reports
 * only check names and never a value from the ledger.
 */
app.get('/api/ready', (req, res) => {
    const health = draining
        ? { ok: false, database: 'ok', migrations: 'ok', detail: 'shutting down' }
        : repo.dataStoreHealth();

    res.status(health.ok ? 200 : 503).json({
        status: health.ok ? 'ready' : 'not_ready',
        draining,
        checks: { database: health.database, migrations: health.migrations },
        detail: health.detail,
        requestId: req.id
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
app.post('/api/admin/login', loginRateLimiter, validateBody(ADMIN_LOGIN_SCHEMA), (req, res) => {
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
            const settings = readSettings();
            const consumed = consumeRecoveryCode(submittedRecovery, settings.authSalt, mfa.recoveryCodes);
            if (consumed.ok) {
                // Single use: the surviving codes are written back before the
                // session is issued, so a replay of the same code cannot work
                // even if two attempts arrive together.
                const row = (settings.operators || []).find(op => op && op.id === actor.id);
                if (row) {
                    row.recoveryCodes = consumed.remainingHashes;
                    if (!writeSettings(settings)) {
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
    const { token, csrfToken } = createAdminSession(actor, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        mfaUsed
    });
    logTelemetry('ADMIN_LOGIN_SUCCESS', 0, `${actor.name} (${actor.role})${mfaUsed ? ' +MFA' : ''}`);
    setAdminSessionCookies(res, req, token, csrfToken);
    // The desk shows who is signed in and hides controls their role cannot
    // use, so the identity goes back with it rather than the browser having
    // to ask a second time. The session credential itself now lives only in
    // the HttpOnly cookie just set above, never in this JSON body.
    res.json({
        success: true,
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
    const settings = readSettings();
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
        const settings = readSettings();
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
        const settings = readSettings();
        const authSalt = ensureAuthSalt(settings);
        const operator = (settings.operators || []).find(op => op && op.id === targetId);
        if (!operator) {
            return res.status(400).json({ error: 'NOT_A_NAMED_OPERATOR', message: 'That operator no longer exists.' });
        }

        const recovery = generateRecoveryCodes(authSalt);
        operator.totpSecret = String(secret);
        operator.mfaEnabled = true;
        operator.recoveryCodes = recovery.hashes;

        if (!writeSettings(settings)) {
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
        const settings = readSettings();
        const operator = (settings.operators || []).find(op => op && op.id === targetId);
        if (!operator) {
            return res.status(400).json({ error: 'NOT_A_NAMED_OPERATOR', message: 'That operator no longer exists.' });
        }

        operator.mfaEnabled = false;
        delete operator.totpSecret;
        delete operator.recoveryCodes;
        if (!writeSettings(settings)) {
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
    const token = (req.cookies || parseCookies(req.headers.cookie))[ADMIN_SESSION_COOKIE] || null;
    destroyAdminSession(token);
    clearAdminSessionCookies(res, req);
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
    return advanceService.phoneHasStoreHistory(phone);
}

/**
 * POST /api/customer/register
 * Self-service signup, allowed only for a number with no existing store
 * history (see above). Returns a live session so the customer lands straight
 * in the portal.
 */
/* Both limiters, because they stop different things: `customerLoginRateLimiter`
   counts FAILURES and so never fires on a flood of *successful* registrations,
   which is exactly what account spam is. */
app.post('/api/customer/register', customerLoginRateLimiter, registerLimiter, validateBody(CUSTOMER_REGISTER_SCHEMA), (req, res) => {
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

        setCustomerSessionCookies(res, req, login.token, login.csrfToken);
        res.json({ success: true, customer: publicAccountView(login.account) });
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
app.post('/api/customer/login', customerLoginRateLimiter, validateBody(CUSTOMER_LOGIN_SCHEMA), (req, res) => {
    try {
        const { phone, password } = req.body || {};
        const result = loginCustomer(phone, password, req.ip);
        if (!result.success) {
            const status = result.code === 'ACCOUNT_LOCKED' ? 429 : 401;
            return res.status(status).json({ error: result.code || 'INVALID_CREDENTIALS', message: result.error });
        }
        setCustomerSessionCookies(res, req, result.token, result.csrfToken);
        res.json({ success: true, customer: publicAccountView(result.account) });
    } catch (err) {
        logError('Customer login failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Sign-in failed. Please retry.' });
    }
});

/** POST /api/customer/logout — invalidates just this device's session. */
app.post('/api/customer/logout', (req, res) => {
    const token = (req.cookies || parseCookies(req.headers.cookie))[CUSTOMER_SESSION_COOKIE] || null;
    destroyCustomerSession(token);
    clearCustomerSessionCookies(res, req);
    res.json({ success: true });
});

/** GET /api/customer/me — the signed-in customer's own profile. */
app.get('/api/customer/me', requireCustomerSession, (req, res) => {
    res.json({ customer: publicAccountView(req.customerAccount) });
});

/** PATCH /api/customer/me — name, email, and notification preferences. */
app.patch('/api/customer/me', requireEstablishedCustomer, validateBody(CUSTOMER_PROFILE_SCHEMA), (req, res) => {
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
app.post('/api/customer/password/change', requireCustomerSession, validateBody(CUSTOMER_PASSWORD_CHANGE_SCHEMA), (req, res) => {
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
app.post('/api/customer/password/forgot', customerLoginRateLimiter, passwordResetLimiter, validateBody(CUSTOMER_FORGOT_SCHEMA), async (req, res) => {
    const GENERIC_OK = {
        success: true,
        message: 'If an account with that mobile number and a registered email exists, a reset code has been sent to it.'
    };
    try {
        const settings = readSettings();
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
app.post('/api/customer/password/reset', customerLoginRateLimiter, validateBody(CUSTOMER_RESET_SCHEMA), (req, res) => {
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
        res.json(advanceService.customerLedger(req.customerPhone));
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
        const rows = returnService
            .listReturns({ customerPhone: req.customerPhone, limit: LEDGER_PAGE_MAX })
            .results
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
app.post('/api/customer/advances', requireEstablishedCustomer, depositClaimLimiter, (req, res) => {
    try {
        const { amount, referenceId } = req.body || {};
        if (!referenceId || !String(referenceId).trim()) {
            return res.status(400).json({ error: 'A transaction reference ID is required.' });
        }
        const result = advanceService.recordDeposit({
            customerPhone: req.customerPhone,
            customerName: (req.customerAccount && req.customerAccount.name) || 'Regular Customer',
            amount,
            paymentMethod: 'UPI',
            referenceId: String(referenceId).trim().slice(0, 100),
            // PENDING, not approved. Nothing here has been verified: the customer
            // has typed an amount and a reference they assert they sent. Crediting
            // that instantly made the portal a self-service way to award yourself
            // an arbitrary advance balance and redeem it against a real bill.
            status: ADVANCE_STATUS.PENDING,
            source: 'portal'
        }, {
            getActiveGoldRates,
            isValidPhone,
            // The customer is the actor, and a customer is not a `users` row —
            // `system` is the honest identity for "submitted through the
            // portal", and it is outside the approvers view, which is exactly
            // right for a claim that still needs a cashier to release it.
            actorLabel: `portal:${req.customerPhone}`,
            ipAddress: req.ip
        });
        if (!result.success) {
            const status = result.status
                || (result.code === 'DUPLICATE_REFERENCE' ? 409 : 400);
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
        const accounts = repo.customers.loadAccounts(repo.dataStoreContext().tenantId);
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
app.post('/api/gold-price/sync', requireAdminSession, expensiveAdminLimiter, async (req, res) => {
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
        const settings = readSettings();
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
        const settings = readSettings();
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
        const currentSettings = readSettings();

        /* TYPE-CHECK BEFORE ANYTHING ELSE.
           `newSettings` below spreads req.body straight over the stored
           document, and the billing pipeline reads these keys with plain JS
           coercion — so a wrong TYPE did not fail, it produced a wrong invoice.
           A string "10" made the invoice sequence CONCATENATE (10 → 101 → 1011),
           a non-numeric tax slab silently billed 0% GST, and an object
           invoicePrefix stamped "[object Object]" into permanent invoice
           numbers. See SETTINGS_FIELD_RULES in defaultSettings.js.

           `checked.values` holds the CANONICALISED value for each key, which is
           what gets merged: storing a validated-but-still-stringified "10" would
           leave the concatenation bug in place. */
        const checked = validateSettingsPatch(req.body);
        if (!checked.ok) {
            return res.status(400).json({ error: checked.error });
        }

        // Destructive-action guard: lowering the invoice sequence can produce
        // duplicate invoice numbers against already-issued invoices. Require
        // an explicit confirmDestructive flag (the frontend triple-confirms
        // with the user before setting it) instead of silently applying it.
        // Reads the canonicalised number, so a string "5" is compared as 5
        // rather than slipping through on a parseInt that returned NaN.
        if (checked.values.invoiceSeqStart !== undefined && currentSettings.invoiceSeqStart !== undefined) {
            const requested = checked.values.invoiceSeqStart;
            const current = parseInt(currentSettings.invoiceSeqStart);
            if (!isNaN(current) && requested < current && !req.body.confirmDestructive) {
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
            // Canonicalised types win over the raw body: "10" is stored as 10,
            // " inclusive " as 'Inclusive'. Placed after the spread so the
            // checked value replaces the raw one it was derived from.
            ...checked.values,
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

        if (!writeSettings(newSettings)) {
            return res.status(500).json({ error: 'Failed to persist settings. Please retry.' });
        }

        /* THE INVOICE SERIES FOLLOWS THE SETTING.
           `invoiceSeqStart` seeds a financial year's first allocation, but the
           allocator lives in `document_sequences` now — so an owner editing
           this key mid-year would otherwise save successfully, be told it
           worked, and see the very next invoice ignore them. Applied after the
           settings write, and only when the value actually moved, so a save
           that changed something else does not disturb a live series.
           Lowering was already refused above without confirmDestructive. */
        if (checked.values.invoiceSeqStart !== undefined
            && Number(checked.values.invoiceSeqStart) !== Number(currentSettings.invoiceSeqStart)) {
            try {
                const context = repo.dataStoreContext();
                repo.inTransaction(() => {
                    repo.sequences.setNextValue({
                        tenantId: context.tenantId,
                        branchId: context.branchId,
                        documentType: 'invoice',
                        financialYear: repo.financialYear(),
                        prefix: newSettings.invoicePrefix || 'GOLD',
                        nextValue: checked.values.invoiceSeqStart
                    });
                });
            } catch (err) {
                // The setting is saved; the series is not. Loud rather than
                // silent — an operator who thinks the numbering moved and finds
                // it did not is exactly the confusion worth logging.
                logError(`Settings saved but the invoice sequence could not be moved to `
                    + `${checked.values.invoiceSeqStart}: ${err.message}`, err.stack);
            }
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
 * every route answers 400 with the same wording.
 *
 * The `years` hint this used to return is gone with the JSON partitions it
 * existed to narrow — the database has an index on `issued_at`, so a bounded
 * range is a WHERE clause rather than a decision about which files to open.
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

    return { ok: true, from, to, limit };
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

        /* The database filters, pages and sums. The route this replaces read
           every sales_YYYY.json off disk, concatenated the store's entire
           history into one array and serialised the lot — the single largest
           thing the server did, and it got slower every day the store traded. */
        const context = repo.dataStoreContext();
        const filter = { tenantId: context.tenantId, fromAt: q.from, toAt: q.to };
        const { rows, total } = repo.invoices.search({ ...filter, limit: q.limit, offset: 0 });

        res.json({
            results: saleService.projectSalesPage(rows),
            total,
            truncated: total > rows.length,
            limit: q.limit,
            // Over the whole matched period, not over the page — see periodTotals().
            totals: repo.invoices.periodTotals(filter)
        });
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
        const { from, to, limit } = parsed;

        /* Return state rides along on every hit — the Return Desk searches
           through this same route (it is the same "find the invoice the
           customer is holding" question) and needs to know what is still
           returnable, while the Reprint Desk needs it to stamp a duplicate of
           an invoice that has since been refunded. `projectSalesPage` attaches
           it in three queries for the whole page rather than three per row. */
        const result = saleService.listSales({
            q: req.query.q,
            fromAt: from,
            toAt: to,
            limit,
            offset: 0
        });

        res.json({
            results: result.results,
            total: result.total,
            truncated: result.truncated
        });
    } catch (err) {
        logError('Invoice reprint lookup failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to search invoices' });
    }
});

/**
 * The `users.id` a session's actor writes as.
 *
 * TWO IDENTITY SYSTEMS MEET HERE. The operator roster is configuration — it
 * lives in settings.json and stays there (§0) — while every accountability
 * column on the ledger is a foreign key into `users`. This resolves one to the
 * other, creating or refreshing the row as needed, so `invoices.created_by_user_id`
 * and `advance_entries.approved_by_user_id` name the person who actually acted
 * instead of defaulting to the store owner.
 *
 * That default is not a cosmetic difference. `advanceService` gates posting a
 * claim on `users.isApprover()`, and `owner` is an approver — so writing every
 * row as the owner would have let a cashier pass the check that exists to stop
 * a cashier releasing money to themselves.
 */
/**
 * The store's settings, with the invoice-numbering fields repaired on disk.
 *
 * POST /api/settings type-checks these on the way in, but a settings.json can
 * also arrive from a restored backup, a hand edit, or an older build — and this
 * is the last point before the values reach a permanent, legally-relevant
 * ledger. The sale service defends itself against the same garbage, but only in
 * memory; repairing the FILE is what stops a poisoned document producing an
 * identical warning on every sale forever.
 *
 * Writing lives here rather than in the service because settings.json is
 * configuration and the routes own it — the service is handed a document and
 * never a path.
 */
function billingSettings() {
    const settings = readSettings();

    const rawPrefix = settings.invoicePrefix;
    const prefix = typeof rawPrefix === 'string' && /^[A-Za-z0-9_-]+$/.test(rawPrefix.trim())
        ? rawPrefix.trim()
        : 'GOLD';
    const rawSeq = Number(settings.invoiceSeqStart);
    const seqStart = Number.isInteger(rawSeq) && rawSeq >= 1 ? rawSeq : 1;

    if (prefix !== settings.invoicePrefix || seqStart !== settings.invoiceSeqStart) {
        settings.invoicePrefix = prefix;
        settings.invoiceSeqStart = seqStart;
        // Best-effort. A repair that cannot be written must not stop the store
        // trading — the in-memory values above are already usable.
        if (!writeSettings(settings)) {
            logError('Invoice numbering settings were unusable and could not be repaired on disk.');
        }
    }

    return settings;
}

function resolveActorUserId(actor) {
    const context = repo.dataStoreContext();
    if (!actor || !actor.id) return context.systemUserId;
    try {
        return repo.users.ensureActorUser(context.tenantId, context.branchId, actor);
    } catch (err) {
        // Never fail a sale because the identity row could not be refreshed —
        // but never silently upgrade rights either. `system` is outside the
        // approvers view, so the fallback is the safe direction.
        logError(`Could not resolve actor ${actor.id} onto a users row: ${err.message}`);
        return context.systemUserId;
    }
}

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
     - the flat `purity` / `weightGrams` / `makingChargeAmount` fields.
   The stored record carries `lines` AND the flat rollup fields, so every reader
   that has not been taught about lines keeps working unchanged. See saleLines()
   in frontend/js/lib/billingMath.js for the reading half of the same seam.

   VALIDATION AND PRICING BOTH LIVE IN backend/services/saleService.js now, not
   here. They moved together on purpose: the limits on what a sale may be are
   properties of a sale, not of HTTP, and keeping a second copy at the boundary
   meant two implementations to hold in step. The route parses the request and
   chooses the status code; everything below that is the service's.
   ========================================================================== */


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

        /* Everything below the parse is the sale service's: the store's rate,
           the store's tax configuration, the arithmetic, the numbering and the
           persistence. The route's job stops at deciding what is a well-formed
           request and what status code the answer gets.

           ONE TRANSACTION. Invoice-number allocation, the header, its lines,
           its tenders, the advance redemption and the audit row now commit
           together or not at all. The JSON path could not make the NUMBER part
           of that unit — the counter lived in settings.json behind a
           read-modify-write, so a failed write silently reissued a number that
           was already on a customer's slip. */
        const result = saleService.createSale({
            lines: Array.isArray(req.body.lines) && req.body.lines.length > 0 ? req.body.lines : null,
            purity: req.body.purity,
            weightGrams: req.body.weightGrams,
            goldPricePerGram: req.body.goldPricePerGram,
            makingChargeAmount: req.body.makingChargeAmount,
            makingChargePercent: req.body.makingChargePercent,
            description: req.body.description,
            discountPercent: numDiscountPercent,
            customerName,
            customerPhone,
            appliedAdvance: numAppliedAdvance,
            clientTotal: numTotal,
            tenders: req.body.tenders,
            idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey || null
        }, {
            getActiveGoldRates,
            getSettings: billingSettings,
            // WHO BILLED THIS — taken from the session, never from the body. A
            // client-supplied cashier name is worth nothing as an audit trail,
            // since the whole point is to bind the record to the credential
            // that was used. `ensureActorUser` maps that identity onto the
            // `users` row the ledger's foreign keys point at.
            actorUserId: resolveActorUserId(req.actor),
            actor: req.actor,
            actorLabel: (req.actor && req.actor.name) || 'counter',
            ipAddress: req.ip
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({ error: result.error });
        }

        logTelemetry('SAVE_SALE', 0, `Invoice: ${result.invoiceId}, Total: ${result.sale.totalAmount}`);
        fireHook('onSaleSaved', result.sale);
        // `totalCorrected` / `rateCorrected` let the cashier know the printed
        // preview no longer matches what was filed, instead of the two
        // silently diverging.
        return res.json({
            success: true,
            invoiceId: result.invoiceId,
            sale: result.sale,
            totalCorrected: result.totalCorrected,
            rateCorrected: result.rateCorrected,
            ...(result.duplicate ? { duplicate: true } : {})
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

        const context = repo.dataStoreContext();
        const result = returnService.listReturns({
            fromAt: q.from, toAt: q.to, limit: q.limit, offset: 0
        });

        res.json({
            results: result.results,
            total: result.total,
            truncated: result.total > result.results.length,
            limit: q.limit,
            totals: repo.creditNotes.periodTotals({
                tenantId: context.tenantId, fromAt: q.from, toAt: q.to
            })
        });
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
 * the credit note, so the two can never exist apart — a foreign key from the
 * advance entry to the credit note now makes an orphaned credit
 * unrepresentable rather than merely unlikely.
 */
app.post('/api/returns', requireAdminSession, (req, res) => {
    try {
        const { invoiceId, weightGrams, refundMode, note, lineNumber } = req.body || {};

        // Which item on the invoice is coming back. Optional on a single-line
        // invoice — the service resolves it — and required on a multi-line one,
        // which it enforces rather than guessing: pricing a 22K return at an
        // 18K line's rate would refund the wrong money, and do it quietly.
        const numLine = lineNumber === undefined || lineNumber === null ? null : Number(lineNumber);
        if (numLine !== null && (!Number.isInteger(numLine) || numLine < 1)) {
            return res.status(400).json({ error: 'Line number must be a positive whole number.' });
        }

        const refundSettings = readSettings();
        const threshold = round2(refundSettings.refundApprovalThreshold || 0);
        const invoiceLabel = String(invoiceId || '').trim();

        const result = returnService.createReturn({
            invoiceId,
            weightGrams,
            refundMode,
            note,
            lineNumber: numLine,
            idempotencyKey: req.get('Idempotency-Key') || (req.body || {}).idempotencyKey || null
        }, {
            getActiveGoldRates,
            isValidPhone,
            actorUserId: resolveActorUserId(req.actor),
            actor: req.actor,
            actorLabel: (req.actor && req.actor.name) || 'counter',
            ipAddress: req.ip,
            /* THE APPROVAL THRESHOLD, applied to the server's own priced refund
               rather than to any figure the client proposed. Zero disables the
               control, which is the previous behaviour and therefore the
               default: no existing store is surprised by a refusal it never
               configured.

               The MFA condition is the same one requireApprover applies,
               restated rather than shared because this is not a whole-route
               gate — a cashier may file small refunds all day, and only
               crossing the threshold makes this an approver's decision. */
            authorizeRefund: (refundAmount) => {
                if (!(threshold > 0) || refundAmount < threshold) return { ok: true };

                if (!roleCanApprove(req.actor.role)) {
                    logTelemetry('REFUND_APPROVAL_DENIED', 0,
                        `${req.actor.name} (${req.actor.role}) attempted ${refundAmount} on ${invoiceLabel}`);
                    return {
                        ok: false,
                        status: 403,
                        error: 'APPROVER_REQUIRED',
                        message: `A refund of ₹${refundAmount} needs a manager or the owner to authorise it `
                            + `(this store's limit is ₹${threshold}). ${req.actor.name} is signed in as ${req.actor.role}.`
                    };
                }

                if (refundSettings.requireMfaForApprovers === true && req.adminSession && !req.adminSession.mfaUsed) {
                    logTelemetry('REFUND_APPROVAL_DENIED_NO_MFA', 0,
                        `${req.actor.name} (${req.actor.role}) attempted ${refundAmount} on ${invoiceLabel}`);
                    return {
                        ok: false,
                        status: 403,
                        error: 'MFA_REQUIRED',
                        message: `A refund of ₹${refundAmount} is at or above this store's ₹${threshold} limit, `
                            + 'and this store requires two-factor authentication to authorise one. '
                            + 'Sign in with your authenticator code.'
                    };
                }

                return { ok: true };
            }
        });

        if (!result.ok) {
            return res.status(result.status || 400).json({
                error: result.error,
                ...(result.message ? { message: result.message } : {})
            });
        }

        logTelemetry(
            'SAVE_RETURN', 0,
            `Return: ${result.returnId}, Invoice: ${result.return.originalInvoiceId}, `
            + `Weight: ${result.return.weightGrams}g, Refund: ${result.return.refundAmount} (${refundMode})`
        );
        fireHook('onReturnSaved', result.return);
        if (result.advanceCredit) fireHook('onAdvanceDeposit', result.advanceCredit);

        res.json({
            success: true,
            returnId: result.returnId,
            return: result.return,
            advanceCredit: result.advanceCredit,
            // What is left on the LINE just returned against…
            remainingWeightGrams: result.remainingWeightGrams,
            // …and on the invoice as a whole, which is what the desk needs to
            // decide whether to offer another return against this bill at all.
            invoiceRemainingWeightGrams: result.invoiceRemainingWeightGrams
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

        const context = repo.dataStoreContext();
        const filter = {
            tenantId: context.tenantId,
            entryType: type || null,
            fromAt: q.from,
            toAt: q.to
        };
        const { rows, total } = repo.advances.search({ ...filter, limit: q.limit, offset: 0 });

        res.json({
            results: repo.advances.toLegacyAdvances(rows),
            total,
            truncated: total > rows.length,
            limit: q.limit,
            // The store's whole outstanding liability, deliberately NOT narrowed
            // by the date filter: what the store owes its customers is not a
            // property of the period being browsed.
            summary: repo.advances.liabilitySummary(context.tenantId),
            totals: repo.advances.periodTotals(filter)
        });
    } catch (err) {
        logError('Error retrieving advances ledger: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve advances ledger' });
    }
});

/**
 * GET /api/audit?entityType=&entityId=&actorUserId=&action=&from=&to=&limit=
 * A page of the append-only audit trail, newest first.
 *
 * APPROVER-ONLY, deliberately. The trail names who released money and when, so
 * it is the record a cashier under suspicion has the strongest motive to read
 * and the least business reading. `requireApprover` is the same gate that
 * governs releasing a claim, which keeps "who may see the evidence" and "who
 * may create the thing being evidenced" answered by one rule rather than two.
 *
 * The table has been written on every money path since Phase 29 — saleService,
 * returnService, advanceService and paymentService all call `audit.record()` —
 * but nothing exposed it until now. An append-only table that cannot be read
 * is evidence in principle and not in practice: the trigger stops it being
 * edited, and the absence of a route stopped it being used.
 *
 * `detail_json` is parsed here rather than shipped as a string, so the browser
 * never has to JSON.parse a field that might be null.
 */
app.get('/api/audit', requireAdminSession, requireApprover, (req, res) => {
    try {
        const q = parseLedgerQuery(req.query);
        if (!q.ok) return res.status(400).json({ error: q.error });

        const context = repo.dataStoreContext();
        const { rows, total } = repo.audit.search({
            tenantId: context.tenantId,
            entityType: String(req.query.entityType || '').trim() || null,
            entityId: String(req.query.entityId || '').trim() || null,
            actorUserId: String(req.query.actorUserId || '').trim() || null,
            action: String(req.query.action || '').trim() || null,
            fromAt: q.from,
            toAt: q.to,
            limit: q.limit,
            offset: 0
        });

        res.json({
            results: rows.map(row => ({
                id: row.id,
                action: row.action,
                entityType: row.entity_type,
                entityId: row.entity_id,
                summary: row.summary,
                actorLabel: row.actor_label,
                actorUserId: row.actor_user_id,
                ipAddress: row.ip_address,
                occurredAt: row.occurred_at,
                businessDate: row.business_date,
                detail: row.detail_json ? JSON.parse(row.detail_json) : null
            })),
            total,
            truncated: total > rows.length,
            limit: q.limit
        });
    } catch (err) {
        logError('Error retrieving audit trail: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve audit trail' });
    }
});

/**
 * GET /api/audit/verify
 * Recompute the audit chain and report whether it still checks out.
 *
 * APPROVER-ONLY, on the same gate as reading the trail itself.
 *
 * WHAT A GREEN ANSWER HERE DOES AND DOES NOT MEAN. It means no row has been
 * edited or removed without the hashes after it being recomputed too. It does
 * NOT mean the history is genuine: whoever holds the database file can edit a
 * row and re-hash the entire tail, and this endpoint will report ok. That is an
 * unavoidable property of a chain that lives in the same file as the data.
 *
 * What closes that gap is the head hash — published on every export, and
 * therefore already in somebody else's hands. `headHash` is returned here for
 * exactly that reason: compare it against the value in an export taken earlier,
 * and a re-hashed chain no longer matches.
 */
app.get('/api/audit/verify', requireAdminSession, requireApprover, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const result = repo.audit.verifyChain(context.tenantId);
        res.json({
            verified: result.ok,
            eventsInChain: result.checked,
            /* Reported, never hidden: events written before the chain existed
               (migration 005) carry no hashes and are not covered. Backfilling
               them would hash whatever they say now, which proves nothing about
               what they said then. */
            eventsPredatingChain: result.unchained,
            headHash: result.head,
            brokenAt: result.brokenAt
        });
    } catch (err) {
        logError('Error verifying the audit chain: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to verify the audit trail' });
    }
});

/**
 * GET /api/audit/export?from=&to=
 * The trail plus the manifest needed to check it later. Approver-only.
 *
 * Served as a download rather than a rendered page because its purpose is to
 * LEAVE — a copy handed to an auditor, an accountant or a regulator is what
 * pins the head hash outside this building and makes the chain worth having.
 *
 * The date range narrows the ROWS, never the manifest: the head hash always
 * describes the whole chain, because a hash over a filtered slice could be made
 * to look clean by choosing the filter.
 */
app.get('/api/audit/export', requireAdminSession, requireApprover, (req, res) => {
    try {
        const q = parseLedgerQuery(req.query);
        if (!q.ok) return res.status(400).json({ error: q.error });

        const context = repo.dataStoreContext();
        const dump = repo.audit.exportChain(context.tenantId, { from: q.from, to: q.to });

        repo.audit.record({
            tenantId: context.tenantId,
            action: 'AUDIT_EXPORTED',
            entityType: 'audit',
            summary: `Audit trail exported (${dump.manifest.rowsExported} events)`,
            actorUserId: resolveActorUserId(req.actor),
            actorLabel: req.actor && req.actor.name ? req.actor.name : 'admin',
            ipAddress: req.ip
        });

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="audit-trail-${stamp}.json"`);
        res.send(JSON.stringify({
            ...dump,
            events: dump.events.map(row => ({
                ...row,
                detail_json: undefined,
                detail: row.detail_json ? JSON.parse(row.detail_json) : null
            }))
        }, null, 2));
    } catch (err) {
        logError('Error exporting the audit trail: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to export the audit trail' });
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

        const context = repo.dataStoreContext();
        const { rows, total } = repo.advances.customerRollup({
            tenantId: context.tenantId, q, limit, offset: 0
        });

        res.json({
            results: rows,
            total,
            truncated: total > rows.length,
            limit,
            summary: repo.advances.liabilitySummary(context.tenantId)
        });
    } catch (err) {
        logError('Error rolling up advance customers: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve advance customers' });
    }
});

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
        res.json(advanceService.customerLedger(phone));
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
        const result = advanceService.recordDeposit({
            ...(req.body || {}),
            status: ADVANCE_STATUS.APPROVED,
            source: 'counter'
        }, {
            getActiveGoldRates,
            isValidPhone,
            actorUserId: resolveActorUserId(req.actor),
            actorLabel: (req.actor && req.actor.name) || 'counter',
            ipAddress: req.ip
        });
        if (!result.success) {
            const status = result.status
                || (result.code === 'DUPLICATE_REFERENCE' ? 409 : 400);
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
        /* The bare array is the wire shape this route has always returned, and
           the approval queue is bounded by how fast a counter reviews claims
           rather than by how long the store has traded — so it stays a list
           rather than growing a page envelope its one consumer would have to
           be taught. The limit is a backstop, not a pager. */
        res.json(advanceService.listPending({ limit: LEDGER_PAGE_MAX }).results);
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
        const result = advanceService.reviewDeposit(
            req.params.id, ADVANCE_STATUS.APPROVED, (req.body || {}).note,
            {
                actorUserId: resolveActorUserId(req.actor),
                actorLabel: (req.actor && req.actor.name) || 'counter',
                ipAddress: req.ip
            }
        );
        if (!result.success) return res.status(result.status || 400).json({ error: result.error });
        // Fired on APPROVAL rather than at submission: this is the moment the
        // credit becomes real for the customer. Raised at the route because
        // extensions are a delivery concern, not something the service layer
        // should know about.
        fireHook('onAdvanceDeposit', result.deposit);
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
        const result = advanceService.reviewDeposit(req.params.id, ADVANCE_STATUS.REJECTED, note, {
            actorUserId: resolveActorUserId(req.actor),
            actorLabel: (req.actor && req.actor.name) || 'counter',
            ipAddress: req.ip
        });
        if (!result.success) return res.status(result.status || 400).json({ error: result.error });
        res.json({ success: true, deposit: result.deposit });
    } catch (err) {
        logError('Error rejecting advance deposit: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to reject the deposit' });
    }
});

/* ==========================================================================
   API Routes: Lot Inventory (roadmap Phase 5.2, the ungated slice)

   No route here creates a `purchase` or `transfer` movement — the roadmap's
   own P2 section gates vendor/purchase and branch transfer behind a legal/
   business definition (GST reverse-charge, inter-GSTIN accounting) that has
   not been made. Stock only ever enters via an opening-balance lot or moves
   via an adjustment — see 006_lot_inventory.sql for the full reasoning.
   Every write is requireAdminSession only (no requireApprover): the
   movement itself is the audit trail, matching this feature's "straight-
   forward CRUD-and-ledger" scope rather than advance_entries' approval
   workflow.
   ========================================================================== */

const PURITY_RULE = { type: 'enum', values: ['24K', '22K', '18K'], required: true };

const INVENTORY_ITEM_CREATE_SCHEMA = {
    name: { type: 'string', maxLength: 200, minLength: 1, required: true },
    category: { type: 'string', maxLength: 100 },
    purity: PURITY_RULE
};

const INVENTORY_ITEM_PATCH_SCHEMA = {
    name: { type: 'string', maxLength: 200, minLength: 1 },
    category: { type: 'string', maxLength: 100 },
    purity: { ...PURITY_RULE, required: false },
    isActive: { type: 'boolean' }
};

const INVENTORY_LOT_OPEN_SCHEMA = {
    itemId: { type: 'string', maxLength: 64, minLength: 1, required: true },
    weightGrams: { type: 'number', min: 0.001, max: 100000, required: true },
    label: { type: 'string', maxLength: 200 },
    reason: { type: 'string', maxLength: 500 }
};

const INVENTORY_ADJUST_SCHEMA = {
    weightDeltaGrams: { type: 'number', min: -100000, max: 100000, required: true },
    reason: { type: 'string', maxLength: 500 }
};

/** grams (wire) -> integer milligrams (storage), matching saleService.js's weightMilligrams(). */
function gramsToMg(grams) {
    return Math.round(Number(grams) * 1000);
}

function inventoryItemToWire(row) {
    return {
        id: row.id, name: row.name, category: row.category, purity: row.purity,
        skuCode: row.sku_code, isActive: Boolean(row.is_active),
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function inventoryLotToWire(row) {
    return {
        id: row.id, branchId: row.branch_id, itemId: row.item_id, label: row.label,
        weightGrams: round3(row.balance_mg / 1000), createdAt: row.created_at
    };
}

function inventoryMovementToWire(row) {
    return {
        id: row.id, branchId: row.branch_id, itemId: row.item_id, lotId: row.lot_id,
        movementType: row.movement_type, weightDeltaGrams: round3(row.weight_delta_mg / 1000),
        reason: row.reason, actorUserId: row.actor_user_id,
        createdAt: row.created_at, businessDate: row.business_date
    };
}

app.get('/api/inventory/items', requireAdminSession, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const activeOnly = req.query.activeOnly === 'true';
        res.json(repo.inventory.listItems(context.tenantId, { activeOnly }).map(inventoryItemToWire));
    } catch (err) {
        logError('Error listing inventory items: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to list inventory items' });
    }
});

app.post('/api/inventory/items', requireAdminSession, validateBody(INVENTORY_ITEM_CREATE_SCHEMA), (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const id = repo.inventory.createItem({
            tenantId: context.tenantId,
            name: req.body.name,
            category: req.body.category || null,
            purity: req.body.purity
        });
        res.json({ success: true, id, item: inventoryItemToWire(repo.inventory.getItem(context.tenantId, id)) });
    } catch (err) {
        logError('Error creating inventory item: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to create the inventory item' });
    }
});

app.patch('/api/inventory/items/:id', requireAdminSession, validateBody(INVENTORY_ITEM_PATCH_SCHEMA), (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const updated = repo.inventory.updateItem(context.tenantId, req.params.id, req.body || {});
        if (!updated) return res.status(404).json({ error: 'No inventory item with that id' });
        res.json({ success: true, item: inventoryItemToWire(updated) });
    } catch (err) {
        logError('Error updating inventory item: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to update the inventory item' });
    }
});

/**
 * GET /api/inventory/stock
 * Current on-hand weight per item, summed across every lot. Scoped to the
 * caller's own branch unless the deployment ever grows more than one — today
 * that is always the bootstrap branch, matching how every other route in
 * this file resolves "which branch" from context rather than the client.
 */
app.get('/api/inventory/stock', requireAdminSession, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const summary = repo.inventory.itemStockSummary(context.tenantId, { branchId: context.branchId });
        res.json(summary.map(row => ({
            itemId: row.item_id, name: row.name, category: row.category, purity: row.purity,
            isActive: Boolean(row.is_active), weightGrams: round3(row.balance_mg / 1000)
        })));
    } catch (err) {
        logError('Error reading inventory stock summary: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to read the stock summary' });
    }
});

app.get('/api/inventory/lots', requireAdminSession, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const lots = repo.inventory.listLots(context.tenantId, {
            branchId: context.branchId,
            itemId: req.query.itemId || null
        });
        res.json(lots.map(inventoryLotToWire));
    } catch (err) {
        logError('Error listing inventory lots: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to list inventory lots' });
    }
});

/**
 * POST /api/inventory/lots
 * Opens a new lot with its opening-balance movement — the only way stock
 * enters this system today (see the section header above for why there is
 * no purchase-receiving route yet).
 */
app.post('/api/inventory/lots', requireAdminSession, validateBody(INVENTORY_LOT_OPEN_SCHEMA), (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const item = repo.inventory.getItem(context.tenantId, req.body.itemId);
        if (!item) return res.status(400).json({ error: 'No inventory item with that id' });

        const { lotId } = repo.inTransaction(() => repo.inventory.openLot({
            tenantId: context.tenantId,
            branchId: context.branchId,
            itemId: req.body.itemId,
            weightMg: gramsToMg(req.body.weightGrams),
            label: req.body.label || null,
            reason: req.body.reason || null,
            actorUserId: resolveActorUserId(req.actor)
        }));
        res.json({ success: true, id: lotId, lot: inventoryLotToWire(repo.inventory.getLot(context.tenantId, lotId)) });
    } catch (err) {
        logError('Error opening inventory lot: ' + err.message, err.stack);
        res.status(400).json({ error: err.message || 'Failed to open the inventory lot' });
    }
});

/**
 * POST /api/inventory/lots/:id/adjust
 * A physical count found more or less than the book figure, breakage, or a
 * correction. Positive or negative weightDeltaGrams; refused if it would
 * take the lot negative.
 */
app.post('/api/inventory/lots/:id/adjust', requireAdminSession, validateBody(INVENTORY_ADJUST_SCHEMA), (req, res) => {
    try {
        const weightDeltaMg = gramsToMg(req.body.weightDeltaGrams);
        if (weightDeltaMg === 0) {
            return res.status(400).json({ error: 'weightDeltaGrams must not round to zero milligrams.' });
        }
        const context = repo.dataStoreContext();
        const movementId = repo.inTransaction(() => repo.inventory.recordAdjustment({
            tenantId: context.tenantId,
            lotId: req.params.id,
            weightDeltaMg,
            reason: req.body.reason || null,
            actorUserId: resolveActorUserId(req.actor)
        }));
        res.json({ success: true, movementId, balanceGrams: round3(repo.inventory.lotBalanceMg(req.params.id) / 1000) });
    } catch (err) {
        logError('Error adjusting inventory lot: ' + err.message, err.stack);
        res.status(400).json({ error: err.message || 'Failed to adjust the inventory lot' });
    }
});

app.get('/api/inventory/movements', requireAdminSession, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const movements = repo.inventory.listMovements(context.tenantId, {
            branchId: context.branchId,
            itemId: req.query.itemId || null,
            lotId: req.query.lotId || null,
            limit: req.query.limit
        });
        res.json(movements.map(inventoryMovementToWire));
    } catch (err) {
        logError('Error listing inventory movements: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to list inventory movements' });
    }
});

/* ==========================================================================
   API Routes: Cash Shifts (roadmap Phase 5.3)

   "Expected cash" is never trusted from the client — it is always computed
   server-side from the ledger over the shift's own time window (see
   cashShiftRepository.js#expectedCashAsOf). requireAdminSession only, no
   requireApprover: the shift record itself (who opened it, who closed it,
   what was counted) is the audit trail, matching this feature's
   straightforward-CRUD scope — the same call made for inventory adjustments
   above. Gating a large-variance close behind an approver is a reasonable
   follow-up, not built here.
   ========================================================================== */

const CASH_SHIFT_OPEN_SCHEMA = {
    openingFloat: { type: 'number', min: 0, max: 1000000, required: true },
    openingNote: { type: 'string', maxLength: 500 }
};

const CASH_SHIFT_CLOSE_SCHEMA = {
    countedCash: { type: 'number', min: 0, max: 10000000, required: true },
    closingNote: { type: 'string', maxLength: 500 }
};

function cashShiftToWire(row) {
    return {
        id: row.id, branchId: row.branch_id, status: row.status,
        openingFloat: fromPaise(row.opening_float_paise), openingNote: row.opening_note,
        openedByUserId: row.opened_by_user_id, openedAt: row.opened_at,
        countedCash: row.counted_cash_paise != null ? fromPaise(row.counted_cash_paise) : null,
        expectedCash: row.expected_cash_paise != null ? fromPaise(row.expected_cash_paise) : null,
        variance: row.variance_paise != null ? fromPaise(row.variance_paise) : null,
        closedByUserId: row.closed_by_user_id, closedAt: row.closed_at, closingNote: row.closing_note,
        businessDate: row.business_date
    };
}

/**
 * GET /api/cash-shifts/current
 * The branch's open shift (if any), plus a live preview of expected cash —
 * the same computation `close` freezes, so a cashier can see where the
 * drawer stands before committing to a count.
 */
app.get('/api/cash-shifts/current', requireAdminSession, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const shift = repo.cashShifts.getOpenShift(context.tenantId, context.branchId);
        if (!shift) return res.json({ shift: null });

        const preview = repo.cashShifts.expectedCashAsOf(shift);
        res.json({
            shift: cashShiftToWire(shift),
            expectedCash: fromPaise(preview.expectedPaise),
            cashTenders: fromPaise(preview.cashTenders),
            cashDeposits: fromPaise(preview.cashDeposits),
            cashRefunds: fromPaise(preview.cashRefunds)
        });
    } catch (err) {
        logError('Error reading current cash shift: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to read the current cash shift' });
    }
});

app.post('/api/cash-shifts/open', requireAdminSession, validateBody(CASH_SHIFT_OPEN_SCHEMA), (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const shiftId = repo.inTransaction(() => repo.cashShifts.openShift({
            tenantId: context.tenantId,
            branchId: context.branchId,
            openingFloatPaise: toPaise(req.body.openingFloat),
            openingNote: req.body.openingNote || null,
            actorUserId: resolveActorUserId(req.actor)
        }));
        res.json({ success: true, id: shiftId, shift: cashShiftToWire(repo.cashShifts.getShift(context.tenantId, shiftId)) });
    } catch (err) {
        logError('Error opening cash shift: ' + err.message, err.stack);
        res.status(400).json({ error: err.message || 'Failed to open the shift' });
    }
});

/**
 * POST /api/cash-shifts/:id/close
 * Freezes expected cash as of now, records what the cashier/manager
 * actually counted, and closes the shift. The response always names both
 * figures and the variance — never just "closed" — because the whole point
 * of this route is to surface a mismatch, not hide one behind a success flag.
 */
app.post('/api/cash-shifts/:id/close', requireAdminSession, validateBody(CASH_SHIFT_CLOSE_SCHEMA), (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const result = repo.inTransaction(() => repo.cashShifts.closeShift({
            tenantId: context.tenantId,
            shiftId: req.params.id,
            countedCashPaise: toPaise(req.body.countedCash),
            closingNote: req.body.closingNote || null,
            actorUserId: resolveActorUserId(req.actor)
        }));
        res.json({
            success: true,
            expectedCash: fromPaise(result.expectedPaise),
            variance: fromPaise(result.variancePaise),
            shift: cashShiftToWire(repo.cashShifts.getShift(context.tenantId, req.params.id))
        });
    } catch (err) {
        logError('Error closing cash shift: ' + err.message, err.stack);
        res.status(400).json({ error: err.message || 'Failed to close the shift' });
    }
});

app.get('/api/cash-shifts', requireAdminSession, (req, res) => {
    try {
        const context = repo.dataStoreContext();
        const shifts = repo.cashShifts.listShifts(context.tenantId, { branchId: context.branchId, limit: req.query.limit });
        res.json(shifts.map(cashShiftToWire));
    } catch (err) {
        logError('Error listing cash shifts: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to list cash shifts' });
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

/* The order intent, and the record of what it was FOR, now live in the
   payment_orders table behind services/paymentService.js. The JSON file this
   replaced was pruned on every write to stay bounded; a table with an index
   does not need pruning to stay fast, and an order that has been paid is
   history worth keeping rather than a row to expire.

   Amounts crossing the wire to Razorpay are integer paise, never rupees. A
   rupee float cannot represent every payable amount exactly (₹1234.35 is
   stored as 1234.3499999999999), so comparing "what the gateway captured"
   against "what we recorded" in rupees compares two roundings and hopes they
   agree. In paise both sides are integers and the comparison is exact — which
   is the entire point of confirming a capture. */
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
app.post('/api/payment/order', requireEstablishedCustomer, paymentOrderLimiter, async (req, res) => {
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
        const settings = readSettings();

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
            if (!paymentService.recordOrder({ providerOrderId: mockOrderId, customerPhone: req.customerPhone, amountPaise, currency, provider: 'mock' })) {
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
        if (!paymentService.recordOrder({ providerOrderId: order.id, customerPhone: req.customerPhone, amountPaise, currency })) {
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

/*  Crediting a confirmed capture is services/paymentService.js's job now: the
    amount check, the duplicate guard keyed on the gateway payment id, the
    ledger credit and the order settlement all happen inside ONE transaction
    there. In the JSON version the credit and the order settlement were two
    separate writes, and a crash between them left a customer credited against
    an order still reading 'created' — or, on the other ordering, an order
    marked paid with no ledger row behind it. */

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
        const alreadyRecorded = repo.advances.toLegacyAdvance(
            repo.advances.findEntryByReference(
                repo.dataStoreContext().tenantId, 'razorpay', razorpay_payment_id
            )
        );
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
        const storedOrder = paymentService.findOrder(razorpay_order_id);
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
        const expectedPaise = storedOrder.amountPaise;
        if (!Number.isSafeInteger(expectedPaise) || expectedPaise <= 0 || expectedPaise > MAX_SANE_AMOUNT * 100) {
            logError(`Payment order ${razorpay_order_id} carries an unusable stored amount (${storedOrder.amountPaise ?? storedOrder.amount}).`);
            return res.status(500).json({ error: 'This payment order is not in a verifiable state. Please contact the store.' });
        }
        const settings = readSettings();
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
                paymentService.settleOrder(razorpay_order_id, 'failed', { paymentId: razorpay_payment_id, note: `gateway status ${gatewayStatus}`, provider: storedOrder.provider });
                return res.status(400).json({
                    error: `This payment was not completed (gateway status: ${gatewayStatus}). Nothing has been credited.`
                });
            }
        }

        const credit = paymentService.creditCapturedPayment({
            order: storedOrder,
            paymentId: razorpay_payment_id,
            capturedPaise,
            source: 'checkout'
        }, {
            getActiveGoldRates,
            isValidPhone,
            findAccount
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

/* The seen-event ledger lives in payment_events behind paymentService, where
   the idempotency guarantee is a UNIQUE index on the gateway's own event id
   rather than a read-modify-write that happened to be safe because Node runs
   a request to completion. The table also holds the OUTCOME of each delivery,
   so a redelivery can be answered with what was decided the first time. */

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
        const settings = readSettings();
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
            raiseAlert({
                code: 'WEBHOOK_SIGNATURE_MISMATCH',
                severity: 'warning',
                message: 'A Razorpay webhook delivery was rejected: signature did not match. Could be a misconfigured secret or a spoofed delivery.'
            });
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

        const claim = paymentService.claimWebhookEvent(eventId, eventType);
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
                paymentService.settleOrder(entity.order_id, 'failed', {
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

        const storedOrder = paymentService.findOrder(entity.order_id);
        if (!storedOrder) {
            // Not necessarily an attack: an order older than the retention
            // window prunes away, and this store may share a Razorpay account
            // with another product. Loud in the log, 2xx on the wire.
            logError(`Razorpay webhook ${eventId} referenced unknown payment order ${entity.order_id} (payment ${entity.id}). No credit applied.`);
            logTelemetry('WEBHOOK_UNKNOWN_ORDER', 0, `Order: ${entity.order_id}`);
            raiseAlert({
                code: 'WEBHOOK_UNKNOWN_ORDER',
                severity: 'warning',
                message: `Razorpay reported a captured payment (${entity.id}) against an order this store has no record of (${entity.order_id}). No credit was applied.`,
                details: { orderId: entity.order_id, paymentId: entity.id }
            });
            return res.json({ success: true, ignored: 'unknown-order' });
        }

        const credit = paymentService.creditCapturedPayment({
            order: storedOrder,
            paymentId: entity.id,
            capturedPaise: Number(entity.amount),
            source: 'webhook'
        }, {
            getActiveGoldRates,
            isValidPhone,
            findAccount
        });

        if (!credit.ok) {
            // A 5xx here is the correct answer: the delivery was authentic and
            // we failed to apply it, so we want Razorpay's retry. The event id
            // claim is released so that retry is not swallowed as a duplicate.
            if (credit.status === 500) {
                paymentService.releaseWebhookEvent(eventId);
                raiseAlert({
                    code: 'PAYMENT_CREDIT_FAILED',
                    severity: 'critical',
                    message: `A captured Razorpay payment (order ${entity.order_id}, payment ${entity.id}) could not be credited to the ledger. Money was taken but not recorded — manual reconciliation required.`,
                    details: { orderId: entity.order_id, paymentId: entity.id }
                });
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
        raiseAlert({
            code: 'WEBHOOK_PROCESSING_ERROR',
            severity: 'critical',
            message: 'An unhandled exception occurred while processing a Razorpay webhook delivery: ' + err.message
        });
        // Deliberately 5xx: an unexpected fault should be retried by the
        // gateway rather than silently dropped.
        res.status(500).json({ error: 'Webhook processing failed.' });
    }
});

/* ==========================================================================
   API Routes: Backups & Business Summary Reports
   ========================================================================== */

/**
 * POST /api/backup/run
 * Manually triggers an immediate rolling database snapshot (same routine
 * the 1:00 AM cron uses).
 */
app.post('/api/backup/run', requireAdminSession, expensiveAdminLimiter, (req, res) => {
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
app.post('/api/reports/send-now', requireAdminSession, expensiveAdminLimiter, async (req, res) => {
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
app.get('/api/diagnostics/export', requireAdminSession, expensiveAdminLimiter, (req, res) => {
    try {
        const context = repo.dataStoreContext();

        /* BOUNDED, and that is a change worth being explicit about. This bundle
           used to read every sales_YYYY.json and returns_YYYY.json off disk and
           encrypt the store's ENTIRE trading history into one payload — which
           grew without limit, and on a store a few years in produced an export
           too large to be usefully emailed to support. It is a diagnostic
           sample, not an archive: `npm run seed`-scale recent history is what
           actually explains a discrepancy, and a full extract is a backup
           (backupEngine.js), which is a different job with different handling.

           Returns travel with the sales they reverse. A bundle holding only the
           sales side shows a ledger that overstates what the store took, which
           is precisely the sort of discrepancy these exports get pulled to
           explain. */
        const EXPORT_SAMPLE_ROWS = 500;
        const sales = saleService.listSales({ limit: EXPORT_SAMPLE_ROWS }).results;
        const returns = returnService.listReturns({ limit: EXPORT_SAMPLE_ROWS }).results;

        // Pack sensitive databases together. Settings are masked even here:
        // diagnosing a tenant needs to know whether SMTP/Razorpay are
        // configured, never what the credentials are, and the mask preserves
        // exactly that distinction (empty string = unset). Keeps live tenant
        // credentials out of support bundles that get emailed around.
        const bundle = {
            timestamp: Date.now(),
            settings: redactSettings(readSettings()),
            advances: advanceService.listLedger({ limit: EXPORT_SAMPLE_ROWS }).results,
            sales,
            returns,
            // So a reader can tell a sampled bundle from a complete one rather
            // than assuming the store only ever made this many sales.
            sample: {
                rowsPerLedger: EXPORT_SAMPLE_ROWS,
                totalInvoices: repo.invoices.countInvoices(context.tenantId),
                totalCreditNotes: repo.creditNotes.countCreditNotes(context.tenantId),
                totalAdvanceEntries: repo.advances.countEntries(context.tenantId)
            }
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
app.get('/api/diagnostics/blackbox-export', requireAdminSession, expensiveAdminLimiter, (req, res) => {
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
   Terminal handlers

   Registered after every route, because Express matches in order and these two
   are the "nothing above me claimed this" cases.
   ========================================================================== */

/**
 * An unmatched /api/* path is a client bug, and it should read as one. Without
 * this it falls through to the static handler and comes back as Express's HTML
 * 404, which a fetch() then fails to parse — turning "you called the wrong URL"
 * into an unexplained JSON syntax error in the browser console. Anything that is
 * not an API path falls through, so a missing front-end asset still 404s as a
 * page rather than as JSON.
 *
 * TESTED BY PREDICATE, NOT MOUNTED AT '/api'. `app.use('/api', …)` strips the
 * mount prefix off `req.url` for the duration of the handler, and because this
 * one never calls next(), Express never restores it — so the body reported
 * `path: "/nope"` and, worse, the telemetry middleware's `finish` listener
 * logged every 404 under a path that does not exist. Caught by curling a bad
 * URL and reading telemetry.log, 2026-08-16.
 */
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    res.status(404).json({ error: 'NOT_FOUND', path: req.path, requestId: req.id });
});

/**
 * The one place an unhandled throw becomes a response.
 *
 * Until this existed, anything thrown outside a route's own try/catch reached
 * Express's default handler, which renders the **stack trace** into the response
 * body outside NODE_ENV=production — leaking absolute paths and internal
 * structure to whoever provoked it. This replies with a fixed message and the
 * request id, and puts the stack where it belongs: in error.log, findable by
 * that id.
 *
 * `next` is unused and must still be declared — Express identifies an error
 * handler by arity, and a three-argument version is silently treated as
 * ordinary middleware that never runs.
 */
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const requestId = req.id || 'unassigned';
    /* body-parser rejects malformed JSON and oversized bodies with a status of
       its own. Honour it: those are the caller's fault, and reporting them as
       500 would both mislead the caller and bury real crashes in noise. */
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;

    logError(`Unhandled error on ${req.method} ${req.path}: ${err.message}`, err.stack, { requestId, status });

    // Streaming responses have already committed a status line; the only honest
    // move left is to let Express destroy the socket.
    if (res.headersSent) return next(err);

    res.status(status).json(status === 500
        ? { error: 'INTERNAL_ERROR', message: 'Something went wrong. Quote this request id when reporting it.', requestId }
        : { error: 'BAD_REQUEST', message: err.message, requestId });
});

/* ==========================================================================
   Server Bootstrap & Scheduler Init
   ========================================================================== */

export { app };

/* How long a shutdown waits for in-flight requests before forcing the remaining
   sockets closed. Comfortably longer than any request this app serves, and
   comfortably shorter than the 30s a process manager or container runtime
   typically allows between SIGTERM and SIGKILL — miss that window and the
   supervisor kills the process mid-sale, which is the exact thing draining
   exists to prevent. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 10000;

/* Keyed by listener, not a single module-level promise. A process has one
   listener in production, but the suite starts a second one — and with a shared
   promise, draining that second listener would hand back the first one's
   promise and never actually close it. `draining` stays process-wide on
   purpose: readiness describes the process, not a socket. */
const shutdownsInFlight = new WeakMap();

/**
 * Stops serving without dropping work in progress.
 *
 * ORDER IS THE WHOLE POINT. Readiness flips to 503 first, so the proxy stops
 * sending new requests to a process that is about to disappear; only then does
 * the listener close, letting the sale already being posted finish and reply.
 * Reversing those two turns every deploy into a handful of failed requests.
 *
 * The database closes last, after the final response, because a repository
 * write that outlives its handle throws where a cashier can see it.
 *
 * Idempotent: two signals in quick succession get the same promise.
 *
 * @param {import('node:http').Server} server
 * @param {string} [reason] what triggered it, recorded in telemetry
 */
export function shutdown(server, reason = 'manual') {
    const already = shutdownsInFlight.get(server);
    if (already) return already;

    draining = true;
    console.log(`[Server] Draining (${reason}); waiting up to ${SHUTDOWN_GRACE_MS}ms for in-flight requests.`);
    logTelemetry('SERVER_SHUTDOWN', 0, reason, { reason, graceMs: SHUTDOWN_GRACE_MS });

    const drained = new Promise(resolve => {
        const forceTimer = setTimeout(() => {
            logError(`Shutdown still had open connections after ${SHUTDOWN_GRACE_MS}ms — forcing them closed.`);
            server.closeAllConnections?.();
        }, SHUTDOWN_GRACE_MS);
        forceTimer.unref?.();

        server.close(() => {
            clearTimeout(forceTimer);
            try {
                repo.closeDb();
            } catch (err) {
                logError('Failed to close the ledger during shutdown: ' + err.message, err.stack);
            }
            console.log('[Server] Drained; ledger closed.');
            resolve();
        });

        /* A keep-alive socket with no request on it holds the listener open for
           its full idle timeout and has nothing to finish, so close those now.
           Without this, `server.close()` routinely waits the entire grace period
           on a browser that is simply sitting there. */
        server.closeIdleConnections?.();
    });

    shutdownsInFlight.set(server, drained);
    return drained;
}

/** Starts the HTTP listener. Exported so route tests can use an ephemeral port. */
export function startServer(port = PORT, host = '127.0.0.1') {
    const server = app.listen(port, host, () => {
        const address = server.address();
        const listeningPort = typeof address === 'object' && address ? address.port : port;
        console.log(`[Server] Gold POS backend running on port ${listeningPort}`);
        logTelemetry('SERVER_BOOTSTRAP', 0, `Listening on port ${listeningPort}`);
    });

    /* `once`, so a second SIGTERM is not swallowed by an already-draining
       process — the operator sending it wants out, and the default handler
       exits immediately. process.exit() is explicit because the schedulers
       (node-cron) hold the event loop open indefinitely; closing the listener
       alone would leave the process running with nothing listening. */
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
            shutdown(server, signal).then(() => process.exit(0));
        });
    }

    return server;
}

/**
 * Migrates the schema, seeds the organisation, and carries a JSON-era tenant
 * across on the first boot after the cutover.
 *
 * THE IMPORT RUNS ONCE AND ONLY INTO AN EMPTY LEDGER. `importLegacyJson()` is
 * idempotent by construction — every row it writes carries an `import:` prefixed
 * idempotency key and a second run is a no-op — but the guard is here as well,
 * because "the database already has invoices" is the honest test for "this
 * tenant has already been cut over" and it costs one COUNT.
 *
 * THE JSON FILES ARE NOT DELETED. They are the fallback if an operator has to
 * roll back to the previous release, and `backupEngine` already carries them.
 * Retiring them is a separate, deliberate step once a tenant has traded on SQL
 * for a while — not something a boot should do to a live ledger unasked.
 */
function initialiseLedger() {
    const settings = readSettings();
    const context = repo.initialiseDataStore({
        name: settings.storeName,
        gstNumber: settings.gstNumber,
        address: settings.storeAddress,
        phone: settings.storePhone
    }, { log: message => console.log(`[DataStore] ${message}`) });

    const existing = repo.invoices.countInvoices(context.tenantId);
    if (existing > 0) return;

    const legacy = collectLegacySource();
    if (!legacy.hasAnything) return;

    console.log('[DataStore] Legacy JSON ledger found and the database is empty — importing.');
    const result = importLegacyJson({ log: message => console.log(`[Import] ${message}`) });
    if (!result.ok) {
        // Loud, and non-fatal. A tenant whose history will not import must not
        // be locked out of trading today, but nobody may be allowed to believe
        // the history came across when it did not.
        logError('Legacy ledger import FAILED — the store is running on an empty database. '
            + 'The JSON files are untouched. ' + (result.error || ''));
        console.error(formatReport(result));
        return;
    }
    logTelemetry('LEDGER_IMPORTED', 0,
        `invoices: ${result.counts.invoices}, advances: ${result.counts.advanceEntries}`);
    console.log(formatReport(result));
}

/** Whether this tenant has any legacy ledger JSON worth importing. */
function collectLegacySource() {
    try {
        const source = collectSource(DATA_DIR);
        return {
            hasAnything: Boolean(
                (source.sales && source.sales.length)
                || (source.advances && source.advances.length)
                || (source.returns && source.returns.length)
            ),
            source
        };
    } catch (err) {
        logError('Could not read the legacy ledger to decide on an import: ' + err.message);
        return { hasAnything: false, source: null };
    }
}

function bootstrapServer() {
    /* FIRST, because everything below reads settings.json and reading it now
       means decrypting it. A production install with no GOLD_POS_SECRET_KEY
       would otherwise die inside migrateStoredPins() with a stack trace rather
       than the numbered refusal an operator can act on. Inert outside
       NODE_ENV=production, where the vault falls back to a dev keyfile. */
    assertVaultKeyReady();

    /* Before the main guard, because it asks "is the master PIN still the
       default?" and can only answer that against the canonical stored form. This
       is also the moment a tenant upgrading from a build that kept PINs in
       plaintext has them hashed and the plaintext deleted — once, on the first
       boot after the upgrade, with nobody having to retype anything. */
    migrateStoredPins();

    // Then the ledger, because every route below reads and writes through it
    // and a pending migration must be applied before the port is bound.
    initialiseLedger();

    // Then, before any scheduler starts, any backup is written, or the port
    // is bound: refuse to run a production process that is configured to take
    // money it cannot honour. Inert outside NODE_ENV=production.
    assertProductionReady();

    // Initialize pricing, backup, report-email, and update-check schedulers.
    initPriceScheduler();
    initBackupScheduler();
    initReportScheduler();
    initUpdateScheduler();
    initAlertScheduler();

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
