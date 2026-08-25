/**
 * ==========================================================================
 * Gold POS Central Licensing Server
 * Serverless-ready, portable microservice for managing client activations.
 * ==========================================================================
 */

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NOTE: port 6000 is deliberately avoided — it's on the WHATWG Fetch spec's
// forbidden-port list (X11's reserved port), so Node's built-in fetch()
// refuses to connect to it. The POS client's licenseChecker.js talks to this
// server via fetch(), so that port choice would silently break every
// license handshake. Keep PORT out of the forbidden list if you override it.
const PORT = process.env.PORT || 6060;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MASTER-ADMIN-SECRET-12345';
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_DIR = path.join(__dirname, 'keys');

// Create folders if missing
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

// Initialize database file
const dbFile = path.join(DATA_DIR, 'licenses.json');
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify([
        {
            licenseKey: "DEMO-KEY-12345",
            customerName: "Demo Gold Jewelers Ltd",
            expiryDate: "2028-12-31",
            status: "active",
            billingCycle: "yearly",
            amount: 0,
            nextDueDate: "2028-12-31"
        }
    ], null, 2));
}

// Platform-wide config: latest published client version (legacy field, kept
// for backward compat with GET /api/version) plus a full release registry —
// POS clients poll GET /api/releases/latest and cryptographically verify the
// signature (via release_public.pem) before ever trusting/applying a release.
// See backend/updateEngine.js and docs/ai_handover.md §7.
const configFile = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({ latestVersion: "1.0.0", releases: [] }, null, 2));
}

// Automatically generate RSA key pairs for signing license tokens if missing
const privateKeyPath = path.join(KEYS_DIR, 'license_private.pem');
const publicKeyPath = path.join(KEYS_DIR, 'license_public.pem');

if (!fs.existsSync(privateKeyPath)) {
    console.log('[Licensing Server] Generating licensing RSA-2048 key pairs...');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(privateKeyPath, privateKey);
    fs.writeFileSync(publicKeyPath, publicKey);
}

const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

// Dedicated release-signing RSA keypair — deliberately separate from the
// license-signing key above (same compartmentalization pattern as
// backend/cryptoHelper.js's developer key vs backend/blackBoxLogger.js's
// black-box key: compromising one key must never unlock the other). This is
// the key that makes auto-applying a "security" release safe: a POS client
// verifies every release manifest against release_public.pem before it will
// ever download or apply it, so a compromised/spoofed licensing server alone
// cannot get malicious code auto-applied to a tenant.
const releasePrivateKeyPath = path.join(KEYS_DIR, 'release_private.pem');
const releasePublicKeyPath = path.join(KEYS_DIR, 'release_public.pem');

if (!fs.existsSync(releasePrivateKeyPath)) {
    console.log('[Licensing Server] Generating release-signing RSA-4096 key pair...');
    const { publicKey: relPub, privateKey: relPriv } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 4096,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(releasePrivateKeyPath, relPriv);
    fs.writeFileSync(releasePublicKeyPath, relPub);
    console.log(`[Licensing Server] IMPORTANT: copy ${releasePublicKeyPath} to every POS client's backend/keys/release_public.pem so it can verify releases.`);
}

const releasePrivateKey = fs.readFileSync(releasePrivateKeyPath, 'utf8');

const VALID_CHANNELS = ['security', 'feature', 'patch'];

/** Compares two "x.y.z" strings — true if `a` is newer than `b`. */
function isNewerVersion(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n) || 0);
    const pb = String(b).split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] || 0, vb = pb[i] || 0;
        if (va > vb) return true;
        if (va < vb) return false;
    }
    return false;
}

const app = express();
// Trust the loopback reverse proxy (Nginx, see deploy/nginx.conf.template)
// so req.ip resolves the real client IP from X-Forwarded-For — required for
// authenticateAdmin's brute-force lockout to key per real caller instead of
// locking every user out globally (same reasoning as backend/server.js).
app.set('trust proxy', 'loopback');
/* NO CORS MIDDLEWARE (security audit H8). `cors()` with no options reflects
   ANY origin as allowed — every consumer of this server is either
   server-to-server (the POS backend's licenseChecker.js) or same-origin (the
   admin panel served below), neither of which needs a CORS grant at all, so
   the previous blanket allowance bought nothing and only widened who a
   browser would let read a response from here. */
