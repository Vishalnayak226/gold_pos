/**
 * Stable, machine-readable outcomes at POS domain boundaries.
 *
 * These values are part of API contract generation 1. Add a value; do not
 * rename or reuse one for a different business fact. A route may choose an
 * HTTP status and operator message, but it may not manufacture a financial,
 * stock or authorization outcome that the owning service has not declared.
 */
export const DOMAIN_CODE = Object.freeze({
    APPROVER_REQUIRED: 'APPROVER_REQUIRED',
    MFA_REQUIRED: 'MFA_REQUIRED',
    INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
    INVOICE_NUMBER_REQUIRED: 'INVOICE_NUMBER_REQUIRED',
    INVOICE_NOT_FOUND: 'INVOICE_NOT_FOUND',
    VOID_REASON_INVALID: 'VOID_REASON_INVALID',
    VOID_NOT_ALLOWED: 'VOID_NOT_ALLOWED',
    VOID_DATE_RESTRICTED: 'VOID_DATE_RESTRICTED',
    VOID_AFTER_RETURN: 'VOID_AFTER_RETURN',
    ADVANCE_REVERSAL_UNAVAILABLE: 'ADVANCE_REVERSAL_UNAVAILABLE',
    VOID_ALREADY_PROCESSED: 'VOID_ALREADY_PROCESSED'
});

const KNOWN_CODES = new Set(Object.values(DOMAIN_CODE));

/** A defensive guard for legacy callbacks that historically used `error` as a code. */
export function isDomainCode(value) {
    return typeof value === 'string' && KNOWN_CODES.has(value);
}
