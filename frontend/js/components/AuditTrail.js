import { adminFetch, logTelemetry } from '../app.js';

/**
 * Escapes HTML-significant characters. Audit rows carry operator names and
 * free-text summaries that originate from settings and from customer-supplied
 * fields, so every one of them is attacker-controlled text arriving into the
 * authenticated admin session — the same reasoning as CustomerAccountsManager's
 * copy of this helper.
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function formatWhen(ts) {
    return ts ? new Date(ts).toLocaleString() : '—';
}

/**
 * The audit trail — who did what, and when.
 *
 * The `audit_events` table has been append-only since Phase 24 (two triggers
 * abort any UPDATE or DELETE) and written on every money path since Phase 29,
 * but nothing displayed it until now. That gap was the point: a control nobody
 * can inspect is not a control, and the roadmap's insider-fraud strand named
 * the missing read path by name.
 *
 * APPROVER-ONLY, matching GET /api/audit. A cashier reaching this tab gets the
 * server's 403 rendered as an explanation rather than an empty table, because
 * "you are not allowed to see this" and "nothing has happened" must not look
 * the same.
 */
export class AuditTrail {
    constructor() {
        this.events = [];
        this.total = 0;
        this.truncated = false;
        this.deniedReason = null;
        this.render();
    }

    render() {
        const container = document.querySelector('#audit-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:70ch;">
                Every sale, refund, advance redemption, counter deposit and deposit approval, in the
                order it happened. This record is <strong>append-only</strong> — the database itself
                refuses to change or delete a row once written, so what is here is what occurred.
            </p>

            <div class="advances-toolbar">
                <input type="text" id="audit-search" class="form-control" placeholder="Filter by action, who, or reference...">
                <select id="audit-entity" class="form-control" style="max-width:190px;">
                    <option value="">All record types</option>
                    <option value="invoice">Invoices</option>
                    <option value="credit_note">Credit notes</option>
                    <option value="advance">Advances</option>
                    <option value="payment">Payments</option>
                </select>
                <input type="date" id="audit-from" class="form-control" style="max-width:170px;" title="From date">
                <input type="date" id="audit-to" class="form-control" style="max-width:170px;" title="To date">
                <button type="button" id="audit-refresh-btn" class="btn btn-secondary">Refresh</button>
            </div>

            <div id="audit-summary" style="font-size:12px; color:var(--color-text-muted); margin-bottom:10px;"></div>

            <table class="advances-table">
                <thead>
                    <tr>
                        <th>When</th>
                        <th>Who</th>
                        <th>Action</th>
                        <th>Record</th>
                        <th>Detail</th>
                    </tr>
                </thead>
                <tbody id="audit-table-body"></tbody>
            </table>
        `;

        document.getElementById('audit-refresh-btn').addEventListener('click', () => this.refresh());
        document.getElementById('audit-search').addEventListener('input', () => this.renderTable());
        // A server-side filter, so changing it refetches rather than hiding rows
        // the page never received.
        ['audit-entity', 'audit-from', 'audit-to'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => this.refresh());
        });
    }

    async refresh() {
        const params = new URLSearchParams();
        const entityType = document.getElementById('audit-entity')?.value || '';
        const from = document.getElementById('audit-from')?.value || '';
        const to = document.getElementById('audit-to')?.value || '';
        if (entityType) params.set('entityType', entityType);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        params.set('limit', '200');

        try {
            const res = await adminFetch(`/api/audit?${params.toString()}`);

            /* A refusal is not an empty trail. Rendering the 403 as "no events"
               would tell a cashier the store had done nothing all day. */
            if (res.status === 403) {
                const body = await res.json().catch(() => ({}));
                this.deniedReason = body.message || 'Viewing the audit trail needs a manager or the owner.';
                this.events = [];
                this.renderTable();
                return;
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const body = await res.json();
            this.deniedReason = null;
            this.events = body.results || [];
            this.total = body.total || 0;
            this.truncated = Boolean(body.truncated);
            this.renderTable();
            logTelemetry(`Audit trail refreshed (${this.events.length} of ${this.total}).`);
        } catch (err) {
            console.error('Failed to load the audit trail:', err);
            this.deniedReason = null;
            this.events = [];
            this.renderTable('The audit trail could not be loaded. Check the server is reachable and try Refresh.');
        }
    }

    /** A money action reads as a sentence, not as a constant. */
    describeAction(action) {
        return String(action || '')
            .replace(/[._]/g, ' ')
            .replace(/\b\w/g, ch => ch.toUpperCase());
    }

    renderTable(errorMessage = null) {
        const tbody = document.getElementById('audit-table-body');
        const summary = document.getElementById('audit-summary');
        if (!tbody) return;

        if (summary) {
            summary.textContent = this.deniedReason || errorMessage
                ? ''
                : this.truncated
                    ? `Showing the ${this.events.length} most recent of ${this.total} events. Narrow the dates to see further back.`
                    : `${this.total} event${this.total === 1 ? '' : 's'}.`;
        }

        if (this.deniedReason) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--color-warning);">${escapeHtml(this.deniedReason)}</td></tr>`;
            return;
        }

        if (errorMessage) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--color-danger);">${escapeHtml(errorMessage)}</td></tr>`;
            return;
        }

        const query = (document.getElementById('audit-search')?.value || '').trim().toLowerCase();
        let rows = this.events;
        if (query) {
            rows = rows.filter(e =>
                (e.action || '').toLowerCase().includes(query) ||
                (e.actorLabel || '').toLowerCase().includes(query) ||
                (e.summary || '').toLowerCase().includes(query) ||
                (e.entityId || '').toLowerCase().includes(query)
            );
        }

        if (rows.length === 0) {
            const message = this.events.length === 0
                ? 'Nothing has been recorded for this period yet.'
                : 'No event matches that filter.';
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--color-text-light); font-style:italic;">${message}</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(e => `
            <tr>
                <td style="white-space:nowrap;">${formatWhen(e.occurredAt)}</td>
                <td>${escapeHtml(e.actorLabel || 'system')}</td>
                <td>${escapeHtml(this.describeAction(e.action))}</td>
                <td style="font-family:monospace; font-size:12px;">${escapeHtml(e.entityId || '—')}</td>
                <td style="color:var(--color-text-muted);">${escapeHtml(e.summary || '—')}</td>
            </tr>
        `).join('');
    }
}
