import { adminFetch, logTelemetry } from '../app.js';

/** Escapes HTML-significant characters — customer names/notes are staff-typed free text. */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function formatWhen(ts) {
    return ts ? new Date(ts).toLocaleString() : '—';
}

function cartWeightGrams(cart) {
    return (cart || []).reduce((sum, line) => sum + (Number(line.weightGrams) || 0), 0);
}

/**
 * Quotes & holds (roadmap Phase 5.3) — carts saved without becoming a sale.
 * A quote is a price estimate shown to a customer; a hold parks an
 * in-progress cart so the counter is free for the next person. Resuming
 * either one loads it back into the Billing Desk's active cart — this
 * screen never prices or files anything itself.
 */
export class QuotesHoldsManager {
    constructor() {
        this.drafts = [];
        this.render();
    }

    render() {
        const container = document.querySelector('#quotes-holds-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:70ch;">
                Saved from the Billing Desk's HOLD/QUOTE buttons. Resuming one loads its cart back
                into the Billing Desk, priced fresh through the ordinary billing flow — nothing here
                is a sale until it is completed from there.
            </p>

            <div class="advances-toolbar">
                <select id="drafts-kind-filter" class="form-control" style="max-width:160px;">
                    <option value="">Quotes & Holds</option>
                    <option value="hold">Holds only</option>
                    <option value="quote">Quotes only</option>
                </select>
                <button type="button" id="drafts-refresh-btn" class="btn btn-secondary">Refresh</button>
            </div>

            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Kind</th>
                        <th>Customer</th>
                        <th class="text-right">Weight</th>
                        <th>Saved</th>
                        <th>Note</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="drafts-table-body"></tbody>
            </table>
        `;

        document.getElementById('drafts-refresh-btn').addEventListener('click', () => this.refresh());
        document.getElementById('drafts-kind-filter').addEventListener('change', () => this.refresh());
    }

    async refresh() {
        try {
            const kind = document.getElementById('drafts-kind-filter')?.value || '';
            const params = new URLSearchParams({ status: 'open' });
            if (kind) params.set('kind', kind);

            const res = await adminFetch(`/api/sale-drafts?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            this.drafts = await res.json();
            this.renderTable();
            logTelemetry(`Quotes & holds refreshed (${this.drafts.length}).`);
        } catch (err) {
            console.error('Failed to load quotes/holds:', err);
            const tbody = document.getElementById('drafts-table-body');
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--color-danger);">Could not load quotes/holds. Check the server is reachable and try Refresh.</td></tr>`;
        }
    }

    renderTable() {
        const tbody = document.getElementById('drafts-table-body');
        if (!tbody) return;

        if (this.drafts.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--color-text-light); font-style:italic;">Nothing saved yet — use HOLD or QUOTE on the Billing Desk.</td></tr>`;
            return;
        }

        tbody.innerHTML = this.drafts.map(d => `
            <tr>
                <td>${d.kind === 'quote' ? 'Quote' : 'Hold'}</td>
                <td>${escapeHtml(d.customerName || 'Walk-in')}${d.customerPhone ? ` (${escapeHtml(d.customerPhone)})` : ''}</td>
                <td class="text-right">${cartWeightGrams(d.cart).toFixed(2)} g</td>
                <td style="white-space:nowrap;">${formatWhen(d.createdAt)}</td>
                <td style="color:var(--color-text-muted);">${escapeHtml(d.note || '—')}</td>
                <td style="white-space:nowrap;">
                    <button type="button" class="btn btn-primary btn-sm resume-draft-btn" data-id="${escapeHtml(d.id)}">Resume</button>
                    <button type="button" class="btn btn-secondary btn-sm discard-draft-btn" data-id="${escapeHtml(d.id)}">Discard</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.resume-draft-btn').forEach(btn => {
            btn.addEventListener('click', () => this.resume(btn.getAttribute('data-id')));
        });
        tbody.querySelectorAll('.discard-draft-btn').forEach(btn => {
            btn.addEventListener('click', () => this.discard(btn.getAttribute('data-id')));
        });
    }

    async resume(draftId) {
        try {
            const res = await adminFetch(`/api/sale-drafts/${encodeURIComponent(draftId)}/resume`, { method: 'POST' });
            const body = await res.json();
            if (!res.ok) {
                alert(body.message || body.error || 'Failed to resume this quote/hold.');
                return;
            }
            if (window.billingDesk) window.billingDesk.loadDraftCart(body.draft);
            document.querySelector('.nav-btn[data-target="sales-tab"]')?.click();
            await this.refresh();
        } catch (err) {
            alert('Could not reach the server.');
        }
    }

    async discard(draftId) {
        if (!confirm('Discard this quote/hold? This cannot be undone.')) return;
        try {
            const res = await adminFetch(`/api/sale-drafts/${encodeURIComponent(draftId)}/discard`, { method: 'POST' });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                alert(body.message || body.error || 'Failed to discard.');
                return;
            }
            await this.refresh();
        } catch (err) {
            alert('Could not reach the server.');
        }
    }
}
