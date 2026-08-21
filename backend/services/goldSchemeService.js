/**
 * ==========================================================================
 * Gold savings schemes.
 *
 * FLAGGED OFF BY DEFAULT (settings.goldSchemeEnabled). Every export below
 * refuses with a 404-shaped result when it is off, so the routes behave as
 * though this module never existed.
 *
 * PLACEHOLDER TERMS, ON PURPOSE. goldSchemeInstallmentCount/BonusInstallments/
 * DefaultGraceDays/EarlyClosurePenaltyPercent in settings are an engineering
 * placeholder (an "11 + 1 free" structure typical of Indian gold-scheme
 * practice), not a legally reviewed product. `ensureDefaultScheme()` snapshots
 * whatever settings say the first time a scheme is needed for a tenant; every
 * enrollment then snapshots ITS terms from that scheme row, never live
 * settings, so editing settings later cannot retroactively change an
 * enrollment already in progress.
 *
 * APPROVAL-GATED throughout, matching advanceService.js's posted-deposit
 * path: enrolling a customer and recording an installment both move a
 * counter obligation, the same authority bar a posted advance deposit needs.
 *
 * MATURITY/CLOSURE PAY OUT AS AN ORDINARY ADVANCE DEPOSIT — the same
 * mechanism old-gold exchange already reuses, zero new redemption logic.
 * ==========================================================================
 */

import {
    inTransaction, goldSchemes, advances, customers, audit, users,
    dataStoreContext, businessDate
} from '../repositories/index.js';
import { newId, logError } from '../db.js';
import { computeGoldGramsForAmount, computeGoldSchemePayout, round2, round3, toPaise, fromPaise } from '../../frontend/js/lib/billingMath.js';

const DEFAULT_SCHEME_NAME = 'Standard Gold Scheme';
const TENDER_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'other'];

function disabledResult() {
    return { success: false, status: 404, error: 'Gold savings schemes are not enabled for this store.' };
}

function requireEnabled(settings) {
    return settings.goldSchemeEnabled === true;
}

/** Finds this tenant's default scheme, creating it from current settings the first time. */
function ensureDefaultScheme(context, settings) {
    const existing = goldSchemes.listSchemes(context.tenantId, { activeOnly: true })
        .find(s => s.name === DEFAULT_SCHEME_NAME);
    if (existing) return existing;

    const id = newId('SCH');
    return inTransaction(() => {
        goldSchemes.createScheme({
            id,
            tenantId: context.tenantId,
            name: DEFAULT_SCHEME_NAME,
            installmentCount: Math.max(1, Math.trunc(Number(settings.goldSchemeInstallmentCount)) || 11),
            bonusInstallments: Math.max(0, Math.trunc(Number(settings.goldSchemeBonusInstallments)) || 0),
            defaultGraceDays: Math.max(1, Math.trunc(Number(settings.goldSchemeDefaultGraceDays)) || 30),
            earlyClosurePenaltyBp: Math.round(Math.max(0, Number(settings.goldSchemeEarlyClosurePenaltyPercent) || 0) * 100),
            createdAt: Date.now()
        });
        return goldSchemes.findSchemeById(context.tenantId, id);
    });
}

/**
 * Enrolls a customer into the tenant's default gold scheme.
 * @param {{customerPhone: string, customerName?: string}} input
 */
export function enroll(input, deps) {
    const { getSettings, isValidPhone } = deps;
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;
    const settings = getSettings();
    if (!requireEnabled(settings)) return disabledResult();

    if (!isValidPhone(input.customerPhone)) {
        return { success: false, status: 400, error: 'Valid 10-digit customer phone number required.' };
    }
    if (!users.isApprover(context.tenantId, actorUserId)) {
        return { success: false, status: 403, error: 'Only an owner or a manager may enroll a customer.' };
    }

    return inTransaction(() => {
        const scheme = ensureDefaultScheme(context, settings);
        const customerId = customers.ensureCustomerId(context.tenantId, input.customerPhone, input.customerName);

        const now = Date.now();
        const enrollmentId = newId('SEN');
        goldSchemes.insertEnrollment({
            id: enrollmentId,
            tenantId: context.tenantId,
            branchId: context.branchId,
            schemeId: scheme.id,
            customerId,
            installmentCount: scheme.installment_count,
            bonusInstallments: scheme.bonus_installments,
            defaultGraceDays: scheme.default_grace_days,
            earlyClosurePenaltyBp: scheme.early_closure_penalty_bp,
            createdByUserId: actorUserId,
            enrolledAt: now,
            businessDate: businessDate(now)
        });

        audit.record({
            tenantId: context.tenantId, branchId: context.branchId, actorUserId,
            actorLabel: deps.actorLabel || 'counter',
            action: 'GOLD_SCHEME_ENROLLED', entityType: 'gold_scheme_enrollment', entityId: enrollmentId,
            summary: `Enrolled in ${scheme.name} (${scheme.installment_count} installments, ${scheme.bonus_installments} bonus)`,
            ipAddress: deps.ipAddress
        });

        return { success: true, enrollment: wireEnrollment(goldSchemes.findEnrollmentById(context.tenantId, enrollmentId)) };
    });
}

