import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
 * Initialize Database files with their templates if missing
 */
export function initDatabaseFiles() {
    const defaultSettings = {
        companyName: "Universal Gold POS Ltd",
        address: "100 Gold Plaza, Retail District",
        phone: "9999999999",
        gstNumber: "29AABCDE1234F1Z",
        goldTaxSlab: 3.0,
        invoicePrefix: "GOLD",
        invoiceSeqStart: 1,
        reportEmail: "reports@goldpos.com",
        // Report emails (backupEngine's daily/monthly summaries) are skipped
        // gracefully whenever host/user/pass are blank — see emailReporter.js.
        smtp: {
            host: "",
            port: 587,
            secure: false,
            user: "",
            pass: "",
            fromName: ""
        },
        goldApiProvider: "public",
        goldApiKey: "",
        // Demo/mock placeholders. Mock checkout only activates on this EXACT pair
        // (see /api/payment/order and /api/payment/verify in server.js) — any other
        // non-empty value (including a tenant's real Razorpay test/sandbox key) is
        // sent to the real Razorpay API instead of being intercepted.
        razorpayKeyId: "rzp_test_xxxxxx",
        razorpayKeySecret: "rzp_test_xxxxxx_secret",
        upiId: "",
        adminPin: "1234",
        overrideGoldPrice: {
            active: false,
            price24K: 0.0,
            price22K: 0.0,
            price18K: 0.0
        },
        currency: "INR"
    };

    const defaultLicense = {
        licenseKey: "DEMO-KEY-12345",
        activated: false,
        status: "inactive",
        expiryDate: null,
        lastHandshakeTime: 0
    };

    readJSON(path.join(DATA_DIR, 'settings.json'), defaultSettings);
    readJSON(path.join(DATA_DIR, 'license.json'), defaultLicense);
    readJSON(path.join(DATA_DIR, 'advances.json'), []);
}

// Auto run initialization on import
initDatabaseFiles();
