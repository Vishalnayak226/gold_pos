import { adminFetch, logTelemetry } from '../app.js';
import { computeInvoiceTotals, normalizeTaxMode, saleLines, describeSaleGoods } from '../lib/billingMath.js';

/**
 * Money for the invoice, always to the paise. Same contract as BillingDesk's
 * copy: every figure reaching this point is already rounded, so the fixed two
 * decimals are a display guarantee rather than a second rounding.
 */
function money(value) {
    return `₹${Number(value || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

/**
 * Escapes HTML-significant characters. Customer name and phone are typed at
 * the counter and stored verbatim in the ledger, so they are untrusted text by
 * the time they are rendered back — the same reasoning as the copies in
 * AdvancesManager and CustomerAccountsManager.
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

/**
 * ==========================================================================
 * Reprint Desk — a second copy of an invoice that has already been filed.
 *
 * THE ONE RULE THIS SCREEN EXISTS TO KEEP: a reprint shows what was filed, not
 * what today's settings would price. Every figure comes off the stored sale
 * record in sales_YYYY.json. The gold rate moves daily, the tax slab and tax
 * mode are editable in Settings, and the discount default changes — so pricing
 * a three-month-old invoice against today's configuration would hand the
 * customer a "duplicate" that matches neither their original slip nor the
 * books. The whole point of a duplicate is that it is not a new document.
 *
 * The one thing computed rather than read is how the stored gross figures
 * split across the printed rows in Inclusive mode (metal and making net of the
 * GST shown beneath them). That runs through computeInvoiceTotals — the same
 * module the original invoice was priced with — fed entirely from the stored
 * record, and the result is checked against the stored total before it is
 * trusted. A mismatch is shown, not hidden: see renderInvoice().
 * ==========================================================================
 */
export class ReprintDesk {
    constructor() {
        this.results = [];
        this.lastSearchData = null;
        this.selected = null;
        this.company = { name: '', logo: '' };
        this.render();
        this.setupEventListeners();
    }

    /** Company identity for the sheet header, so a duplicate looks like the original. */
    async refresh() {
        try {
            const res = await adminFetch('/api/settings');
            if (!res.ok) return;
            const s = await res.json();
            this.company = {
                name: s.companyName || '',
                logo: s.companyLogo || '',
                address: s.address || '',
                gstNumber: s.gstNumber || ''
            };
            if (this.selected) this.renderInvoice(this.selected);
        } catch (err) {
            // Header falls back to the static default — never blocks a reprint.
        }
    }

    render() {
        const container = document.querySelector('#reprint-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div class="reprint-controls">
                <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:75ch;">
                    Find a filed invoice and print another copy of it. Every figure shown is the one
                    written to the ledger when the sale was saved — reprints are never re-priced
                    against today's gold rate or tax settings.
                </p>

                <div class="new-deposit-form" style="margin-bottom:20px;">
                    <div class="form-group-row">
                        <div class="form-group" style="flex:2;">
                            <label for="reprint-q">Invoice number, phone, or customer name</label>
                            <input type="text" id="reprint-q" class="form-control" placeholder="e.g. GOLD-000012-26, 9876543210, or Ramesh">
                        </div>
                        <div class="form-group">
                            <label for="reprint-from">From</label>
                            <input type="date" id="reprint-from" class="form-control">
                        </div>
                        <div class="form-group">
                            <label for="reprint-to">To</label>
                            <input type="date" id="reprint-to" class="form-control">
                        </div>
                    </div>
                    <div style="display:flex; gap:10px; margin-top:10px;">
                        <button type="button" id="reprint-search-btn" class="btn btn-primary">SEARCH INVOICES</button>
                        <button type="button" id="reprint-clear-btn" class="btn btn-secondary">Clear</button>
                    </div>
                </div>

                <div id="reprint-results"></div>
            </div>

            <div id="reprint-sheet-container" style="display:none;"></div>
        `;
    }

    setupEventListeners() {
        const searchBtn = document.getElementById('reprint-search-btn');
        const clearBtn = document.getElementById('reprint-clear-btn');
        const qInput = document.getElementById('reprint-q');
        if (!searchBtn) return;

        searchBtn.addEventListener('click', () => this.search());
        // Enter is how a cashier with a slip in one hand actually searches.
        qInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.search();
            }
        });

        clearBtn.addEventListener('click', () => {
            qInput.value = '';
            document.getElementById('reprint-from').value = '';
            document.getElementById('reprint-to').value = '';
            this.results = [];
            this.selected = null;
            document.getElementById('reprint-results').innerHTML = '';
            document.getElementById('reprint-sheet-container').style.display = 'none';
        });
    }

    async search() {
        const btn = document.getElementById('reprint-search-btn');
        const resultsEl = document.getElementById('reprint-results');
        const q = document.getElementById('reprint-q').value.trim();
        const from = document.getElementById('reprint-from').value;
        const to = document.getElementById('reprint-to').value;

        // An unfiltered search would return the entire ledger. Asking for one
        // filter is cheaper for the cashier than scrolling ten years of sales.
        if (!q && !from && !to) {
            resultsEl.innerHTML = `<p class="text-muted-small" style="color:var(--color-warning);">
                Enter an invoice number, phone, or name — or pick a date range — to search.
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
            this.lastSearchData = data;
            this.renderResults(data);
            logTelemetry(`Reprint search returned ${this.results.length} invoice(s).`);
        } catch (err) {
            resultsEl.innerHTML = `<p class="text-muted-small" style="color:var(--color-danger);">
                Could not reach the server to search invoices.
            </p>`;
        } finally {
            btn.disabled = false;
        }
    }

    renderResults(data) {
        const resultsEl = document.getElementById('reprint-results');

        if (this.results.length === 0) {
            resultsEl.innerHTML = `<p class="text-muted-small">
                No filed invoice matches that. Check the invoice number, or widen the date range —
                only saved invoices appear here, so a bill that was printed but never saved will not.
            </p>`;
            return;
        }

        const rows = this.results.map(sale => `
            <tr>
                <td style="font-family:var(--font-mono);">${escapeHtml(sale.id)}</td>
                <td>${escapeHtml(formatWhen(sale.timestamp))}</td>
                <td>${escapeHtml(sale.customerName || 'Cash Sale')}</td>
                <td>${escapeHtml(sale.customerPhone || '—')}</td>
                <td>${escapeHtml(describeSaleGoods(sale))}</td>
                <td class="text-right">${money(sale.totalAmount)}</td>
                <td>${sale.deliveryStatus === 'delivered'
                    ? `<span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; color:var(--color-success); background:var(--color-success-bg);" title="${sale.deliveredAt ? formatWhen(sale.deliveredAt) : ''}">Delivered</span>`
                    : '<span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; color:var(--color-text-muted); background:var(--color-surface-alt, #f1f5f9);">Pending</span>'}
                    <button type="button" class="btn btn-secondary btn-sm toggle-delivery-btn" style="margin-left:6px;"
                            data-invoice="${escapeHtml(sale.id)}" data-delivered="${sale.deliveryStatus === 'delivered' ? '1' : '0'}">
                        ${sale.deliveryStatus === 'delivered' ? 'Mark Pending' : 'Mark Delivered'}
                    </button>
                </td>
                <td class="text-right">
                    <button type="button" class="btn btn-secondary btn-sm reprint-open-btn"
                            data-invoice="${escapeHtml(sale.id)}">Open</button>
                    ${sale.state !== 'cancelled' ? `<button type="button" class="btn btn-secondary btn-sm void-invoice-btn"
                            data-invoice="${escapeHtml(sale.id)}">Void</button>` : ''}
                </td>
            </tr>
        `).join('');

        resultsEl.innerHTML = `
            ${data.truncated ? `<p class="text-muted-small" style="color:var(--color-warning);">
                Showing the ${this.results.length} most recent of ${data.total} matches — narrow the
                search to see older ones.
            </p>` : ''}
            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Invoice</th>
                        <th>Saved</th>
                        <th>Customer</th>
                        <th>Phone</th>
                        <th>Goods</th>
                        <th class="text-right">Total</th>
                        <th>Delivery</th>
                        <th class="text-right">Reprint</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;

        resultsEl.querySelectorAll('.reprint-open-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sale = this.results.find(s => s.id === btn.getAttribute('data-invoice'));
                if (sale) this.renderInvoice(sale);
            });
        });
        resultsEl.querySelectorAll('.toggle-delivery-btn').forEach(btn => {
            btn.addEventListener('click', () => this.toggleDelivery(
                btn.getAttribute('data-invoice'), btn.getAttribute('data-delivered') === '1'
            ));
        });
        resultsEl.querySelectorAll('.void-invoice-btn').forEach(btn => {
            btn.addEventListener('click', () => this.voidInvoice(btn.getAttribute('data-invoice')));
        });
    }

    async voidInvoice(invoiceNumber) {
        const reason = window.prompt(
            `Cancel ${invoiceNumber}? This is only allowed on the same business date and restores linked stock.\n\nEnter a reason (at least 5 characters):`
        );
        if (reason === null) return;
        if (reason.trim().length < 5) {
            alert('Enter a cancellation reason of at least 5 characters.');
            return;
        }
        if (!window.confirm(`Permanently mark ${invoiceNumber} CANCELLED? Filed rows remain in the audit trail.`)) return;
        try {
            const res = await adminFetch(`/api/sales/${encodeURIComponent(invoiceNumber)}/void`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: reason.trim() })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(body.error || 'The invoice could not be cancelled.');
                return;
            }
            const index = this.results.findIndex(sale => sale.id === invoiceNumber);
            if (index >= 0) this.results[index] = body.sale;
            this.renderResults(this.lastSearchData || { truncated: false, total: this.results.length });
            logTelemetry(`Cancelled invoice ${invoiceNumber}.`);
        } catch (err) {
            alert('Could not reach the server. Nothing was cancelled.');
        }
    }

    /** Flips an invoice's delivery status. Reversible on purpose — see the route's own comment for why. */
    async toggleDelivery(invoiceNumber, currentlyDelivered) {
        try {
            const res = await adminFetch(`/api/sales/${encodeURIComponent(invoiceNumber)}/delivery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ delivered: !currentlyDelivered })
            });
            const body = await res.json();
            if (!res.ok) {
                alert(body.message || body.error || 'Failed to update delivery status.');
                return;
            }
            const sale = this.results.find(s => s.id === invoiceNumber);
            if (sale) {
                sale.deliveryStatus = body.deliveryStatus;
                sale.deliveredAt = body.deliveredAt;
            }
            this.renderResults(this.lastSearchData || { truncated: false, total: this.results.length });
            logTelemetry(`Invoice ${invoiceNumber} marked ${body.deliveryStatus}.`);
        } catch (err) {
            alert('Could not reach the server.');
        }
    }

    /**
     * Splits the stored gross figures into the rows the sheet prints.
     *
     * In Exclusive mode the stored metal and making figures ARE the printed
     * ones. In Inclusive mode they contain the GST that is also printed on its
     * own line beneath them, so they have to be carved down or the rows
     * overshoot the total by exactly the tax — the same problem BillingDesk
     * solves, solved by the same function rather than by a second formula.
     *
     * Fed only from the stored record, then verified against the stored total.
     * If the two disagree the caller shows the gross figures and says so: an
     * unexplained rupee on a duplicate invoice is worse than a plain one.
     *
     * Returns three facts about the record, which the sheet renders differently:
     *
     *   legacy  — filed before the sale record carried taxableAmount, taxAmount
     *             and taxMode (invoices from before Phase 20). The tax split was
     *             never written down, so there is nothing to reprint: guessing
     *             it today from the current slab would put a GST figure on a
     *             document that never carried one. Such a sheet prints the total
     *             that WAS filed and says the breakdown is unavailable.
     *   agrees  — the stored figures reconcile, so the row split can be trusted.
     *   rows    — that split.
     */
    derivePrintedRows(sale) {
        const legacy = sale.taxableAmount === undefined || sale.taxAmount === undefined;

        // Rebuilt from the invoice's OWN lines, whether it stored several or is
        // a pre-multi-line record that saleLines() reads as one. Passing the
        // rolled-up scalars instead would reconcile a mixed-purity invoice
        // against an average rate it was never billed at.
        const lines = saleLines(sale);
        const totals = computeInvoiceTotals({
            lines: lines.map(l => ({
                metalValue: l.metalValue,
                makingChargeAmount: l.makingChargeAmount,
                discountPercent: l.discountPercent
            })),
            discountPercent: sale.discountPercent,
            taxSlab: sale.taxPercent,
            taxMode: sale.taxMode,
            appliedAdvance: sale.appliedAdvance,
            // The stored figure is already the resolved, clamped one — pass it
            // as the balance too so the clamp cannot alter it.
            customerAdvanceBalance: sale.appliedAdvance
        });

        const agrees = !legacy
            && Math.abs(totals.totalAmount - Number(sale.totalAmount)) < 0.01
            && Math.abs(totals.taxAmount - Number(sale.taxAmount)) < 0.01;

        return { rows: totals.components, lines, agrees, legacy };
    }

    renderInvoice(sale) {
        this.selected = sale;
        const container = document.getElementById('reprint-sheet-container');
        if (!container) return;

        const { rows, lines, agrees, legacy } = this.derivePrintedRows(sale);
        const isInclusive = normalizeTaxMode(sale.taxMode) === 'Inclusive';
        // Only a trusted inclusive split restates its rows, so only that case
        // may claim to be net of GST.
        const netNote = (agrees && isInclusive) ? ' (net of GST)' : '';

        // When the split cannot be trusted, print the stored gross figures.
        // They are the ledger's own numbers; only the row-level breakdown is
        // in doubt, and the totals below are stored either way.
        const metalRow = agrees ? rows.metalValue : sale.metalValue;
        const makingRow = agrees ? rows.makingChargeAmount : sale.makingChargeAmount;
        const discountRow = agrees ? rows.discountAmount : sale.discount;

        const header = this.company.logo
            ? `<img src="${escapeHtml(this.company.logo)}" alt="" style="max-height:80px; margin:0 auto 10px auto; display:block;">`
            : `<h2>${escapeHtml(this.company.name || 'UNIVERSAL GOLD POS')}</h2>`;

        container.style.display = 'block';
        container.innerHTML = `
            <div class="reprint-controls" style="display:flex; gap:10px; align-items:center; margin:20px 0;">
                <button type="button" id="reprint-print-btn" class="btn btn-primary">PRINT DUPLICATE</button>
                <button type="button" id="reprint-close-btn" class="btn btn-secondary">Close</button>
                ${sale.state === 'cancelled' ? `<strong style="color:var(--color-danger);">CANCELLED — ${escapeHtml(sale.cancelReason || '')}</strong>` : ''}
                <span class="text-muted-small">
                    Filed ${escapeHtml(formatWhen(sale.timestamp))}${sale.goldRateSource ? ` · rate source: ${escapeHtml(sale.goldRateSource)}` : ''}${
                        // Who billed it. Shown on the desk's control strip, not
                        // on the customer's copy — it is an internal audit fact,
                        // and the .reprint-controls class is excluded from print.
                        sale.actor ? ` · billed by ${escapeHtml(sale.actor.name)} (${escapeHtml(sale.actor.role)})` : ''
                    }${
                        Array.isArray(sale.tenders) && sale.tenders.length > 0
                            ? ` · paid ${escapeHtml(sale.tenders.map(t => `${t.method} ${money(t.amount)}`).join(' + '))}`
                            : ''
                    }
                </span>
            </div>

            ${legacy ? `
            <p class="reprint-controls" style="font-size:13px; color:#92400e; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:10px 12px; margin-bottom:12px;">
                <strong>This invoice predates itemised GST storage.</strong> Only its total was filed
                — the taxable value and tax amount were never recorded against it, so they cannot be
                reprinted. The figures below are exactly what is in the ledger.
            </p>` : agrees ? '' : `
            <p class="reprint-controls" style="font-size:13px; color:#92400e; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:10px 12px; margin-bottom:12px;">
                <strong>Row breakdown unavailable.</strong> The stored line items do not reconcile
                against the stored total for this invoice, so the metal and making figures below are
                shown exactly as filed rather than split. The totals are the ledger's own. Worth
                raising with support before handing this to a customer.
            </p>`}

            <div class="billing-invoice-preview">
                <div class="invoice-sheet">
                    <div class="invoice-header">
                        ${header}
                        <p>TAX INVOICE</p>
                        <!--
                            Marked on the document itself, not just on screen.
                            A duplicate that is indistinguishable from the
                            original is a second payable-looking bill, and the
                            store cannot tell later which copy was the one the
                            customer settled against.
                        -->
                        <p style="margin-top:8px; font-weight:700; letter-spacing:0.12em; color:#b91c1c; border:2px solid #b91c1c; border-radius:4px; padding:4px 8px; display:inline-block; font-size:12px;">
                            DUPLICATE — REPRINT
                        </p>
                    </div>
                    <div class="invoice-divider"></div>
                    <div class="invoice-meta">
                        <p><strong>Invoice:</strong> <span style="font-family:var(--font-mono);">${escapeHtml(sale.id)}</span></p>
                        <p><strong>Customer:</strong> ${escapeHtml(sale.customerName || 'Cash Sale')}</p>
                        <p><strong>Phone:</strong> ${escapeHtml(sale.customerPhone || '-')}</p>
                        <p><strong>Date:</strong> ${escapeHtml(formatDate(sale.timestamp))}</p>
                    </div>
                    <div class="invoice-divider"></div>
                    <table class="invoice-table">
                        <thead>
                            <tr>
                                <th>Description</th>
                                <th class="text-right">Qty/Wt</th>
                                <th class="text-right">Rate/g</th>
                                <th class="text-right">Total (₹)</th>
                            </tr>
                        </thead>
                        <!--
                            One row per item AS FILED. A duplicate has to
                            reproduce the original document, so a two-item
                            invoice reprints two rows — collapsing them into one
                            averaged line would hand the customer a "duplicate"
                            that describes goods they did not buy.
                        -->
                        <tbody>
                            ${lines.map(l => `
                            <tr>
                                <td>${escapeHtml(l.description || 'Gold Ornament')} (${escapeHtml(l.purity || '')})</td>
                                <td class="text-right">${Number(l.weightGrams || 0).toFixed(3)} g</td>
                                <td class="text-right">${money(l.goldPricePerGram)}</td>
                                <td class="text-right">${money(l.metalValue)}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>

                    <div class="invoice-summary">
                        <div class="summary-row">
                            <span>Metal Value${netNote}:</span>
                            <span>${money(metalRow)}</span>
                        </div>
                        <div class="summary-row">
                            <span>Making Charges (${escapeHtml(String(sale.makingChargePercent ?? 0))}%)${netNote}:</span>
                            <span>${money(makingRow)}</span>
                        </div>
                        ${Number(sale.discountPercent) > 0 ? `
                        <div class="summary-row">
                            <span>Discount (${escapeHtml(String(sale.discountPercent))}%)${netNote}:</span>
                            <span>-${money(discountRow)}</span>
                        </div>` : ''}
                        <!--
                            Omitted entirely on a pre-Phase-20 record rather
                            than printed as ₹0.00. A zero GST line on a
                            duplicate reads as "no tax was charged", which is a
                            statement about a tax period this system never
                            recorded and has no business making.
                        -->
                        ${legacy ? `
                        <div class="summary-row">
                            <span>Taxable Value / GST:</span>
                            <span style="font-style:italic; color:#64748b;">not recorded on this invoice</span>
                        </div>` : `
                        <div class="summary-row summary-subtotal">
                            <span>Taxable Value (Metal + Making):</span>
                            <span>${money(sale.taxableAmount)}</span>
                        </div>
                        <div class="summary-row">
                            <span>GST Tax (${escapeHtml(String(sale.taxPercent ?? 0))}% ${isInclusive ? 'Incl' : 'Excl'}):</span>
                            <span>${money(sale.taxAmount)}</span>
                        </div>`}
                        ${Number(sale.appliedAdvance) > 0 ? `
                        <div class="summary-row">
                            <span>Advance Redeemed:</span>
                            <span>-${money(sale.appliedAdvance)}</span>
                        </div>` : ''}
                        <div class="invoice-divider"></div>
                        <div class="summary-row grand-total">
                            <span>GRAND TOTAL:</span>
                            <span>${money(sale.totalAmount)}</span>
                        </div>
                    </div>

                    <p style="text-align:center; font-size:11px; color:#64748b; margin-top:18px;">
                        Duplicate copy of invoice ${escapeHtml(sale.id)}, reprinted ${escapeHtml(new Date().toLocaleString())}.
                    </p>
                </div>
            </div>
        `;

        document.getElementById('reprint-print-btn').addEventListener('click', () => {
            logTelemetry(`Reprinted invoice ${sale.id}.`);
            window.print();
        });
        document.getElementById('reprint-close-btn').addEventListener('click', () => {
            this.selected = null;
            container.style.display = 'none';
        });

        container.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
}
