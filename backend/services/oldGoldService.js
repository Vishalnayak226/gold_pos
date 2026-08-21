/**
 * ==========================================================================
 * Old-gold exchange.
 *
 * FLAGGED OFF BY DEFAULT (settings.oldGoldExchangeEnabled). Disabled means
 * this route behaves as if it never existed — see the route in server.js.
 *
 * NOT A NEW REDEMPTION MECHANISM. An exchange computes a ₹ credit for gold a
 * customer trades in, then posts it as an ORDINARY advance_entries deposit —
 * the existing advance/credit-redemption machinery (already wired into
 * computeInvoiceTotals() via appliedAdvance/customerAdvanceBalance) applies
 * it against a sale with zero new logic. This module only owns the exchange
 * fact and its valuation.
 *
 * APPROVAL-GATED like advanceService#recordDeposit()'s posted path: crediting
 * a customer's spendable balance is cash-equivalent, the same authority bar
 * as a counter advance deposit.
 *
 * NO GST/RCM TREATMENT. Buying gold from a customer is an unresolved legal
 * question (CLAUDE.md, PRODUCTION_READINESS_ROADMAP.md Phase 5 §4) — this
 * module computes and records a valuation only, never a tax figure.
 * ==========================================================================
 */

import {
    inTransaction, oldGold, advances, customers, audit, users,
    dataStoreContext, businessDate
} from '../repositories/index.js';
import { newId, logError } from '../db.js';
import { computeOldGoldCredit, round2, round3, toPaise } from '../../frontend/js/lib/billingMath.js';
import { DomainRefusal } from './saleService.js';

const VALID_PURITIES = ['24K', '22K', '18K'];
const PURITY_RATE_KEY = { '24K': 'price24K', '22K': 'price22K', '18K': 'price18K' };
const MAX_SANE_WEIGHT_GRAMS = 100000;

/**
 * Records an old-gold exchange and posts its credit as a spendable advance.
 *
 * @param {object} input
 * @param {string} input.customerPhone
 * @param {string} [input.customerName]
 * @param {string} [input.description]
 * @param {'24K'|'22K'|'18K'} input.declaredPurity what the customer claims
 * @param {'24K'|'22K'|'18K'} input.testedPurity what the counter's test found —
 *        priced at this, never the declared one
 * @param {number} input.grossWeightGrams as weighed at the counter
 * @param {object} deps
 * @param {() => object} deps.getActiveGoldRates
 * @param {() => object} deps.getSettings
 * @param {(phone: string) => boolean} deps.isValidPhone
 * @param {string} [deps.actorUserId]
 * @param {string} [deps.actorLabel]
 * @param {string} [deps.ipAddress]
 * @returns {{success: true, exchange: object}|{success: false, status: number, error: string}}
 */
