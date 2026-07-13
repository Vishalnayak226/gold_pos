import { adminFetch, logTelemetry } from '../app.js';

/**
 * Advances report/browse module — the missing counterpart to the redemption
 * flow already built into BillingDesk. Lists every customer with an advance
 * balance, supports search, a full per-customer ledger drill-down, and a
 * manual deposit entry form for cash/counter deposits.
 */
export class AdvancesManager {
    constructor() {
        this.advances = [];
        this.expandedPhone = null;
        this.render();
    }

    render() {
        const container = document.querySelector('#advances-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div class="advances-toolbar">
                <input type="text" id="advances-search" class="form-control" placeholder="Search by phone or name...">
                <button type="button" id="advances-refresh-btn" class="btn btn-secondary">Refresh</button>
                <button type="button" id="advances-new-deposit-btn" class="btn btn-primary">+ New Deposit</button>
            </div>

            <div id="new-deposit-form" class="new-deposit-form" style="display:none;">
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="deposit-phone">Customer Phone (10-digit)</label>
                        <input type="tel" id="deposit-phone" class="form-control" maxlength="10">
                    </div>
                    <div class="form-group">
                        <label for="deposit-name">Customer Name</label>
                        <input type="text" id="deposit-name" class="form-control" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="deposit-amount">Amount (₹)</label>
                        <input type="number" id="deposit-amount" class="form-control" min="0" step="1">
                    </div>
                    <div class="form-group">
                        <label for="deposit-method">Method</label>
                        <select id="deposit-method" class="form-control">
                            <option value="Cash">Cash</option>
                            <option value="UPI">UPI</option>
                            <option value="Bank Transfer">Bank Transfer</option>
                        </select>
                    </div>
                </div>
                <div style="display:flex; gap:10px;">
                    <button type="button" id="submit-deposit-btn" class="btn btn-primary">Save Deposit</button>
                    <button type="button" id="cancel-deposit-btn" class="btn btn-secondary">Cancel</button>
                </div>
            </div>

            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Phone Number</th>
                        <th>Customer Name</th>
                        <th class="text-right">Balance</th>
                        <th>Last Activity</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="advances-table-body"></tbody>
            </table>
        `;

        document.getElementById('advances-refresh-btn').addEventListener('click', () => this.refresh());
        document.getElementById('advances-search').addEventListener('input', () => this.renderTable());
        document.getElementById('advances-new-deposit-btn').addEventListener('click', () => {
            const form = document.getElementById('new-deposit-form');
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('cancel-deposit-btn').addEventListener('click', () => {
            document.getElementById('new-deposit-form').style.display = 'none';
        });
        document.getElementById('submit-deposit-btn').addEventListener('click', () => this.submitManualDeposit());
    }

    async refresh() {
        try {
            const res = await adminFetch('/api/advances');
            this.advances = res.ok ? await res.json() : [];
            this.renderTable();
            logTelemetry('Advances ledger refreshed.');
        } catch (err) {
            console.error('Failed to load advances ledger:', err);
        }
    }

    /**
     * Collapses the flat ledger into one running-balance row per customer.
     * The customer's display name is taken from their most recent deposit
     * (redemption records copy the name from the sale, which is fine too,
     * but a deposit is the more authoritative "who this customer is" source).
     */
    getCustomerSummaries() {
        const map = new Map();
        this.advances.forEach(a => {
            if (!map.has(a.customerPhone)) {
                map.set(a.customerPhone, { phone: a.customerPhone, name: a.customerName, balance: 0, lastActivity: 0, entries: [] });
            }
            const c = map.get(a.customerPhone);
            const delta = a.type === 'deposit' ? parseFloat(a.amount) : -parseFloat(a.amount);
            c.balance += (delta || 0);
            c.lastActivity = Math.max(c.lastActivity, a.timestamp || 0);
            c.entries.push(a);
            if (a.type === 'deposit' && a.customerName) c.name = a.customerName;
        });
        return Array.from(map.values()).sort((a, b) => b.lastActivity - a.lastActivity);
    }

    renderTable() {
        const tbody = document.getElementById('advances-table-body');
        if (!tbody) return;

        const query = (document.getElementById('advances-search')?.value || '').trim().toLowerCase();
        let customers = this.getCustomerSummaries();
        if (query) {
            customers = customers.filter(c =>
                (c.phone || '').includes(query) || (c.name || '').toLowerCase().includes(query)
            );
        }

        if (customers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--color-text-light); font-style:italic;">No customer advances found.</td></tr>`;
            return;
        }

        tbody.innerHTML = customers.map(c => `
            <tr class="advances-row" data-phone="${c.phone}">
                <td>${c.phone}</td>
                <td>${c.name || 'Regular Customer'}</td>
                <td class="text-right">₹${Math.max(0, c.balance).toLocaleString('en-IN')}</td>
                <td>${new Date(c.lastActivity).toLocaleDateString()}</td>
                <td class="text-right"><button type="button" class="btn btn-secondary btn-sm expand-btn" data-phone="${c.phone}">${this.expandedPhone === c.phone ? 'Hide' : 'View'}</button></td>
            </tr>
            ${this.expandedPhone === c.phone ? this.renderDetailRow(c) : ''}
        `).join('');

        tbody.querySelectorAll('.expand-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const phone = btn.getAttribute('data-phone');
                this.expandedPhone = this.expandedPhone === phone ? null : phone;
                this.renderTable();
            });
        });
    }

    renderDetailRow(customer) {
        const entries = [...customer.entries].sort((a, b) => b.timestamp - a.timestamp);
        return `
            <tr class="advances-detail-row">
                <td colspan="5">
                    <div class="ledger-drilldown">
                        ${entries.map(e => `
                            <div class="recent-list-item">
                                <div>
                                    <strong>${e.type === 'deposit' ? 'Deposit' : 'Redeemed at Billing'}</strong>
                                    <div class="text-muted-small">${e.paymentMethod || (e.invoiceId ? 'Invoice ' + e.invoiceId : '')}${e.referenceId ? ' · Ref: ' + e.referenceId : ''}</div>
                                </div>
                                <div class="text-right">
                                    <strong class="${e.type === 'deposit' ? 'ledger-amount-positive' : 'ledger-amount-negative'}">${e.type === 'deposit' ? '+' : '-'}₹${(parseFloat(e.amount) || 0).toLocaleString('en-IN')}</strong>
                                    <div class="text-muted-small">${new Date(e.timestamp).toLocaleString()}</div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </td>
            </tr>
        `;
    }

    async submitManualDeposit() {
        const phone = document.getElementById('deposit-phone').value.replace(/\D/g, '');
        const name = document.getElementById('deposit-name').value;
        const amount = parseFloat(document.getElementById('deposit-amount').value);
        const method = document.getElementById('deposit-method').value;

        if (phone.length !== 10) {
            alert('Valid 10-digit phone number required.');
            return;
        }
        if (!amount || amount <= 0) {
            alert('Enter a valid deposit amount.');
            return;
        }

        try {
            // Public endpoint (also used by the customer portal) — an admin
            // counter deposit is functionally identical to a customer's own.
            const res = await fetch('/api/advances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerPhone: phone, customerName: name, amount, paymentMethod: method })
            });
            if (res.ok) {
                alert('Success: Advance deposit recorded!');
                document.getElementById('new-deposit-form').style.display = 'none';
                document.getElementById('deposit-phone').value = '';
                document.getElementById('deposit-name').value = '';
                document.getElementById('deposit-amount').value = '';
                await this.refresh();
                if (window.dashboard) window.dashboard.refresh();
            } else {
                const err = await res.json();
                alert('Failed to save deposit: ' + (err.error || 'Unknown error'));
            }
        } catch (err) {
            alert('Connection failed while saving deposit.');
        }
    }
}
