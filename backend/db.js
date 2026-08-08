import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    getDefaultSettings,
    RETIRED_SETTINGS_KEYS,
    NESTED_SETTINGS_KEYS,
    SUPPORTED_GOLD_PROVIDERS
} from './defaultSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, 'data');
export const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure database and logs directories exist on import
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

/**
 * Standardized Error Logging Engine
 * Writes exceptions, stack traces, and warnings to flat log files.
 * @param {string} message 
 * @param {string} [stack] 
 */
export function logError(message, stack = '') {
    try {
        const logFile = path.join(LOGS_DIR, 'error.log');
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ERROR: ${message}\n${stack ? stack + '\n' : ''}----------------------------------------\n`;
        fs.appendFileSync(logFile, logEntry, 'utf8');
        console.error(`[System Error] ${message}`);
    } catch (err) {
        console.error('CRITICAL: Failed to write to error log file:', err);
    }
}

/**
 * Technical Level-1 Telemetry Logger
 * Logs system performance profile details without customer data.
 * @param {string} action - e.g., "GET_GOLD_PRICE", "SAVE_BILL"
 * @param {number} durationMs - execution latency
 * @param {string} [details] - CPU, memory, database query, or server logs
 */
export function logTelemetry(action, durationMs, details = '') {
    try {
        const telemetryFile = path.join(LOGS_DIR, 'telemetry.log');
        const timestamp = new Date().toISOString();
        const mem = process.memoryUsage();
        const heapUsedMB = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;
        
        const logEntry = JSON.stringify({
            timestamp,
            action,
            durationMs,
            heapUsedMB,
            details: details || undefined
        }) + '\n';
        
        fs.appendFileSync(telemetryFile, logEntry, 'utf8');
    } catch (err) {
        logError('Failed to write telemetry log', err.stack);
    }
}

/**
 * Reads a JSON file safely, returning default data if missing or corrupted.
 * @param {string} filepath 
 * @param {*} defaultData 
 * @returns {*}
 */
export function readJSON(filepath, defaultData = []) {
    try {
        if (!fs.existsSync(filepath)) {
            writeJSON(filepath, defaultData);
            return defaultData;
        }
        const content = fs.readFileSync(filepath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        logError(`Error reading JSON database file at ${filepath}: ${err.message}`, err.stack);
        return defaultData;
    }
}

/**
 * Blocking synchronous sleep (no async/await). Kept synchronous deliberately:
 * every route handler in server.js does its read-modify-write JSON cycle
 * without ever yielding to the event loop, which is what makes concurrent
 * HTTP requests safe from interleaved lost updates (Node's run-to-completion
 * semantics serialize them). An async retry here would reintroduce exactly
 * that race.
 */
function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (_) {
        // Extremely defensive fallback; Atomics.wait is available in every
        // Node >=18 target this project supports.
    }
}

/**
 * Writes data atomicly to JSON file.
 * Prevents file corruption by writing to a temporary file first, then renaming.
 * Retries the rename a few times on transient Windows file-lock contention
 * (EPERM/EBUSY/EACCES) — observed under concurrent load when another handle
 * (a concurrent backup copy, antivirus, search indexer) is briefly open on
 * the destination file. Without this, a transient failure here was silently
 * swallowed by every call site (none check the return value), which under
 * real load produced a duplicate invoice number when a settings.json write
 * silently failed to persist the incremented invoice sequence.
 * @param {string} filepath
 * @param {*} data
 * @returns {boolean}
 */
export function writeJSON(filepath, data) {
    const tempFile = filepath + '.tmp';
    const MAX_ATTEMPTS = 5;
    const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
    let lastErr;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tempFile, filepath);
            return true;
        } catch (err) {
            lastErr = err;
            if (attempt < MAX_ATTEMPTS && RETRYABLE_CODES.has(err.code)) {
                sleepSync(15 * attempt);
                continue;
            }
            break;
        }
    }

    logError(`Error writing JSON database atomic chunk at ${filepath}: ${lastErr.message}`, lastErr.stack);
    try {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    } catch (_) {}
    return false;
}

/**
 * Brings an existing tenant's settings.json up to the current template.
 *
 * Without this, a key added to the template only ever reaches installs whose
 * settings.json did not exist yet — every already-running tenant would keep
 * reading `undefined` until someone happened to open Settings and press Save.
 *
 * Existing values always win; this only fills gaps, drops retired keys, and
 * normalizes enums whose accepted values have narrowed.
 * @returns {object} the current (possibly migrated) settings
 */
export function migrateSettings() {
    const settingsFile = path.join(DATA_DIR, 'settings.json');
    const defaults = getDefaultSettings();

    // Seeds the file with the full template when this is a fresh install.
    const existing = readJSON(settingsFile, defaults);
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        writeJSON(settingsFile, defaults);
        return defaults;
    }

    const merged = { ...defaults, ...existing };

    // Nested objects need the same treatment one level down, otherwise a
    // tenant's older `smtp` block would shadow any newly added sub-key.
    NESTED_SETTINGS_KEYS.forEach(key => {
        const existingBlock = existing[key];
        merged[key] = (existingBlock && typeof existingBlock === 'object' && !Array.isArray(existingBlock))
            ? { ...defaults[key], ...existingBlock }
            : { ...defaults[key] };
    });

    const removed = RETIRED_SETTINGS_KEYS.filter(key => key in merged);
    removed.forEach(key => { delete merged[key]; });

    // Legacy paid providers ('goldapi', 'metalsdev') no longer exist — fall
    // back to the keyless public source rather than to mocked prices.
    if (!SUPPORTED_GOLD_PROVIDERS.includes(merged.goldApiProvider)) {
        merged.goldApiProvider = defaults.goldApiProvider;
    }

    const added = Object.keys(merged).filter(key => !(key in existing));
    if (JSON.stringify(merged) === JSON.stringify(existing)) {
        return existing;
    }

    if (!writeJSON(settingsFile, merged)) {
        // Non-fatal: the server still boots and serves, it just reads the
        // in-memory merge this once and retries the write on next start.
        logError('Settings migration could not be persisted; continuing with in-memory defaults for this run.');
        return merged;
    }

    logTelemetry('SETTINGS_MIGRATED', 0, `added: [${added.join(', ')}], removed: [${removed.join(', ')}]`);
    return merged;
}

/**
 * Initialize Database files with their templates if missing
 */
export function initDatabaseFiles() {
    const defaultLicense = {
        licenseKey: "DEMO-KEY-12345",
        activated: false,
        status: "inactive",
        expiryDate: null,
        lastHandshakeTime: 0
    };

    migrateSettings();
    readJSON(path.join(DATA_DIR, 'license.json'), defaultLicense);
    readJSON(path.join(DATA_DIR, 'advances.json'), []);
    // Customer portal logins (scrypt hashes + hashed session/reset tokens —
    // never plaintext). Deliberately excluded from the Level-2 diagnostics
    // export bundle in server.js: a support export should never carry
    // credential material off the tenant's machine, even encrypted.
    readJSON(path.join(DATA_DIR, 'customer_auth.json'), []);
}

// Auto run initialization on import
initDatabaseFiles();
