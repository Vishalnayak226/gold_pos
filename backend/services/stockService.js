/**
 * ==========================================================================
 * Stock: opening a lot and adjusting one for a physical count, breakage or
 * correction.
 *
 * Previously the routes called `inventoryRepository.js` directly with no
 * owning service — flagged in `docs/INVARIANT_MATRIX.md` as a real
 * inconsistency with every money-moving workflow, which all have a
 * `DomainRefusal`-throwing service between the route and the repository.
 * This module closes that gap for the two named refusals only:
 *   - the adjustment's negative-balance refusal now carries a DOMAIN_CODE
 *     instead of a bare `Error` (INVARIANT_MATRIX's "known gap"), and
 *   - every stock mutation now has an `audit.record()` entry, matching
 *     every money-workflow service (INVARIANT_MATRIX's other named gap —
 *     day reconciliation already got this in an earlier pass).
 *
 * NO NEW APPROVAL GATE. `requireAdminSession` remains the only
 * authorization check, exactly as before — deciding whether stock
 * adjustment should gain an approver gate the way a refund has one is a
 * real product decision, explicitly called out in INVARIANT_MATRIX as
 * still open, and is not made here.
 * ==========================================================================
 */

import { inTransaction, inventory, audit, dataStoreContext } from '../repositories/index.js';
import { round3 } from '../../frontend/js/lib/billingMath.js';
import { DomainRefusal } from './saleService.js';
import { DOMAIN_CODE } from '../domainCodes.js';

/**
 * Opens a new lot with its opening-balance movement.
 *
 * @param {object} input
 * @param {string} input.itemId
 * @param {number} input.weightMg positive integer milligrams
 * @param {string} [input.label]
 * @param {string} [input.reason]
 * @param {string} [input.hallmarkHuid]
 * @param {number|null} [input.unitCostPaisePerG]
 * @param {object} deps
 * @param {string} deps.actorUserId
 * @param {string} [deps.actorLabel]
 * @param {string} [deps.ipAddress]
 * @returns {{success: true, lotId: string, movementId: string}|{success: false, status: number, error: string, code: string}}
 */
export function openLot(input, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    const item = inventory.getItem(context.tenantId, input.itemId);
    if (!item) {
        return { success: false, status: 400, error: 'No inventory item with that id', code: DOMAIN_CODE.STOCK_ITEM_NOT_FOUND };
    }

    try {
        return inTransaction(() => {
            const { lotId, movementId } = inventory.openLot({
                tenantId: context.tenantId,
                branchId: context.branchId,
                itemId: input.itemId,
                weightMg: input.weightMg,
                label: input.label || null,
                reason: input.reason || null,
                actorUserId,
                hallmarkHuid: input.hallmarkHuid || null,
                unitCostPaisePerG: input.unitCostPaisePerG == null ? null : input.unitCostPaisePerG
            });

            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'admin',
                action: 'STOCK_LOT_OPENED',
                entityType: 'inventory_lot',
                entityId: lotId,
                summary: `Lot opened for ${item.name} at ${round3(input.weightMg / 1000)}g`,
                detail: { itemId: input.itemId, weightGrams: round3(input.weightMg / 1000), label: input.label || null, reason: input.reason || null },
                ipAddress: deps.ipAddress
            });

            return { success: true, lotId, movementId };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message, code: err.code };
        }
        throw err;
    }
}

/**
 * Records a physical-count/breakage/correction movement against a lot.
 * Refused if it would take the lot negative.
 *
 * @param {object} input
 * @param {string} input.lotId
 * @param {number} input.weightDeltaMg non-zero integer milligrams
 * @param {string} [input.reason]
 * @param {object} deps
 * @param {string} deps.actorUserId
 * @param {string} [deps.actorLabel]
 * @param {string} [deps.ipAddress]
 * @returns {{success: true, movementId: string, balanceGrams: number}|{success: false, status: number, error: string, code: string}}
 */
export function adjustLot(input, deps) {
    const context = dataStoreContext();
    const actorUserId = deps.actorUserId || context.ownerUserId;

    if (!Number.isInteger(input.weightDeltaMg) || input.weightDeltaMg === 0) {
        return { success: false, status: 400, error: 'weightDeltaGrams must not round to zero milligrams.', code: DOMAIN_CODE.STOCK_ADJUSTMENT_ZERO };
    }

    try {
        return inTransaction(() => {
            const lot = inventory.getLot(context.tenantId, input.lotId);
            if (!lot) {
                throw new DomainRefusal(400, `No lot ${input.lotId} for this tenant.`, DOMAIN_CODE.STOCK_LOT_NOT_FOUND);
            }
            if (lot.balance_mg + input.weightDeltaMg < 0) {
                throw new DomainRefusal(409,
                    `Adjustment would take the lot negative (current ${round3(lot.balance_mg / 1000)}g, delta ${round3(input.weightDeltaMg / 1000)}g).`,
                    DOMAIN_CODE.STOCK_ADJUSTMENT_NEGATIVE);
            }

            const movementId = inventory.recordAdjustment({
                tenantId: context.tenantId,
                lotId: input.lotId,
                weightDeltaMg: input.weightDeltaMg,
                reason: input.reason || null,
                actorUserId
            });

            const balanceMg = inventory.lotBalanceMg(input.lotId);
            audit.record({
                tenantId: context.tenantId,
                branchId: context.branchId,
                actorUserId,
                actorLabel: deps.actorLabel || 'admin',
                action: 'STOCK_ADJUSTED',
                entityType: 'inventory_lot',
                entityId: input.lotId,
                summary: `Lot adjusted by ${round3(input.weightDeltaMg / 1000)}g to ${round3(balanceMg / 1000)}g`,
                detail: { weightDeltaGrams: round3(input.weightDeltaMg / 1000), balanceGrams: round3(balanceMg / 1000), reason: input.reason || null },
                ipAddress: deps.ipAddress
            });

            return { success: true, movementId, balanceGrams: round3(balanceMg / 1000) };
        });
    } catch (err) {
        if (err instanceof DomainRefusal) {
            return { success: false, status: err.status, error: err.message, code: err.code };
        }
        throw err;
    }
}
