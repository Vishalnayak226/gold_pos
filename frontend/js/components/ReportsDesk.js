import { adminFetch, logTelemetry } from '../app.js';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function moneyPaise(value) {
    return `₹${(Number(value || 0) / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    })}`;
}

function gramsMg(value) {
    return `${(Number(value || 0) / 1000).toFixed(3)} g`;
}

export class ReportsDesk {
    constructor() {
        this.render();
        this.wire();
    }

    render() {
        const host = document.querySelector('#reports-tab .panel-body');
        if (!host) return;
        const now = new Date();
        const first = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        const today = now.toISOString().slice(0, 10);
        host.innerHTML = `
            <div class="advances-toolbar">
                <select id="management-report-kind" class="form-control">
                    <option value="settlement">Settlement</option>
                    <option value="reconciliation">Reconciliation exceptions</option>
                    <option value="profitability">Gross profitability</option>
                    <option value="ageing">Inventory ageing</option>
                </select>
                <input type="date" id="management-report-from" class="form-control" value="${first}">
                <input type="date" id="management-report-to" class="form-control" value="${today}">
                <button type="button" id="management-report-run" class="btn btn-primary">Run report</button>
            </div>
            <div id="management-report-output" style="margin-top:18px;">
                <p class="text-muted-small">Choose a report and run it. Each result states the definition used.</p>
            </div>`;
    }

    wire() {
        document.getElementById('management-report-run')?.addEventListener('click', () => this.refresh());
        document.getElementById('management-report-kind')?.addEventListener('change', event => {
            const dates = event.target.value !== 'ageing';
            document.getElementById('management-report-from').disabled = !dates;
            document.getElementById('management-report-to').disabled = !dates;
        });
    }

    async refresh() {
        const kind = document.getElementById('management-report-kind')?.value || 'settlement';
        const from = document.getElementById('management-report-from')?.value || '';
        const to = document.getElementById('management-report-to')?.value || '';
        const output = document.getElementById('management-report-output');
        if (!output) return;
        output.innerHTML = '<p class="text-muted-small">Building report…</p>';
        try {
            const query = kind === 'ageing' ? '' : `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
            const res = await adminFetch(`/api/reports/${kind}${query}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Report failed.');
            output.innerHTML = `<p class="text-muted-small" style="max-width:95ch;">${escapeHtml(data.definition)}</p>${this.renderData(kind, data)}`;
            logTelemetry(`Ran ${kind} management report.`);
        } catch (err) {
            output.innerHTML = `<p class="text-muted-small" style="color:var(--color-danger);">${escapeHtml(err.message)}</p>`;
        }
    }

    renderData(kind, data) {
        if (kind === 'settlement') return this.renderSettlement(data);
        if (kind === 'reconciliation') return this.renderReconciliation(data);
        if (kind === 'profitability') return this.renderProfitability(data);
        return this.renderAgeing(data);
    }

    renderSettlement(data) {
        const tenderRows = (data.tenders || []).map(row => `
            <tr><td>${escapeHtml(row.method)}</td><td class="text-right">${moneyPaise(row.active_paise)}</td>
            <td class="text-right">${moneyPaise(row.voided_paise)}</td><td class="text-right">${row.entry_count}</td></tr>`).join('');
        const refundRows = (data.refunds || []).map(row => `
            <tr><td>${escapeHtml(row.method)}</td><td class="text-right">-${moneyPaise(row.amount_paise)}</td>
            <td class="text-right">${row.entry_count}</td></tr>`).join('');
        return `
            <div class="dashboard-grid" style="margin:14px 0;">
                <div class="stat-card"><span>Counter tenders</span><strong>${moneyPaise(data.counterTenderPaise)}</strong></div>
                <div class="stat-card"><span>Cash-like refunds</span><strong>${moneyPaise(data.cashRefundPaise)}</strong></div>
                <div class="stat-card"><span>Net settlement</span><strong>${moneyPaise(data.netSettlementPaise)}</strong></div>
            </div>
            <h3>Tenders</h3><table class="advances-table"><thead><tr><th>Method</th><th class="text-right">Active</th><th class="text-right">On voids</th><th class="text-right">Entries</th></tr></thead><tbody>${tenderRows || '<tr><td colspan="4">No tenders.</td></tr>'}</tbody></table>
            <h3 style="margin-top:20px;">Refunds / credits</h3><table class="advances-table"><thead><tr><th>Mode</th><th class="text-right">Amount</th><th class="text-right">Entries</th></tr></thead><tbody>${refundRows || '<tr><td colspan="3">No refunds.</td></tr>'}</tbody></table>`;
    }

    renderReconciliation(data) {
        const rows = (data.issues || []).map(row => `
            <tr><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.invoice_number || row.provider_order_id || '—')}</td>
            <td>${escapeHtml(row.state || row.status || '—')}</td><td class="text-right">${row.difference_paise == null ? '—' : moneyPaise(row.difference_paise)}</td></tr>`).join('');
        return `<h3 style="margin-top:16px;">${data.issueCount || 0} exception(s)</h3>
            <table class="advances-table"><thead><tr><th>Exception</th><th>Document</th><th>Status</th><th class="text-right">Difference</th></tr></thead><tbody>${rows || '<tr><td colspan="4" style="color:var(--color-success);">No reconciliation exceptions in this period.</td></tr>'}</tbody></table>`;
    }

    renderProfitability(data) {
        const totals = data.totals || {};
        const rows = (data.rows || []).map(row => `
            <tr><td>${escapeHtml(row.invoiceNumber)}</td><td>${escapeHtml(row.description || row.purity)}</td>
            <td class="text-right">${gramsMg(row.netWeightMg)}</td><td class="text-right">${moneyPaise(row.revenuePaise)}</td>
            <td class="text-right">${row.costPaise == null ? 'Uncosted' : moneyPaise(row.costPaise)}</td>
            <td class="text-right">${row.grossProfitPaise == null ? '—' : moneyPaise(row.grossProfitPaise)}</td></tr>`).join('');
        return `<div class="dashboard-grid" style="margin:14px 0;">
                <div class="stat-card"><span>Net revenue</span><strong>${moneyPaise(totals.revenuePaise)}</strong></div>
                <div class="stat-card"><span>Cost coverage</span><strong>${Number(totals.costCoveragePercent || 0).toFixed(2)}%</strong></div>
                <div class="stat-card"><span>Gross contribution (covered)</span><strong>${moneyPaise(totals.grossProfitPaise)}</strong></div>
            </div><table class="advances-table"><thead><tr><th>Invoice</th><th>Line</th><th class="text-right">Net weight</th><th class="text-right">Revenue</th><th class="text-right">Lot cost</th><th class="text-right">Contribution</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No sales.</td></tr>'}</tbody></table>`;
    }

    renderAgeing(data) {
        const rows = (data.buckets || []).map(row => `
            <tr><td>${escapeHtml(row.bucket)} days</td><td class="text-right">${row.lotCount}</td>
            <td class="text-right">${gramsMg(row.balanceMg)}</td><td class="text-right">${moneyPaise(row.knownCostValuePaise)}</td>
            <td class="text-right">${row.uncostedLotCount}</td></tr>`).join('');
        return `<table class="advances-table" style="margin-top:16px;"><thead><tr><th>Age</th><th class="text-right">Lots</th><th class="text-right">On hand</th><th class="text-right">Known cost value</th><th class="text-right">Uncosted lots</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
}
