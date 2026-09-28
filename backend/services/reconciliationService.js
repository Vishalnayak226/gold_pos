/**
 * ==========================================================================
 * Day reconciliation (cash shifts, roadmap Phase 5.3).
 *
 * Previously the routes called `cashShiftRepository.js` directly with no
 * owning service — flagged in `docs/INVARIANT_MATRIX.md` as a real
 * inconsistency with every money-moving workflow, which all have a
 * `DomainRefusal`-throwing service between the route and the repository.
 * The audit trail was already fixed in an earlier pass (both routes already
 * called `audit.record()`); this module just gives that same logic an
 * owning home and gives its state-guard refusals ("already open", "already
 * closed") a DOMAIN_CODE instead of a bare `Error`.
 *
 * NO NEW APPROVAL GATE. `requireAdminSession` remains the only
 * authorization check, exactly as before — server.js's own comment already
 * notes that gating a large-variance close behind an approver is a
 * reasonable follow-up, not decided here.
 * ==========================================================================
 */

import { inTransaction, cashShifts, audit, dataStoreContext } from '../repositories/index.js';
import { round2, fromPaise } from '../../frontend/js/lib/billingMath.js';
import { DomainRefusal } from './saleService.js';
import { DOMAIN_CODE } from '../domainCodes.js';

/**
 * Opens a new cash shift for the caller's branch.
 *
 * @param {object} input
 * @param {number} input.openingFloatPaise non-negative integer paise
 * @param {string} [input.openingNote]
 * @param {object} deps
 * @param {string} deps.actorUserId
 * @param {string} [deps.actorLabel]
 * @param {string} [deps.ipAddress]
 * @returns {{success: true, id: string}|{success: false, status: number, error: string, code: string}}
 */
export function openShift(input, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    try {
        return inTransaction(() => {
            if (cashShifts.getOpenShift(context.tenantId, context.branchId)) {
                throw new DomainRefusal(409, 'A shift is already open for this branch. Close it before opening another.', DOMAIN_CODE.CASH_SHIFT_ALREADY_OPEN);
            }

            const id = cashShifts.openShift({
                tenantId: context.tenantId,
                branchId: context.branchId,
                openingFloatPaise: input.openingFloatPaise,
                openingNote: input.openingNote || null,
                actorUserId
            });

            // A cash shift is a financial fact like any other counter action —
            // it belongs in the same tamper-evident trail a sale/return/void
            // already lands in, not just the shift row's own actor column.
            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'admin',
                action: 'CASH_SHIFT_OPENED',
                entityType: 'cash_shift',
                entityId: id,
                summary: `Shift opened with float ${round2(fromPaise(input.openingFloatPaise))}`,
                detail: { openingFloat: round2(fromPaise(input.openingFloatPaise)), openingNote: input.openingNote || null },
                ipAddress: deps.ipAddress
            });

            return { success: true, id };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message, code: err.code };
        }
        throw err;
    }
}

/**
 * Freezes expected cash as of now, records what was actually counted, and
 * closes the shift.
 *
 * @param {object} input
 * @param {string} input.shiftId
 * @param {number} input.countedCashPaise non-negative integer paise
 * @param {string} [input.closingNote]
 * @param {object} deps
 * @param {string} deps.actorUserId
 * @param {string} [deps.actorLabel]
 * @param {string} [deps.ipAddress]
 * @returns {{success: true, expectedPaise: number, variancePaise: number}|{success: false, status: number, error: string, code: string}}
 */
export function closeShift(input, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    try {
        return inTransaction(() => {
            const shift = cashShifts.getShift(context.tenantId, input.shiftId);
            if (!shift) {
                throw new DomainRefusal(400, `No shift ${input.shiftId} for this tenant.`, DOMAIN_CODE.CASH_SHIFT_NOT_FOUND);
            }
            if (shift.status !== 'open') {
                throw new DomainRefusal(409, `Shift ${input.shiftId} is already closed.`, DOMAIN_CODE.CASH_SHIFT_ALREADY_CLOSED);
            }

            const closed = cashShifts.closeShift({
                tenantId: context.tenantId,
                shiftId: input.shiftId,
                countedCashPaise: input.countedCashPaise,
                closingNote: input.closingNote || null,
                actorUserId
            });

            // Closing is the one action that can surface a cash variance —
            // worth its own tamper-evident audit entry even more than opening.
            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'admin',
                action: 'CASH_SHIFT_CLOSED',
                entityType: 'cash_shift',
                entityId: input.shiftId,
                summary: `Shift closed: expected ${round2(fromPaise(closed.expectedPaise))}, variance ${round2(fromPaise(closed.variancePaise))}`,
                detail: {
                    countedCash: round2(fromPaise(input.countedCashPaise)),
                    expectedCash: round2(fromPaise(closed.expectedPaise)),
                    variance: round2(fromPaise(closed.variancePaise)),
                    closingNote: input.closingNote || null
                },
                ipAddress: deps.ipAddress
            });

            return { success: true, expectedPaise: closed.expectedPaise, variancePaise: closed.variancePaise };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message, code: err.code };
        }
        throw err;
    }
}
