import { adminFetch } from '../app.js';

/**
 * Gold savings schemes — enroll, pay installments, mature or close early.
 *
 * OFF BY DEFAULT (settings.goldSchemeEnabled). The nav button
 * (#gold-schemes-nav-btn) starts hidden in index.html; `refresh()` calls
 * `checkEnabled()` first and shows the button only once the server confirms
 * the module is on, matching the "never existed until turned on" contract
 * every other flagged module in this build follows. If a request lands here
 * while the module is off, the routes answer 404 and the desk shows that
 * plainly rather than a blank table.
 *
 * PLACEHOLDER TERMS. The installment count, bonus and penalty shown per
 * enrollment are whatever Settings held the moment that customer enrolled —
 * see backend/services/goldSchemeService.js's own header note.
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function money(value) {
    return `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABEL = {
    active: 'Active', matured: 'Matured', closed_early: 'Closed Early', defaulted: 'Defaulted'
};

export class SchemeDesk {
    constructor() {
        this.enabled = false;
        this.enrollments = [];
        this.expandedId = null;
        this.installmentsById = new Map();
        this.render();
    }

    render() {
        const container = document.querySelector('#gold-schemes-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div id="scheme-disabled-notice" style="display:none;" class="text-muted-small">
                Gold savings schemes are not enabled for this store. Turn them on under
                Settings → Wastage/Tax section to use this desk.
            </div>
            <div id="scheme-desk-body" style="display:none;">
                <div class="advances-toolbar">
                    <button type="button" id="scheme-refresh-btn" class="btn btn-secondary">Refresh</button>
                    <button type="button" id="scheme-new-enrollment-btn" class="btn btn-primary">+ New Enrollment</button>
                </div>

                <div id="new-enrollment-form" class="new-deposit-form" style="display:none;">
                    <div class="form-group-row">
                        <div class="form-group">
                            <label for="scheme-enroll-phone">Customer Phone (10-digit)</label>
                            <input type="tel" id="scheme-enroll-phone" class="form-control" maxlength="10">
                        </div>
                        <div class="form-group">
                            <label for="scheme-enroll-name">Customer Name</label>
                            <input type="text" id="scheme-enroll-name" class="form-control" placeholder="Optional">
                        </div>
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button type="button" id="scheme-submit-enroll-btn" class="btn btn-primary">Enroll</button>
                        <button type="button" id="scheme-cancel-enroll-btn" class="btn btn-secondary">Cancel</button>
                    </div>
                    <p id="scheme-enroll-result" class="text-muted-small"></p>
                </div>

                <table class="advances-table">
                    <thead>
                        <tr>
                            <th>Customer</th>
                            <th>Terms</th>
                            <th class="text-right">Paid</th>
                            <th>Status</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody id="scheme-table-body"></tbody>
                </table>
            </div>
        `;

        document.getElementById('scheme-refresh-btn').addEventListener('click', () => this.refresh());
        document.getElementById('scheme-new-enrollment-btn').addEventListener('click', () => {
            document.getElementById('new-enrollment-form').style.display = 'block';
        });
        document.getElementById('scheme-cancel-enroll-btn').addEventListener('click', () => {
            document.getElementById('new-enrollment-form').style.display = 'none';
        });
        document.getElementById('scheme-submit-enroll-btn').addEventListener('click', () => this.submitEnroll());
    }

    /** Confirms the module is on before showing anything, and toggles the nav button to match. */
    async checkEnabled() {
        try {
            const res = await adminFetch('/api/gold-schemes/enrollments?status=active');
            this.enabled = res.status !== 404;
        } catch {
            this.enabled = false;
        }
        const navBtn = document.getElementById('gold-schemes-nav-btn');
        if (navBtn) navBtn.style.display = this.enabled ? 'block' : 'none';
        const notice = document.getElementById('scheme-disabled-notice');
        const body = document.getElementById('scheme-desk-body');
        if (notice) notice.style.display = this.enabled ? 'none' : 'block';
        if (body) body.style.display = this.enabled ? 'block' : 'none';
        return this.enabled;
    }

    async refresh() {
        if (!(await this.checkEnabled())) return;
        try {
            const res = await adminFetch('/api/gold-schemes/enrollments');
            if (!res.ok) return;
            const data = await res.json();
            this.enrollments = data.results || [];
            this.renderTable();
        } catch (err) {
            console.error('Failed to load gold scheme enrollments:', err);
        }
    }

    renderTable() {
        const body = document.getElementById('scheme-table-body');
        if (!body) return;
        if (this.enrollments.length === 0) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center; font-style:italic; opacity:0.6;">No enrollments yet</td></tr>';
            return;
        }
        body.innerHTML = this.enrollments.map(e => this.renderRow(e)).join('');
        this.enrollments.forEach(e => {
            const payBtn = document.getElementById(`scheme-pay-btn-${e.id}`);
            if (payBtn) payBtn.addEventListener('click', () => this.payInstallment(e.id));
            const matureBtn = document.getElementById(`scheme-mature-btn-${e.id}`);
            if (matureBtn) matureBtn.addEventListener('click', () => this.settle(e.id, 'mature'));
            const closeBtn = document.getElementById(`scheme-close-btn-${e.id}`);
            if (closeBtn) closeBtn.addEventListener('click', () => this.settle(e.id, 'close-early'));
            const defaultBtn = document.getElementById(`scheme-default-btn-${e.id}`);
            if (defaultBtn) defaultBtn.addEventListener('click', () => this.markDefaulted(e.id));
        });
    }

    renderRow(e) {
        const active = e.status === 'active';
        return `
            <tr>
                <td>${escapeHtml(e.customerName || 'Customer')} — ${escapeHtml(e.customerPhone || '')}</td>
                <td>${e.installmentCount} installments, ${e.bonusInstallments} bonus</td>
                <td class="text-right">${e.installmentsPaid ?? '—'}</td>
                <td>${STATUS_LABEL[e.status] || e.status}</td>
                <td>
                    ${active ? `
                        <input type="number" id="scheme-amount-${e.id}" class="form-control" placeholder="₹" style="width:90px; display:inline-block;" min="1">
                        <button type="button" id="scheme-pay-btn-${e.id}" class="btn btn-secondary btn-small">Pay</button>
                        <button type="button" id="scheme-mature-btn-${e.id}" class="btn btn-secondary btn-small">Mature</button>
                        <button type="button" id="scheme-close-btn-${e.id}" class="btn btn-secondary btn-small">Close Early</button>
                        <button type="button" id="scheme-default-btn-${e.id}" class="btn btn-secondary btn-small">Mark Defaulted</button>
                    ` : (e.advanceEntryId ? `<span class="text-muted-small">Credited to advance balance</span>` : '')}
                </td>
            </tr>
        `;
    }

    async submitEnroll() {
        const resultEl = document.getElementById('scheme-enroll-result');
        const phone = document.getElementById('scheme-enroll-phone').value.trim();
        if (!/^\d{10}$/.test(phone)) {
            if (resultEl) resultEl.textContent = 'Enter a valid 10-digit phone number.';
            return;
        }
        try {
            const res = await adminFetch('/api/gold-schemes/enrollments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerPhone: phone,
                    customerName: document.getElementById('scheme-enroll-name').value.trim()
                })
            });
            const data = await res.json();
            if (!res.ok) {
                if (resultEl) resultEl.textContent = data.error || 'Could not enroll this customer.';
                return;
            }
            document.getElementById('new-enrollment-form').style.display = 'none';
            document.getElementById('scheme-enroll-phone').value = '';
            document.getElementById('scheme-enroll-name').value = '';
            if (resultEl) resultEl.textContent = '';
            await this.refresh();
        } catch (err) {
            console.error('Failed to enroll:', err);
            if (resultEl) resultEl.textContent = 'Could not enroll — check your connection and try again.';
        }
    }

    async payInstallment(enrollmentId) {
        const input = document.getElementById(`scheme-amount-${enrollmentId}`);
        const amount = parseFloat(input && input.value);
        if (!Number.isFinite(amount) || amount <= 0) {
            alert('Enter a positive installment amount first.');
            return;
        }
        try {
            const res = await adminFetch(`/api/gold-schemes/enrollments/${enrollmentId}/installments`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, paymentMethod: 'cash' })
            });
            const data = await res.json();
            if (!res.ok) { alert(data.error || 'Could not record this installment.'); return; }
            await this.refresh();
        } catch (err) {
            console.error('Failed to record installment:', err);
            alert('Could not record this installment — check your connection and try again.');
        }
    }

    async settle(enrollmentId, action) {
        if (!confirm(action === 'mature'
            ? 'Mature this enrollment and credit its payout to the customer\'s advance balance?'
            : 'Close this enrollment early? The bonus is forfeited and the early-closure penalty applies.')) {
            return;
        }
        try {
            const res = await adminFetch(`/api/gold-schemes/enrollments/${enrollmentId}/${action}`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { alert(data.error || 'Could not settle this enrollment.'); return; }
            alert(`Credited ${money(data.payout.payoutAmount)} to the customer's advance balance.`);
            await this.refresh();
        } catch (err) {
            console.error('Failed to settle enrollment:', err);
            alert('Could not settle this enrollment — check your connection and try again.');
        }
    }

    async markDefaulted(enrollmentId) {
        if (!confirm('Mark this enrollment defaulted? This only records a status — it does not move any money.')) return;
        try {
            const res = await adminFetch(`/api/gold-schemes/enrollments/${enrollmentId}/default`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) { alert(data.error || 'Could not mark this enrollment defaulted.'); return; }
            await this.refresh();
        } catch (err) {
            console.error('Failed to mark enrollment defaulted:', err);
            alert('Could not mark this enrollment defaulted — check your connection and try again.');
        }
    }
}
