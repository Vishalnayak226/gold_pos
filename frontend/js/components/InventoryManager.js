import { adminFetch, logTelemetry } from '../app.js';

/**
 * Escapes HTML-significant characters. Item names, categories and reasons
 * are free-text fields typed by staff, so every one of them is
 * attacker-controlled text arriving into the authenticated admin session —
 * the same reasoning as AuditTrail's copy of this helper.
 */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function formatWhen(ts) {
    return ts ? new Date(ts).toLocaleString() : '—';
}

function formatGrams(g) {
    return `${Number(g).toFixed(2)} g`;
}

/** `null`/`undefined` prints as an em dash — a catalogue field nobody has filled in yet, not a zero. */
function formatGramsOrDash(g) {
    return g == null ? '—' : formatGrams(g);
}

function formatAmountOrDash(amount) {
    return amount == null ? '—' : `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Lot inventory — items, lots, and the movements that explain a lot's
 * current weight (roadmap Phase 5.2, the ungated slice).
 *
 * Deliberately has no "Receive Purchase" or "Transfer to Branch" action —
 * the roadmap's own P2 section gates both behind a legal/business
 * definition (GST reverse-charge treatment, inter-GSTIN accounting) that
 * has never been made. Stock only ever enters through "+ New Lot" (an
 * opening-balance entry) or changes through "Adjust" (a physical count
 * correction) — both internal facts with no tax event of their own. See
 * backend/repositories/migrations/006_lot_inventory.sql for the full
 * reasoning.
 *
 * Also carries the SKU-catalogue slice (roadmap Phase 5.1) that 006 reserved
 * `sku_code` for: barcode/HSN/gross-net-stone weight on the item (the
 * design's nominal figures), hallmark/HUID on the lot (BIS assigns one per
 * physical article, not per design). Billing can now resolve a barcode/SKU,
 * bind an exact lot, and post sale/return/void movements atomically with the
 * financial document. See migrations 011 and 016.
 */
export class InventoryManager {
    constructor() {
        this.stock = [];
        this.items = [];
        this.movements = [];
        this.expandedItemId = null;
        this.lotsByItem = new Map();
        this.editingItemId = null;
        this.render();
    }

    render() {
        const container = document.querySelector('#inventory-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <p style="font-size:13px; color:var(--color-text-muted); margin-bottom:18px; max-width:70ch;">
                Track what is physically on the shelf, lot by lot. Stock enters through an
                <strong>opening balance</strong>, leaves through a linked <strong>sale</strong>, and
                returns through a filed return or same-day void. Physical-count adjustments remain
                append-only, so every balance is derivable from movement history.
            </p>

            <div class="advances-toolbar">
                <input type="text" id="inventory-search" class="form-control" placeholder="Search by item name, category, barcode or HSN...">
                <button type="button" id="inventory-refresh-btn" class="btn btn-secondary">Refresh</button>
                <button type="button" id="inventory-new-item-btn" class="btn btn-secondary">+ New Item</button>
                <button type="button" id="inventory-new-lot-btn" class="btn btn-primary">+ New Lot</button>
            </div>

            <div id="new-item-form" class="new-deposit-form" style="display:none;">
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="item-name">Item Name</label>
                        <input type="text" id="item-name" class="form-control" maxlength="200">
                    </div>
                    <div class="form-group">
                        <label for="item-category">Category</label>
                        <input type="text" id="item-category" class="form-control" maxlength="100" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="item-purity">Purity</label>
                        <select id="item-purity" class="form-control">
                            <option value="22K">22K</option>
                            <option value="24K">24K</option>
                            <option value="18K">18K</option>
                        </select>
                    </div>
                </div>
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="item-sku">Barcode / SKU</label>
                        <input type="text" id="item-sku" class="form-control" maxlength="64" placeholder="Scan or type — optional">
                    </div>
                    <div class="form-group">
                        <label for="item-hsn">HSN Code</label>
                        <input type="text" id="item-hsn" class="form-control" maxlength="20" placeholder="e.g. 7113">
                    </div>
                </div>
                <p style="font-size:12px; color:var(--color-text-muted); margin:4px 0 8px;">
                    Gross/net/stone weight below are the design's nominal figures for the catalogue and the
                    printed tag — what actually sells is still whatever the scale reads at billing.
                </p>
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="item-gross-weight">Gross Weight (g)</label>
                        <input type="number" id="item-gross-weight" class="form-control" min="0.001" step="0.001" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="item-net-weight">Net (Metal) Weight (g)</label>
                        <input type="number" id="item-net-weight" class="form-control" min="0.001" step="0.001" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="item-stone-weight">Stone Weight (g)</label>
                        <input type="number" id="item-stone-weight" class="form-control" min="0" step="0.001" placeholder="Optional">
                    </div>
                    <div class="form-group">
                        <label for="item-stone-value">Stone Value (₹)</label>
                        <input type="number" id="item-stone-value" class="form-control" min="0" step="0.01" placeholder="Optional">
                    </div>
                </div>
                <div style="display:flex; gap:10px;">
                    <button type="button" id="submit-item-btn" class="btn btn-primary">Save Item</button>
                    <button type="button" id="cancel-item-btn" class="btn btn-secondary">Cancel</button>
                </div>
                <span id="item-form-status" style="font-size:12px; color:var(--color-danger);"></span>
            </div>

            <div id="new-lot-form" class="new-deposit-form" style="display:none;">
                <div class="form-group-row">
                    <div class="form-group">
                        <label for="lot-item">Item</label>
                        <select id="lot-item" class="form-control"></select>
                    </div>
                    <div class="form-group">
                        <label for="lot-weight">Weight (g)</label>
                        <input type="number" id="lot-weight" class="form-control" min="0.001" step="0.001">
                    </div>
                    <div class="form-group">
                        <label for="lot-label">Label</label>
                        <input type="text" id="lot-label" class="form-control" maxlength="200" placeholder="e.g. Opening stock">
                    </div>
                    <div class="form-group">
                        <label for="lot-huid">Hallmark HUID</label>
                        <input type="text" id="lot-huid" class="form-control" maxlength="32" placeholder="If this lot is one piece">
                    </div>
                    <div class="form-group">
                        <label for="lot-unit-cost">Cost / gram (₹)</label>
                        <input type="number" id="lot-unit-cost" class="form-control" min="0" step="0.01" placeholder="Optional; enables profit report">
                    </div>
                </div>
                <div style="display:flex; gap:10px;">
                    <button type="button" id="submit-lot-btn" class="btn btn-primary">Open Lot</button>
                    <button type="button" id="cancel-lot-btn" class="btn btn-secondary">Cancel</button>
                </div>
                <span id="lot-form-status" style="font-size:12px; color:var(--color-danger);"></span>
            </div>

            <table class="advances-table">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th>Barcode</th>
                        <th>Category</th>
                        <th>Purity</th>
                        <th class="text-right">On Hand</th>
                        <th>Status</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody id="inventory-table-body"></tbody>
            </table>

            <h2 style="font-size:15px; margin:24px 0 10px;">Recent Activity</h2>
            <table class="advances-table">
                <thead>
                    <tr>
                        <th>When</th>
                        <th>Type</th>
                        <th class="text-right">Weight</th>
                        <th>Reason</th>
                    </tr>
                </thead>
                <tbody id="inventory-movements-body"></tbody>
            </table>
        `;

        document.getElementById('inventory-refresh-btn').addEventListener('click', () => this.refresh());
        document.getElementById('inventory-search').addEventListener('input', () => this.renderTable());

        document.getElementById('inventory-new-item-btn').addEventListener('click', () => {
            const form = document.getElementById('new-item-form');
            const willShow = form.style.display === 'none';
            if (willShow) this.resetItemForm();
            form.style.display = willShow ? 'block' : 'none';
        });
        document.getElementById('cancel-item-btn').addEventListener('click', () => {
            document.getElementById('new-item-form').style.display = 'none';
            this.editingItemId = null;
        });
        document.getElementById('submit-item-btn').addEventListener('click', () => this.submitItemForm());

        document.getElementById('inventory-new-lot-btn').addEventListener('click', () => {
            const form = document.getElementById('new-lot-form');
            const willShow = form.style.display === 'none';
            form.style.display = willShow ? 'block' : 'none';
            if (willShow) this.populateLotItemSelect();
        });
        document.getElementById('cancel-lot-btn').addEventListener('click', () => {
            document.getElementById('new-lot-form').style.display = 'none';
        });
        document.getElementById('submit-lot-btn').addEventListener('click', () => this.submitNewLot());
    }

    async refresh() {
        try {
            const [stockRes, itemsRes, movementsRes] = await Promise.all([
                adminFetch('/api/inventory/stock'),
                adminFetch('/api/inventory/items'),
                adminFetch('/api/inventory/movements?limit=50')
            ]);
            if (!stockRes.ok || !itemsRes.ok || !movementsRes.ok) throw new Error('One or more inventory requests failed');

            this.stock = await stockRes.json();
            this.items = await itemsRes.json();
            this.movements = await movementsRes.json();
            this.lotsByItem.clear();
            this.renderTable();
            this.renderMovements();
            logTelemetry(`Inventory refreshed (${this.stock.length} item(s)).`);
        } catch (err) {
            console.error('Failed to load inventory:', err);
            const tbody = document.getElementById('inventory-table-body');
            if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--color-danger);">Inventory could not be loaded. Check the server is reachable and try Refresh.</td></tr>`;
        }
    }

    populateLotItemSelect() {
        const select = document.getElementById('lot-item');
        const activeItems = this.items.filter(i => i.isActive);
        select.innerHTML = activeItems.length
            ? activeItems.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)} (${escapeHtml(i.purity)})</option>`).join('')
            : '<option value="">No active items — create one first</option>';
    }

    /** Clears the New/Edit Item form and drops any in-progress edit. */
    resetItemForm() {
        this.editingItemId = null;
        ['item-name', 'item-category', 'item-sku', 'item-hsn', 'item-gross-weight',
            'item-net-weight', 'item-stone-weight', 'item-stone-value'].forEach(id => {
            document.getElementById(id).value = '';
        });
        document.getElementById('item-purity').value = '22K';
        document.getElementById('item-form-status').textContent = '';
        document.getElementById('submit-item-btn').textContent = 'Save Item';
    }

    /** Opens the same form pre-filled, for adding/correcting catalogue detail on an item that already exists. */
    editItem(itemId) {
        const item = this.items.find(i => i.id === itemId);
        if (!item) return;
        this.editingItemId = itemId;
        document.getElementById('item-name').value = item.name || '';
        document.getElementById('item-category').value = item.category || '';
        document.getElementById('item-purity').value = item.purity;
        document.getElementById('item-sku').value = item.skuCode || '';
        document.getElementById('item-hsn').value = item.hsnCode || '';
        document.getElementById('item-gross-weight').value = item.grossWeightGrams ?? '';
        document.getElementById('item-net-weight').value = item.netWeightGrams ?? '';
        document.getElementById('item-stone-weight').value = item.stoneWeightGrams ?? '';
        document.getElementById('item-stone-value').value = item.stoneValueAmount ?? '';
        document.getElementById('item-form-status').textContent = '';
        document.getElementById('submit-item-btn').textContent = 'Update Item';
        document.getElementById('new-item-form').style.display = 'block';
        document.getElementById('new-item-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async submitItemForm() {
        const statusEl = document.getElementById('item-form-status');
        const name = document.getElementById('item-name').value.trim();
        const category = document.getElementById('item-category').value.trim();
        const purity = document.getElementById('item-purity').value;
        const skuCode = document.getElementById('item-sku').value.trim();
        const hsnCode = document.getElementById('item-hsn').value.trim();
        const grossWeightGrams = parseFloat(document.getElementById('item-gross-weight').value);
        const netWeightGrams = parseFloat(document.getElementById('item-net-weight').value);
        const stoneWeightGrams = parseFloat(document.getElementById('item-stone-weight').value);
        const stoneValueAmount = parseFloat(document.getElementById('item-stone-value').value);
        if (!name) { statusEl.textContent = 'Item name is required.'; return; }

        const payload = {
            name, category: category || undefined, purity,
            skuCode: skuCode || undefined, hsnCode: hsnCode || undefined,
            grossWeightGrams: Number.isFinite(grossWeightGrams) ? grossWeightGrams : undefined,
            netWeightGrams: Number.isFinite(netWeightGrams) ? netWeightGrams : undefined,
            stoneWeightGrams: Number.isFinite(stoneWeightGrams) ? stoneWeightGrams : undefined,
            stoneValueAmount: Number.isFinite(stoneValueAmount) ? stoneValueAmount : undefined
        };
        const editing = this.editingItemId;
        const url = editing ? `/api/inventory/items/${encodeURIComponent(editing)}` : '/api/inventory/items';
        const method = editing ? 'PATCH' : 'POST';

        try {
            const res = await adminFetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const body = await res.json();
            if (!res.ok) { statusEl.textContent = body.message || body.error || 'Failed to save the item.'; return; }

            document.getElementById('new-item-form').style.display = 'none';
            this.resetItemForm();
            await this.refresh();
        } catch (err) {
            statusEl.textContent = 'Could not reach the server.';
        }
    }

    /**
     * Opens a small printable tag in a new tab: a QR of the barcode value
     * (scannable by any phone or QR-capable scanner — reuses the existing
     * /api/qrcode endpoint rather than adding a barcode-symbology library)
     * plus the catalogue text a jeweller's shelf tag actually needs.
     */
    async printLabel(itemId) {
        const item = this.items.find(i => i.id === itemId);
        if (!item) return;
        if (!item.skuCode) { alert('This item has no barcode/SKU set yet — add one via Edit first.'); return; }

        let qrDataUrl = '';
        try {
            const res = await adminFetch(`/api/qrcode?data=${encodeURIComponent(item.skuCode)}`);
            if (res.ok) qrDataUrl = (await res.json()).dataUrl;
        } catch (err) { /* label still prints without the QR image */ }

        const rows = [
            ['Purity', item.purity],
            ['HSN', item.hsnCode || '—'],
            ['Gross Wt', formatGramsOrDash(item.grossWeightGrams)],
            ['Net Wt', formatGramsOrDash(item.netWeightGrams)],
            ['Stone Wt', formatGramsOrDash(item.stoneWeightGrams)]
        ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');

        const win = window.open('', '_blank', 'width=420,height=560');
        if (!win) { alert('Pop-up blocked — allow pop-ups to print a label.'); return; }
        win.document.write(`
            <html><head><title>Label — ${escapeHtml(item.name)}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 16px; }
                .tag { width: 260px; border: 1px solid #333; border-radius: 6px; padding: 12px; text-align: center; }
                .tag h3 { margin: 0 0 4px; font-size: 15px; }
                .tag img { width: 140px; height: 140px; margin: 8px auto; }
                .tag .code { font-family: monospace; font-size: 12px; letter-spacing: 1px; margin-bottom: 8px; }
                .tag .rows div { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; border-top: 1px dashed #ccc; }
            </style></head>
            <body>
                <div class="tag">
                    <h3>${escapeHtml(item.name)}</h3>
                    ${qrDataUrl ? `<img src="${qrDataUrl}" alt="barcode">` : ''}
                    <div class="code">${escapeHtml(item.skuCode)}</div>
                    <div class="rows">${rows}</div>
                </div>
                <script>window.onload = () => window.print();</script>
            </body></html>
        `);
        win.document.close();
    }

    async submitNewLot() {
        const statusEl = document.getElementById('lot-form-status');
        const itemId = document.getElementById('lot-item').value;
        const weightGrams = parseFloat(document.getElementById('lot-weight').value);
        const label = document.getElementById('lot-label').value.trim();
        const hallmarkHuid = document.getElementById('lot-huid').value.trim();
        const unitCostRaw = document.getElementById('lot-unit-cost').value;
        const unitCostPerGram = unitCostRaw === '' ? null : Number(unitCostRaw);
        if (!itemId) { statusEl.textContent = 'Choose an item.'; return; }
        if (!(weightGrams > 0)) { statusEl.textContent = 'Weight must be a positive number of grams.'; return; }

        try {
            const res = await adminFetch('/api/inventory/lots', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    itemId, weightGrams, label: label || undefined,
                    hallmarkHuid: hallmarkHuid || undefined,
                    unitCostPerGram
                })
            });
            const body = await res.json();
            if (!res.ok) { statusEl.textContent = body.message || body.error || 'Failed to open the lot.'; return; }

            statusEl.textContent = '';
            document.getElementById('lot-weight').value = '';
            document.getElementById('lot-label').value = '';
            document.getElementById('lot-huid').value = '';
            document.getElementById('lot-unit-cost').value = '';
            document.getElementById('new-lot-form').style.display = 'none';
            await this.refresh();
        } catch (err) {
            statusEl.textContent = 'Could not reach the server.';
        }
    }

    async toggleLots(itemId) {
        this.expandedItemId = this.expandedItemId === itemId ? null : itemId;
        if (this.expandedItemId && !this.lotsByItem.has(itemId)) {
            try {
                const res = await adminFetch(`/api/inventory/lots?itemId=${encodeURIComponent(itemId)}`);
                this.lotsByItem.set(itemId, res.ok ? await res.json() : []);
            } catch (err) {
                this.lotsByItem.set(itemId, []);
            }
        }
        this.renderTable();
    }

    async submitAdjustment(lotId) {
        const deltaInput = document.getElementById(`adjust-delta-${lotId}`);
        const reasonInput = document.getElementById(`adjust-reason-${lotId}`);
        const statusEl = document.getElementById(`adjust-status-${lotId}`);
        const weightDeltaGrams = parseFloat(deltaInput.value);
        if (!weightDeltaGrams) { statusEl.textContent = 'Enter a non-zero amount (grams, negative to reduce).'; return; }

        try {
            const res = await adminFetch(`/api/inventory/lots/${encodeURIComponent(lotId)}/adjust`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ weightDeltaGrams, reason: reasonInput.value.trim() || undefined })
            });
            const body = await res.json();
            if (!res.ok) { statusEl.textContent = body.message || body.error || 'Adjustment failed.'; return; }

            this.lotsByItem.delete(this.expandedItemId);
            await this.refresh();
            await this.toggleLots(this.expandedItemId);
        } catch (err) {
            statusEl.textContent = 'Could not reach the server.';
        }
    }

    renderTable() {
        const tbody = document.getElementById('inventory-table-body');
        if (!tbody) return;

        const query = (document.getElementById('inventory-search')?.value || '').trim().toLowerCase();
        let rows = this.stock;
        if (query) {
            rows = rows.filter(s =>
                (s.name || '').toLowerCase().includes(query) ||
                (s.category || '').toLowerCase().includes(query) ||
                (s.skuCode || '').toLowerCase().includes(query) ||
                (s.hsnCode || '').toLowerCase().includes(query));
        }

        if (rows.length === 0) {
            const message = this.stock.length === 0
                ? 'No inventory items yet. Use "+ New Item" to start a catalogue entry, then "+ New Lot" to record what is on the shelf.'
                : 'No item matches that filter.';
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--color-text-light); font-style:italic;">${message}</td></tr>`;
            return;
        }

        tbody.innerHTML = rows.map(s => {
            const expanded = this.expandedItemId === s.itemId;
            const lots = this.lotsByItem.get(s.itemId) || [];
            const catalogueRows = [
                ['HSN', s.hsnCode || '—'],
                ['Gross Wt', formatGramsOrDash(s.grossWeightGrams)],
                ['Net Wt', formatGramsOrDash(s.netWeightGrams)],
                ['Stone Wt', formatGramsOrDash(s.stoneWeightGrams)],
                ['Stone Value', formatAmountOrDash(s.stoneValueAmount)]
            ].map(([label, value]) => `<span style="margin-right:16px;"><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>`).join('');

            const lotsRow = expanded ? `
                <tr>
                    <td colspan="7" style="background:var(--color-surface-alt, #f8fafc); padding:10px 20px;">
                        <div style="font-size:12px; color:var(--color-text-muted); margin-bottom:10px;">${catalogueRows}</div>
                        ${lots.length === 0
                            ? '<p style="font-size:12px; color:var(--color-text-muted); margin:0;">No lots yet for this item.</p>'
                            : `<table class="advances-table" style="margin:0;">
                                <thead><tr><th>Lot</th><th>Label</th><th>Hallmark HUID</th><th class="text-right">Weight</th><th class="text-right">Cost/g</th><th>Opened</th><th></th></tr></thead>
                                <tbody>
                                    ${lots.map(l => `
                                        <tr>
                                            <td style="font-family:monospace; font-size:12px;">${escapeHtml(l.id)}</td>
                                            <td>${escapeHtml(l.label || '—')}</td>
                                            <td style="font-family:monospace; font-size:12px;">${escapeHtml(l.hallmarkHuid || '—')}</td>
                                            <td class="text-right">${formatGrams(l.weightGrams)}</td>
                                            <td class="text-right">${formatAmountOrDash(l.unitCostPerGram)}</td>
                                            <td style="white-space:nowrap;">${formatWhen(l.createdAt)}</td>
                                            <td>
                                                <details>
                                                    <summary style="cursor:pointer; font-size:12px; color:var(--color-primary, #2563eb);">Adjust</summary>
                                                    <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                                                        <input type="number" id="adjust-delta-${escapeHtml(l.id)}" class="form-control" step="0.001" placeholder="±grams" style="width:110px;">
                                                        <input type="text" id="adjust-reason-${escapeHtml(l.id)}" class="form-control" placeholder="Reason" style="width:160px;">
                                                        <button type="button" class="btn btn-secondary btn-sm submit-adjust-btn" data-lot="${escapeHtml(l.id)}">Save</button>
                                                    </div>
                                                    <span id="adjust-status-${escapeHtml(l.id)}" style="font-size:12px; color:var(--color-danger);"></span>
                                                </details>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>`
                        }
                    </td>
                </tr>` : '';

            return `
                <tr>
                    <td>${escapeHtml(s.name)}</td>
                    <td style="font-family:monospace; font-size:12px;">${escapeHtml(s.skuCode || '—')}</td>
                    <td>${escapeHtml(s.category || '—')}</td>
                    <td>${escapeHtml(s.purity)}</td>
                    <td class="text-right">${formatGrams(s.weightGrams)}</td>
                    <td>${s.isActive
                        ? '<span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; color:var(--color-success); background:var(--color-success-bg);">Active</span>'
                        : '<span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px; color:var(--color-text-muted); background:var(--color-surface-alt, #f1f5f9);">Inactive</span>'}</td>
                    <td style="white-space:nowrap;">
                        <button type="button" class="btn btn-secondary btn-sm toggle-lots-btn" data-item="${escapeHtml(s.itemId)}">${expanded ? 'Hide Lots' : 'View Lots'}</button>
                        <button type="button" class="btn btn-secondary btn-sm edit-item-btn" data-item="${escapeHtml(s.itemId)}">Edit</button>
                        <button type="button" class="btn btn-secondary btn-sm label-item-btn" data-item="${escapeHtml(s.itemId)}">Label</button>
                    </td>
                </tr>
                ${lotsRow}
            `;
        }).join('');

        tbody.querySelectorAll('.toggle-lots-btn').forEach(btn => {
            btn.addEventListener('click', () => this.toggleLots(btn.getAttribute('data-item')));
        });
        tbody.querySelectorAll('.edit-item-btn').forEach(btn => {
            btn.addEventListener('click', () => this.editItem(btn.getAttribute('data-item')));
        });
        tbody.querySelectorAll('.label-item-btn').forEach(btn => {
            btn.addEventListener('click', () => this.printLabel(btn.getAttribute('data-item')));
        });
        tbody.querySelectorAll('.submit-adjust-btn').forEach(btn => {
            btn.addEventListener('click', () => this.submitAdjustment(btn.getAttribute('data-lot')));
        });
    }

    renderMovements() {
        const tbody = document.getElementById('inventory-movements-body');
        if (!tbody) return;

        if (this.movements.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--color-text-light); font-style:italic;">Nothing recorded yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = this.movements.map(m => `
            <tr>
                <td style="white-space:nowrap;">${formatWhen(m.createdAt)}</td>
                <td>${escapeHtml({
                    opening_balance: 'Opening balance', adjustment: 'Adjustment',
                    sale: 'Sale', return: 'Return', void: 'Void reversal'
                }[m.movementType] || m.movementType)}</td>
                <td class="text-right" style="color:${m.weightDeltaGrams < 0 ? 'var(--color-danger)' : 'inherit'};">${m.weightDeltaGrams > 0 ? '+' : ''}${formatGrams(m.weightDeltaGrams)}</td>
                <td style="color:var(--color-text-muted);">${escapeHtml(m.reason || '—')}</td>
            </tr>
        `).join('');
    }
}