/** Records one installment payment, locking its gold-gram equivalent at today's rate. */
export function recordInstallment(enrollmentId, input, deps) {
    const { getActiveGoldRates, getSettings } = deps;
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;
    const settings = getSettings();
    if (!requireEnabled(settings)) return disabledResult();

    if (!users.isApprover(context.tenantId, actorUserId)) {
        return { success: false, status: 403, error: 'Only an owner or a manager may record an installment.' };
    }

    const enrollment = goldSchemes.findEnrollmentById(context.tenantId, enrollmentId);
    if (!enrollment) return { success: false, status: 404, error: 'No such enrollment.' };
    if (enrollment.status !== 'active') {
        return { success: false, status: 409, error: `This enrollment is ${enrollment.status}, not active — no further installments can be recorded.` };
    }

    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return { success: false, status: 400, error: 'A positive installment amount is required.' };
    }
    const paymentMethod = TENDER_METHODS.includes(input.paymentMethod) ? input.paymentMethod : 'cash';

    const activeRates = getActiveGoldRates();
    const ratePerGram = Number(activeRates.price22K);
    if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
        logError('Refusing a gold-scheme installment: the active 22K rate is unusable.');
        return { success: false, status: 503, error: 'The current gold rate is unavailable, so this installment cannot be locked. Check the gold rate in Settings and retry.' };
    }

    const gramsLocked = computeGoldGramsForAmount(amount, ratePerGram);
    if (gramsLocked <= 0) return { success: false, status: 400, error: 'This amount locks zero gold at the current rate.' };

    return inTransaction(() => {
        const summary = goldSchemes.installmentSummary(enrollmentId);
        const now = Date.now();
        const installmentId = newId('SIN');
        goldSchemes.insertInstallment({
            id: installmentId,
            tenantId: context.tenantId,
            enrollmentId,
            installmentNumber: summary.count + 1,
            amountPaise: toPaise(amount),
            ratePaisePerGLocked: Math.round(ratePerGram * 100),
            goldGramsLockedMg: Math.round(gramsLocked * 1000),
            paymentMethod,
            actorUserId,
            createdAt: now,
            businessDate: businessDate(now)
        });

        audit.record({
            tenantId: context.tenantId, branchId: context.branchId, actorUserId,
            actorLabel: deps.actorLabel || 'counter',
            action: 'GOLD_SCHEME_INSTALLMENT_RECORDED', entityType: 'gold_scheme_enrollment', entityId: enrollmentId,
            summary: `Installment ${summary.count + 1}: ₹${round2(amount)} locked ${gramsLocked}g at ₹${ratePerGram}/g`,
            detail: { installmentNumber: summary.count + 1, amount: round2(amount), ratePerGram, gramsLocked },
            ipAddress: deps.ipAddress
        });

        return {
            success: true,
            installment: {
                id: installmentId, installmentNumber: summary.count + 1, amount: round2(amount),
                ratePerGram, gramsLocked, paymentMethod
            }
        };
    });
}

/** Matures an enrollment that has paid its full term, crediting real + bonus grams at today's rate. */
export function matureEnrollment(enrollmentId, deps) {
    return settle(enrollmentId, deps, {
        requireFullTerm: true,
        awardBonus: true,
        action: 'GOLD_SCHEME_MATURED',
        toStatus: 'matured',
        insufficientTermError: (paid, needed) => `Only ${paid} of ${needed} installments have been paid — this enrollment cannot mature yet. Use close-early instead if the customer wants their money now.`
    });
}