// A handful of headers, not a helmet() dependency (this is a JSON API with
// one inline admin panel, not a page that needs a full CSP directive list —
// see backend/package.json's dependency-budget note in CLAUDE.md §0).
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
app.use(express.json());

/**
 * Per-IP rate limiter (security audit H8: no rate limiting anywhere on this
 * server). Same fixed-window-counter shape as backend/rateLimit.js's
 * createRateLimiter; duplicated (not imported) because this is a separate
 * deployable with its own package.json and dependency budget — see the
 * createBoundedMap note further down for why. Built on createBoundedMap,
 * which is a hoisted function declaration, so calling it here ahead of its
 * own textual definition is safe.
 */
function createRateLimiter({ windowMs, max, message }) {
    const counters = createBoundedMap({ ttlMs: windowMs });
    return function limiter(req, res, next) {
        const now = Date.now();
        const key = req.ip || 'unknown';
        let entry = counters.get(key);
        if (!entry) entry = counters.set(key, { count: 0, resetAt: now + windowMs }, now);
        entry.count += 1;
        if (entry.count > max) {
            const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({ error: 'RATE_LIMITED', message, retryAfterSeconds });
        }
        return next();
    };
}

// Blanket per-IP ceiling, high enough that a legitimate tenant fleet polling
// this server never trips it — a stop on runaway/scripted traffic, not a
// quota. /api/health is exempt: monitoring polls it by design. Registered
// before every route below, which is what makes it apply to all of them —
// Express walks middleware in registration order, so a limiter added after
// a route is defined would never see that route's requests.
const apiRateLimiter = createRateLimiter({
    windowMs: 60 * 1000, max: 300,
    message: 'Too many requests. Please slow down and try again shortly.'
});
app.use((req, res, next) => {
    if (req.path === '/api/health') return next();
    return apiRateLimiter(req, res, next);
});

// License verification is unauthenticated and, unlike the other public
// routes here, its response shape distinguishes an unknown key from a
// known one — so an unthrottled caller could both spam the control plane
// and enumerate valid license keys (security audit H6).
const licenseVerifyLimiter = createRateLimiter({
    windowMs: 60 * 60 * 1000, max: 30,
    message: 'Too many verification attempts from this address. Please wait and try again.'
});

/**
 * GET /api/health
 * Public liveness check — used by CI post-deploy smoke tests and uptime
 * monitoring to confirm this specific environment's process is up.
 */
app.get('/api/health', (req, res) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    res.json({
        status: 'ok',
        version: pkg.version,
        env: process.env.ENV_NAME || process.env.NODE_ENV || 'unknown'
    });
});

/* ==========================================================================
   PORTABLE DATABASE ADAPTER (Easily replace JSON with CF KV / Mongo / Postgres)
   ========================================================================== */
class DatabaseAdapter {
    static async getLicenses() {
        try {
            // Local file implementation - Swap with DB driver fetch if migrating
            const content = fs.readFileSync(dbFile, 'utf8');
            return JSON.parse(content);
        } catch (_) {
            return [];
        }
    }

    static async saveLicenses(licenses) {
        // Local file implementation - Swap with DB driver save if migrating
        fs.writeFileSync(dbFile, JSON.stringify(licenses, null, 2));
    }

    static async findKey(key) {
        const licenses = await this.getLicenses();
        return licenses.find(l => l.licenseKey === key);
    }
}

/* ==========================================================================
   API Routes: Client Verification Gate
   ========================================================================== */

/**
 * POST /api/license/verify
 * Validates a client's license and returns an RSA-signed verification payload.
 */
app.post('/api/license/verify', licenseVerifyLimiter, async (req, res) => {
    try {
        const { licenseKey, systemFingerprint } = req.body;
        if (!licenseKey) {
            return res.status(400).json({ error: 'License key is required' });
        }

        const licenseRecord = await DatabaseAdapter.findKey(licenseKey);

        if (!licenseRecord) {
            return res.json({
                success: false,
                status: 'invalid',
                message: 'License key does not exist on central verification server.'
            });
        }

        const isExpired = new Date(licenseRecord.expiryDate) < new Date();
        const activeStatus = (licenseRecord.status === 'active' && !isExpired) ? 'active' : (isExpired ? 'expired' : 'suspended');

        // Create the activation payload token
        const payload = {
            licenseKey,
            customerName: licenseRecord.customerName,
            expiryDate: licenseRecord.expiryDate,
            status: activeStatus,
            billingCycle: licenseRecord.billingCycle || null,
            amount: licenseRecord.amount || 0,
            nextDueDate: licenseRecord.nextDueDate || null,
            systemFingerprint: systemFingerprint || 'unknown',
            timestamp: Date.now()
        };

        const payloadStr = JSON.stringify(payload);

        // Sign the token with licensing private key
        const signer = crypto.createSign('sha256');
        signer.update(payloadStr);
        const signature = signer.sign(privateKey, 'base64');

        res.json({
            success: activeStatus === 'active',
            payload: payloadStr,
            signature
        });
    } catch (err) {
        console.error('Verify exception:', err);
        res.status(500).json({ error: 'Internal licensing engine error' });
    }
});

