/**
 * ==========================================================================
 * Gold savings schemes.
 *
 * Rebased on the Phase-1 SQL model per PRODUCTION_READINESS_ROADMAP.md
 * Phase 6's own instruction, not the JSON-file design an earlier plan
 * proposed: installments are append-only rows, a gram lock references the
 * rate in force at payment time, and maturity/closure/default is a state
 * machine with a transition history — the same shape advance_entries and
 * old_gold_exchanges already use.
 *
 * `transition()` here mirrors advanceRepository.js#transition(): the UPDATE
 * is conditional on the CURRENT status, so a double-tapped "Mature" button
 * matches zero rows and is reported as already-transitioned rather than
 * double-crediting the payout.
 * ==========================================================================
 */

import { getDb, inTransactionNow } from './connection.js';
import { newId } from '../db.js';

function assertInTransaction(name) {
    if (!inTransactionNow()) {
        throw new Error(`${name}() must run inside inTransaction().`);
    }
}

/* --------------------------------------------------------------------------
   Scheme definitions
   -------------------------------------------------------------------------- */

export function createScheme(scheme) {
    assertInTransaction('createScheme');
    getDb().prepare(`
        INSERT INTO gold_schemes (
            id, tenant_id, name, installment_count, bonus_installments,
            default_grace_days, early_closure_penalty_bp, is_active, created_at
        ) VALUES (
            @id, @tenantId, @name, @installmentCount, @bonusInstallments,
            @defaultGraceDays, @earlyClosurePenaltyBp, 1, @createdAt
        )
    `).run(scheme);
    return scheme.id;
}

export function findSchemeById(tenantId, id) {
    return getDb().prepare('SELECT * FROM gold_schemes WHERE id = ? AND tenant_id = ?').get(id, tenantId) || null;
}

export function listSchemes(tenantId, { activeOnly = true } = {}) {
    const where = activeOnly ? 'AND is_active = 1' : '';
    return getDb().prepare(`SELECT * FROM gold_schemes WHERE tenant_id = ? ${where} ORDER BY created_at DESC`)
        .all(tenantId);
}

/* --------------------------------------------------------------------------
   Enrollments
   -------------------------------------------------------------------------- */

export function insertEnrollment(enrollment) {
    assertInTransaction('insertEnrollment');
    const db = getDb();
    db.prepare(`
        INSERT INTO gold_scheme_enrollments (
            id, tenant_id, branch_id, scheme_id, customer_id,
            installment_count, bonus_installments, default_grace_days, early_closure_penalty_bp,
            status, created_by_user_id, enrolled_at, business_date
        ) VALUES (
            @id, @tenantId, @branchId, @schemeId, @customerId,
            @installmentCount, @bonusInstallments, @defaultGraceDays, @earlyClosurePenaltyBp,
            'active', @createdByUserId, @enrolledAt, @businessDate
        )
    `).run(enrollment);

    db.prepare(`
        INSERT INTO gold_scheme_transitions (id, enrollment_id, from_status, to_status, actor_user_id, note, occurred_at)
        VALUES (?, ?, NULL, 'active', ?, ?, ?)
    `).run(newId('GST'), enrollment.id, enrollment.createdByUserId, 'Enrolled', enrollment.enrolledAt);

    return enrollment.id;
}

export function findEnrollmentById(tenantId, id) {
    return getDb().prepare('SELECT * FROM gold_scheme_enrollments WHERE id = ? AND tenant_id = ?').get(id, tenantId) || null;
}

export function listEnrollments(tenantId, { customerId = null, status = null, limit = 100 } = {}) {
    const where = ['tenant_id = @tenantId'];
    const params = { tenantId, limit: Math.min(500, Math.max(1, Math.trunc(limit) || 100)) };
    if (customerId) { where.push('customer_id = @customerId'); params.customerId = customerId; }
    if (status) { where.push('status = @status'); params.status = status; }
    return getDb().prepare(`
        SELECT * FROM gold_scheme_enrollments WHERE ${where.join(' AND ')}
        ORDER BY enrolled_at DESC LIMIT @limit
    `).all(params);
}

/**
 * Moves an enrollment to a new terminal status and, when it is credited,
 * names the advance entry the payout was posted as.
 * @returns {{changed: boolean, enrollment: object|null}}
 */
export function transitionEnrollment(enrollmentId, { fromStatus, toStatus, advanceEntryId = null, actorUserId, note = null, at = Date.now() }) {
    assertInTransaction('transitionEnrollment');
    const db = getDb();
    const result = db.prepare(`
        UPDATE gold_scheme_enrollments
           SET status = @toStatus, advance_entry_id = COALESCE(@advanceEntryId, advance_entry_id)
         WHERE id = @enrollmentId AND status = @fromStatus
    `).run({ enrollmentId, fromStatus, toStatus, advanceEntryId });

    if (result.changes !== 1) return { changed: false, enrollment: findEnrollmentByRawId(enrollmentId) };

    db.prepare(`
        INSERT INTO gold_scheme_transitions (id, enrollment_id, from_status, to_status, actor_user_id, note, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(newId('GST'), enrollmentId, fromStatus, toStatus, actorUserId, note, at);

    return { changed: true, enrollment: findEnrollmentByRawId(enrollmentId) };
}

function findEnrollmentByRawId(id) {
    return getDb().prepare('SELECT * FROM gold_scheme_enrollments WHERE id = ?').get(id) || null;
}

/* --------------------------------------------------------------------------
   Installments
   -------------------------------------------------------------------------- */

export function insertInstallment(installment) {
    assertInTransaction('insertInstallment');
    getDb().prepare(`
        INSERT INTO gold_scheme_installments (
            id, tenant_id, enrollment_id, installment_number, amount_paise,
            rate_paise_per_g_locked, gold_grams_locked_mg, payment_method,
            actor_user_id, created_at, business_date
        ) VALUES (
            @id, @tenantId, @enrollmentId, @installmentNumber, @amountPaise,
            @ratePaisePerGLocked, @goldGramsLockedMg, @paymentMethod,
            @actorUserId, @createdAt, @businessDate
        )
    `).run(installment);
    return installment.id;
}

export function listInstallments(enrollmentId) {
    return getDb().prepare(
        'SELECT * FROM gold_scheme_installments WHERE enrollment_id = ? ORDER BY installment_number'
    ).all(enrollmentId);
}

/** Sum of locked grams and count of installments paid so far — what maturity/closure math needs. */
export function installmentSummary(enrollmentId) {
    const row = getDb().prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(gold_grams_locked_mg), 0) AS totalGramsMg,
               MAX(created_at) AS lastPaidAt
        FROM gold_scheme_installments WHERE enrollment_id = ?
    `).get(enrollmentId);
    return { count: row.count, totalGramsMg: row.totalGramsMg, lastPaidAt: row.lastPaidAt || null };
}
