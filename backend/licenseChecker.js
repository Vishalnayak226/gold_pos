/**
 * ==========================================================================
 * POS Client License Verification Module
 * Manages activation state, RSA token verification, and offline grace periods.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { readJSON, writeJSON, logError, logTelemetry, DATA_DIR } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');
const PUBLIC_KEY_FILE = path.join(process.cwd(), 'keys', 'license_public.pem');

// central licensing server URL (configured locally or via env). Port 6000 is
// deliberately avoided as the default — it's on the WHATWG Fetch spec's
// forbidden-port list, so Node's fetch() rejects it outright ("bad port").
const LICENSING_SERVER_URL = process.env.LICENSING_SERVER_URL || 'http://127.0.0.1:6060';

const LOCAL_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

/**
 * Compares two "x.y.z" version strings. Returns true if `remote` is newer
 * than `local`. Deliberately simple (no pre-release/build metadata) — this
 * project's release model is manual, version-flagged bumps, not semver ranges.
 */
function isNewerVersion(remote, local) {
    const r = String(remote).split('.').map(n => parseInt(n) || 0);
    const l = String(local).split('.').map(n => parseInt(n) || 0);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
        const rv = r[i] || 0, lv = l[i] || 0;
        if (rv > lv) return true;
        if (rv < lv) return false;
    }
    return false;
}

/**
 * Best-effort check against the central server's published "latest version"
 * flag. Never throws — an update banner is a courtesy, not a gate, and this
 * project's release model is manual (see docs/PROJECT_PLAN.md §5.1): this
 * only surfaces information, it never pushes or installs anything.
 */
async function checkForUpdate() {
    try {
        const res = await fetch(`${LICENSING_SERVER_URL}/api/version`);
        if (!res.ok) return;
        const data = await res.json();
        const license = readJSON(LICENSE_FILE, {});
        license.currentVersion = LOCAL_VERSION;
        license.latestVersion = data.latestVersion;
        license.updateAvailable = isNewerVersion(data.latestVersion, LOCAL_VERSION);
        writeJSON(LICENSE_FILE, license);
    } catch (err) {
        // Silent — this is a courtesy check, not part of the license gate.
    }
}

/**
 * Checks if the current local license state is valid.
 * Allows a 7-day grace period since the last successful handshake to handle internet outages.
 */
export function isLicenseValid() {
    try {
        const license = readJSON(LICENSE_FILE, { activated: false, status: 'inactive', expiryDate: null, lastHandshakeTime: 0 });
        
        // If explicitly active and recently verified
        if (license.activated && license.status === 'active') {
            const expiry = license.expiryDate ? new Date(license.expiryDate) : null;
            if (expiry && expiry < new Date()) {
                // Expired locally
                license.activated = false;
                license.status = 'expired';
                writeJSON(LICENSE_FILE, license);
                return false;
            }
            return true;
        }

        // If server is offline, allow a 7-day grace period from the last successful handshake
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const timeSinceHandshake = Date.now() - (license.lastHandshakeTime || 0);

        if (license.status === 'active' && timeSinceHandshake < sevenDaysMs) {
            logTelemetry('LICENSE_OFFLINE_GRACE', 0, `Operating under grace period. Time remaining: ${Math.round((sevenDaysMs - timeSinceHandshake) / 3600000)} hours`);
            return true;
        }

        return false;
    } catch (err) {
        logError('Error checking license validity: ' + err.message, err.stack);
        return false;
    }
}

/**
 * Contacts the central licensing server, fetches verification token, and validates the RSA signature.
 */
export async function syncLicenseStatus(forceKey = null) {
    try {
        const license = readJSON(LICENSE_FILE, { licenseKey: "DEMO-KEY-12345", activated: false, status: 'inactive', expiryDate: null, lastHandshakeTime: 0 });
        const keyToCheck = forceKey || license.licenseKey;

        if (!keyToCheck) {
            return { success: false, error: 'No license key configured.' };
        }

        // 1. Fetch from licensing server
        const res = await fetch(`${LICENSING_SERVER_URL}/api/license/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                licenseKey: keyToCheck,
                systemFingerprint: 'POS-NODE-LOCAL-001'
            })
        });

        if (!res.ok) {
            throw new Error(`Licensing server returned status: ${res.status}`);
        }

        const data = await res.json();

        // 2. If server reports key doesn't exist/suspended
        if (!data.payload || !data.signature) {
            license.activated = false;
            license.status = data.status || 'invalid';
            writeJSON(LICENSE_FILE, license);
            return { success: false, error: data.message || 'Verification rejected by server.' };
        }

        // 3. Cryptographically Verify Signature using central public key
        if (!fs.existsSync(PUBLIC_KEY_FILE)) {
            throw new Error('Licensing Public Key file (license_public.pem) is missing. Cannot verify handshake.');
        }

        const publicKey = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
        const verifier = crypto.createVerify('sha256');
        verifier.update(data.payload);
        const isValidSignature = verifier.verify(publicKey, data.signature, 'base64');

        if (!isValidSignature) {
            logTelemetry('LICENSE_SIGNATURE_INVALID', 0, 'Handshake signature verification failed.');
            return { success: false, error: 'Cryptographic signature mismatch on licensing handshake token.' };
        }

        // 4. Parse verified payload and update state
        const payload = JSON.parse(data.payload);
        
        license.licenseKey = keyToCheck;
        license.activated = payload.status === 'active';
        license.status = payload.status;
        license.expiryDate = payload.expiryDate;
        license.billingCycle = payload.billingCycle || null;
        license.amount = payload.amount || 0;
        license.nextDueDate = payload.nextDueDate || null;
        license.lastHandshakeTime = Date.now();

        writeJSON(LICENSE_FILE, license);
        logTelemetry('LICENSE_SYNC_SUCCESS', 0, `Status: ${license.status}, Expiry: ${license.expiryDate}`);

        await checkForUpdate();

        return { success: license.activated, license: readJSON(LICENSE_FILE, license) };
    } catch (err) {
        logError('Licensing sync connection failed: ' + err.message, err.stack);
        return { success: false, error: 'Could not contact licensing server. Operational state defaults to local grace checks.' };
    }
}

/**
 * Express middleware to restrict operations if license gate is closed.
 */
export function checkLicenseGate(req, res, next) {
    // Exempt licensing/admin-login endpoints themselves so users can still
    // authenticate and activate a new key while the gate is closed
    if (req.path.startsWith('/api/license') || req.path === '/api/settings' || req.path.startsWith('/api/admin')) {
        return next();
    }

    if (!isLicenseValid()) {
        logTelemetry('LICENSE_GATE_BLOCKED', 0, `Blocked API request to: ${req.path}`);
        return res.status(402).json({
            error: 'LICENSE_INACTIVE',
            message: 'Your system license has expired, been suspended, or requires internet activation. Please contact support.'
        });
    }

    next();
}
