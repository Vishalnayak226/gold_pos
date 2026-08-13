import { adminFetch, logTelemetry, canApprove, getActor } from '../app.js';
import { ADVANCE_STATUS, advanceEntryDelta, normalizeAdvanceStatus } from '../lib/billingMath.js';

/** Customers listed per page. The server clamps to 500 regardless. */
const CUSTOMER_ROWS = 100;

/**
 * Escapes HTML-significant characters. Advance records can contain
 * customer-supplied strings (customerName, phone, paymentMethod, referenceId)
 * submitted through public, unauthenticated endpoints (POST /api/advances,
 * POST /api/payment/verify) with no server-side content restriction — every
 * such field must be escaped before going into innerHTML here, since this
 * renders inside the authenticated admin session (bearer token in
 * sessionStorage would otherwise be exfiltratable via a stored-XSS payload).
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/**
 * Advances report/browse module — the missing counterpart to the redemption
 * flow already built into BillingDesk. Lists every customer with an advance
 * balance, supports search, a full per-customer ledger drill-down, and a
 * manual deposit entry form for cash/counter deposits.
 */
export class AdvancesManager {
    constructor() {
        this.customers = [];
        this.customerTotal = 0;
        this.pending = [];
        this.expandedPhone = null;
        this.entriesByPhone = new Map();
        this.searchTimer = null;
        this.render();
    }

