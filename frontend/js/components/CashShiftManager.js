import { adminFetch, logTelemetry } from '../app.js';

/** Escapes HTML-significant characters — notes are free-text typed by staff. */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function formatWhen(ts) {
    return ts ? new Date(ts).toLocaleString() : '—';
}

function formatRupees(v) {
    return `₹${Number(v).toFixed(2)}`;
}

/**
 * Cash shifts — open with a float, close with a count (roadmap Phase 5.3).
 *
 * "Expected cash" is never computed in the browser. Every figure shown here
 * — the live preview on an open shift and the frozen figure on a closed one
 * — comes straight from the server's own ledger query, the same posture
 * every money screen in this app takes.
 */
export class CashShiftManager {
    constructor() {
        this.current = null;
        this.history = [];
        this.render();
    }

    render() {
        const container = document.querySelector('#cash-shifts-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:70ch;">
                Open a shift with the starting cash float, take sales through it, then close it with
                what was actually counted. Expected cash is computed from the ledger — every cash
                sale, cash advance deposit and cash refund recorded while the shift was open.
            </p>

            <div id="shift-current-panel"></div>

            <h2 style="font-size:15px; margin:24px 0 10px;">Shift History</h2>
            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Opened</th>
                        <th>Closed</th>
                        <th class="text-right">Float</th>
                        <th class="text-right">Expected</th>
                        <th class="text-right">Counted</th>
                        <th class="text-right">Variance</th>
                        <th>Note</th>
                    </tr>
                </thead>
                <tbody id="shift-history-body"></tbody>
            </table>
        `;
    }

    async refresh() {
        try {
            const [currentRes, historyRes] = await Promise.all([
                adminFetch('/api/cash-shifts/current'),
                adminFetch('/api/cash-shifts?limit=30')
            ]);
            if (!currentRes.ok || !historyRes.ok) throw new Error('One or more cash-shift requests failed');

            this.current = await currentRes.json();
            this.history = await historyRes.json();
            this.renderCurrent();
            this.renderHistory();
            logTelemetry('Cash shifts refreshed.');
        } catch (err) {
            console.error('Failed to load cash shifts:', err);
            const panel = document.getElementById('shift-current-panel');
            if (panel) panel.innerHTML = `<p style="color:var(--color-danger);">Cash shift data could not be loaded. Check the server is reachable and try again.</p>`;
        }
    }

    renderCurrent() {
        const panel = document.getElementById('shift-current-panel');
        if (!panel) return;

        if (!this.current || !this.current.shift) {
            panel.innerHTML = `
                <div class="new-deposit-form" style="display:block;">
                    <h2 style="font-size:15px; margin:0 0 10px;">No shift is open</h2>
                    <div class="form-group-row">
                        <div class="form-group">
                            <label for="open-float">Opening Float (₹)</label>
                            <input type="number" id="open-float" class="form-control" min="0" step="0.01">
                        </div>
                        <div class="form-group">
                            <label for="open-note">Note</label>
                            <input type="text" id="open-note" class="form-control" maxlength="500" placeholder="Optional">
                        </div>
                    </div>
                    <button type="button" id="open-shift-btn" class="btn btn-primary">Open Shift</button>
                    <span id="open-shift-status" style="font-size:12px; color:var(--color-danger); margin-left:10px;"></span>
                </div>
            `;
            document.getElementById('open-shift-btn').addEventListener('click', () => this.openShift());
            return;
        }

        const { shift, expectedCash, cashTenders, cashDeposits, cashRefunds } = this.current;
        panel.innerHTML = `
            <div class="new-deposit-form" style="display:block;">
                <h2 style="font-size:15px; margin:0 0 10px;">Shift open since ${formatWhen(shift.openedAt)}</h2>
                <p style="font-size:13px; margin:0 0 12px;">
                    Opening float: <strong>${formatRupees(shift.openingFloat)}</strong>
                    ${shift.openingNote ? ` — ${escapeHtml(shift.openingNote)}` : ''}
                </p>
                <table class="advances-table" style="margin-bottom:16px;">
                    <thead><tr><th>Opening Float</th><th>+ Cash Sales</th><th>+ Cash Deposits</th><th>− Cash Refunds</th><th>Expected Now</th></tr></thead>
                    <tbody>
                        <tr>
                            <td>${formatRupees(shift.openingFloat)}</td>
                            <td>${formatRupees(cashTenders)}</td>
                            <td>${formatRupees(cashDeposits)}</td>
                            <td>${formatRupees(cashRefunds)}</td>
                            <td><strong>${formatRupees(expectedCash)}</strong></td>
                        </tr>
                    </tbody>
                </table>
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="close-counted">Counted Cash (₹)</label>
                        <input type="number" id="close-counted" class="form-control" min="0" step="0.01">
                    </div>
                    <div class="form-group">
                        <label for="close-note">Note</label>
                        <input type="text" id="close-note" class="form-control" maxlength="500" placeholder="Optional">
                    </div>
                </div>
                <button type="button" id="close-shift-btn" class="btn btn-primary">Close Shift</button>
                <span id="close-shift-status" style="font-size:12px; color:var(--color-danger); margin-left:10px;"></span>
            </div>
        `;
        document.getElementById('close-shift-btn').addEventListener('click', () => this.closeShift(shift.id));
    }

    async openShift() {
        const statusEl = document.getElementById('open-shift-status');
        const openingFloat = parseFloat(document.getElementById('open-float').value);
        const openingNote = document.getElementById('open-note').value.trim();
        if (!(openingFloat >= 0)) { statusEl.textContent = 'Enter a valid opening float.'; return; }

        try {
            const res = await adminFetch('/api/cash-shifts/open', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ openingFloat, openingNote: openingNote || undefined })
            });
            const body = await res.json();
            if (!res.ok) { statusEl.textContent = body.message || body.error || 'Failed to open the shift.'; return; }
            await this.refresh();
        } catch (err) {
            statusEl.textContent = 'Could not reach the server.';
        }
    }

    async closeShift(shiftId) {
        const statusEl = document.getElementById('close-shift-status');
        const countedCash = parseFloat(document.getElementById('close-counted').value);
        const closingNote = document.getElementById('close-note').value.trim();
        if (!(countedCash >= 0)) { statusEl.textContent = 'Enter what was actually counted.'; return; }

        try {
            const res = await adminFetch(`/api/cash-shifts/${encodeURIComponent(shiftId)}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ countedCash, closingNote: closingNote || undefined })
            });
            const body = await res.json();
            if (!res.ok) { statusEl.textContent = body.message || body.error || 'Failed to close the shift.'; return; }

            const varianceNote = body.variance === 0
                ? 'Drawer matched exactly.'
                : `Variance: ${body.variance > 0 ? '+' : ''}${formatRupees(body.variance)}.`;
            window.alert(`Shift closed. Expected ${formatRupees(body.expectedCash)}. ${varianceNote}`);
            await this.refresh();
        } catch (err) {
            statusEl.textContent = 'Could not reach the server.';
        }
    }

    renderHistory() {
        const tbody = document.getElementById('shift-history-body');
        if (!tbody) return;

        if (this.history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--color-text-light); font-style:italic;">No shifts recorded yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = this.history.map(s => `
            <tr>
                <td style="white-space:nowrap;">${formatWhen(s.openedAt)}</td>
                <td style="white-space:nowrap;">${formatWhen(s.closedAt)}</td>
                <td class="text-right">${formatRupees(s.openingFloat)}</td>
                <td class="text-right">${s.expectedCash != null ? formatRupees(s.expectedCash) : '—'}</td>
                <td class="text-right">${s.countedCash != null ? formatRupees(s.countedCash) : '—'}</td>
                <td class="text-right" style="color:${s.variance ? (s.variance < 0 ? 'var(--color-danger)' : 'var(--color-warning)') : 'inherit'};">${s.variance != null ? (s.variance > 0 ? '+' : '') + formatRupees(s.variance) : '—'}</td>
                <td style="color:var(--color-text-muted);">${escapeHtml(s.closingNote || s.openingNote || '—')}</td>
            </tr>
        `).join('');
    }
}
