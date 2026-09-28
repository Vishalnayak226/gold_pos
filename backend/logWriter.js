/**
 * Bounded operational-log writer.
 *
 * HTTP telemetry must never put a synchronous filesystem write on a cashier's
 * request path. Financial SQLite commits and immutable audit rows deliberately
 * remain synchronous/durable in their own layers; this module is only for
 * diagnostic event streams that can be buffered briefly.
 */

import fs from 'node:fs';

const MAX_QUEUE_ENTRIES = clampInteger(process.env.GOLD_POS_LOG_QUEUE_MAX, 2048, 64, 100000);
const FLUSH_DELAY_MS = clampInteger(process.env.GOLD_POS_LOG_FLUSH_MS, 50, 5, 5000);
const MAX_LOG_BYTES = clampInteger(process.env.GOLD_POS_LOG_MAX_BYTES, 10 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
const LOG_RETENTION_FILES = clampInteger(process.env.GOLD_POS_LOG_RETENTION, 7, 1, 30);

let queued = new Map();
let queuedEntries = 0;
let inFlightEntries = 0;
let flushTimer = null;
let flushing = null;
let droppedEntries = 0;
let writeFailures = 0;
let retryDelayMs = FLUSH_DELAY_MS;
let lastDropWarningAt = 0;
let rotationFailures = 0;

function clampInteger(value, fallback, min, max) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function scheduleFlush(delayMs = FLUSH_DELAY_MS) {
    if (flushTimer || flushing || queuedEntries === 0) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushQueuedLogs();
    }, delayMs);
    flushTimer.unref?.();
}

/** Queues one complete log line. Returns false when the bounded queue is full. */
export function enqueueLog(filepath, line) {
    if (!filepath || typeof line !== 'string') return false;
    if (queuedEntries + inFlightEntries >= MAX_QUEUE_ENTRIES) {
        droppedEntries += 1;
        const now = Date.now();
        if (now - lastDropWarningAt >= 60000) {
            lastDropWarningAt = now;
            // Bypass the queue once so overload is visible without turning a
            // degraded log volume into a per-request console storm.
            console.warn(`[LogWriter] Diagnostic queue full; dropped events: ${droppedEntries}`);
        }
        return false;
    }
    const lines = queued.get(filepath) || [];
    lines.push(line);
    queued.set(filepath, lines);
    queuedEntries += 1;
    scheduleFlush();
    return true;
}

async function appendBatch(batch) {
    const failed = new Map();
    for (const [filepath, lines] of batch) {
        try {
            await fs.promises.appendFile(filepath, lines.join(''), 'utf8');
            await rotateIfNeeded(filepath);
        } catch (err) {
            writeFailures += lines.length;
            failed.set(filepath, lines);
            // Do not call db.logError here: db queues through this module, so
            // that would recurse forever on an unwritable log volume.
            console.error(`[LogWriter] Could not append ${lines.length} diagnostic event(s) to ${filepath}: ${err.message}`);
        }
    }
    return failed;
}

/**
 * Retains a small bounded diagnostic history. It runs only inside the already
 * asynchronous flush, never during a sale request. A rotation failure leaves
 * the just-written active log intact and is observable through diagnostics.
 */
async function rotateIfNeeded(filepath) {
    try {
        const { size } = await fs.promises.stat(filepath);
        if (size < MAX_LOG_BYTES) return;

        for (let index = LOG_RETENTION_FILES - 1; index >= 1; index -= 1) {
            const source = `${filepath}.${index}`;
            const target = `${filepath}.${index + 1}`;
            try {
                await fs.promises.rm(target, { force: true });
                await fs.promises.rename(source, target);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        }
        await fs.promises.rm(`${filepath}.1`, { force: true });
        await fs.promises.rename(filepath, `${filepath}.1`);
    } catch (err) {
        rotationFailures += 1;
        console.error(`[LogWriter] Could not rotate ${filepath}: ${err.message}`);
    }
}

/** Starts one asynchronous flush. Safe to call repeatedly. */
export async function flushQueuedLogs() {
    if (flushing) return flushing;
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (queuedEntries === 0) return { ok: true, pending: 0 };

    const batch = queued;
    const batchEntries = queuedEntries;
    queued = new Map();
    queuedEntries = 0;
    inFlightEntries += batchEntries;

    flushing = appendBatch(batch)
        .then(failed => {
            let failedEntries = 0;
            for (const [filepath, lines] of failed) {
                const existing = queued.get(filepath) || [];
                queued.set(filepath, [...lines, ...existing]);
                failedEntries += lines.length;
            }
            queuedEntries += failedEntries;
            inFlightEntries -= batchEntries;
            retryDelayMs = failedEntries > 0
                ? Math.min(Math.max(retryDelayMs * 2, FLUSH_DELAY_MS), 30000)
                : FLUSH_DELAY_MS;
            return { ok: failedEntries === 0, pending: queuedEntries };
        })
        .finally(() => {
            flushing = null;
            // A full/read-only diagnostic volume must not create a busy retry
            // loop that steals CPU from active counters.
            scheduleFlush(retryDelayMs);
        });

    return flushing;
}

/** Drains queued diagnostics during graceful server shutdown. */
export async function drainLogWriter() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    let result = { ok: true, pending: queuedEntries };
    // A failed filesystem stays queued for a later retry; do not spin forever
    // during shutdown on a full or read-only volume.
    do {
        result = await flushQueuedLogs();
    } while (result.ok && queuedEntries > 0);
    return { ...getLogWriterStats(), ok: result.ok };
}

/** Observable from diagnostics/tests without exposing log contents. */
export function getLogWriterStats() {
    return {
        queuedEntries,
        inFlightEntries,
        droppedEntries,
        writeFailures,
        rotationFailures,
        maxQueueEntries: MAX_QUEUE_ENTRIES,
        flushDelayMs: FLUSH_DELAY_MS,
        retryDelayMs,
        maxLogBytes: MAX_LOG_BYTES,
        logRetentionFiles: LOG_RETENTION_FILES
    };
}