/** Closes an enrollment before its full term — no bonus, and the scheme's early-closure penalty applies. */
export function closeEarlyEnrollment(enrollmentId, deps) {
    return settle(enrollmentId, deps, {
        requireFullTerm: false,
        awardBonus: false,
        action: 'GOLD_SCHEME_CLOSED_EARLY',
        toStatus: 'closed_early'
    });
}

function settle(enrollmentId, deps, { requireFullTerm, awardBonus, action, toStatus, insufficientTermError }) {
    const { getActiveGoldRates, getSettings } = deps;
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;
    const settings = getSettings();
    if (!requireEnabled(settings)) return disabledResult();

    if (!users.isApprover(context.tenantId, actorUserId)) {
        return { success: false, status: 403, error: 'Only an owner or a manager may settle a scheme enrollment.' };
    }

    const enrollment = goldSchemes.findEnrollmentById(context.tenantId, enrollmentId);
    if (!enrollment) return { success: false, status: 404, error: 'No such enrollment.' };
    if (enrollment.status !== 'active') {
        return { success: false, status: 409, error: `This enrollment is already ${enrollment.status}.` };
    }

    const summary = goldSchemes.installmentSummary(enrollmentId);
    if (requireFullTerm && summary.count < enrollment.installment_count) {
        return { success: false, status: 409, error: insufficientTermError(summary.count, enrollment.installment_count) };
    }
    if (summary.count === 0) {
        return { success: false, status: 409, error: 'No installments have been paid — nothing to settle.' };
    }

    const activeRates = getActiveGoldRates();
    const ratePerGram = Number(activeRates.price22K);
    if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
        return { success: false, status: 503, error: 'The current gold rate is unavailable, so this cannot be settled. Check the gold rate in Settings and retry.' };
    }

    const payout = computeGoldSchemePayout({
        totalGramsLocked: summary.totalGramsMg / 1000,
        installmentsPaid: summary.count,
        bonusInstallments: awardBonus ? enrollment.bonus_installments : 0,
        penaltyPercent: awardBonus ? 0 : enrollment.early_closure_penalty_bp / 100,
        currentRatePerGram: ratePerGram
    });
    if (payout.payoutAmount <= 0) {
        return { success: false, status: 409, error: 'This settlement values at zero — nothing to credit.' };
    }

    return inTransaction(() => {
        const now = Date.now();
        // The SAME advance_accounts row a sale or an old-gold exchange would
        // find for this customer — keyed by phone, never by id, so the
        // payout must resolve the customer's actual phone rather than pass
        // null and silently create a second, unreachable account.
        const customer = customers.getCustomerById(context.tenantId, enrollment.customer_id);
        if (!customer) throw new Error(`No customer record for enrollment ${enrollmentId}.`);
        const accountId = advances.ensureAccount({
            tenantId: context.tenantId, customerPhone: customer.phone, customerName: customer.full_name,
            customerId: enrollment.customer_id
        });
        const advanceEntryId = newId('ADV');
        advances.insertEntry({
            id: advanceEntryId,
            tenantId: context.tenantId, branchId: context.branchId, accountId,
            entryType: 'deposit',
            amountPaise: advances.signedPaise('deposit', payout.payoutAmount),
            status: 'posted', paymentMethod: 'other', referenceId: null, source: 'counter',
            lockedRate22kPaisePerG: Math.round(ratePerGram * 100),
            invoiceId: null, creditNoteId: null, reversesEntryId: null, idempotencyKey: null,
            createdByUserId: actorUserId, approvedByUserId: actorUserId, approvedAt: now,
            reviewNote: `Gold scheme ${toStatus}`, createdAt: now, businessDate: businessDate(now)
        });

        const { changed, enrollment: updated } = goldSchemes.transitionEnrollment(enrollmentId, {
            fromStatus: 'active', toStatus, advanceEntryId, actorUserId,
            note: `${round3(payout.payoutGrams)}g settled for ₹${round2(payout.payoutAmount)}`, at: now
        });
        if (!changed) {
            throw new Error('This enrollment was settled by another request just now.');
        }

        audit.record({
            tenantId: context.tenantId, branchId: context.branchId, actorUserId,
            actorLabel: deps.actorLabel || 'counter',
            action, entityType: 'gold_scheme_enrollment', entityId: enrollmentId,
            summary: `${round3(payout.payoutGrams)}g credited as ₹${round2(payout.payoutAmount)}`,
            detail: { ...payout, ratePerGram, advanceEntryId },
            ipAddress: deps.ipAddress
        });

        return { success: true, enrollment: wireEnrollment(updated), payout: { ...payout, advanceEntryId } };
    });
}