/* ==========================================================================
   API Routes: Platform Version Check
   ========================================================================== */

/**
 * GET /api/version
 * Public — POS clients poll this on boot to compare against their own
 * package.json version and surface a non-blocking "update available"
 * banner. Never auto-updates anything (see docs/PROJECT_PLAN.md §5.1).
 */
app.get('/api/version', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        res.json({ latestVersion: config.latestVersion || '1.0.0' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read platform version config' });
    }
});

/**
 * GET /api/releases/latest?channel=security|feature|patch
 * Public — returns the newest published release (optionally filtered to one
 * channel) plus its RSA signature, so a POS client's updateEngine.js can
 * verify authenticity before ever downloading or applying it. Omit
 * `channel` to consider all channels (used for the "update available"
 * banner, which surfaces feature/patch releases too — those are never
 * auto-applied, only security-channel releases are).
 */
app.get('/api/releases/latest', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const releases = Array.isArray(config.releases) ? config.releases : [];
        const { channel } = req.query;

        const candidates = channel ? releases.filter(r => r.channel === channel) : releases;
        if (candidates.length === 0) {
            return res.status(404).json({ error: 'No matching release published' });
        }

        // Pick the highest-semver candidate. Return the exact signed payload
        // string alongside its signature — the client verifies the raw
        // string (never a re-serialized object, which could reorder keys
        // and break the signature) and only JSON.parses it after that
        // verification succeeds.
        //
        // Two entries can share a version: that's how a canary/pilot rollout
        // widens (see POST /api/admin/releases below) — the same version is
        // republished with a higher rolloutPercent rather than mutating the
        // original signed entry. On a tie, the most recently published one
        // wins, so republishing actually takes effect.
        const latest = candidates.reduce((best, r) => {
            if (isNewerVersion(r.version, best.version)) return r;
            if (r.version === best.version && r.publishedAt > best.publishedAt) return r;
            return best;
        }, candidates[0]);
        res.json({ payload: latest.payload, signature: latest.signature });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read release registry' });
    }
});

/* ==========================================================================
   API Routes: Management & Control Panel
   ========================================================================== */

// This token now gates far more than license management — since Phase 18 it
// can also publish signed "security"-channel releases that every tenant
// auto-applies (see backend/updateEngine.js). A leaked or default-left
// ADMIN_SECRET is effectively remote-code-execution across the whole
// tenant fleet, so this deserves the same brute-force lockout as the POS
// client's own admin PIN, plus a timing-safe comparison (a naive `!==`
// string compare leaks a byte-by-byte timing signal) and a loud startup
// warning if the well-known default was never changed.
const ADMIN_SECRET_IS_DEFAULT = ADMIN_SECRET === 'MASTER-ADMIN-SECRET-12345';
const IS_PRODUCTION = (process.env.NODE_ENV === 'production') || (process.env.ENV_NAME === 'production');
if (ADMIN_SECRET_IS_DEFAULT) {
    /* FAIL CLOSED IN PRODUCTION (security audit C2). A warning that does not
       stop the process is not a control — this default is documented in the
       repo, so anyone who can reach this port already knows it. Mirrors the
       fail-closed posture backend/productionGuard.js already takes for the
       POS admin PIN: refuse to boot rather than run with a known-public
       credential guarding fleet-wide code publishing. Non-production
       environments (local dev, a fresh install before ADMIN_SECRET is set)
       still boot, with a loud warning. */
    if (IS_PRODUCTION) {
        console.error('[Licensing Server] REFUSING TO START: ADMIN_SECRET is still the documented default (MASTER-ADMIN-SECRET-12345) and NODE_ENV/ENV_NAME is "production". This token can publish signed releases that auto-apply to every tenant — set a real secret via the ADMIN_SECRET env var before deploying.');
        process.exit(1);
    }
    console.warn('[Licensing Server] WARNING: ADMIN_SECRET is still the documented default. This token can publish code releases that auto-apply to every tenant — set a real secret via the ADMIN_SECRET env var before any real deployment.');
}

