/**
 * ==========================================================================
 * Abuse limiting — one keyed counter, and the middleware built on it.
 *
 * WHY THIS MODULE EXISTS RATHER THAN A THIRD MAP. Two hand-rolled in-memory
 * attempt trackers were already here before it: `failedAttempts` in
 * `adminAuth.js` and `ipFailures` in `customerAuth.js`. Both are *credential*
 * lockouts — they count failures, escalate a cooldown, and clear on success —
 * and that policy is deliberately not what this file implements. What they
 * share with an abuse limiter is the substrate underneath: a keyed map of
 * short-lived counters that has to be bounded. So the substrate lives here once
 * (`createBoundedMap`), each caller keeps its own policy, and there is no third
 * way to count something per IP (CLAUDE.md §1).
 *
 * WHY IN MEMORY. PM2 runs `instances: 1` and there is one process per tenant,
 * so a shared store would be a new dependency buying nothing. An attacker who
 * can restart the process to clear the counters already has better levers —
 * the same reasoning `customerAuth.js` records for its own map.
 *
 * WHY FIXED WINDOWS, NOT SLIDING. A fixed window lets a caller burst across a
 * boundary — up to 2× the quota in one instant. That is a real weakness and an
 * acceptable one: this is abuse control, not a billing meter, and the cost of
 * the sliding-log alternative is storing every request timestamp per key, which
 * is exactly the unbounded growth this module exists to avoid.
 * ==========================================================================
 */

import { logTelemetry } from './db.js';

/**
 * A Map that cannot grow without bound.
 *
 * THIS IS THE BUG IT FIXES. Both pre-existing trackers only ever deleted an
 * entry on a *successful* login, so every source that failed once and never
 * came back stayed resident forever. One request per new IP is enough to grow
 * them indefinitely — slow, silent, and indistinguishable from a leak.
 *
 * Two bounds, because either alone is escapable: entries past their TTL are
 * swept on write, and if a flood outruns the sweep the oldest entries are
 * dropped until the map is back under `maxEntries`. A JS Map iterates in
 * insertion order, which is what makes "oldest" cheap to find.
 *
 * Dropping the oldest can forgive a counter early under a flood. That is the
 * right trade: the alternative is exhausting memory, which takes the whole
 * till down rather than letting one attacker retry sooner.
 *
 * @param {{maxEntries?: number, ttlMs: number}} options
 */
export function createBoundedMap({ maxEntries = 20000, ttlMs }) {
    const entries = new Map();
    let nextSweepAt = 0;

    function sweep(now) {
        for (const [key, value] of entries) {
            if (value.expiresAt <= now) entries.delete(key);
        }
        // Map iteration order is insertion order, so this drops the least
        // recently created keys first.
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
        /** The live entry for `key`, or undefined if absent or expired. */
        get(key) {
            const entry = entries.get(key);
            if (!entry) return undefined;
            if (entry.expiresAt <= Date.now()) {
                entries.delete(key);
                return undefined;
            }
            return entry;
        },
        /** Stores `entry`, stamping its expiry and sweeping when due. */
        set(key, entry, now = Date.now()) {
            entry.expiresAt = now + ttlMs;
            entries.set(key, entry);
            if (now >= nextSweepAt || entries.size > maxEntries) sweep(now);
            return entry;
        },
        delete(key) {
            return entries.delete(key);
        },
        get size() {
            return entries.size;
        },
        /** Test seam: drops everything without waiting for a TTL. */
        clear() {
            entries.clear();
            nextSweepAt = 0;
        }
    };
}

/**
 * Express middleware refusing more than `max` requests per `windowMs` per key.
 *
 * The key defaults to `req.ip`, which is the real client address because
 * `server.js` sets `trust proxy` to 'loopback' — without that every request
 * behind Nginx would key to 127.0.0.1 and one abuser would lock out the store.
 *
 * Emits the `RateLimit-*` headers so a client can back off before being
 * refused, and `Retry-After` on the 429 so it knows when to return.
 *
 * @param {{name: string, windowMs: number, max: number, message: string,
 *          keyOf?: (req: any) => string}} options
 */
export function createRateLimiter({ name, windowMs, max, message, keyOf }) {
    const counters = createBoundedMap({ ttlMs: windowMs });

    function limiter(req, res, next) {
        const now = Date.now();
        const key = keyOf ? keyOf(req) : req.ip;

        let entry = counters.get(key);
        if (!entry) entry = counters.set(key, { count: 0, resetAt: now + windowMs }, now);
        entry.count += 1;

        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
        res.setHeader('RateLimit-Reset', String(retryAfterSeconds));

        if (entry.count > max) {
            res.setHeader('Retry-After', String(retryAfterSeconds));
            /* Logged because a limiter that fires silently is indistinguishable
               from one set too tight — and "customers cannot register" is how a
               wrong number here presents. Structured, so it can be counted. */
            logTelemetry('RATE_LIMITED', 0, name, {
                requestId: req.id,
                limiter: name,
                path: req.path,
                count: entry.count,
                max
            });
            return res.status(429).json({
                error: 'RATE_LIMITED',
                message,
                retryAfterSeconds,
                requestId: req.id
            });
        }

        return next();
    }

    // Exposed so a suite can start from a known state rather than depending on
    // whatever earlier checks in the same process already spent.
    limiter.reset = () => counters.clear();
    limiter.limiterName = name;
    return limiter;
}
