import { adminFetch, logTelemetry } from '../app.js';

/**
 * Escapes HTML-significant characters. Customer account fields (name, email)
 * are self-service-editable through PATCH /api/customer/me, so every one of
 * them is attacker-controlled text arriving into the authenticated admin
 * session — the same reasoning as AdvancesManager's copy of this helper.
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
 * Customer portal login administration — the store-side counterpart to
 * customer.html's sign-in screen.
 *
 * GET /api/customer-accounts and POST /api/customer-accounts/issue-login have
 * existed since Phase 20.1 but had no screen behind them, which left the one
 * path a customer with existing store history can get a login (issued at the
 * counter, never self-registered) reachable only by hand-crafting an HTTP
 * request. This is that screen.
 */
export class CustomerAccountsManager {
    constructor() {
        this.accounts = [];
        this.lastIssued = null;
        this.render();
    }

    render() {
        const container = document.querySelector('#customer-accounts-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:70ch;">
                Portal logins for customers. A customer whose number already has deposit history
                <strong>cannot self-register</strong> — issue their login here instead, and hand them the
                temporary password shown after issuing.
            </p>

            <div class="advances-toolbar">
                <input type="text" id="accounts-search" class="form-control" placeholder="Search by phone, name or email...">
                <button type="button" id="accounts-refresh-btn" class="btn btn-secondary">Refresh</button>
                <button type="button" id="accounts-issue-btn" class="btn btn-primary">+ Issue Login</button>
            </div>

            <div id="issue-login-form" class="new-deposit-form" style="display:none;">
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="issue-phone">Customer Phone (10-digit)</label>
                        <input type="tel" id="issue-phone" class="form-control" maxlength="10" inputmode="numeric">
                    </div>
                    <div class="form-group">
                        <label for="issue-name">Customer Name</label>
                        <input type="text" id="issue-name" class="form-control" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="issue-email">Email</label>
                        <input type="email" id="issue-email" class="form-control" placeholder="Optional — needed for password resets">
                    </div>
                </div>
                <div style="display:flex; gap:10px;">
                    <button type="button" id="submit-issue-btn" class="btn btn-primary">Issue Login</button>
                    <button type="button" id="cancel-issue-btn" class="btn btn-secondary">Cancel</button>
                </div>
                <div id="issue-result" style="display:none; margin-top:16px;"></div>
            </div>

            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Phone Number</th>
                        <th>Name</th>
                        <th>Email</th>
                        <th>State</th>
                        <th class="text-right">Devices</th>
                        <th>Created</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="accounts-table-body"></tbody>
            </table>
        `;

        document.getElementById('accounts-refresh-btn').addEventListener('click', () => this.refresh());
        document.getElementById('accounts-search').addEventListener('input', () => this.renderTable());
        document.getElementById('accounts-issue-btn').addEventListener('click', () => {
            const form = document.getElementById('issue-login-form');
            const opening = form.style.display === 'none';
            form.style.display = opening ? 'block' : 'none';
            if (opening) document.getElementById('issue-phone').focus();
        });
        document.getElementById('cancel-issue-btn').addEventListener('click', () => this.closeIssueForm());
        document.getElementById('submit-issue-btn').addEventListener('click', () => this.issueLogin());
    }

    closeIssueForm() {
        document.getElementById('issue-login-form').style.display = 'none';
        document.getElementById('issue-result').style.display = 'none';
        ['issue-phone', 'issue-name', 'issue-email'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    }

    async refresh() {
        try {
            const res = await adminFetch('/api/customer-accounts');
            this.accounts = res.ok ? await res.json() : [];
            this.renderTable();
            logTelemetry(`Customer logins refreshed (${this.accounts.length}).`);
        } catch (err) {
            console.error('Failed to load customer logins:', err);
            this.renderTable();
        }
    }

    /**
     * The account state a cashier actually needs to see, in priority order: a
     * lockout is the reason a customer is on the phone complaining, and an
     * unchanged temporary password means they never completed setup.
     */
    describeState(account) {
        if (account.lockedUntil && account.lockedUntil > Date.now()) {
            const mins = Math.ceil((account.lockedUntil - Date.now()) / 60000);
            return { label: `Locked ${mins}m`, color: 'var(--color-danger)', bg: 'var(--color-danger-bg)' };
        }
        if (account.mustChangePassword) {
            return { label: 'Temp password', color: 'var(--color-warning)', bg: 'var(--color-warning-bg)' };
        }
        return { label: 'Active', color: 'var(--color-success)', bg: 'var(--color-success-bg)' };
    }

    renderTable() {
        const tbody = document.getElementById('accounts-table-body');
        if (!tbody) return;

        const query = (document.getElementById('accounts-search')?.value || '').trim().toLowerCase();
        let rows = this.accounts;
        if (query) {
            rows = rows.filter(a =>
                (a.phone || '').includes(query) ||
                (a.name || '').toLowerCase().includes(query) ||
                (a.email || '').toLowerCase().includes(query)
            );
        }

        if (rows.length === 0) {
            const message = this.accounts.length === 0
                ? 'No customer has a portal login yet. Use “Issue Login” to create the first one.'
                : 'No customer login matches that search.';
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--color-text-light); font-style:italic;">${message}</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(a => {
            const state = this.describeState(a);
            return `
                <tr>
                    <td>${escapeHtml(a.phone)}</td>
                    <td>${escapeHtml(a.name || '—')}</td>
                    <td>${escapeHtml(a.email || '—')}</td>
                    <td><span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; color:${state.color}; background:${state.bg};">${escapeHtml(state.label)}</span></td>
                    <td class="text-right">${a.activeSessions || 0}</td>
                    <td>${formatWhen(a.createdAt)}</td>
                    <td class="text-right">
                        <button type="button" class="btn btn-secondary btn-sm reissue-btn" data-phone="${escapeHtml(a.phone)}">Reset password</button>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('.reissue-btn').forEach(btn => {
            btn.addEventListener('click', () => this.reissueLogin(btn.getAttribute('data-phone')));
        });
    }

    async issueLogin() {
        const phone = document.getElementById('issue-phone').value.replace(/\D/g, '');
        const name = document.getElementById('issue-name').value.trim();
        const email = document.getElementById('issue-email').value.trim();

        if (phone.length !== 10) {
            alert('A valid 10-digit mobile number is required.');
            return;
        }
        await this.postIssue({ phone, name, email });
    }

    /**
     * Reissuing signs the customer out of every device and invalidates the
     * password they are currently using, so it is confirmed before the
     * confirmDestructive flag the server demands is sent.
     */
    async reissueLogin(phone) {
        const ok = confirm(
            `Reset the portal password for ${phone}?\n\n` +
            `This signs that customer out of every device and their current password stops working. ` +
            `You will be given a new temporary password to hand over.`
        );
        if (!ok) return;

        const form = document.getElementById('issue-login-form');
        form.style.display = 'block';
        document.getElementById('issue-phone').value = phone;
        await this.postIssue({ phone, confirmDestructive: true });
    }

    async postIssue(payload) {
        const btn = document.getElementById('submit-issue-btn');
        btn.disabled = true;
        try {
            const res = await adminFetch('/api/customer-accounts/issue-login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json().catch(() => ({}));

            if (res.status === 409 && data.error === 'CONFIRMATION_REQUIRED') {
                // Reached when issuing against a number that turns out to
                // already have a login — re-ask, then resend with the flag.
                if (confirm(`${data.message}\n\nReset it now?`)) {
                    await this.postIssue({ ...payload, confirmDestructive: true });
                }
                return;
            }
            if (!res.ok) {
                alert('Could not issue the login: ' + (data.message || data.error || `HTTP ${res.status}`));
                return;
            }

            this.showIssuedPassword(data);
            await this.refresh();
            logTelemetry(`Customer login ${data.reissued ? 'reset' : 'issued'} for ${data.phone}.`);
        } catch (err) {
            alert('Connection failed while issuing the login.');
        } finally {
            btn.disabled = false;
        }
    }

    /**
     * The temporary password is shown once, in the page, rather than through
     * alert(): the cashier has to read it out or write it down, and an alert
     * that has been dismissed cannot be recovered — the only way back would be
     * another reset, signing the customer out all over again.
     */
    showIssuedPassword(data) {
        const box = document.getElementById('issue-result');
        if (!box) return;
        box.style.display = 'block';
        box.innerHTML = `
            <div style="border:1px solid var(--color-success); background:var(--color-success-bg); border-radius:8px; padding:16px;">
                <p style="font-size:12px; font-weight:700; color:var(--color-success); text-transform:uppercase; letter-spacing:0.03em; margin:0 0 8px;">
                    ${data.reissued ? 'Password reset' : 'Login created'} · ${escapeHtml(data.phone)}
                </p>
                <p style="font-size:13px; color:var(--color-text-main); margin:0 0 10px;">
                    Give the customer this temporary password. They will be asked to change it when they sign in.
                    <strong>It is shown only once.</strong>
                </p>
                <p style="font-family:var(--font-mono); font-size:22px; font-weight:700; letter-spacing:2px; background:#fff; border:1px dashed var(--color-border-dark); border-radius:6px; padding:12px; text-align:center; margin:0; user-select:all;">${escapeHtml(data.tempPassword)}</p>
                ${data.hasEmail ? '' : `
                <p style="font-size:13px; line-height:1.5; color:#92400e; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:10px 12px; margin:12px 0 0;">
                    <strong>No email on this account.</strong> Tell the customer to add one under
                    <strong>Account</strong> in the portal — without it, "Forgot password" has
                    nowhere to send a code and they will have to come back to the counter every
                    time they are locked out.
                </p>`}
            </div>
        `;
    }
}