const MAX_FAILED_ADMIN_ATTEMPTS = 5;
const BASE_ADMIN_LOCKOUT_MS = 30 * 1000;
const MAX_ADMIN_LOCKOUT_MS = 15 * 60 * 1000;

/* Bounded, not a plain Map (security audit H7). A plain Map here only ever
   shed an entry on a SUCCESSFUL admin auth, so every source that failed once
   and never came back — one request from any new IP is enough — stayed
   resident for the life of the process: unbounded growth, indistinguishable
   from a memory leak. Same fix backend/rateLimit.js's createBoundedMap
   applies to the POS server's own login lockout; duplicated here in full
   (not imported) because this is a separate deployable with its own
   package.json and dependency budget (CLAUDE.md §0) — importing across that
   boundary would pull backend/db.js's whole module graph in for 25 lines. */
function createBoundedMap({ maxEntries = 20000, ttlMs }) {
    const entries = new Map();
    let nextSweepAt = 0;
    function sweep(now) {
        for (const [key, value] of entries) {
            if (value.expiresAt <= now) entries.delete(key);
        }
        if (entries.size > maxEntries) {
            const excess = entries.size - maxEntries;
            let dropped = 0;
            for (const key of entries.keys()) {
                entries.delete(key);
                if (++dropped >= excess) break;
            }
        }
        nextSweepAt = now + ttlMs;
    }
    return {
        get(key) {
            const entry = entries.get(key);
            if (!entry) return undefined;
            if (entry.expiresAt <= Date.now()) { entries.delete(key); return undefined; }
            return entry;
        },
        set(key, entry, now = Date.now()) {
            entry.expiresAt = now + ttlMs;
            entries.set(key, entry);
            if (now >= nextSweepAt || entries.size > maxEntries) sweep(now);
            return entry;
        },
        delete(key) { return entries.delete(key); }
    };
}

const failedAdminAttempts = createBoundedMap({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 10000 }); // ip -> { count, lockedUntil }

/**
 * Append-only audit trail for admin actions (security audit C2): who
 * published what, when, from where. There was none before — a leaked or
 * brute-forced ADMIN_SECRET could publish a fleet-wide release with no
 * record of it happening. Plain newline-delimited JSON, matching the
 * lightweight-on-purpose posture of the rest of this file (no DB here).
 */
const adminAuditLogFile = path.join(DATA_DIR, 'admin_audit.log');
function auditAdminAction(req, action, detail) {
    const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        ip: req.ip || 'unknown',
        action,
        detail
    });
    try {
        fs.appendFileSync(adminAuditLogFile, line + '\n');
    } catch (err) {
        console.error('[Licensing Server] Failed to write admin audit log entry:', err.message);
    }
}

function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    // Buffers must be equal length for timingSafeEqual — pad the shorter
    // one so length itself isn't a distinguishing timing signal, then
    // still require the real lengths to match.
    const maxLen = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(maxLen); bufA.copy(paddedA);
    const paddedB = Buffer.alloc(maxLen); bufB.copy(paddedB);
    return bufA.length === bufB.length && crypto.timingSafeEqual(paddedA, paddedB);
}

// Simple Admin Authenticator Middleware
const authenticateAdmin = (req, res, next) => {
    const key = req.ip || 'unknown';
    const entry = failedAdminAttempts.get(key);
    if (entry && entry.lockedUntil && Date.now() < entry.lockedUntil) {
        const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
        return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS', message: `Too many failed admin attempts. Try again in ${remaining}s.` });
    }

    const authHeader = req.headers.authorization || '';
    const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!providedToken || !timingSafeStringEqual(providedToken, ADMIN_SECRET)) {
        const e = entry || { count: 0, lockedUntil: 0 };
        e.count += 1;
        if (e.count >= MAX_FAILED_ADMIN_ATTEMPTS) {
            const extra = e.count - MAX_FAILED_ADMIN_ATTEMPTS;
            e.lockedUntil = Date.now() + Math.min(BASE_ADMIN_LOCKOUT_MS * Math.pow(2, extra), MAX_ADMIN_LOCKOUT_MS);
        }
        failedAdminAttempts.set(key, e);
        return res.status(401).json({ error: 'Unauthorized administrative token' });
    }

    failedAdminAttempts.delete(key);
    next();
};