    render() {
        const container = document.querySelector('#advances-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div id="pending-approvals"></div>

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
            <p id="advances-truncation" class="text-muted-small" style="margin-top:8px;"></p>
        `;

        document.getElementById('advances-refresh-btn').addEventListener('click', () => this.refresh());
        // Search runs on the SERVER now — it has to, because the balance a row
        // shows is rolled up from a customer's whole history and this screen
        // only ever holds a page of customers. Debounced so a typed phone
        // number is one request, not ten.
        document.getElementById('advances-search').addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => this.refresh(), 250);
        });
        document.getElementById('advances-new-deposit-btn').addEventListener('click', () => {
            const form = document.getElementById('new-deposit-form');
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
        });
        document.getElementById('cancel-deposit-btn').addEventListener('click', () => {
            document.getElementById('new-deposit-form').style.display = 'none';
        });
        document.getElementById('submit-deposit-btn').addEventListener('click', () => this.submitManualDeposit());
    }

    /**
     * Loads a page of per-customer balances plus the approval queue.
     *
     * This screen no longer downloads the advances ledger. It asked for every
     * deposit and redemption ever recorded and rolled them up here, which grew
     * without bound and made paging impossible — a customer's spendable credit
     * is their whole history, so a page of rows cannot produce it. The rollup
     * now happens on the server (GET /api/advances/customers) and the
     * per-customer drill-down fetches one customer's rows on demand.
     */
    async refresh() {
        const query = (document.getElementById('advances-search')?.value || '').trim();
        // Approving a deposit or filing one changes a customer's rows, so the
        // drill-down cache cannot survive a refresh.
        this.entriesByPhone.clear();
        try {
            const [customersRes, pendingRes] = await Promise.all([
                adminFetch(`/api/advances/customers?limit=${CUSTOMER_ROWS}&q=${encodeURIComponent(query)}`),
                adminFetch('/api/advances/pending')
            ]);
            const page = customersRes.ok ? await customersRes.json() : null;
            this.customers = page ? page.results : [];
            this.customerTotal = page ? page.total : 0;
            this.pending = pendingRes.ok ? await pendingRes.json() : [];
            // An open drill-down stays open across a refresh, so its rows are
            // re-fetched rather than left showing the loading placeholder.
            if (this.expandedPhone) await this.loadCustomerEntries(this.expandedPhone);
            this.renderPendingApprovals();
            this.renderTable();
            logTelemetry(`Advances ledger refreshed (${this.pending.length} awaiting approval).`);
        } catch (err) {
            console.error('Failed to load advances ledger:', err);
        }
    }

    /**
     * One customer's rows, fetched only when their drill-down is opened.
     * Cached per phone so collapsing and re-expanding is free.
     */
    async loadCustomerEntries(phone) {
        if (this.entriesByPhone.has(phone)) return;
        try {
            const res = await adminFetch(`/api/advances/lookup?phone=${encodeURIComponent(phone)}`);
            if (!res.ok) return;
            const ledger = await res.json();
            this.entriesByPhone.set(phone, ledger.history || []);
        } catch (err) {
            console.error('Failed to load the customer ledger:', err);
        }
    }

    /**
     * The approval queue, above the ledger because it is the only part of this
     * tab with work outstanding in it. Customer-submitted UPI deposits arrive
     * unverified and hold no balance until a cashier confirms the transfer
     * landed — see ADVANCE_STATUS in frontend/js/lib/billingMath.js.
     */
    renderPendingApprovals() {
        const host = document.getElementById('pending-approvals');
        if (!host) return;

        if (!this.pending || this.pending.length === 0) {
            host.innerHTML = '';
            return;
        }

        const total = this.pending.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

        host.innerHTML = `
            <div style="border:1px solid var(--color-warning); background:var(--color-warning-bg); border-radius:10px; padding:18px; margin-bottom:22px;">
                <div style="display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:6px;">
                    <h3 style="margin:0; font-size:14px; color:var(--color-warning); text-transform:uppercase; letter-spacing:0.03em;">
                        ${this.pending.length} deposit${this.pending.length === 1 ? '' : 's'} awaiting verification
                    </h3>
                    <strong style="font-size:15px; color:var(--color-text-main);">₹${total.toLocaleString('en-IN')}</strong>
                </div>
                <p style="font-size:12px; color:var(--color-text-muted); margin:0 0 14px; max-width:80ch;">
                    Customers submitted these from the portal. Check each reference against the store's bank or UPI
                    statement before approving — <strong>none of this money is in any customer's balance yet</strong>,
                    and approving is what credits it.
                </p>
                ${canApprove() ? '' : `
                <p style="font-size:12px; color:var(--color-warning); margin:0 0 14px; max-width:80ch; font-weight:600;">
                    Releasing one of these needs an Owner or a Manager. You are signed in as
                    ${escapeHtml((getActor() && getActor().role) || 'cashier')}, so the queue is
                    shown for visibility but the decision is not yours to make.
                </p>`}
                <div style="display:flex; flex-direction:column; gap:10px;">
                    ${this.pending.map(p => this.renderPendingRow(p)).join('')}
                </div>
            </div>
        `;

        host.querySelectorAll('.approve-deposit-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reviewDeposit(btn.getAttribute('data-id'), 'approve'));
        });
        host.querySelectorAll('.reject-deposit-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reviewDeposit(btn.getAttribute('data-id'), 'reject'));
        });
    }

    renderPendingRow(p) {
        const waitedMs = Date.now() - (p.timestamp || 0);
        const waitedHours = Math.floor(waitedMs / 3600000);
        const waited = waitedHours >= 24
            ? `${Math.floor(waitedHours / 24)}d ago`
            : waitedHours >= 1 ? `${waitedHours}h ago` : 'just now';

        return `
            <div style="background:var(--color-bg-panel); border:1px solid var(--color-border-dark); border-radius:8px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap;">
                <div style="min-width:0;">
                    <strong style="font-size:14px;">₹${(parseFloat(p.amount) || 0).toLocaleString('en-IN')}</strong>
                    <span style="color:var(--color-text-muted); font-size:13px;"> · ${escapeHtml(p.customerName || 'Regular Customer')} (${escapeHtml(p.customerPhone)})</span>
                    <div class="text-muted-small" style="margin-top:3px;">
                        ${escapeHtml(p.paymentMethod || 'UPI')} · Ref: <span style="font-family:var(--font-mono);">${escapeHtml(p.referenceId || '—')}</span> · submitted ${waited}
                    </div>
                </div>
                ${canApprove() ? `
                <div style="display:flex; gap:8px; flex-shrink:0;">
                    <button type="button" class="btn btn-primary btn-sm approve-deposit-btn" data-id="${escapeHtml(p.id)}">Approve</button>
                    <button type="button" class="btn btn-danger btn-sm reject-deposit-btn" data-id="${escapeHtml(p.id)}">Reject</button>
                </div>` : ''}
            </div>
        `;
    }

    /**
     * Approving credits real money, so it is confirmed rather than one-click.
     * Rejecting requires a reason the server enforces — the customer has to be
     * told something more useful than "declined".
     */
    async reviewDeposit(depositId, decision) {
        const entry = this.pending.find(p => p.id === depositId);
        if (!entry) return;
        const amount = (parseFloat(entry.amount) || 0).toLocaleString('en-IN');
        let note = '';

        if (decision === 'approve') {
            const ok = confirm(
                `Approve ₹${amount} for ${entry.customerName || entry.customerPhone}?\n\n` +
                `Reference: ${entry.referenceId || '—'}\n\n` +
                `This credits the money to their advance balance, where it can be redeemed against a bill. ` +
                `Only approve once you have found this transfer on the store's statement.`
            );
            if (!ok) return;
        } else {
            note = (prompt(
                `Reject ₹${amount} from ${entry.customerName || entry.customerPhone}?\n\n` +
                `Give a reason (the store's record of why this claim was not credited):`
            ) || '').trim();
            if (!note) return;
        }

