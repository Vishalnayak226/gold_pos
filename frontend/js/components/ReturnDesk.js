import { adminFetch, logTelemetry } from '../app.js';
import { computeReturnRefund, round2, round3, describeSaleGoods } from '../lib/billingMath.js';

/**
 * Money for the credit note, always to the paise. Same contract as the copies
 * in BillingDesk and ReprintDesk: every figure reaching this point is already
 * rounded, so the fixed two decimals are a display guarantee rather than a
 * second rounding.
 */
function money(value) {
    return `₹${Number(value || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

/**
 * Escapes HTML-significant characters. Customer name, phone and the cashier's
 * own note are free text stored verbatim in the ledger, so they are untrusted
 * by the time they render back into this authenticated admin screen — same
 * reasoning as the copies in ReprintDesk and Dashboard.
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function formatDate(ts) {
    return ts ? new Date(ts).toLocaleDateString() : '—';
}

function formatWhen(ts) {
    return ts ? new Date(ts).toLocaleString() : '—';
}

/** Rows the recent-returns list shows — and therefore rows it asks for. */
const RECENT_RETURNS = 25;

function grams(value) {
    return `${Number(value || 0).toFixed(3)} g`;
}

/**
 * ==========================================================================
 * Return Desk — refunding part or all of an invoice that has already been filed.
 *
 * THREE RULES THIS SCREEN EXISTS TO KEEP:
 *
 *  1. THE REFUND IS PRICED BY THE ORIGINAL INVOICE, NOT BY TODAY. Metal comes
 *     back at the rate it was sold at, under the tax slab and mode it was sold
 *     under. Re-pricing against the current rate would over-refund after a
 *     rise and short-change the customer after a fall — and either way hand
 *     back a number the store never charged.
 *
 *  2. THE PREVIEW BELOW IS ONLY A PREVIEW. It runs computeReturnRefund() so
 *     the cashier can see the figure before committing, but POST /api/returns
 *     re-runs the identical function server-side and files ITS answer. The
 *     browser names the invoice, the weight and the mode; it never names the
 *     refund. Same posture as the Billing Desk.
 *
 *  3. RETURNS ARE THE STORE'S TO ISSUE. There is no customer-facing way to
 *     raise one — a refund moves money out of the till and that call is made
 *     at the counter with the goods in hand. The customer's phone SHOWS the
 *     return the moment it is filed, and that is all it does.
 *
 * Partial returns are tracked cumulatively: an invoice for 13.435g returned
 * 6g today can still have 7.435g come back next week, and the desk always
 * measures against what is left rather than against the original.
 * ==========================================================================
 */
export class ReturnDesk {
    constructor() {
        this.results = [];
        this.selected = null;
        this.recent = [];
        this.recentTotal = 0;
        this.company = { name: '', logo: '' };
        this.filedReturn = null;
        this.render();
        this.setupEventListeners();
    }

    /** Company identity for the credit-note header, plus the recent-returns list. */
    async refresh() {
        try {
            const [settingsRes, returnsRes] = await Promise.all([
                adminFetch('/api/settings'),
                // Only the rows the list below actually draws. This used to ask
                // for the entire returns ledger to show the last handful.
                adminFetch(`/api/returns?limit=${RECENT_RETURNS}`)
            ]);
            if (settingsRes.ok) {
                const s = await settingsRes.json();
                this.company = {
                    name: s.companyName || '',
                    logo: s.companyLogo || '',
                    address: s.address || '',
                    gstNumber: s.gstNumber || ''
                };
            }
            if (returnsRes.ok) {
                const page = await returnsRes.json();
                this.recent = page.results || [];
                this.recentTotal = page.total || this.recent.length;
                this.renderRecent();
            }
        } catch (err) {
            // The desk still searches and files without either — neither the
            // header nor the history list is on the path that moves money.
        }
    }

    render() {
        const container = document.querySelector('#returns-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div class="no-print">
                <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:78ch;">
                    Refund part or all of a filed invoice. The refund is priced from the invoice
                    itself — the gold rate, making charge, discount and GST it was sold under — never
                    from today's rate. Pay it back as <strong>cash</strong>, or as
                    <strong>gold credit</strong> that lands in the customer's account and shows on
                    their phone straight away.
                </p>

                <div class="new-deposit-form" style="margin-bottom:20px;">
                    <div class="form-group-row">
                        <div class="form-group" style="flex:2;">
                            <label for="return-q">Invoice number, phone, or customer name</label>
                            <input type="text" id="return-q" class="form-control" placeholder="e.g. GOLD-000012-26, 9876543210, or Ramesh">
                        </div>
                        <div class="form-group">
                            <label for="return-from">From</label>
                            <input type="date" id="return-from" class="form-control">
                        </div>
                        <div class="form-group">
                            <label for="return-to">To</label>
                            <input type="date" id="return-to" class="form-control">
                        </div>
                    </div>
                    <div style="display:flex; gap:10px; margin-top:10px;">
                        <button type="button" id="return-search-btn" class="btn btn-primary">FIND INVOICE</button>
                        <button type="button" id="return-clear-btn" class="btn btn-secondary">Clear</button>
                    </div>
                </div>

                <div id="return-results"></div>
                <div id="return-form-container" style="display:none; margin-top:22px;"></div>
            </div>

            <div id="return-note-container" style="display:none;"></div>

            <div class="no-print" style="margin-top:32px;">
                <h3 class="dashboard-section-title">Recent Returns</h3>
                <div id="return-recent"></div>
            </div>
        `;
    }

    setupEventListeners() {
        const searchBtn = document.getElementById('return-search-btn');
        const clearBtn = document.getElementById('return-clear-btn');
        const qInput = document.getElementById('return-q');
        if (!searchBtn) return;

        searchBtn.addEventListener('click', () => this.search());
        // Enter is how a cashier holding the customer's slip actually searches.
        qInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.search();
            }
        });

        clearBtn.addEventListener('click', () => {
            qInput.value = '';
            document.getElementById('return-from').value = '';
            document.getElementById('return-to').value = '';
            this.results = [];
            this.selected = null;
            this.filedReturn = null;
            document.getElementById('return-results').innerHTML = '';
            document.getElementById('return-form-container').style.display = 'none';
            document.getElementById('return-note-container').style.display = 'none';
        });
    }

    async search() {
        const btn = document.getElementById('return-search-btn');
        const resultsEl = document.getElementById('return-results');
        const q = document.getElementById('return-q').value.trim();
        const from = document.getElementById('return-from').value;
        const to = document.getElementById('return-to').value;

        // An unfiltered search would return the entire ledger — same guard the
        // Reprint Desk keeps, for the same reason.
        if (!q && !from && !to) {
            resultsEl.innerHTML = `<p class="text-muted-small" style="color:var(--color-warning);">
                Enter an invoice number, phone, or name — or pick a date range — to find the invoice.
            </p>`;
            return;
        }

        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (from) params.set('from', from);
        if (to) params.set('to', to);

        btn.disabled = true;
        resultsEl.innerHTML = '<p class="text-muted-small">Searching…</p>';
        try {
            const res = await adminFetch(`/api/sales/lookup?${params.toString()}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                resultsEl.innerHTML = `<p class="text-muted-small" style="color:var(--color-danger);">
                    ${escapeHtml(data.error || `Search failed (HTTP ${res.status}).`)}
                </p>`;
                return;
            }
            this.results = data.results || [];
            this.renderResults(data);
            logTelemetry(`Return search returned ${this.results.length} invoice(s).`);
        } catch (err) {
            resultsEl.innerHTML = `<p class="text-muted-small" style="color:var(--color-danger);">
                Could not reach the server to search invoices.
            </p>`;
        } finally {
            btn.disabled = false;
        }
    }

    renderResults(data) {
        const resultsEl = document.getElementById('return-results');

        if (this.results.length === 0) {
            resultsEl.innerHTML = `<p class="text-muted-small">
                No filed invoice matches that. Check the invoice number, or widen the date range —
                only saved invoices can be returned against, so a bill that was printed but never
                saved will not appear here.
            </p>`;
            return;
        }

        const rows = this.results.map(sale => {
            const done = Number(sale.returnedWeightGrams) || 0;
            const state = sale.fullyReturned
                ? '<span style="color:var(--color-danger); font-weight:600;">Fully returned</span>'
                : done > 0
                    ? `<span style="color:var(--color-warning); font-weight:600;">${grams(done)} returned</span>`
                    : '<span class="text-muted-small">—</span>';
            return `
            <tr>
                <td style="font-family:var(--font-mono);">${escapeHtml(sale.id)}</td>
                <td>${escapeHtml(formatWhen(sale.timestamp))}</td>
                <td>${escapeHtml(sale.customerName || 'Cash Sale')}</td>
                <td>${escapeHtml(describeSaleGoods(sale))}</td>
                <td>${state}</td>
                <td class="text-right">${money(sale.totalAmount)}</td>
                <td class="text-right">
                    <button type="button" class="btn btn-secondary btn-sm return-open-btn"
                            data-invoice="${escapeHtml(sale.id)}" ${sale.fullyReturned ? 'disabled' : ''}>
                        ${sale.fullyReturned ? 'Closed' : 'Return'}
                    </button>
                </td>
            </tr>`;
        }).join('');

        resultsEl.innerHTML = `
            ${data.truncated ? `<p class="text-muted-small" style="color:var(--color-warning);">
                Showing the ${this.results.length} most recent of ${data.total} matches — narrow the
                search to see older ones.
            </p>` : ''}
            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Invoice</th>
                        <th>Sold</th>
                        <th>Customer</th>
                        <th>Goods</th>
                        <th>Returns</th>
                        <th class="text-right">Billed</th>
                        <th class="text-right">Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;

        resultsEl.querySelectorAll('.return-open-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sale = this.results.find(s => s.id === btn.getAttribute('data-invoice'));
                if (sale) this.openReturnForm(sale);
            });
        });
    }

    /** The invoice's gross — what it charged, advance included. See computeReturnRefund(). */
    filedGross(sale) {
        return (Number(sale.totalAmount) || 0) + (Number(sale.appliedAdvance) || 0);
    }

    /**
     * Every item on the invoice with weight still on it, and how much.
     *
     * The server computes this (withReturnState) because "what is still
     * returnable" is a question about the returns ledger, not about the sale.
     * `lineReturnState` is absent only on a response from an older server, in
     * which case the invoice is treated as the single line it must have been.
     */
    returnableLines(sale) {
        if (Array.isArray(sale.lineReturnState) && sale.lineReturnState.length > 0) {
            return sale.lineReturnState;
        }
        return [{
            lineNumber: 1,
            description: '',
            purity: sale.purity || '',
            weightGrams: round3(sale.weightGrams),
            goldPricePerGram: round2(sale.goldPricePerGram),
            returnedWeightGrams: round3(sale.returnedWeightGrams || 0),
            returnableWeightGrams: round3(Number(sale.returnableWeightGrams ?? sale.weightGrams) || 0),
            fullyReturned: false
        }];
    }

    /** The line the cashier has picked, or the only one there is. */
    activeLine() {
        const lines = this.returnableLines(this.selected);
        return lines.find(l => l.lineNumber === this.selectedLineNumber) || lines[0];
    }

    openReturnForm(sale) {
        this.selected = sale;
        this.filedReturn = null;
        document.getElementById('return-note-container').style.display = 'none';

        const container = document.getElementById('return-form-container');
        if (!container) return;

        const allLines = this.returnableLines(sale);
        const openLines = allLines.filter(l => l.returnableWeightGrams > 0);
        // Default to the first line with weight left on it — the one a cashier
        // almost always wants, and never a line that would only refuse them.
        this.selectedLineNumber = (openLines[0] || allLines[0]).lineNumber;

        const done = Number(sale.returnedWeightGrams) || 0;
        const hasPhone = /^\d{10}$/.test(String(sale.customerPhone || ''));
        const multiLine = allLines.length > 1;

        container.style.display = 'block';
        container.innerHTML = `
            <div class="new-deposit-form">
                <h3 style="margin:0 0 4px; font-size:16px;">Return against ${escapeHtml(sale.id)}</h3>
                <p class="text-muted-small" style="margin-bottom:16px;">
                    ${escapeHtml(sale.customerName || 'Cash Sale')}
                    ${sale.customerPhone ? ` · ${escapeHtml(sale.customerPhone)}` : ''}
                    · sold ${escapeHtml(formatDate(sale.timestamp))}
                    · ${escapeHtml(describeSaleGoods(sale))}
                    · billed ${money(this.filedGross(sale))}
                </p>

                ${done > 0 ? `
                <p class="text-muted-small" style="color:#92400e; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:8px 12px; margin-bottom:14px;">
                    ${grams(done)} has already come back on this invoice
                    (${money(sale.refundedAmount)} refunded across ${sale.returnCount} return${sale.returnCount === 1 ? '' : 's'}).
                    <strong>${grams(sale.returnableWeightGrams)} remains returnable.</strong>
                </p>` : ''}

                ${multiLine ? `
                <!--
                    Which item is coming back. Not a convenience: the lines on a
                    mixed invoice carry different rates and different making
                    charges, so a refund cannot be priced until the line is
                    known. An exhausted line stays listed but disabled, so a
                    cashier can see it was returned rather than wonder where it
                    went.
                -->
                <div class="form-group">
                    <label for="return-line">Which item is being returned</label>
                    <select id="return-line" class="form-control">
                        ${allLines.map(l => `
                            <option value="${l.lineNumber}"${l.lineNumber === this.selectedLineNumber ? ' selected' : ''}
                                    ${l.returnableWeightGrams > 0 ? '' : 'disabled'}>
                                ${l.lineNumber}. ${escapeHtml(l.description || 'Gold ornament')}
                                — ${escapeHtml(l.purity)} ${grams(l.weightGrams)} @ ${money(l.goldPricePerGram)}/g
                                ${l.returnableWeightGrams > 0
                                    ? `(${grams(l.returnableWeightGrams)} returnable)`
                                    : '(fully returned)'}
                            </option>
                        `).join('')}
                    </select>
                </div>` : ''}

                <div class="form-group-row">
                    <div class="form-group">
                        <label for="return-weight">Weight being returned <span id="return-weight-max"></span></label>
                        <input type="number" id="return-weight" class="form-control"
                               step="0.001" min="0.001">
                    </div>
                    <div class="form-group">
                        <label for="return-note">Reason / note (optional)</label>
                        <input type="text" id="return-note" class="form-control" maxlength="300"
                               placeholder="e.g. size exchange, customer changed mind">
                    </div>
                </div>

                <div class="form-group" style="margin-top:6px;">
                    <label>Refund the customer as</label>
                    <div style="display:flex; gap:22px; flex-wrap:wrap; padding:6px 0;">
                        <label style="display:flex; align-items:center; gap:8px; font-weight:500; cursor:pointer;">
                            <input type="radio" name="return-mode" value="cash" checked style="width:auto; margin:0;">
                            <span>Cash — paid back over the counter</span>
                        </label>
                        <label style="display:flex; align-items:center; gap:8px; font-weight:500; cursor:${hasPhone ? 'pointer' : 'not-allowed'}; opacity:${hasPhone ? '1' : '0.55'};">
                            <input type="radio" name="return-mode" value="gold" style="width:auto; margin:0;" ${hasPhone ? '' : 'disabled'}>
                            <span>Gold — credited to their account</span>
                        </label>
                    </div>
                    ${hasPhone ? '' : `<p class="text-muted-small" style="color:var(--color-warning); margin-top:4px;">
                        This invoice carries no customer phone number, so there is no account to
                        credit. It can only be refunded as cash.
                    </p>`}
                </div>

                <div id="return-preview" style="margin-top:18px;"></div>

                <div style="display:flex; gap:10px; margin-top:18px;">
                    <button type="button" id="return-file-btn" class="btn btn-primary">FILE RETURN &amp; REFUND</button>
                    <button type="button" id="return-cancel-btn" class="btn btn-secondary">Cancel</button>
                </div>
            </div>
        `;

        const weightInput = document.getElementById('return-weight');
        weightInput.addEventListener('input', () => this.renderPreview());
        container.querySelectorAll('input[name="return-mode"]').forEach(radio => {
            radio.addEventListener('change', () => this.renderPreview());
        });

        const lineSelect = document.getElementById('return-line');
        if (lineSelect) {
            lineSelect.addEventListener('change', () => {
                this.selectedLineNumber = Number(lineSelect.value);
                this.resetWeightToLineMax();
                this.renderPreview();
            });
        }

        document.getElementById('return-file-btn').addEventListener('click', () => this.fileReturn());
        document.getElementById('return-cancel-btn').addEventListener('click', () => {
            this.selected = null;
            container.style.display = 'none';
        });

        this.resetWeightToLineMax();
        this.renderPreview();
        container.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    /**
     * Pre-fills the weight box with everything still returnable on the SELECTED
     * line, and re-labels the cap.
     *
     * Switching line has to move both. Leaving line 1's 10 g in the box after
     * picking a 5 g line 2 would offer a return the server is bound to refuse.
     */
    resetWeightToLineMax() {
        const line = this.activeLine();
        const max = round3(line.returnableWeightGrams);
        const input = document.getElementById('return-weight');
        const label = document.getElementById('return-weight-max');
        if (input) {
            input.max = max;
            input.value = max.toFixed(3);
        }
        if (label) label.textContent = `(max ${max.toFixed(3)} g)`;
    }

    /** Whichever refund mode the cashier currently has selected. */
    selectedMode() {
        const checked = document.querySelector('input[name="return-mode"]:checked');
        return checked ? checked.value : 'cash';
    }

    /**
     * Prices the return the cashier is about to file — through the same
     * function the server will re-run on submit, so the figure on screen and
     * the figure in the ledger are produced by one formula, not two.
     */
    renderPreview() {
        const previewEl = document.getElementById('return-preview');
        const sale = this.selected;
        if (!previewEl || !sale) return;

        // Priced against the SELECTED line, with that line's own prior returns
        // as the limit and the invoice's remaining weight deciding whether this
        // return closes the bill. Same arguments the server passes, so the
        // preview and the ledger cannot disagree.
        const line = this.activeLine();
        const refund = computeReturnRefund({
            sale,
            returnWeightGrams: document.getElementById('return-weight').value,
            lineNumber: line.lineNumber,
            alreadyReturnedGrams: line.returnedWeightGrams,
            invoiceRemainingGrams: sale.returnableWeightGrams,
            alreadyRefundedAmount: sale.refundedAmount
        });

        const fileBtn = document.getElementById('return-file-btn');
        if (!refund.ok) {
            if (fileBtn) fileBtn.disabled = true;
            previewEl.innerHTML = `<p class="text-muted-small" style="color:var(--color-danger);">
                ${escapeHtml(refund.error)}
            </p>`;
            return;
        }
        if (fileBtn) fileBtn.disabled = false;

        const isGold = this.selectedMode() === 'gold';
        const rows = refund.itemised ? `
            <div class="summary-row">
                <span>Metal returned (${escapeHtml(refund.purity)} @ ${money(refund.goldPricePerGram)}/g):</span>
                <span>${money(refund.components.metalValue)}</span>
            </div>
            <div class="summary-row">
                <span>Making charges returned:</span>
                <span>${money(refund.components.makingChargeAmount)}</span>
            </div>
            ${refund.discountPercent > 0 ? `
            <div class="summary-row">
                <span>Discount reversed (${escapeHtml(String(refund.discountPercent))}%):</span>
                <span>-${money(refund.components.discountAmount)}</span>
            </div>` : ''}
            <div class="summary-row summary-subtotal">
                <span>Taxable value:</span>
                <span>${money(refund.components.taxableAmount)}</span>
            </div>
            <div class="summary-row">
                <span>GST (${escapeHtml(String(refund.taxPercent))}% ${refund.taxMode === 'Inclusive' ? 'Incl' : 'Excl'}):</span>
                <span>${money(refund.components.taxAmount)}</span>
            </div>
        ` : `
            <div class="summary-row">
                <span>Share of the invoice being returned:</span>
                <span>${(refund.fraction * 100).toFixed(2)}%</span>
            </div>
            <p class="text-muted-small" style="margin:8px 0 0; color:#92400e;">
                This invoice does not carry a stored GST breakdown, so the refund is a straight
                pro-rata share of what it charged rather than an itemised reversal. The total below
                is the ledger's own arithmetic.
            </p>
        `;

        previewEl.innerHTML = `
            <div class="invoice-summary" style="background:var(--color-surface-alt, #f8fafc); border:1px solid var(--color-border, #cbd5e1); border-radius:8px; padding:14px 16px;">
                ${rows}
                <div class="invoice-divider"></div>
                <div class="summary-row grand-total">
                    <span>REFUND ${isGold ? '(GOLD CREDIT)' : '(CASH)'}:</span>
                    <span>${money(refund.refundAmount)}</span>
                </div>
                <p class="text-muted-small" style="margin:10px 0 0;">
                    ${isGold
                        ? 'Credited to the customer\'s advance account and visible on their phone immediately. It can be redeemed against a future bill.'
                        : 'Pay this out from the till. Nothing is credited to the customer\'s account.'}
                    ${/* The item is named only on an invoice that HAS several —
                          on a single-item bill "item 1" is noise, and the
                          sentence should read exactly as it always has. */
                      refund.closesInvoice
                        ? ' This closes the invoice — nothing further can be returned against it.'
                        : refund.closesLine
                            ? ` This closes item ${refund.lineNumber}; other items on this invoice remain returnable.`
                            : this.returnableLines(sale).length > 1
                                ? ` ${grams(refund.remainingWeightAfter)} of item ${refund.lineNumber} would remain returnable afterwards.`
                                : ` ${grams(refund.remainingWeightAfter)} would remain returnable afterwards.`}
                </p>
            </div>
        `;
    }

    async fileReturn() {
        const sale = this.selected;
        if (!sale) return;
        const btn = document.getElementById('return-file-btn');
        const mode = this.selectedMode();
        const weight = document.getElementById('return-weight').value;
        const note = document.getElementById('return-note').value;

        // A refund moves money out of the till and cannot be undone from this
        // screen, so it gets an explicit confirmation rather than firing on a
        // single click of a button the cashier may have been tabbing past.
        const line = this.activeLine();
        const preview = computeReturnRefund({
            sale,
            returnWeightGrams: weight,
            lineNumber: line.lineNumber,
            alreadyReturnedGrams: line.returnedWeightGrams,
            invoiceRemainingGrams: sale.returnableWeightGrams,
            alreadyRefundedAmount: sale.refundedAmount
        });
        if (!preview.ok) {
            alert(preview.error);
            return;
        }
        const itemLabel = this.returnableLines(sale).length > 1
            ? ` (item ${line.lineNumber}: ${line.description || line.purity})`
            : '';
        const confirmed = window.confirm(
            `Refund ${money(preview.refundAmount)} as ${mode === 'gold' ? 'GOLD CREDIT' : 'CASH'} ` +
            `for ${grams(preview.weightGrams)} returned against ${sale.id}${itemLabel}?\n\n` +
            `This is filed to the ledger and cannot be undone from this screen.`
        );
        if (!confirmed) return;

        btn.disabled = true;
        btn.textContent = 'FILING…';
        try {
            const res = await adminFetch('/api/returns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    invoiceId: sale.id,
                    lineNumber: line.lineNumber,
                    weightGrams: Number(weight),
                    refundMode: mode,
                    note
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(data.error || `The return could not be filed (HTTP ${res.status}).`);
                return;
            }

            logTelemetry(`Filed return ${data.returnId} against ${sale.id} — ${money(data.return.refundAmount)} (${mode}).`);
            this.filedReturn = data.return;
            document.getElementById('return-form-container').style.display = 'none';
            document.getElementById('return-results').innerHTML = '';
            this.renderCreditNote(data.return);
            this.refresh();
        } catch (err) {
            alert('Could not reach the server to file the return. Nothing was saved — please retry.');
        } finally {
            btn.disabled = false;
            btn.textContent = 'FILE RETURN & REFUND';
        }
    }

    renderCreditNote(record) {
        const container = document.getElementById('return-note-container');
        if (!container) return;

        const header = this.company.logo
            ? `<img src="${escapeHtml(this.company.logo)}" alt="" style="max-height:80px; margin:0 auto 10px auto; display:block;">`
            : `<h2>${escapeHtml(this.company.name || 'UNIVERSAL GOLD POS')}</h2>`;

        const isGold = record.refundMode === 'gold';

        container.style.display = 'block';
        container.innerHTML = `
            <div class="no-print" style="display:flex; gap:10px; align-items:center; margin:20px 0;">
                <button type="button" id="return-print-btn" class="btn btn-primary">PRINT CREDIT NOTE</button>
                <button type="button" id="return-close-btn" class="btn btn-secondary">Close</button>
                <span class="text-muted-small">
                    Filed ${escapeHtml(formatWhen(record.timestamp))}
                </span>
            </div>

            <div class="billing-invoice-preview">
                <div class="invoice-sheet">
                    <div class="invoice-header">
                        ${header}
                        <p>CREDIT NOTE</p>
                        <p style="margin-top:8px; font-weight:700; letter-spacing:0.12em; color:#b45309; border:2px solid #b45309; border-radius:4px; padding:4px 8px; display:inline-block; font-size:12px;">
                            RETURN &amp; REFUND
                        </p>
                    </div>
                    <div class="invoice-divider"></div>
                    <div class="invoice-meta">
                        <p><strong>Credit note:</strong> <span style="font-family:var(--font-mono);">${escapeHtml(record.id)}</span></p>
                        <p><strong>Against invoice:</strong> <span style="font-family:var(--font-mono);">${escapeHtml(record.originalInvoiceId)}</span> (${escapeHtml(formatDate(record.originalTimestamp))})</p>
                        <p><strong>Customer:</strong> ${escapeHtml(record.customerName || 'Cash Sale')}</p>
                        <p><strong>Phone:</strong> ${escapeHtml(record.customerPhone || '-')}</p>
                        <p><strong>Date:</strong> ${escapeHtml(formatDate(record.timestamp))}</p>
                    </div>
                    <div class="invoice-divider"></div>
                    <table class="invoice-table">
                        <thead>
                            <tr>
                                <th>Description</th>
                                <th class="text-right">Qty/Wt</th>
                                <th class="text-right">Rate/g</th>
                                <th class="text-right">Value (₹)</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>${escapeHtml(record.description || 'Gold Ornament')} returned (${escapeHtml(record.purity || '')})${
                                    // Named only when the original invoice had
                                    // several items — otherwise "item 1 of 1" is
                                    // noise on a customer's document.
                                    record.lineNumber > 1 || record.invoiceWeightGrams > record.originalWeightGrams
                                        ? ` <span style="font-size:11px; opacity:0.75;">— item ${escapeHtml(String(record.lineNumber || 1))} of invoice</span>`
                                        : ''
                                }</td>
                                <td class="text-right">${grams(record.weightGrams)}</td>
                                <td class="text-right">${money(record.goldPricePerGram)}</td>
                                <td class="text-right">${record.itemised ? money(record.metalValue) : '—'}</td>
                            </tr>
                        </tbody>
                    </table>

                    <div class="invoice-summary">
                        ${record.itemised ? `
                        <div class="summary-row">
                            <span>Metal Value:</span>
                            <span>${money(record.metalValue)}</span>
                        </div>
                        <div class="summary-row">
                            <span>Making Charges (${escapeHtml(String(record.makingChargePercent ?? 0))}%):</span>
                            <span>${money(record.makingChargeAmount)}</span>
                        </div>
                        ${Number(record.discountPercent) > 0 ? `
                        <div class="summary-row">
                            <span>Discount reversed (${escapeHtml(String(record.discountPercent))}%):</span>
                            <span>-${money(record.discount)}</span>
                        </div>` : ''}
                        <div class="summary-row summary-subtotal">
                            <span>Taxable Value:</span>
                            <span>${money(record.taxableAmount)}</span>
                        </div>
                        <div class="summary-row">
                            <span>GST (${escapeHtml(String(record.taxPercent ?? 0))}% ${record.taxMode === 'Inclusive' ? 'Incl' : 'Excl'}):</span>
                            <span>${money(record.taxAmount)}</span>
                        </div>` : `
                        <div class="summary-row">
                            <span>Returned portion of invoice ${escapeHtml(record.originalInvoiceId)}:</span>
                            <span>${grams(record.weightGrams)} of ${grams(record.originalWeightGrams)}</span>
                        </div>
                        <div class="summary-row">
                            <span>Itemised breakdown:</span>
                            <span style="font-style:italic; color:#64748b;">not recorded on the original invoice</span>
                        </div>`}
                        <div class="invoice-divider"></div>
                        <div class="summary-row grand-total">
                            <span>REFUNDED (${isGold ? 'GOLD CREDIT' : 'CASH'}):</span>
                            <span>${money(record.refundAmount)}</span>
                        </div>
                    </div>

                    ${isGold ? `
                    <p style="text-align:center; font-size:12px; color:#1e293b; margin-top:16px; font-weight:600;">
                        ${money(record.refundAmount)} has been credited to your account and is
                        available on your customer portal. It can be redeemed against a future purchase.
                    </p>` : ''}

                    ${record.note ? `
                    <p style="font-size:11px; color:#64748b; margin-top:14px;">
                        <strong>Note:</strong> ${escapeHtml(record.note)}
                    </p>` : ''}

                    <p style="text-align:center; font-size:11px; color:#64748b; margin-top:18px;">
                        ${record.closesInvoice
                            ? `Invoice ${escapeHtml(record.originalInvoiceId)} is fully returned.`
                            : `Partial return against invoice ${escapeHtml(record.originalInvoiceId)}.`}
                        Issued ${escapeHtml(new Date(record.timestamp).toLocaleString())}.
                    </p>
                </div>
            </div>
        `;

        document.getElementById('return-print-btn').addEventListener('click', () => {
            logTelemetry(`Printed credit note ${record.id}.`);
            window.print();
        });
        document.getElementById('return-close-btn').addEventListener('click', () => {
            this.filedReturn = null;
            container.style.display = 'none';
        });

        container.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    renderRecent() {
        const el = document.getElementById('return-recent');
        if (!el) return;

        if (!this.recent || this.recent.length === 0) {
            el.innerHTML = '<p class="text-muted-small">No returns have been filed yet.</p>';
            return;
        }

        const rows = this.recent.map(r => `
            <tr>
                <td style="font-family:var(--font-mono);">${escapeHtml(r.id)}</td>
                <td>${escapeHtml(formatWhen(r.timestamp))}</td>
                <td style="font-family:var(--font-mono);">${escapeHtml(r.originalInvoiceId)}</td>
                <td>${escapeHtml(r.customerName || 'Cash Sale')}</td>
                <td>${escapeHtml(r.actor ? r.actor.name : '—')}</td>
                <td class="text-right">${grams(r.weightGrams)}</td>
                <td>${r.refundMode === 'gold'
                    ? '<span style="color:#b45309; font-weight:600;">GOLD CREDIT</span>'
                    : '<span style="color:#0f766e; font-weight:600;">CASH</span>'}</td>
                <td class="text-right">${money(r.refundAmount)}</td>
                <td class="text-right">
                    <button type="button" class="btn btn-secondary btn-sm return-reprint-btn"
                            data-return="${escapeHtml(r.id)}">Note</button>
                </td>
            </tr>
        `).join('');

        el.innerHTML = `
            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Credit note</th>
                        <th>Filed</th>
                        <th>Invoice</th>
                        <th>Customer</th>
                        <!-- Who authorised the refund. A cash refund moves money
                             out of the till; the ledger names the person now. -->
                        <th>Refunded by</th>
                        <th class="text-right">Weight</th>
                        <th>Mode</th>
                        <th class="text-right">Refunded</th>
                        <th class="text-right">Reprint</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            ${this.recentTotal > this.recent.length
                ? `<p class="text-muted-small" style="margin-top:8px;">Showing the
                     ${this.recent.length} most recent of ${this.recentTotal} credit notes.
                     Search an invoice above to find an older one.</p>`
                : ''}
        `;

        el.querySelectorAll('.return-reprint-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const record = this.recent.find(r => r.id === btn.getAttribute('data-return'));
                if (record) this.renderCreditNote(record);
            });
        });
    }
}