export function recordExchange(input, deps) {
    const { getActiveGoldRates, getSettings, isValidPhone } = deps;
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    const settings = getSettings();
    if (settings.oldGoldExchangeEnabled !== true) {
        return { success: false, status: 404, error: 'Old-gold exchange is not enabled for this store.' };
    }

    // Crediting a customer's balance is cash-equivalent — the same bar a
    // posted counter advance deposit already needs.
    if (!users.isApprover(context.tenantId, actorUserId)) {
        return { success: false, status: 403, error: 'Only an owner or a manager may record an old-gold exchange.' };
    }

    if (!isValidPhone(input.customerPhone)) {
        return { success: false, status: 400, error: 'Valid 10-digit customer phone number required.' };
    }
    if (!VALID_PURITIES.includes(input.declaredPurity)) {
        return { success: false, status: 400, error: 'Declared purity must be 24K, 22K, or 18K.' };
    }
    if (!VALID_PURITIES.includes(input.testedPurity)) {
        return { success: false, status: 400, error: 'Tested purity must be 24K, 22K, or 18K.' };
    }
    const grossWeightGrams = Number(input.grossWeightGrams);
    if (!Number.isFinite(grossWeightGrams) || grossWeightGrams <= 0) {
        return { success: false, status: 400, error: 'A positive gross weight is required.' };
    }
    if (grossWeightGrams > MAX_SANE_WEIGHT_GRAMS) {
        return { success: false, status: 400, error: `Weight exceeds the ${MAX_SANE_WEIGHT_GRAMS}g limit.` };
    }

    // The deduction percentage is a store policy, not a client-supplied
    // figure — same posture wastage already takes on the tax slab.
    const deductionPercent = Number.isFinite(Number(settings.oldGoldDeductionPercent))
        ? Number(settings.oldGoldDeductionPercent) : 0;

    const activeRates = getActiveGoldRates();
    const rateKey = PURITY_RATE_KEY[input.testedPurity];
    const ratePerGram = Number(activeRates[rateKey]);
    if (!Number.isFinite(ratePerGram) || ratePerGram <= 0) {
        logError(`Refusing an old-gold exchange at ${input.testedPurity}: the active gold rate is unusable (${activeRates[rateKey]}).`);
        return { success: false, status: 503, error: 'The current gold rate is unavailable, so this exchange cannot be valued. Check the gold rate in Settings and retry.' };
    }

    const { netWeightGrams, creditAmount } = computeOldGoldCredit({
        grossWeightGrams, ratePerGram, deductionPercent
    });
    if (creditAmount <= 0) {
        return { success: false, status: 400, error: 'This exchange values at zero after the deduction — nothing to credit.' };
    }

    try {
        return inTransaction(() => {
            const now = Date.now();
            const customerId = customers.ensureCustomerId(context.tenantId, input.customerPhone, input.customerName);
            const accountId = advances.ensureAccount({
                tenantId: context.tenantId,
                customerPhone: input.customerPhone,
                customerName: input.customerName || '',
                customerId
            });

            const advanceEntryId = newId('ADV');
            advances.insertEntry({
                id: advanceEntryId,
                tenantId: context.tenantId,
                branchId: context.branchId,
                accountId,
                entryType: 'deposit',
                amountPaise: advances.signedPaise('deposit', creditAmount),
                status: 'posted',
                paymentMethod: 'other',
                referenceId: null,
                source: 'counter',
                lockedRate22kPaisePerG: Math.round(Number(activeRates.price22K) * 100),
                invoiceId: null,
                creditNoteId: null,
                reversesEntryId: null,
                idempotencyKey: null,
                createdByUserId: actorUserId,
                approvedByUserId: actorUserId,
                approvedAt: now,
                reviewNote: 'Old-gold exchange credit',
                createdAt: now,
                businessDate: businessDate(now)
            });

            const exchangeId = newId('OGX');
            oldGold.insertExchange({
                id: exchangeId,
                tenantId: context.tenantId,
                branchId: context.branchId,
                customerId,
                advanceEntryId,
                description: String(input.description || '').trim().slice(0, 200),
                declaredPurity: input.declaredPurity,
                testedPurity: input.testedPurity,
                grossWeightMg: Math.round(grossWeightGrams * 1000),
                deductionBp: Math.round(Math.min(100, Math.max(0, deductionPercent)) * 100),
                netWeightMg: Math.round(netWeightGrams * 1000),
                ratePaisePerG: Math.round(ratePerGram * 100),
                creditAmountPaise: toPaise(creditAmount),
                actorUserId,
                createdAt: now,
                businessDate: businessDate(now)
            });

            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'counter',
                action: 'OLD_GOLD_EXCHANGE_RECORDED',
                entityType: 'old_gold_exchange',
                entityId: exchangeId,
                summary: `${round3(netWeightGrams)}g net ${input.testedPurity} credited as ₹${round2(creditAmount)}`,
                detail: {
                    declaredPurity: input.declaredPurity, testedPurity: input.testedPurity,
                    grossWeightGrams: round3(grossWeightGrams), netWeightGrams: round3(netWeightGrams),
                    deductionPercent, ratePerGram, creditAmount: round2(creditAmount), advanceEntryId
                },
                ipAddress: deps.ipAddress
            });

            return {
                success: true,
                exchange: {
                    id: exchangeId,
                    customerPhone: input.customerPhone,
                    declaredPurity: input.declaredPurity,
                    testedPurity: input.testedPurity,
                    grossWeightGrams: round3(grossWeightGrams),
                    netWeightGrams: round3(netWeightGrams),
                    deductionPercent,
                    ratePerGram,
                    creditAmount: round2(creditAmount),
                    advanceEntryId
                }
            };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message, code: err.code };
        }
        throw err;
    }
}
