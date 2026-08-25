/** Operational and management reports.  All SQL stays behind the repository seam. */

import { getDb } from './connection.js';

function bounds(fromAt, toAt) {
    const hasFrom = fromAt !== null && fromAt !== undefined && fromAt !== '';
    const hasTo = toAt !== null && toAt !== undefined && toAt !== '';
    return {
        fromAt: hasFrom && Number.isFinite(Number(fromAt)) ? Number(fromAt) : 0,
        toAt: hasTo && Number.isFinite(Number(toAt)) ? Number(toAt) : Number.MAX_SAFE_INTEGER
    };
}

export function settlement({ tenantId, fromAt = null, toAt = null }) {
    const db = getDb();
    const period = { tenantId, ...bounds(fromAt, toAt) };
    const tenders = db.prepare(`
        SELECT t.method,
               SUM(CASE WHEN i.state <> 'cancelled' THEN t.amount_paise ELSE 0 END) AS active_paise,
               SUM(CASE WHEN i.state = 'cancelled' THEN t.amount_paise ELSE 0 END) AS voided_paise,
               COUNT(*) AS entry_count
          FROM tenders t JOIN invoices i ON i.id = t.invoice_id
         WHERE i.tenant_id = @tenantId AND i.issued_at >= @fromAt AND i.issued_at <= @toAt
         GROUP BY t.method ORDER BY t.method
    `).all(period);
    const refunds = db.prepare(`
        SELECT CASE WHEN is_exchange = 1 THEN 'exchange' ELSE refund_mode END AS method,
               SUM(refund_amount_paise) AS amount_paise, COUNT(*) AS entry_count
          FROM credit_notes
         WHERE tenant_id = @tenantId AND issued_at >= @fromAt AND issued_at <= @toAt
         GROUP BY CASE WHEN is_exchange = 1 THEN 'exchange' ELSE refund_mode END
         ORDER BY method
    `).all(period);
    const gateway = db.prepare(`
        SELECT provider, status, COUNT(*) AS entry_count, SUM(amount_paise) AS amount_paise
          FROM payment_orders
         WHERE tenant_id = @tenantId AND created_at >= @fromAt AND created_at <= @toAt
         GROUP BY provider, status ORDER BY provider, status
    `).all(period);

    const activeTenderPaise = tenders.reduce((sum, row) => sum + Number(row.active_paise || 0), 0);
    const counterTenderPaise = tenders
        .filter(row => row.method !== 'advance')
        .reduce((sum, row) => sum + Number(row.active_paise || 0), 0);
    const cashRefundPaise = refunds
        .filter(row => ['cash', 'card', 'upi'].includes(row.method))
        .reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);
    return {
        definition: 'Filed tender totals by capture method; cancelled-invoice tenders are shown separately. Net counter settlement subtracts cash/card/UPI refunds. Customer and exchange credits remain liabilities, not cash payouts.',
        tenders,
        refunds,
        gateway,
        activeTenderPaise,
        counterTenderPaise,
        cashRefundPaise,
        netSettlementPaise: counterTenderPaise - cashRefundPaise
    };
}

export function reconciliation({ tenantId, fromAt = null, toAt = null, limit = 200 }) {
    const db = getDb();
    const period = { tenantId, ...bounds(fromAt, toAt), limit: Math.min(Math.max(Number(limit) || 200, 1), 500) };
    const invoiceIssues = db.prepare(`
        SELECT i.invoice_number, i.state, i.total_amount_paise,
               COALESCE(SUM(CASE WHEN t.method <> 'advance' THEN t.amount_paise ELSE 0 END), 0) AS counter_tender_paise,
               COUNT(t.id) AS tender_count
          FROM invoices i LEFT JOIN tenders t ON t.invoice_id = i.id
         WHERE i.tenant_id = @tenantId AND i.issued_at >= @fromAt AND i.issued_at <= @toAt
         GROUP BY i.id
        HAVING (i.state <> 'cancelled'
                    AND i.total_amount_paise
                        <> COALESCE(SUM(CASE WHEN t.method <> 'advance' THEN t.amount_paise ELSE 0 END), 0))
            OR (i.state = 'cancelled' AND COUNT(t.id) > 0)
         ORDER BY i.issued_at DESC LIMIT @limit
    `).all(period).map(row => ({
        kind: row.state === 'cancelled' ? 'voided_tender' : 'invoice_tender_mismatch',
        ...row,
        difference_paise: Number(row.counter_tender_paise) - Number(row.total_amount_paise)
    }));

    const gatewayIssues = db.prepare(`
        SELECT po.provider, po.provider_order_id, po.provider_payment_id, po.status,
               po.amount_paise, po.advance_entry_id,
               ae.status AS advance_status, ae.amount_paise AS advance_amount_paise
          FROM payment_orders po
          LEFT JOIN advance_entries ae ON ae.id = po.advance_entry_id
         WHERE po.tenant_id = @tenantId AND po.created_at >= @fromAt AND po.created_at <= @toAt
           AND (
                (po.status = 'paid' AND (po.provider_payment_id IS NULL OR po.advance_entry_id IS NULL))
             OR (po.status = 'paid' AND (ae.status <> 'posted' OR ae.amount_paise <> po.amount_paise))
             OR po.status = 'mismatched'
           )
         ORDER BY po.created_at DESC LIMIT @limit
    `).all(period).map(row => ({ kind: 'gateway_advance_mismatch', ...row }));

    return {
        definition: 'Checks active invoice payable totals against non-advance counter tenders, flags tenders retained on voided invoices, and verifies each paid gateway order has one equal posted advance credit.',
        issues: [...invoiceIssues, ...gatewayIssues],
        issueCount: invoiceIssues.length + gatewayIssues.length
    };
}