/**
 * GET /api/admin/keys
 * Lists all registered licenses.
 */
app.get('/api/admin/keys', authenticateAdmin, async (req, res) => {
    const licenses = await DatabaseAdapter.getLicenses();
    res.json(licenses);
});

/**
 * POST /api/admin/keys
 * Upserts a license key configuration.
 */
app.post('/api/admin/keys', authenticateAdmin, async (req, res) => {
    try {
        const { licenseKey, customerName, expiryDate, status, billingCycle, amount, nextDueDate } = req.body;
        if (!licenseKey || !customerName || !expiryDate) {
            return res.status(400).json({ error: 'Missing mandatory license registration parameters' });
        }

        const licenses = await DatabaseAdapter.getLicenses();
        const existingIdx = licenses.findIndex(l => l.licenseKey === licenseKey);

        const record = {
            licenseKey,
            customerName,
            expiryDate,
            status: status || 'active',
            billingCycle: billingCycle || 'monthly',
            amount: parseFloat(amount) || 0,
            nextDueDate: nextDueDate || expiryDate
        };

        if (existingIdx >= 0) {
            licenses[existingIdx] = record;
        } else {
            licenses.push(record);
        }

        await DatabaseAdapter.saveLicenses(licenses);
        res.json({ success: true, record });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write license update' });
    }
});

/**
 * POST /api/admin/releases
 * Publishes a new release into the registry: builds the manifest, signs it
 * with the dedicated release-signing key, and appends it. Also advances the
 * legacy `latestVersion` flag if this is the newest version seen (that flag
 * is now derived, not directly editable — see history: the old
 * POST /api/admin/version endpoint overwrote the whole config file
 * including this releases array, which would have silently wiped the
 * registry the moment anyone called it after this feature shipped).
 */
