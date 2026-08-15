/**
 * ==========================================================================
 * Document numbering.
 *
 * This module exists to kill one specific bug. In the JSON ledger the next
 * invoice number was read out of settings.json, incremented in JavaScript and
 * written back — a read-modify-write that loses an update whenever the write
 * silently fails or two requests interleave, and which really did hand two
 * customers the same invoice number (see the comment on writeJSON in db.js).
 *
 * Here, allocation is a single `UPDATE ... RETURNING` executed inside the
 * sale's own transaction. Two concurrent sales serialise on the row lock: the
 * second one waits, then reads the value the first one already committed. And
 * because it is the same transaction that writes the invoice, a sale that
 * fails after allocation rolls the number back rather than burning it.
 *
 * The `uq_invoices_sequence` index is the belt to this braces — even if a
 * future caller allocated outside a transaction, the insert would fail rather
 * than duplicate.
 * ==========================================================================
 */

import { inTransactionNow } from './connection.js';
import { getDb } from './connection.js';

const DOCUMENT_TYPES = new Set(['invoice', 'credit_note']);

/**
 * Reserves the next number for a document type in a financial year.
 *
 * @param {{tenantId: string, branchId: string, documentType: 'invoice'|'credit_note',
 *          financialYear: string, prefix?: string, startAt?: number}} spec
 * @returns {{sequenceValue: number, prefix: string}}
 */
export function allocate({ tenantId, branchId, documentType, financialYear, prefix = '', startAt = 1 }) {
    if (!DOCUMENT_TYPES.has(documentType)) {
        throw new Error(`Unknown document type "${documentType}"`);
    }
    if (!inTransactionNow()) {
        // Asserted rather than trusted: allocating outside a transaction is the
        // exact shape of the bug this module replaces, and it must fail in a
        // test rather than survive to production and burn a number on a sale
        // that then rolls back.
        throw new Error('allocate() must run inside inTransaction() so the number is committed with its document.');
    }

    const db = getDb();
    const first = Math.max(1, Math.trunc(Number(startAt) || 1));

    db.prepare(`
        INSERT INTO document_sequences (tenant_id, branch_id, document_type, financial_year, prefix, next_value)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, branch_id, document_type, financial_year) DO NOTHING
    `).run(tenantId, branchId, documentType, financialYear, prefix, first);

    // RETURNING on an UPDATE yields the POST-update row, so the number this
    // caller owns is one below the new next_value.
    const row = db.prepare(`
        UPDATE document_sequences
           SET next_value = next_value + 1
         WHERE tenant_id = ? AND branch_id = ? AND document_type = ? AND financial_year = ?
        RETURNING next_value, prefix
    `).get(tenantId, branchId, documentType, financialYear);

    if (!row) {
        throw new Error(`No ${documentType} sequence for ${financialYear} could be allocated.`);
    }
    return { sequenceValue: row.next_value - 1, prefix: row.prefix };
}

/**
 * Where a sequence currently stands, without consuming a number.
 * Returns null when nothing has ever been allocated for that year.
 */
export function peek({ tenantId, branchId, documentType, financialYear }) {
    return getDb().prepare(`
        SELECT * FROM document_sequences
         WHERE tenant_id = ? AND branch_id = ? AND document_type = ? AND financial_year = ?
    `).get(tenantId, branchId, documentType, financialYear) || null;
}

/**
 * Sets where a sequence resumes, in EITHER direction.
 *
 * This is what makes `invoiceSeqStart` in Settings still mean something after
 * the cutover. That key seeds a financial year's first allocation, but a store
 * that wants its numbering to jump — a new GST registration, a move from a
 * previous system, correcting a misconfigured series — edits it mid-year, and
 * before the ledger moved to SQL that edit took effect on the very next sale.
 * Without this the setting would save, report success, and silently do nothing.
 *
 * LOWERING IS ALLOWED HERE AND GUARDED ABOVE. Moving a sequence backwards can
 * reissue a number a customer already holds, so `POST /api/settings` refuses it
 * without `confirmDestructive`. That check belongs at the boundary, where the
 * operator can be asked; `uq_invoices_number` remains the backstop that turns a
 * genuine collision into a failed insert rather than a duplicate document.
 */
export function setNextValue({ tenantId, branchId, documentType, financialYear, prefix = '', nextValue }) {
    if (!inTransactionNow()) {
        throw new Error('setNextValue() must run inside inTransaction().');
    }
    const value = Math.trunc(Number(nextValue) || 0);
    if (value < 1) throw new Error('setNextValue() needs a positive sequence value.');

    getDb().prepare(`
        INSERT INTO document_sequences (tenant_id, branch_id, document_type, financial_year, prefix, next_value)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, branch_id, document_type, financial_year)
        DO UPDATE SET next_value = excluded.next_value, prefix = excluded.prefix
    `).run(tenantId, branchId, documentType, financialYear, prefix, value);
}

/**
 * Raises the floor of a sequence without ever lowering it — the importer's
 * entry point, so that after history is imported the next live invoice
 * continues past the highest imported number instead of colliding with it.
 */
export function reserveUpTo({ tenantId, branchId, documentType, financialYear, prefix = '', throughValue }) {
    if (!inTransactionNow()) {
        throw new Error('reserveUpTo() must run inside inTransaction().');
    }
    const nextValue = Math.trunc(Number(throughValue) || 0) + 1;
    if (nextValue < 1) throw new Error('reserveUpTo() needs a positive sequence value.');

    const db = getDb();
    db.prepare(`
        INSERT INTO document_sequences (tenant_id, branch_id, document_type, financial_year, prefix, next_value)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, branch_id, document_type, financial_year)
        DO UPDATE SET next_value = MAX(next_value, excluded.next_value)
    `).run(tenantId, branchId, documentType, financialYear, prefix, nextValue);
}