export function profitability({ tenantId, fromAt = null, toAt = null }) {
    const db = getDb();
    const period = { tenantId, ...bounds(fromAt, toAt) };
    const rows = db.prepare(`
        SELECT i.invoice_number, i.issued_at, il.line_number, il.description, il.purity,
               it.category, il.weight_mg, il.returned_weight_mg,
               il.taxable_amount_paise, il.tax_amount_paise,
               il.inventory_lot_id, l.unit_cost_paise_per_g
          FROM invoice_lines il
          JOIN invoices i ON i.id = il.invoice_id
          LEFT JOIN inventory_items it ON it.id = il.inventory_item_id
          LEFT JOIN inventory_lots l ON l.id = il.inventory_lot_id
         WHERE i.tenant_id = @tenantId AND i.state <> 'cancelled'
           AND i.issued_at >= @fromAt AND i.issued_at <= @toAt
         ORDER BY i.issued_at DESC, il.line_number
    `).all(period).map(row => {
        const netWeightMg = Math.max(0, row.weight_mg - row.returned_weight_mg);
        const revenuePaise = Math.round(row.taxable_amount_paise * netWeightMg / row.weight_mg);
        const costPaise = row.unit_cost_paise_per_g == null
            ? null
            : Math.round(row.unit_cost_paise_per_g * netWeightMg / 1000);
        return {
            invoiceNumber: row.invoice_number,
            issuedAt: row.issued_at,
            lineNumber: row.line_number,
            description: row.description,
            purity: row.purity,
            category: row.category || 'Uncategorised',
            netWeightMg,
            revenuePaise,
            costPaise,
            grossProfitPaise: costPaise == null ? null : revenuePaise - costPaise
        };
    });
    const known = rows.filter(row => row.costPaise != null);
    const revenuePaise = rows.reduce((sum, row) => sum + row.revenuePaise, 0);
    const coveredRevenuePaise = known.reduce((sum, row) => sum + row.revenuePaise, 0);
    const costPaise = known.reduce((sum, row) => sum + row.costPaise, 0);
    return {
        definition: 'Gross contribution = net-of-GST taxable sale value remaining after returns, less the linked lot cost per gram. It excludes overhead, payroll, finance cost, and uncosted/manual billing lines.',
        rows,
        totals: {
            revenuePaise,
            coveredRevenuePaise,
            costPaise,
            grossProfitPaise: coveredRevenuePaise - costPaise,
            costCoveragePercent: revenuePaise > 0 ? Math.round(coveredRevenuePaise * 10000 / revenuePaise) / 100 : 100
        }
    };
}

export function ageing({ tenantId, branchId = null, at = Date.now() }) {
    const db = getDb();
    const rows = db.prepare(`
        SELECT l.id AS lot_id, l.created_at, l.label, l.hallmark_huid,
               l.unit_cost_paise_per_g, i.id AS item_id, i.name, i.sku_code, i.category, i.purity,
               COALESCE(SUM(m.weight_delta_mg), 0) AS balance_mg
          FROM inventory_lots l JOIN inventory_items i ON i.id = l.item_id
          LEFT JOIN (
              SELECT lot_id, weight_delta_mg FROM inventory_movements
              UNION ALL
              SELECT lot_id, weight_delta_mg FROM inventory_document_movements
          ) m ON m.lot_id = l.id
         WHERE l.tenant_id = @tenantId AND (@branchId IS NULL OR l.branch_id = @branchId)
         GROUP BY l.id HAVING COALESCE(SUM(m.weight_delta_mg), 0) > 0
         ORDER BY l.created_at
    `).all({ tenantId, branchId }).map(row => {
        const ageDays = Math.max(0, Math.floor((at - row.created_at) / 86400000));
        const bucket = ageDays <= 30 ? '0–30' : ageDays <= 60 ? '31–60'
            : ageDays <= 90 ? '61–90' : ageDays <= 180 ? '91–180' : '181+';
        return {
            lotId: row.lot_id, itemId: row.item_id, name: row.name,
            skuCode: row.sku_code, category: row.category, purity: row.purity,
            label: row.label, hallmarkHuid: row.hallmark_huid,
            openedAt: row.created_at, ageDays, bucket,
            balanceMg: row.balance_mg,
            costValuePaise: row.unit_cost_paise_per_g == null
                ? null : Math.round(row.unit_cost_paise_per_g * row.balance_mg / 1000)
        };
    });
    const buckets = ['0–30', '31–60', '61–90', '91–180', '181+'].map(bucket => {
        const matching = rows.filter(row => row.bucket === bucket);
        return {
            bucket,
            lotCount: matching.length,
            balanceMg: matching.reduce((sum, row) => sum + row.balanceMg, 0),
            knownCostValuePaise: matching.reduce((sum, row) => sum + Number(row.costValuePaise || 0), 0),
            uncostedLotCount: matching.filter(row => row.costValuePaise == null).length
        };
    });
    return {
        definition: 'Age is calendar days since the lot was opened; only current positive on-hand weight is bucketed. Cost value appears only where the lot has a cost per gram.',
        asOf: at,
        buckets,
        rows
    };
}