app.post('/api/admin/releases', authenticateAdmin, (req, res) => {
    try {
        const { version, channel, changelog, downloadUrl, sha256, rolloutPercent } = req.body;
        if (!version || !channel || !downloadUrl || !sha256) {
            return res.status(400).json({ error: 'version, channel, downloadUrl, and sha256 are all required' });
        }
        if (!VALID_CHANNELS.includes(channel)) {
            return res.status(400).json({ error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` });
        }
        if (!/^\d+\.\d+\.\d+$/.test(version)) {
            return res.status(400).json({ error: 'version must be a semver string like 1.2.3' });
        }
        if (!/^https?:\/\//.test(downloadUrl) || downloadUrl.length > 2000) {
            return res.status(400).json({ error: 'downloadUrl must be a valid http(s) URL' });
        }
        if (!/^[a-f0-9]{64}$/i.test(sha256)) {
            return res.status(400).json({ error: 'sha256 must be a 64-character hex string' });
        }
        if (changelog && String(changelog).length > 5000) {
            return res.status(400).json({ error: 'changelog is too long (max 5000 characters)' });
        }
        // Canary/pilot rollout — only meaningful on the security channel,
        // since it's the only one a POS client ever auto-applies (see
        // backend/updateEngine.js#checkForUpdates). Defaults to 100 (full
        // rollout) so publishing without the field behaves exactly as before
        // this existed. To widen an in-progress rollout, republish the SAME
        // version/channel/downloadUrl/sha256 with a higher percentage — the
        // picking logic above takes the most recently published entry on a
        // version tie, so the wider figure takes effect without needing a
        // second signed payload for a "different" release.
        const rolloutPct = rolloutPercent === undefined ? 100 : Number(rolloutPercent);
        if (!Number.isInteger(rolloutPct) || rolloutPct < 1 || rolloutPct > 100) {
            return res.status(400).json({ error: 'rolloutPercent must be an integer from 1 to 100' });
        }

        const manifest = {
            version,
            channel,
            changelog: changelog || '',
            downloadUrl,
            sha256,
            rolloutPercent: rolloutPct,
            publishedAt: Date.now()
        };
        const payloadStr = JSON.stringify(manifest);

        const signer = crypto.createSign('sha256');
        signer.update(payloadStr);
        const signature = signer.sign(releasePrivateKey, 'base64');

        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (!Array.isArray(config.releases)) config.releases = [];
        config.releases.push({ payload: payloadStr, signature, ...manifest });
        if (isNewerVersion(version, config.latestVersion || '0.0.0')) {
            config.latestVersion = version;
        }
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

        auditAdminAction(req, 'PUBLISH_RELEASE', { version, channel, downloadUrl, rolloutPercent: rolloutPct });
        res.json({ success: true, release: manifest });
    } catch (err) {
        console.error('Publish release error:', err);
        res.status(500).json({ error: 'Failed to publish release' });
    }
});

/**
 * GET /api/releases
 * Admin-only — lists every published release (newest first) for the
 * dashboard.
 */
app.get('/api/releases', authenticateAdmin, (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const releases = Array.isArray(config.releases) ? config.releases : [];
        res.json([...releases].sort((a, b) => b.publishedAt - a.publishedAt));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read release registry' });
    }
});

/**
 * DELETE /api/admin/keys/:key
 * Revokes a license key configuration.
 */
app.delete('/api/admin/keys/:key', authenticateAdmin, async (req, res) => {
    try {
        const key = req.params.key;
        let licenses = await DatabaseAdapter.getLicenses();
        licenses = licenses.filter(l => l.licenseKey !== key);
        await DatabaseAdapter.saveLicenses(licenses);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete license' });
    }
});

/**
 * GET /
 * Administrative Web Control Dashboard (PDF style, print-ledger look)
 */
app.get('/', (req, res) => {
    // Return HTML dashboard page
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SaaS License Center</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
                background-color: #f8fafc;
                margin: 0;
                padding: 40px 20px;
                color: #0f172a;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: white;
                border: 1px solid #e2e8f0;
                padding: 30px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            h1 {
                font-size: 22px;
                letter-spacing: -0.02em;
                margin-top: 0;
                border-bottom: 2px solid #0f172a;
                padding-bottom: 10px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
                font-size: 13px;
            }
            th, td {
                padding: 10px;
                text-align: left;
                border-bottom: 1px solid #e2e8f0;
            }
            th {
                background-color: #f1f5f9;
                font-weight: 600;
            }
            .badge {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 500;
            }
            .badge-active { background: #dcfce7; color: #166534; }
            .badge-suspended { background: #fee2e2; color: #991b1b; }
            .form-grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 10px;
                margin-top: 25px;
                border-top: 1px dashed #cbd5e1;
                padding-top: 20px;
            }
            input, select, button {
                padding: 8px 12px;
                font-size: 13px;
                border: 1px solid #cbd5e1;
                border-radius: 4px;
            }
            button {
                background-color: #0f172a;
                color: white;
                cursor: pointer;
                border: none;
            }
            button:hover { background-color: #1e293b; }
            .password-prompt {
                text-align: center;
                margin-top: 100px;
            }
        </style>
    </head>
    <body>
        <div class="container" id="admin-panel" style="display:none;">
            <h1>SaaS LICENSE CONTROL PANEL</h1>

            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <strong style="font-size:13px;">Latest Published Version:</strong>
                <input type="text" id="latest-version-input" placeholder="1.0.0" style="width:100px;" readonly>
                <span style="font-size:12px; color:#64748b;">(derived from the newest published release below)</span>
            </div>

            <div style="border-top:1px dashed #cbd5e1; margin-top:15px; padding-top:15px;">
                <h2 style="font-size:15px; margin-bottom:10px;">Publish Release</h2>
                <div class="form-grid" style="grid-template-columns: repeat(3,1fr) 2fr 1fr 1.5fr; align-items:start;">
                    <input type="text" id="rel-version" placeholder="Version (1.1.0)">
                    <select id="rel-channel">
                        <option value="security">security (auto-applies)</option>
                        <option value="feature">feature (manual)</option>
                        <option value="patch">patch (manual)</option>
                    </select>
                    <input type="text" id="rel-sha256" placeholder="SHA-256 of release zip">
                    <input type="text" id="rel-url" placeholder="Download URL (https://...)">
                    <input type="number" id="rel-rollout" placeholder="Rollout %" min="1" max="100" value="100" title="Percent of the security channel's tenants that auto-apply this build. Republish the same version/sha256 with a higher number to widen it later. Only meaningful for the security channel.">
                    <button onclick="publishRelease()">PUBLISH</button>
                </div>
                <textarea id="rel-changelog" placeholder="Changelog for this release..." style="width:100%; box-sizing:border-box; margin-top:10px; padding:8px; font-family:inherit; font-size:13px;" rows="2"></textarea>
                <span id="release-status" style="font-size:12px; color:#64748b;"></span>

                <table style="margin-top:15px;">
                    <thead><tr><th>Version</th><th>Channel</th><th>Published</th><th>Changelog</th></tr></thead>
                    <tbody id="releases-tbody"></tbody>
                </table>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>License Key</th>
                        <th>Client / Name</th>
                        <th>Expiry Date</th>
                        <th>Status</th>
                        <th>Billing</th>
                        <th>Amount</th>
                        <th>Next Due</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="keys-tbody"></tbody>
            </table>

            <div class="form-grid" style="grid-template-columns: repeat(4, 1fr);">
                <input type="text" id="new-key" placeholder="License Key">
                <input type="text" id="new-name" placeholder="Client Name">
                <input type="date" id="new-expiry">
                <select id="new-status">
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                </select>
                <select id="new-billing-cycle">
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                </select>
                <input type="number" id="new-amount" placeholder="Amount" min="0" step="1">
                <input type="date" id="new-due-date" placeholder="Next Due Date">
                <button onclick="upsertKey()">SAVE / UPDATE LICENSE</button>
            </div>
        </div>

        <div class="password-prompt" id="auth-panel">
            <h2>Enter Administrative Secret</h2>
            <input type="password" id="admin-pass" placeholder="Enter Token">
            <button onclick="login()">Enter Dashboard</button>
        </div>

        <script>
            let adminToken = '';

            // Every field below can contain admin-submitted free text
            // (license customerName, a release's version/channel/changelog)
            // — escape before ever going into innerHTML. Never build
            // onclick="...('${value}')" attribute strings from this data
            // either (that's a second, attribute/JS-context injection point
            // distinct from HTML-context) — use data-* attributes and a
            // real event listener instead, as done below for Revoke.
            function escapeHtml(value) {
                return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[ch]));
            }

            function login() {
                const pass = document.getElementById('admin-pass').value;
                adminToken = pass;
                loadKeys();
            }

            async function loadKeys() {
                const res = await fetch('/api/admin/keys', {
                    headers: { 'Authorization': 'Bearer ' + adminToken }
                });
                if (res.ok) {
                    document.getElementById('auth-panel').style.display = 'none';
                    document.getElementById('admin-panel').style.display = 'block';
                    const data = await res.json();
                    const tbody = document.getElementById('keys-tbody');
                    tbody.innerHTML = '';
                    data.forEach(k => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = \`
                            <td><strong>\${escapeHtml(k.licenseKey)}</strong></td>
                            <td>\${escapeHtml(k.customerName)}</td>
                            <td>\${escapeHtml(k.expiryDate)}</td>
                            <td><span class="badge badge-\${escapeHtml(k.status)}">\${escapeHtml((k.status || '').toUpperCase())}</span></td>
                            <td>\${escapeHtml(k.billingCycle || '—')}</td>
                            <td>\${k.amount ? escapeHtml(k.amount.toLocaleString()) : '—'}</td>
                            <td>\${escapeHtml(k.nextDueDate || '—')}</td>
                            <td>
                                <button class="revoke-btn" data-key="\${escapeHtml(k.licenseKey)}" style="background:#ef4444; padding: 4px 8px; font-size:11px;">Revoke</button>
                            </td>
                        \`;
                        tbody.appendChild(tr);
                    });
                    tbody.querySelectorAll('.revoke-btn').forEach(btn => {
                        btn.addEventListener('click', () => deleteKey(btn.getAttribute('data-key')));
                    });
                } else {
                    alert('Invalid admin credentials.');
                }

                try {
                    const verRes = await fetch('/api/version');
                    if (verRes.ok) {
                        const verData = await verRes.json();
                        document.getElementById('latest-version-input').value = verData.latestVersion;
                    }
                } catch (e) { /* non-fatal */ }

                loadReleases();
            }

            async function loadReleases() {
                const res = await fetch('/api/releases', { headers: { 'Authorization': 'Bearer ' + adminToken } });
                if (!res.ok) return;
                const releases = await res.json();
                const tbody = document.getElementById('releases-tbody');
                tbody.innerHTML = releases.map(r => \`
                    <tr>
                        <td><strong>\${escapeHtml(r.version)}</strong></td>
                        <td>\${escapeHtml(r.channel)}\${(r.rolloutPercent || 100) < 100 ? \` <span style="color:#b45309;">(\${r.rolloutPercent}% rollout)</span>\` : ''}</td>
                        <td>\${new Date(r.publishedAt).toLocaleString()}</td>
                        <td>\${escapeHtml(r.changelog || '')}</td>
                    </tr>
                \`).join('') || '<tr><td colspan="4" style="color:#94a3b8;">No releases published yet.</td></tr>';
            }

            async function publishRelease() {
                const version = document.getElementById('rel-version').value.trim();
                const channel = document.getElementById('rel-channel').value;
                const sha256 = document.getElementById('rel-sha256').value.trim();
                const downloadUrl = document.getElementById('rel-url').value.trim();
                const changelog = document.getElementById('rel-changelog').value.trim();
                const rolloutPercent = parseInt(document.getElementById('rel-rollout').value, 10) || 100;
                const statusEl = document.getElementById('release-status');

                if (!version || !sha256 || !downloadUrl) {
                    statusEl.textContent = 'Version, SHA-256, and download URL are required.';
                    return;
                }
                if (channel === 'security') {
                    const rolloutNote = rolloutPercent < 100
                        ? \`only the \${rolloutPercent}% of tenants in this build's rollout cohort will\`
                        : 'every tenant will';
                    const confirmed = confirm(\`This release is on the SECURITY channel — \${rolloutNote} auto-apply it (after backup + signature verification) on their next daily check, with no manual approval step. Continue?\`);
                    if (!confirmed) return;
                }

                const res = await fetch('/api/admin/releases', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
                    body: JSON.stringify({ version, channel, changelog, downloadUrl, sha256, rolloutPercent })
                });

                if (res.ok) {
                    statusEl.textContent = 'Published.';
                    document.getElementById('rel-version').value = '';
                    document.getElementById('rel-sha256').value = '';
                    document.getElementById('rel-url').value = '';
                    document.getElementById('rel-changelog').value = '';
                    document.getElementById('rel-rollout').value = '100';
                    loadKeys();
                } else {
                    const data = await res.json().catch(() => ({}));
                    statusEl.textContent = 'Failed: ' + (data.error || res.status);
                }
            }

            async function upsertKey() {
                const licenseKey = document.getElementById('new-key').value;
                const customerName = document.getElementById('new-name').value;
                const expiryDate = document.getElementById('new-expiry').value;
                const status = document.getElementById('new-status').value;
                const billingCycle = document.getElementById('new-billing-cycle').value;
                const amount = document.getElementById('new-amount').value;
                const nextDueDate = document.getElementById('new-due-date').value;

                if(!licenseKey || !customerName || !expiryDate) {
                    alert('Please fill out all fields.');
                    return;
                }

                const res = await fetch('/api/admin/keys', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + adminToken
                    },
                    body: JSON.stringify({ licenseKey, customerName, expiryDate, status, billingCycle, amount, nextDueDate })
                });

                if (res.ok) {
                    document.getElementById('new-key').value = '';
                    document.getElementById('new-name').value = '';
                    document.getElementById('new-expiry').value = '';
                    document.getElementById('new-amount').value = '';
                    document.getElementById('new-due-date').value = '';
                    loadKeys();
                } else {
                    alert('Failed to update key.');
                }
            }


            async function deleteKey(key) {
                if(!confirm('Are you sure you want to revoke this license?')) return;
                const res = await fetch('/api/admin/keys/' + key, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + adminToken }
                });
                if(res.ok) {
                    loadKeys();
                } else {
                    alert('Delete failed.');
                }
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Licensing Server] Control panel running on http://localhost:${PORT}`);
    // Never the secret itself (it used to be printed here) — stdout ends up
    // in log files and terminal scrollback far more casually than
    // settings.json ever does, and this token can publish fleet-wide code.
    console.log(`[Licensing Server] Admin authentication is ${ADMIN_SECRET_IS_DEFAULT ? 'using the DEFAULT secret — set ADMIN_SECRET before deploying' : 'configured'}.`);
});
