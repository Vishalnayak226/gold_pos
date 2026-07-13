import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_KEY_FILE = path.join(__dirname, 'blackbox_private.pem');

/**
 * Decrypts a black-box export envelope (GET /api/diagnostics/blackbox-export)
 * using the offline black-box private key, then aggregates the JSONL event
 * stream into an error-frequency / slow-endpoint / memory-trend report.
 *
 * This script — and blackbox_private.pem — never ship to tenants. It runs
 * entirely offline (pass it the exported envelope file by hand).
 *
 * Usage: node analyze_blackbox.js <path_to_envelope_json>
 */
function decryptEnvelope(envelopePath) {
    if (!fs.existsSync(envelopePath)) {
        console.error(`Error: Envelope file not found at ${envelopePath}`);
        process.exit(1);
    }
    if (!fs.existsSync(PRIVATE_KEY_FILE)) {
        console.error(`Error: Black-box private key not found at ${PRIVATE_KEY_FILE}`);
        process.exit(1);
    }

    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    const privateKeyPem = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
    const { encryptedAesKey, iv, authTag, ciphertext } = envelope.envelope || envelope;

    const aesKey = crypto.privateDecrypt({
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, Buffer.from(encryptedAesKey, 'base64'));

    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function parseEvents(rawLog) {
    return rawLog
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);
}

function buildReport(events) {
    const httpEvents = events.filter(e => e.eventType === 'HTTP_REQUEST');

    // Error frequency by path (status >= 400)
    const errorsByPath = new Map();
    httpEvents.filter(e => e.statusCode >= 400).forEach(e => {
        const key = `${e.method} ${e.path}`;
        errorsByPath.set(key, (errorsByPath.get(key) || 0) + 1);
    });

    // Slow endpoints: avg + max duration per path
    const durationsByPath = new Map();
    httpEvents.forEach(e => {
        const key = `${e.method} ${e.path}`;
        if (!durationsByPath.has(key)) durationsByPath.set(key, []);
        durationsByPath.get(key).push(e.durationMs || 0);
    });
    const slowEndpoints = Array.from(durationsByPath.entries()).map(([key, durations]) => ({
        endpoint: key,
        count: durations.length,
        avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
        maxMs: Math.max(...durations)
    })).sort((a, b) => b.avgMs - a.avgMs);

    // Memory trend
    const memSamples = httpEvents.map(e => e.heapUsedMB).filter(m => typeof m === 'number');
    const memTrend = memSamples.length > 0 ? {
        minMB: Math.min(...memSamples),
        maxMB: Math.max(...memSamples),
        avgMB: Math.round((memSamples.reduce((a, b) => a + b, 0) / memSamples.length) * 100) / 100,
        firstMB: memSamples[0],
        lastMB: memSamples[memSamples.length - 1]
    } : null;

    return {
        totalEvents: events.length,
        totalRequests: httpEvents.length,
        totalErrors: Array.from(errorsByPath.values()).reduce((a, b) => a + b, 0),
        errorsByPath: Object.fromEntries(Array.from(errorsByPath.entries()).sort((a, b) => b[1] - a[1])),
        slowestEndpoints: slowEndpoints.slice(0, 10),
        memoryTrend: memTrend
    };
}

function main() {
    const envelopePath = process.argv[2];
    if (!envelopePath) {
        console.log('Usage: node analyze_blackbox.js <path_to_envelope_json>');
        process.exit(1);
    }

    console.log('[Analyzer] Decrypting black-box envelope...');
    const rawLog = decryptEnvelope(path.resolve(envelopePath));
    const events = parseEvents(rawLog);
    console.log(`[Analyzer] Decrypted ${events.length} events. Building report...\n`);

    const report = buildReport(events);
    console.log('='.repeat(70));
    console.log('BLACK-BOX ANALYSIS REPORT');
    console.log('='.repeat(70));
    console.log(`Total events: ${report.totalEvents}  |  HTTP requests: ${report.totalRequests}  |  Errors (4xx/5xx): ${report.totalErrors}`);

    console.log('\n-- Error frequency by endpoint --');
    if (Object.keys(report.errorsByPath).length === 0) {
        console.log('  (none)');
    } else {
        Object.entries(report.errorsByPath).forEach(([k, v]) => console.log(`  ${v.toString().padStart(4)}  ${k}`));
    }

    console.log('\n-- Slowest endpoints (by avg duration) --');
    report.slowestEndpoints.forEach(e => {
        console.log(`  avg ${e.avgMs.toString().padStart(5)}ms  max ${e.maxMs.toString().padStart(5)}ms  (${e.count} calls)  ${e.endpoint}`);
    });

    console.log('\n-- Memory trend (heap used, MB) --');
    if (report.memoryTrend) {
        console.log(`  min ${report.memoryTrend.minMB}MB  max ${report.memoryTrend.maxMB}MB  avg ${report.memoryTrend.avgMB}MB  (first ${report.memoryTrend.firstMB}MB -> last ${report.memoryTrend.lastMB}MB)`);
    } else {
        console.log('  (no samples)');
    }
    console.log('='.repeat(70));
}

main();
