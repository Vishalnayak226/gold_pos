/**
 * ==========================================================================
 * Rate snapshots — the immutable record of what gold cost when an invoice was
 * priced.
 *
 * The JSON ledger stored only `goldPricePerGram` and `goldRateSource` on the
 * sale row, which answers "what rate" but not "where did that rate come from
 * and what were the other purities at that instant". A reprint has to be
 * explainable years later, and an auditor asking why 22K was billed at ₹6,875
 * on a Tuesday deserves a row rather than an inference.
 *
 * Snapshots are append-only by convention and by use: nothing here updates or
 * deletes one, and `invoices.rate_snapshot_id` points at it forever.
 * ==========================================================================
 */

import { getDb } from './connection.js';
import { newId } from '../db.js';
import { toPaise } from '../../frontend/js/lib/billingMath.js';

const SOURCES = new Set(['auto', 'manual', 'override', 'seeded', 'mock']);

/**
 * Records a snapshot and returns its id.
 *
 * Rates arrive in rupees-per-gram (what priceEngine.js and settings.json deal
 * in) and are stored as paise-per-gram, converted here at the seam so no
 * caller has to remember the scale.
 *
 * @param {{source: string, provider?: string, price24K: number, price22K: number,
 *          price18K: number, capturedAt?: number, createdByUserId?: string|null}} spec
 * @returns {string} snapshot id
 */
export function recordSnapshot({ source, provider = null, price24K, price22K, price18K,
                                 capturedAt = Date.now(), createdByUserId = null }) {
    const normalisedSource = SOURCES.has(source) ? source : 'manual';
    const id = newId('RAT');

    getDb().prepare(`
        INSERT INTO rate_snapshots (id, tenant_id, source, provider,
                                    price_24k_paise_per_g, price_22k_paise_per_g, price_18k_paise_per_g,
                                    captured_at, created_by_user_id)
        VALUES (?, (SELECT id FROM tenants ORDER BY created_at LIMIT 1), ?, ?, ?, ?, ?, ?, ?)
    `).run(id, normalisedSource, provider,
        toPaise(price24K), toPaise(price22K), toPaise(price18K),
        Math.trunc(capturedAt), createdByUserId);

    return id;
}

/**
 * The most recent snapshot, or null.
 *
 * Deliberately NOT used to price a sale — pricing reads the live rate through
 * priceEngine.js, which is the store's configured source of truth. This is for
 * reporting and for reusing an identical snapshot rather than writing a new
 * row per invoice when nothing has moved.
 */
export function latestSnapshot(tenantId) {
    return getDb().prepare(
        'SELECT * FROM rate_snapshots WHERE tenant_id = ? ORDER BY captured_at DESC LIMIT 1'
    ).get(tenantId) || null;
}

/**
 * Reuses the newest snapshot when it already states exactly these three prices,
 * otherwise records a new one. A counter billing forty invoices on an unchanged
 * rate produces one snapshot row, not forty — while any rate movement is still
 * captured the instant it is first billed against.
 */
export function snapshotFor({ tenantId, source, provider = null, price24K, price22K, price18K,
                              capturedAt = Date.now(), createdByUserId = null }) {
    const latest = latestSnapshot(tenantId);
    if (latest
        && latest.source === source
        && latest.price_24k_paise_per_g === toPaise(price24K)
        && latest.price_22k_paise_per_g === toPaise(price22K)
        && latest.price_18k_paise_per_g === toPaise(price18K)) {
        return latest.id;
    }
    return recordSnapshot({ source, provider, price24K, price22K, price18K, capturedAt, createdByUserId });
}

/** One snapshot by id, or null. */
export function findSnapshot(id) {
    if (!id) return null;
    return getDb().prepare('SELECT * FROM rate_snapshots WHERE id = ?').get(id) || null;
}