/** Marks an enrollment defaulted — a status flag only, no money moves. Refused unless genuinely overdue. */
export function markDefaulted(enrollmentId, deps) {
    const { getSettings } = deps;
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;
    const settings = getSettings();
    if (!requireEnabled(settings)) return disabledResult();

    if (!users.isApprover(context.tenantId, actorUserId)) {
        return { success: false, status: 403, error: 'Only an owner or a manager may mark an enrollment defaulted.' };
    }

    const enrollment = goldSchemes.findEnrollmentById(context.tenantId, enrollmentId);
    if (!enrollment) return { success: false, status: 404, error: 'No such enrollment.' };
    if (enrollment.status !== 'active') {
        return { success: false, status: 409, error: `This enrollment is already ${enrollment.status}.` };
    }

    const summary = goldSchemes.installmentSummary(enrollmentId);
    const since = summary.lastPaidAt || enrollment.enrolled_at;
    const graceMs = enrollment.default_grace_days * 24 * 60 * 60 * 1000;
    if (Date.now() - since < graceMs) {
        return { success: false, status: 409, error: `This enrollment is not yet overdue — its ${enrollment.default_grace_days}-day grace period has not elapsed since the last payment.` };
    }

    return inTransaction(() => {
        const { changed, enrollment: updated } = goldSchemes.transitionEnrollment(enrollmentId, {
            fromStatus: 'active', toStatus: 'defaulted', actorUserId,
            note: deps.note || 'No payment within the grace period', at: Date.now()
        });
        if (!changed) throw new Error('This enrollment changed status just now.');

        audit.record({
            tenantId: context.tenantId, branchId: context.branchId, actorUserId,
            actorLabel: deps.actorLabel || 'counter',
            action: 'GOLD_SCHEME_DEFAULTED', entityType: 'gold_scheme_enrollment', entityId: enrollmentId,
            summary: `Marked defaulted — no payment since ${new Date(since).toISOString()}`,
            ipAddress: deps.ipAddress
        });

        return { success: true, enrollment: wireEnrollment(updated) };
    });
}

export function listEnrollments(input, deps) {
    const context = dataStoreContext();
    const rows = goldSchemes.listEnrollments(context.tenantId, input);
    // installmentsPaid and the customer's own name/phone are per-row lookups
    // rather than a JOIN — this list is bounded (max 500) and both tables are
    // low-volume, so the extra roundtrips are negligible against the
    // readability of a plain loop.
    return rows.map(row => {
        const customer = customers.getCustomerById(context.tenantId, row.customer_id);
        return {
            ...wireEnrollment(row),
            installmentsPaid: goldSchemes.installmentSummary(row.id).count,
            customerName: customer ? customer.full_name : '',
            customerPhone: customer ? customer.phone : ''
        };
    });
}

export function getInstallments(enrollmentId) {
    const context = dataStoreContext();
    const enrollment = goldSchemes.findEnrollmentById(context.tenantId, enrollmentId);
    if (!enrollment) return null;
    return goldSchemes.listInstallments(enrollmentId).map(row => ({
        id: row.id, installmentNumber: row.installment_number,
        amount: fromPaise(row.amount_paise), ratePerGram: fromPaise(row.rate_paise_per_g_locked),
        gramsLocked: round3(row.gold_grams_locked_mg / 1000), paymentMethod: row.payment_method,
        createdAt: row.created_at
    }));
}

function wireEnrollment(row) {
    if (!row) return null;
    return {
        id: row.id, schemeId: row.scheme_id, customerId: row.customer_id,
        installmentCount: row.installment_count, bonusInstallments: row.bonus_installments,
        defaultGraceDays: row.default_grace_days,
        earlyClosurePenaltyPercent: round2(row.early_closure_penalty_bp / 100),
        status: row.status, advanceEntryId: row.advance_entry_id,
        enrolledAt: row.enrolled_at
    };
}