        try {
            const res = await adminFetch(`/api/advances/${encodeURIComponent(depositId)}/${decision}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                alert(`Could not ${decision} the deposit: ` + (err.error || `HTTP ${res.status}`));
                await this.refresh();
                return;
            }
            alert(decision === 'approve'
                ? `Success: ₹${amount} credited to ${entry.customerPhone}.`
                : `Deposit rejected. ${entry.customerPhone} has not been credited.`);
            await this.refresh();
            if (window.dashboard) window.dashboard.refresh();
        } catch (err) {
            alert(`Connection failed while trying to ${decision} the deposit.`);
        }
    }

    /**
     * The customer list, straight from the server's rollup. Every balance here
     * was computed over that customer's whole history — see refresh().
     */
    renderTable() {
        const tbody = document.getElementById('advances-table-body');
        if (!tbody) return;

        const customers = this.customers || [];
        const note = document.getElementById('advances-truncation');
        if (note) {
            note.textContent = this.customerTotal > customers.length
                ? `Showing ${customers.length} of ${this.customerTotal} customers. Narrow the search to find a specific one.`
                : '';
        }

        if (customers.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--color-text-light); font-style:italic;">No customer advances found.</td></tr>`;
            return;
        }

        tbody.innerHTML = customers.map(c => `
            <tr class="advances-row" data-phone="${escapeHtml(c.phone)}">
                <td>${escapeHtml(c.phone)}</td>
                <td>${escapeHtml(c.name || 'Regular Customer')}</td>
                <td class="text-right">
                    ₹${Math.max(0, c.balance).toLocaleString('en-IN')}
                    ${c.pendingTotal > 0 ? `<div class="text-muted-small" style="color:var(--color-warning);">+₹${c.pendingTotal.toLocaleString('en-IN')} pending</div>` : ''}
                </td>
                <td>${new Date(c.lastActivity).toLocaleDateString()}</td>
                <td class="text-right"><button type="button" class="btn btn-secondary btn-sm expand-btn" data-phone="${escapeHtml(c.phone)}">${this.expandedPhone === c.phone ? 'Hide' : 'View'}</button></td>
            </tr>
            ${this.expandedPhone === c.phone ? this.renderDetailRow(c) : ''}
        `).join('');

        tbody.querySelectorAll('.expand-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const phone = btn.getAttribute('data-phone');
                if (this.expandedPhone === phone) {
                    this.expandedPhone = null;
                } else {
                    this.expandedPhone = phone;
                    // Fetched on open rather than held for every customer.
                    btn.disabled = true;
                    await this.loadCustomerEntries(phone);
                }
                this.renderTable();
            });
        });
    }

    renderDetailRow(customer) {
        const held = this.entriesByPhone.get(customer.phone);
        if (!held) {
            return `
            <tr class="advances-detail-row">
                <td colspan="5"><div class="ledger-drilldown"><p class="text-muted-small">Loading this customer's ledger…</p></div></td>
            </tr>`;
        }
        const entries = [...held].sort((a, b) => b.timestamp - a.timestamp);
        return `
            <tr class="advances-detail-row">
                <td colspan="5">
                    <div class="ledger-drilldown">
                        ${entries.map(e => {
                            const status = normalizeAdvanceStatus(e);
                            const counts = advanceEntryDelta(e) !== 0;
                            // A row that holds no balance is greyed and struck
                            // through, so scanning the ledger cannot leave the
                            // impression an unverified claim is money on hand.
                            const tag = e.type !== 'deposit' ? ''
                                : status === ADVANCE_STATUS.PENDING
                                    ? ` <span style="font-size:10px; font-weight:700; color:var(--color-warning); background:var(--color-warning-bg); padding:1px 6px; border-radius:8px;">AWAITING APPROVAL</span>`
                                    : status === ADVANCE_STATUS.REJECTED
                                        ? ` <span style="font-size:10px; font-weight:700; color:var(--color-danger); background:var(--color-danger-bg); padding:1px 6px; border-radius:8px;">REJECTED</span>`
                                        : '';
                            return `
                            <div class="recent-list-item"${counts ? '' : ' style="opacity:0.6;"'}>
                                <div>
                                    <strong>${e.type === 'deposit' ? 'Deposit' : 'Redeemed at Billing'}</strong>${tag}
                                    <div class="text-muted-small">${escapeHtml(e.paymentMethod || (e.invoiceId ? 'Invoice ' + e.invoiceId : ''))}${e.referenceId ? ' · Ref: ' + escapeHtml(e.referenceId) : ''}${e.reviewNote ? ' · ' + escapeHtml(e.reviewNote) : ''}</div>
                                </div>
                                <div class="text-right">
                                    <strong class="${!counts ? '' : e.type === 'deposit' ? 'ledger-amount-positive' : 'ledger-amount-negative'}"${counts ? '' : ' style="text-decoration:line-through; color:var(--color-text-light);"'}>${e.type === 'deposit' ? '+' : '-'}₹${(parseFloat(e.amount) || 0).toLocaleString('en-IN')}</strong>
                                    <div class="text-muted-small">${new Date(e.timestamp).toLocaleString()}</div>
                                </div>
                            </div>
                            `;
                        }).join('')}
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
            // Admin-gated since Phase 20.1: a counter deposit can name any
            // customer's phone, so it needs a cashier session. The customer
            // portal posts its own deposits to /api/customer/advances, which
            // can only ever credit the phone on that customer's session.
            const res = await adminFetch('/api/advances', {
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
