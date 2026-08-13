import { logTelemetry, adminFetch } from '../app.js';
import { ADVANCE_STATUS, advanceEntryDelta, normalizeAdvanceStatus } from '../lib/billingMath.js';

/** Rows each "recent" list shows — and therefore rows each list asks for. */
const RECENT_ROWS = 5;

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
                    <p class="stat-tile-sub" id="stat-pending-advances" style="color:var(--color-warning); font-weight:600;"></p>
                </div>
                <div class="stat-tile">
                    <h3 class="stat-tile-label">Active Gold Rate (22K)</h3>
                    <p class="stat-tile-value" id="stat-gold-rate">₹0.00/g</p>
                    <p class="stat-tile-sub"><span class="widget-type-badge" id="stat-gold-rate-badge">Auto</span></p>
                </div>
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
     * Fetches the figures the tiles state and the handful of rows the lists
     * show, then repaints every data region. Safe to call repeatedly (e.g. each
     * time the Dashboard tab is opened) — all API reads are already-admin-gated
     * GETs.
     *
     * THIS SCREEN DOES NOT DOWNLOAD THE LEDGER. It used to ask for every sale
     * and every advance row ever filed and add them up here, which meant the
     * response grew with the store's whole trading history to render two
     * revenue tiles and five list rows. The revenue figures now come from the
     * server's own `totals` over the matched period, the liability figure from
     * its `summary` over the whole advance ledger, and the lists ask for
     * exactly the rows they display.
     */
    async refresh() {
        const refreshBtn = document.getElementById('dashboard-refresh-btn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Loading...';
        }

        try {
            const now = new Date();
            const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const today = day(now);
            const monthStart = day(new Date(now.getFullYear(), now.getMonth(), 1));

            // Four small reads instead of two unbounded ones. The two tile
            // calls ask for a single row each because only their `totals` is
            // wanted; the two list calls ask for exactly the rows they draw.
            // The recent-invoice list is deliberately NOT date-bounded — a
            // store with a quiet month still has a last invoice, and it should
            // still be shown.
            const [todayRes, mtdRes, recentRes, advancesRes, rateRes] = await Promise.all([
                adminFetch(`/api/sales?from=${today}&to=${today}&limit=1`),
                adminFetch(`/api/sales?from=${monthStart}&to=${today}&limit=1`),
                adminFetch(`/api/sales?limit=${RECENT_ROWS}`),
                adminFetch(`/api/advances?type=deposit&limit=${RECENT_ROWS}`),
                fetch('/api/gold-price')
            ]);

            const todayPage = todayRes.ok ? await todayRes.json() : null;
            const mtdPage = mtdRes.ok ? await mtdRes.json() : null;
            const recentPage = recentRes.ok ? await recentRes.json() : null;
            const advancesPage = advancesRes.ok ? await advancesRes.json() : null;
            const rate = rateRes.ok ? await rateRes.json() : null;

            this.renderStatTiles(todayPage, mtdPage, advancesPage, rate);
            this.renderRecentTransactions(recentPage ? recentPage.results : []);
            this.renderRecentAdvances(advancesPage ? advancesPage.results : []);

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

    /**
     * The four tiles, every figure taken from a server-computed aggregate.
     *
     * Nothing here sums a page of rows. A tile that says "this month's revenue"
     * has to be the whole month's revenue, and the rows this screen holds are
     * only ever the handful the lists below display — so summing them locally
     * would have quietly understated the business the day the ledger outgrew
     * one page.
     */
    renderStatTiles(todayPage, mtdPage, advancesPage, rate) {
        const period = (page) => (page && page.totals) || { count: 0, totalAmount: 0 };
        const tile = (revenueId, countId, page) => {
            const t = period(page);
            this.setText(revenueId, `₹${(t.totalAmount || 0).toLocaleString('en-IN')}`);
            this.setText(countId, `${t.count} invoice${t.count === 1 ? '' : 's'}`);
        };

        tile('stat-today-revenue', 'stat-today-count', todayPage);
        tile('stat-mtd-revenue', 'stat-mtd-count', mtdPage);

        // Outstanding advance balance per customer: deposits minus redemptions,
        // floored per customer at 0. summarizeAdvanceLiability() is the shared
        // rule and it runs on the server here — it excludes a deposit still
        // awaiting counter approval, so an unverified customer claim cannot
        // inflate the store's liability figure on this tile.
        const liability = (advancesPage && advancesPage.summary) || {
            outstandingTotal: 0, outstandingCustomers: 0, pendingTotal: 0, pendingCount: 0
        };
        this.setText('stat-outstanding-advances', `₹${liability.outstandingTotal.toLocaleString('en-IN')}`);
        this.setText('stat-outstanding-customers', `${liability.outstandingCustomers} customer${liability.outstandingCustomers === 1 ? '' : 's'}`);

        // Awaiting-approval callout: money customers say they have sent that no
        // one has confirmed yet. Deliberately NOT added to the tile above — the
        // point of the pending state is that it is not yet a liability.
        const pendingNote = document.getElementById('stat-pending-advances');
        if (pendingNote) {
            pendingNote.textContent = liability.pendingCount > 0
                ? `₹${liability.pendingTotal.toLocaleString('en-IN')} awaiting approval (${liability.pendingCount})`
                : '';
        }

        if (rate) {
            this.setText('stat-gold-rate', `₹${(rate.price22K || 0).toLocaleString('en-IN')}/g`);
            const badge = document.getElementById('stat-gold-rate-badge');
            if (badge) {
                badge.textContent = rate.source === 'manual' ? 'Manual Override' : 'Auto Midnight';
            }
        }
    }

    /** The newest invoices, already ordered and already clamped by the server. */
    renderRecentTransactions(sales) {
        const list = document.getElementById('recent-transactions-list');
        if (!list) return;

        if (sales.length === 0) {
            list.innerHTML = '<div class="recent-list-empty">No transactions yet.</div>';
            return;
        }

        list.innerHTML = sales.map(s => `
            <div class="recent-list-item">
                <div>
                    <strong>${escapeHtml(s.id || 'N/A')}</strong>
                    <div class="text-muted-small">${escapeHtml(s.customerName || 'Cash Sale')} · ${escapeHtml(describeSaleGoods(s))}</div>
                </div>
                <div class="text-right">
                    <strong>₹${(parseFloat(s.totalAmount) || 0).toLocaleString('en-IN')}</strong>
                    <div class="text-muted-small">${new Date(s.timestamp).toLocaleString()}</div>
                </div>
            </div>
        `).join('');
    }

    /** The newest deposits — the server filtered to `type=deposit` and clamped. */
    renderRecentAdvances(advances) {
        const list = document.getElementById('recent-advances-list');
        if (!list) return;

        const recentDeposits = advances;

        if (recentDeposits.length === 0) {
            list.innerHTML = '<div class="recent-list-empty">No advance deposits yet.</div>';
            return;
        }

        list.innerHTML = recentDeposits.map(a => {
            // An unapproved claim in this list must not read as money received.
            const counts = advanceEntryDelta(a) !== 0;
            const status = normalizeAdvanceStatus(a);
            const tag = counts ? ''
                : status === ADVANCE_STATUS.REJECTED
                    ? ' <span style="font-size:10px; font-weight:700; color:var(--color-danger);">REJECTED</span>'
                    : ' <span style="font-size:10px; font-weight:700; color:var(--color-warning);">PENDING</span>';
            return `
            <div class="recent-list-item"${counts ? '' : ' style="opacity:0.6;"'}>
                <div>
                    <strong>${escapeHtml(a.customerName || 'Regular Customer')}</strong>${tag}
                    <div class="text-muted-small">${escapeHtml(a.customerPhone || '')} · ${escapeHtml(a.paymentMethod || 'UPI')}</div>
                </div>
                <div class="text-right">
                    <strong${counts ? '' : ' style="text-decoration:line-through; color:var(--color-text-light);"'}>₹${(parseFloat(a.amount) || 0).toLocaleString('en-IN')}</strong>
                    <div class="text-muted-small">${new Date(a.timestamp).toLocaleString()}</div>
                </div>
            </div>
            `;
        }).join('');
    }

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }
}
