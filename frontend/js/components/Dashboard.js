import { logTelemetry, adminFetch } from '../app.js';

const PURITY_LABELS = { '24K': '24K Gold', '22K': '22K Gold', '18K': '18K Gold' };
const PURITY_SWATCH_CLASS = { '24K': 'swatch-24k', '22K': 'swatch-22k', '18K': 'swatch-18k' };

/**
 * Escapes HTML-significant characters. Sales/advances records can contain
 * customer-supplied strings (customerName, phone, purity, paymentMethod)
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

export class Dashboard {
    constructor() {
        this.loaded = false;
        this.render();
    }

    /**
     * Renders the static shell once. Called from the constructor; data-bearing
     * regions are populated separately by refresh() so re-opening the tab
     * doesn't rebuild the DOM from scratch.
     */
    render() {
        const container = document.querySelector('#dashboard-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div class="dashboard-toolbar">
                <button type="button" id="dashboard-refresh-btn" class="btn btn-secondary">Refresh</button>
                <span id="dashboard-updated-at" class="text-muted-small"></span>
            </div>

            <div class="dashboard-grid" id="dashboard-stat-tiles">
                <div class="stat-tile">
                    <h3 class="stat-tile-label">Today's Revenue</h3>
                    <p class="stat-tile-value" id="stat-today-revenue">₹0.00</p>
                    <p class="stat-tile-sub" id="stat-today-count">0 invoices</p>
                </div>
                <div class="stat-tile">
                    <h3 class="stat-tile-label">This Month's Revenue</h3>
                    <p class="stat-tile-value" id="stat-mtd-revenue">₹0.00</p>
                    <p class="stat-tile-sub" id="stat-mtd-count">0 invoices</p>
                </div>
                <div class="stat-tile">
                    <h3 class="stat-tile-label">Outstanding Advances</h3>
                    <p class="stat-tile-value" id="stat-outstanding-advances">₹0.00</p>
                    <p class="stat-tile-sub" id="stat-outstanding-customers">0 customers</p>
                </div>
                <div class="stat-tile">
                    <h3 class="stat-tile-label">Active Gold Rate (22K)</h3>
                    <p class="stat-tile-value" id="stat-gold-rate">₹0.00/g</p>
                    <p class="stat-tile-sub"><span class="widget-type-badge" id="stat-gold-rate-badge">Auto</span></p>
                </div>
            </div>

            <div class="dashboard-section">
                <h3 class="dashboard-section-title">Purity Mix — Lifetime Revenue Share</h3>
                <div class="purity-mix-bar" id="purity-mix-bar"></div>
                <div class="purity-mix-legend" id="purity-mix-legend"></div>
            </div>

            <div class="dashboard-columns">
                <div class="dashboard-section">
                    <h3 class="dashboard-section-title">Recent Transactions</h3>
                    <div class="recent-list" id="recent-transactions-list"></div>
                </div>
                <div class="dashboard-section">
                    <h3 class="dashboard-section-title">Recent Advance Deposits</h3>
                    <div class="recent-list" id="recent-advances-list"></div>
                </div>
            </div>
        `;

        const refreshBtn = document.getElementById('dashboard-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this.refresh());
        }
    }

    /**
     * Fetches sales, advances, and the active gold rate, then recomputes and
     * repaints every data region. Safe to call repeatedly (e.g. each time the
     * Dashboard tab is opened) — all API reads are already-admin-gated GETs.
     */
    async refresh() {
        const refreshBtn = document.getElementById('dashboard-refresh-btn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Loading...';
        }

        try {
            const [salesRes, advancesRes, rateRes] = await Promise.all([
                adminFetch('/api/sales'),
                adminFetch('/api/advances'),
                fetch('/api/gold-price')
            ]);

            const sales = salesRes.ok ? await salesRes.json() : [];
            const advances = advancesRes.ok ? await advancesRes.json() : [];
            const rate = rateRes.ok ? await rateRes.json() : null;

            this.renderStatTiles(sales, advances, rate);
            this.renderPurityMix(sales);
            this.renderRecentTransactions(sales);
            this.renderRecentAdvances(advances);

            const updatedAt = document.getElementById('dashboard-updated-at');
            if (updatedAt) {
                updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;
            }

            this.loaded = true;
            logTelemetry('Dashboard data refreshed.');
        } catch (err) {
            console.error('Failed to refresh dashboard data:', err);
        } finally {
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = 'Refresh';
            }
        }
    }

    renderStatTiles(sales, advances, rate) {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

        const todaySales = sales.filter(s => s.timestamp >= todayStart);
        const mtdSales = sales.filter(s => s.timestamp >= monthStart);

        const sum = (arr) => arr.reduce((total, s) => total + (parseFloat(s.totalAmount) || 0), 0);

        this.setText('stat-today-revenue', `₹${sum(todaySales).toLocaleString('en-IN')}`);
        this.setText('stat-today-count', `${todaySales.length} invoice${todaySales.length === 1 ? '' : 's'}`);
        this.setText('stat-mtd-revenue', `₹${sum(mtdSales).toLocaleString('en-IN')}`);
        this.setText('stat-mtd-count', `${mtdSales.length} invoice${mtdSales.length === 1 ? '' : 's'}`);

        // Outstanding advance balance per customer: deposits minus redemptions, floored at 0
        const balances = new Map();
        advances.forEach(a => {
            const delta = a.type === 'deposit' ? parseFloat(a.amount) : -parseFloat(a.amount);
            balances.set(a.customerPhone, (balances.get(a.customerPhone) || 0) + (delta || 0));
        });
        let outstandingTotal = 0;
        let outstandingCustomers = 0;
        balances.forEach(balance => {
            if (balance > 0) {
                outstandingTotal += balance;
                outstandingCustomers += 1;
            }
        });
        this.setText('stat-outstanding-advances', `₹${outstandingTotal.toLocaleString('en-IN')}`);
        this.setText('stat-outstanding-customers', `${outstandingCustomers} customer${outstandingCustomers === 1 ? '' : 's'}`);

        if (rate) {
            this.setText('stat-gold-rate', `₹${(rate.price22K || 0).toLocaleString('en-IN')}/g`);
            const badge = document.getElementById('stat-gold-rate-badge');
            if (badge) {
                badge.textContent = rate.source === 'manual' ? 'Manual Override' : 'Auto Midnight';
            }
        }
    }

    renderPurityMix(sales) {
        const bar = document.getElementById('purity-mix-bar');
        const legend = document.getElementById('purity-mix-legend');
        if (!bar || !legend) return;

        const totals = { '24K': 0, '22K': 0, '18K': 0 };
        sales.forEach(s => {
            if (totals[s.purity] !== undefined) {
                totals[s.purity] += parseFloat(s.totalAmount) || 0;
            }
        });
        const grandTotal = totals['24K'] + totals['22K'] + totals['18K'];

        if (grandTotal <= 0) {
            bar.innerHTML = '<div class="purity-mix-empty">No sales recorded yet</div>';
            legend.innerHTML = '';
            return;
        }

        const purities = ['24K', '22K', '18K'];
        bar.innerHTML = purities
            .filter(p => totals[p] > 0)
            .map(p => {
                const pct = (totals[p] / grandTotal) * 100;
                return `<div class="purity-mix-segment ${PURITY_SWATCH_CLASS[p]}" style="width:${pct}%" title="${PURITY_LABELS[p]}: ${pct.toFixed(1)}%"></div>`;
            })
            .join('');

        legend.innerHTML = purities
            .filter(p => totals[p] > 0)
            .map(p => {
                const pct = (totals[p] / grandTotal) * 100;
                return `
                    <div class="legend-item">
                        <span class="legend-swatch ${PURITY_SWATCH_CLASS[p]}"></span>
                        <span>${PURITY_LABELS[p]} — ₹${totals[p].toLocaleString('en-IN')} (${pct.toFixed(1)}%)</span>
                    </div>
                `;
            })
            .join('');
    }

    renderRecentTransactions(sales) {
        const list = document.getElementById('recent-transactions-list');
        if (!list) return;

        const recent = [...sales].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
        if (recent.length === 0) {
            list.innerHTML = '<div class="recent-list-empty">No transactions yet.</div>';
            return;
        }

        list.innerHTML = recent.map(s => `
            <div class="recent-list-item">
                <div>
                    <strong>${escapeHtml(s.id || 'N/A')}</strong>
                    <div class="text-muted-small">${escapeHtml(s.customerName || 'Cash Sale')} · ${escapeHtml(s.purity || '')} · ${(parseFloat(s.weightGrams) || 0).toFixed(3)}g</div>
                </div>
                <div class="text-right">
                    <strong>₹${(parseFloat(s.totalAmount) || 0).toLocaleString('en-IN')}</strong>
                    <div class="text-muted-small">${new Date(s.timestamp).toLocaleString()}</div>
                </div>
            </div>
        `).join('');
    }

    renderRecentAdvances(advances) {
        const list = document.getElementById('recent-advances-list');
        if (!list) return;

        const recentDeposits = advances
            .filter(a => a.type === 'deposit')
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 5);

        if (recentDeposits.length === 0) {
            list.innerHTML = '<div class="recent-list-empty">No advance deposits yet.</div>';
            return;
        }

        list.innerHTML = recentDeposits.map(a => `
            <div class="recent-list-item">
                <div>
                    <strong>${escapeHtml(a.customerName || 'Regular Customer')}</strong>
                    <div class="text-muted-small">${escapeHtml(a.customerPhone || '')} · ${escapeHtml(a.paymentMethod || 'UPI')}</div>
                </div>
                <div class="text-right">
                    <strong>₹${(parseFloat(a.amount) || 0).toLocaleString('en-IN')}</strong>
                    <div class="text-muted-small">${new Date(a.timestamp).toLocaleString()}</div>
                </div>
            </div>
        `).join('');
    }

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
}
