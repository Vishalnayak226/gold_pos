import { logTelemetry, adminFetch, getActor } from '../app.js';
import {
    computeInvoiceTotals,
    makingChargeFromPercent,
    makingPercentFromAmount,
    normalizeTaxMode,
    round2,
    toPaise
} from '../lib/billingMath.js';

/**
 * Money for the invoice, always to the paise.
 *
 * Every figure reaching this point is already rounded by billingMath, so the
 * fixed 2 decimals are a display guarantee rather than a second rounding: the
 * printed rows line up in a column and never render a third decimal.
 */
function money(value) {
    return `₹${Number(value || 0).toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/** The three purities, and the key each one reads its rate from. */
const PURITY_BY_KEY = { price24K: '24K', price22K: '22K', price18K: '18K' };

/**
 * How a bill can be settled. Matches TENDER_METHODS on the server, which
 * matches `tenders.method` in the SQL schema — one vocabulary, three layers.
 *
 * 'advance' is deliberately absent: a redeemed advance is not tendered at the
 * counter, it was tendered when the customer deposited it, and it appears on the
 * invoice as `appliedAdvance`. Offering it here would let a cashier record the
 * same money twice.
 */
const TENDER_METHODS = [
    { value: 'cash', label: 'Cash' },
    { value: 'card', label: 'Card' },
    { value: 'upi', label: 'UPI' },
    { value: 'bank_transfer', label: 'Bank transfer' },
    { value: 'other', label: 'Other' }
];

export class BillingDesk {
    constructor() {
        this.goldRate = { price24K: 0, price22K: 0, price18K: 0, source: 'auto' };
        this.selectedPurity = 'price22K';
        this.metalValue = 0;
        this.makingChargePercent = 10; // Default 10%
        this.makingChargeAmount = 0;
        this.taxSlab = 3; // Default 3% GST
        this.taxMode = 'Exclusive'; // Default
        this.defaultDiscountConfig = 0;
        this.discountPercent = 0;
        this.discountAmount = 0;
        this.totalAmount = 0;
        this.appliedAdvance = 0;
        this.customerAdvanceBalance = 0;
        this.customerPhone = '';
        this.customerName = '';

        /* THE CART. Items already added to this invoice, in order.
           Empty for the common single-item sale: the entry form's own contents
           count as a line, so "type a weight and press Save" bills one item with
           no extra clicks. "Add Item" moves the entry into the cart and clears
           the form for the next one. */
        this.cart = [];

        /* HOW THE BILL IS BEING PAID. One cash tender by default, its amount
           tracking the total, so an ordinary sale records its tender without the
           cashier doing anything — which is the point: a sale used to record no
           payment method at all, making a drawer count impossible to reconcile.
           `amountEdited` flips once the cashier types an amount, after which the
           row stops auto-tracking and the remainder is theirs to allocate. */
        this.tenders = [{ method: 'cash', amount: 0, reference: '', amountEdited: false }];

        this.init();
    }

    async init() {
        this.render();
        await this.fetchGoldRate();
        if (sessionStorage.getItem('adminToken')) {
            await this.fetchSettings();
        }
        this.setupEventListeners();
        this.recalculate();

        /* The desk is now live: rates and settings have landed and the event
           listeners are wired.

           Stated explicitly because until this attribute existed, the only way
           to know was to watch for the gold rate appearing in the invoice
           preview — and the preview no longer shows a rate until an item is
           entered, so that signal was both indirect and gone. Filling the form
           before this point types into a live-looking form whose Save button
           does nothing. */
        document.getElementById('sales-tab')?.setAttribute('data-desk-ready', 'true');
    }

    async fetchGoldRate() {
        try {
            const res = await fetch('/api/gold-price');
            if (res.ok) {
                this.goldRate = await res.json();
                this.updateGoldRateDisplay();
            }
        } catch (err) {
            console.error('Failed to fetch gold rate:', err);
        }
    }

    async fetchSettings() {
        try {
            const res = await adminFetch('/api/settings');
            if (res.ok) {
                const settings = await res.json();
                if (settings.companyLogo) {
                    const logoEl = document.getElementById('invoice-company-logo');
                    const nameEl = document.getElementById('invoice-company-name');
                    if (logoEl) {
                        logoEl.src = settings.companyLogo;
                        logoEl.style.display = 'block';
                    }
                    if (nameEl) {
                        nameEl.style.display = 'none';
                    }
                }
                
                if (settings.goldTaxSlab !== undefined) {
                    this.taxSlab = parseFloat(settings.goldTaxSlab) || 0;
                    const taxInput = document.getElementById('tax-slab');
                    if (taxInput) taxInput.value = this.taxSlab;
                }
                
                this.taxMode = normalizeTaxMode(settings.taxMode);
                
                if (settings.defaultDiscountPercent !== undefined) {
                    this.defaultDiscountConfig = parseInt(settings.defaultDiscountPercent, 10) || 0;
                    this.discountPercent = this.defaultDiscountConfig;
                    const discountInput = document.getElementById('manual-discount');
                    if (discountInput) discountInput.value = this.discountPercent;
                    
                    const toggleBtn = document.getElementById('toggle-discount-btn');
                    if (toggleBtn) {
                        if (this.defaultDiscountConfig > 0) {
                            toggleBtn.style.display = 'block';
                            toggleBtn.textContent = 'Remove';
                            toggleBtn.className = 'btn btn-secondary btn-small';
                        } else {
                            toggleBtn.style.display = 'none';
                        }
                    }
                }
                
                this.recalculate();
            }
        } catch (err) {
            console.error('Failed to fetch settings', err);
        }
    }

    updateGoldRateDisplay() {
        const rateVal = this.goldRate[this.selectedPurity] || 0;
        const displayEl = document.getElementById('current-gold-rate-22k');
        const badgeEl = document.getElementById('rate-type-badge');
        
        if (displayEl) {
            displayEl.textContent = `₹${rateVal.toLocaleString('en-IN')}/g`;
        }
        if (badgeEl) {
            badgeEl.textContent = this.goldRate.source === 'manual' ? 'Manual Override' : 'Auto Midnight';
            badgeEl.style.backgroundColor = this.goldRate.source === 'manual' ? 'var(--color-warning-bg)' : 'var(--color-accent-light)';
            badgeEl.style.color = this.goldRate.source === 'manual' ? 'var(--color-warning)' : 'var(--color-text-main)';
        }
    }

    render() {
        const container = document.querySelector('#sales-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div class="billing-desk-grid">
                <!-- Left Column: inputs -->
                <div class="billing-inputs-card">
                    <form id="billing-form">
                        <div class="form-section">
                            <h3>1. Gold Metal Valuation</h3>
                            <div class="form-group-row">
                                <div class="form-group">
                                    <label for="gold-purity">Purity</label>
                                    <select id="gold-purity" class="form-control">
                                        <option value="price24K">24K Gold</option>
                                        <option value="price22K" selected>22K Gold</option>
                                        <option value="price18K">18K Gold</option>
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label for="gold-weight">Weight (Grams)</label>
                                    <input type="number" id="gold-weight" class="form-control" placeholder="0.00" step="0.001" min="0" required>
                                </div>
                            </div>
                            <div class="form-group">
                                <label for="item-description">Item (optional)</label>
                                <input type="text" id="item-description" class="form-control" placeholder="e.g. Bangles, chain" maxlength="120">
                            </div>
                            <!--
                                One invoice can hold several items, each with its
                                own purity, rate and making charge. A single-item
                                sale needs no click here: the entry above counts
                                as the line. "Add Item" banks it and clears the
                                form so a second, differently-priced item can go
                                on the same bill and the same GST document.
                            -->
                            <div id="cart-list"></div>
                            <button type="button" id="add-item-btn" class="btn btn-secondary" style="margin-top:10px;">+ Add Item to Invoice</button>
                        </div>

                        <div class="form-section">
                            <h3>2. Making Charges & Taxes</h3>
                            <div class="form-group-row">
                                <div class="form-group">
                                    <label>Making Charge (%)</label>
                                    <div style="display:flex; align-items:center; gap:4px;">
                                        <input type="number" id="making-percent-int" class="form-control" value="10" min="1" max="100" style="padding-right:5px; text-align:right;">
                                        <span style="font-weight:bold; font-size:18px;">.</span>
                                        <input type="number" id="making-percent-dec" class="form-control" value="0" min="0" max="99" style="padding-left:5px;">
                                    </div>
                                </div>
                                <div class="form-group">
                                    <label for="making-amount">Making Charge (₹)</label>
                                    <input type="number" id="making-amount" class="form-control" value="0" min="0" step="0.01">
                                </div>
                            </div>
                            <div class="form-group">
                                <label for="tax-slab">GST Tax Slab (%)</label>
                                <select id="tax-slab" class="form-control" disabled>
                                    <option value="0">0%</option>
                                    <option value="3" selected>3% (Gold & Silver)</option>
                                    <option value="5">5%</option>
                                    <option value="12">12%</option>
                                    <option value="18">18%</option>
                                    <option value="28">28%</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-section">
                            <h3>3. Customer & Discount Details</h3>
                            <div class="form-group-row">
                                <div class="form-group">
                                    <label for="customer-name">Customer Name</label>
                                    <input type="text" id="customer-name" class="form-control" placeholder="Optional">
                                </div>
                                <div class="form-group">
                                    <label for="customer-phone">Customer Phone (10-Digit)</label>
                                    <input type="tel" id="customer-phone" class="form-control" placeholder="Optional" maxlength="10">
                                    <span class="input-error-msg" id="phone-validation-error"></span>
                                </div>
                            </div>
                            <div class="form-group">
                                <label for="manual-discount">Discount (%)</label>
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <input type="number" id="manual-discount" class="form-control" value="0" min="0" step="1" max="99" disabled style="flex:1;">
                                    <button type="button" id="toggle-discount-btn" class="btn btn-secondary btn-small" style="padding: 6px 12px; display: none;">Remove</button>
                                </div>
                            </div>
                        </div>

                        <!--
                            HOW THE BILL IS PAID. A sale used to record no payment
                            method whatsoever, which is why a cash-drawer close,
                            a shift variance and a card settlement could not be
                            reconciled against the ledger — the data to reconcile
                            simply was not there. One cash row is filled in
                            automatically so an ordinary sale costs no extra
                            keystrokes; splitting is a click.
                        -->
                        <div class="form-section">
                            <h3>4. Payment</h3>
                            <div id="tender-rows"></div>
                            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:10px;">
                                <button type="button" id="add-tender-btn" class="btn btn-secondary btn-small">+ Split payment</button>
                                <span id="tender-remaining" class="text-muted-small"></span>
                            </div>
                        </div>
                    </form>
                </div>

                <!-- Right Column: Invoice PDF-style Preview Grid -->
                <div class="billing-invoice-preview">
                    <div class="invoice-sheet">
                        <div class="invoice-header">
                            <img id="invoice-company-logo" src="" alt="Company Logo" style="max-height:80px; display:none; margin: 0 auto 10px auto;">
                            <h2 id="invoice-company-name">UNIVERSAL GOLD POS</h2>
                            <p id="invoice-company-details">TAX INVOICE</p>
                        </div>
                        <div class="invoice-divider"></div>
                        <div class="invoice-meta">
                            <p><strong>Customer:</strong> <span id="preview-customer-name">Cash Sale</span></p>
                            <p><strong>Phone:</strong> <span id="preview-customer-phone">-</span></p>
                            <p><strong>Date:</strong> <span>${new Date().toLocaleDateString()}</span></p>
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
                                One row per item on the invoice, rendered from the
                                cart. Each quotes its own purity, weight and rate,
                                because on a mixed bill those genuinely differ per
                                line and a single averaged row would misdescribe
                                what was sold.
                            -->
                            <tbody id="preview-line-rows"></tbody>
                        </table>
                        
                        <!--
                            The rows below are what window.print() puts in the
                            customer's hand, so they must add up: every visible
                            line is stated NET of GST, the tax is added once at
                            the bottom, and the sum is the grand total. In
                            inclusive mode that means these lines are the quoted
                            prices with the embedded tax carved out — hence the
                            "(net of GST)" qualifier, which only appears there.
                        -->
                        <div class="invoice-summary">
                            <div class="summary-row">
                                <span>Metal Value<span class="sum-net-note"></span>:</span>
                                <span id="sum-metal-value">₹0.00</span>
                            </div>
                            <div class="summary-row">
                                <span>Making Charges (<span id="sum-making-percent">10</span>%)<span class="sum-net-note"></span>:</span>
                                <span id="sum-making-amount">₹0.00</span>
                            </div>
                            <div class="summary-row" id="summary-discount-row" style="display: none;">
                                <span>Discount (<span id="sum-discount-percent">0</span>%)<span class="sum-net-note"></span>:</span>
                                <span id="sum-discount-amount">-₹0.00</span>
                            </div>
                            <!--
                                Named, not just "Taxable Value". Under Indian
                                GST a jewellery sale is a composite supply —
                                one slab on the whole consideration, making
                                charge included — and this is the line a
                                customer questions at the counter. Saying what
                                the base is on the slip answers it without the
                                cashier having to.
                            -->
                            <div class="summary-row summary-subtotal">
                                <span>Taxable Value (Metal + Making):</span>
                                <span id="sum-taxable-amount">₹0.00</span>
                            </div>
                            <div class="summary-row">
                                <span>GST Tax (<span id="sum-tax-slab">3</span>% <span id="sum-tax-mode" style="font-size: 0.85em; opacity: 0.8;"></span>):</span>
                                <span id="sum-tax-amount">₹0.00</span>
                            </div>
                            <div class="summary-row" id="summary-advance-row" style="display: none;">
                                <span>Advance Redeemed:</span>
                                <span id="sum-advance-amount">-₹0.00</span>
                            </div>
                            <div class="invoice-divider"></div>
                            <div class="summary-row grand-total">
                                <span>GRAND TOTAL:</span>
                                <span id="sum-grand-total">₹0.00</span>
                            </div>
                        </div>

                        <!-- Advance Ledger Alert Block -->
                        <div id="advance-redeem-container" style="display: none;">
                            <div class="advance-alert-box">
                                <div class="advance-info">
                                    <p><strong>Customer Advance Available:</strong> <span id="advance-balance-display">₹0.00</span></p>
                                    <p class="text-muted-small">You can redeem this balance to discount this invoice.</p>
                                </div>
                                <button type="button" id="apply-advance-btn" class="btn btn-secondary">Apply Advance</button>
                            </div>
                        </div>

                        <div style="display:flex; gap:10px; width: 100%; margin-top:20px;">
                            <button type="button" id="print-invoice-btn" class="btn btn-secondary" style="flex:1;">PRINT INVOICE</button>
                            <button type="button" id="generate-invoice-btn" class="btn btn-primary" style="flex:2;">SAVE INVOICE</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        const printBtn = document.getElementById('print-invoice-btn');
        if (printBtn) {
            printBtn.addEventListener('click', () => {
                window.print();
            });
        }
        const form = document.getElementById('billing-form');
        const puritySelect = document.getElementById('gold-purity');
        const weightInput = document.getElementById('gold-weight');
        const percentIntInput = document.getElementById('making-percent-int');
        const percentDecInput = document.getElementById('making-percent-dec');
        const amountInput = document.getElementById('making-amount');
        const taxInput = document.getElementById('tax-slab');
        const discountInput = document.getElementById('manual-discount');
        const phoneInput = document.getElementById('customer-phone');
        const nameInput = document.getElementById('customer-name');
        const applyAdvanceBtn = document.getElementById('apply-advance-btn');
        const submitBtn = document.getElementById('generate-invoice-btn');

        if (!form) return;

        // Purity changes
        puritySelect.addEventListener('change', (e) => {
            this.selectedPurity = e.target.value;
            this.updateGoldRateDisplay();
            this.recalculate();
        });

        // Weight changes
        weightInput.addEventListener('input', () => this.recalculate());

        // GST Tax changes (now disabled in UI, but kept here for programmatic updates)
        taxInput.addEventListener('change', () => {
            this.taxSlab = parseFloat(taxInput.value) || 0;
            this.recalculate();
        });

        // Discount Toggle
        const toggleDiscountBtn = document.getElementById('toggle-discount-btn');
        if (toggleDiscountBtn) {
            toggleDiscountBtn.addEventListener('click', () => {
                if (!this.defaultDiscountConfig) return;
                
                if (this.discountPercent > 0) {
                    this.discountPercent = 0;
                    toggleDiscountBtn.textContent = 'Apply';
                    toggleDiscountBtn.className = 'btn btn-primary btn-small';
                } else {
                    this.discountPercent = this.defaultDiscountConfig;
                    toggleDiscountBtn.textContent = 'Remove';
                    toggleDiscountBtn.className = 'btn btn-secondary btn-small';
                }
                
                if (discountInput) discountInput.value = this.discountPercent;
                this.recalculate();
            });
        }

        // Customer details
        nameInput.addEventListener('input', (e) => {
            this.customerName = e.target.value;
            const previewName = document.getElementById('preview-customer-name');
            if (previewName) {
                previewName.textContent = this.customerName || 'Cash Sale';
            }
        });

        // Phone input with 10-digit validation and lookup
        phoneInput.addEventListener('input', async (e) => {
            let phone = e.target.value.replace(/\D/g, ''); // keep only digits
            if (phone.length > 10) phone = phone.substring(0, 10);
            e.target.value = phone;
            this.customerPhone = phone;

            const previewPhone = document.getElementById('preview-customer-phone');
            if (previewPhone) {
                previewPhone.textContent = phone ? phone.replace(/(\d{5})(\d{5})/, '$1-$2') : '-';
            }

            const errorEl = document.getElementById('phone-validation-error');
            if (phone.length > 0 && phone.length < 10) {
                errorEl.textContent = 'Phone number must be exactly 10 digits';
            } else {
                errorEl.textContent = '';
                if (phone.length === 10) {
                    await this.lookupCustomerAdvance(phone);
                } else {
                    this.clearAdvance();
                }
            }
        });

        // Bi-directional Making Charges
        const updateMakingChargeFromPercent = () => {
            const intPart = parseInt(percentIntInput.value) || 0;
            const decStr = percentDecInput.value || '0';

            const { percent, amount } = makingChargeFromPercent(
                this.metalValue,
                parseFloat(`${intPart}.${decStr}`)
            );

            this.makingChargePercent = percent;
            this.makingChargeAmount = amount;
            amountInput.value = round2(amount);

            this.recalculateSummaryOnly();
        };

        if (percentIntInput) percentIntInput.addEventListener('input', updateMakingChargeFromPercent);
        if (percentDecInput) percentDecInput.addEventListener('input', updateMakingChargeFromPercent);

        amountInput.addEventListener('input', (e) => {
            const { percent, amount } = makingPercentFromAmount(
                parseFloat(e.target.value),
                this.metalValue
            );

            e.target.value = amount;
            this.makingChargeAmount = amount;

            // `percent` is null while there is no metal value to divide by —
            // leave the percentage boxes alone until a weight is entered.
            if (percent !== null) {
                this.makingChargePercent = percent;
                const pctStr = percent.toString().split('.');
                percentIntInput.value = pctStr[0] || '0';
                percentDecInput.value = pctStr[1] || '0';
            }

            this.recalculateSummaryOnly();
        });

        // Apply customer advance click
        applyAdvanceBtn.addEventListener('click', () => {
            if (this.customerAdvanceBalance > 0) {
                if (this.appliedAdvance > 0) {
                    // Remove advance
                    this.appliedAdvance = 0;
                    applyAdvanceBtn.textContent = 'Apply Advance';
                    applyAdvanceBtn.classList.remove('btn-danger');
                    applyAdvanceBtn.classList.add('btn-secondary');
                } else {
                    // Apply advance (up to total before advance)
                    const totalBeforeAdvance = this.totalAmount + this.appliedAdvance;
                    this.appliedAdvance = Math.min(this.customerAdvanceBalance, totalBeforeAdvance);
                    applyAdvanceBtn.textContent = 'Remove Advance';
                    applyAdvanceBtn.classList.remove('btn-secondary');
                    applyAdvanceBtn.classList.add('btn-danger');
                }
                this.recalculateSummaryOnly();
            }
        });

        // Cart: bank the entry form as a line and clear it for the next item.
        const addItemBtn = document.getElementById('add-item-btn');
        if (addItemBtn) addItemBtn.addEventListener('click', () => this.addEntryToCart());

        // The item description is descriptive only, but the preview row shows
        // it, so the preview has to follow it as it is typed.
        const descInput = document.getElementById('item-description');
        if (descInput) descInput.addEventListener('input', () => this.recalculateSummaryOnly());

        // Payment: add a split row, pre-filled with whatever is unallocated so
        // the common "₹5,000 cash, rest on card" split is one click and no
        // arithmetic.
        const addTenderBtn = document.getElementById('add-tender-btn');
        if (addTenderBtn) {
            addTenderBtn.addEventListener('click', () => {
                if (this.tenders.length >= 10) {
                    alert('An invoice can be split across at most 10 payments.');
                    return;
                }
                // The first row stops auto-tracking the total the moment a
                // second one exists, otherwise the two would fight over it.
                this.tenders.forEach(t => { t.amountEdited = true; });
                const remaining = this.remainingToAllocate();
                this.tenders.push({
                    method: 'card',
                    amount: remaining > 0 ? remaining : 0,
                    reference: '',
                    amountEdited: true
                });
                this.renderTenderRows();
            });
        }

        this.renderCart();
        this.renderTenderRows();

        // Submit Invoice
        submitBtn.addEventListener('click', () => this.submitSale());
    }

    async lookupCustomerAdvance(phone) {
        try {
            // Admin-gated since Phase 20.1 — reading an arbitrary customer's
            // ledger by phone number is a cashier action, not a public one.
            const res = await adminFetch(`/api/advances/lookup?phone=${phone}`);
            if (res.ok) {
                const data = await res.json();
                this.customerAdvanceBalance = parseFloat(data.balance) || 0;
                
                const container = document.getElementById('advance-redeem-container');
                const balanceDisplay = document.getElementById('advance-balance-display');
                
                if (this.customerAdvanceBalance > 0 && container && balanceDisplay) {
                    balanceDisplay.textContent = `₹${this.customerAdvanceBalance.toLocaleString('en-IN')}`;
                    container.style.display = 'block';
                    logTelemetry('CUSTOMER_ADVANCE_FOUND', 0, `Phone: ${phone}, Balance: ${this.customerAdvanceBalance}`);
                } else {
                    this.clearAdvance();
                }
            }
        } catch (err) {
            console.error('Failed to lookup customer advance:', err);
            this.clearAdvance();
        }
    }

    clearAdvance() {
        this.customerAdvanceBalance = 0;
        this.appliedAdvance = 0;
        const container = document.getElementById('advance-redeem-container');
        const applyAdvanceBtn = document.getElementById('apply-advance-btn');
        if (container) container.style.display = 'none';
        if (applyAdvanceBtn) {
            applyAdvanceBtn.textContent = 'Apply Advance';
            applyAdvanceBtn.classList.remove('btn-danger');
            applyAdvanceBtn.classList.add('btn-secondary');
        }
        this.recalculateSummaryOnly();
    }

    recalculate() {
        const weightInput = document.getElementById('gold-weight');
        const weight = parseFloat(weightInput?.value) || 0;
        const rateVal = this.goldRate[this.selectedPurity] || 0;

        // 1. Metal value of the line being ENTERED. The making-charge percentage
        //    boxes are bi-directional against this one line, not against the
        //    whole cart — each item carries its own making charge, and rebasing
        //    the percentage on the cart total would silently rewrite the charge
        //    on items already added.
        this.metalValue = weight * rateVal;

        // 2. Making Charges recalculation based on percent
        this.makingChargeAmount = makingChargeFromPercent(this.metalValue, this.makingChargePercent).amount;
        const amountInput = document.getElementById('making-amount');
        if (amountInput) {
            amountInput.value = round2(this.makingChargeAmount);
        }

        this.recalculateSummaryOnly();
    }

    /* ------------------------------------------------------------------ Cart

       An invoice is a list of lines. The entry form holds the line being typed;
       the cart holds the ones already banked. `activeLines()` is the union, and
       it is the ONE thing the preview, the totals and the submitted payload are
       all derived from — so what the cashier sees on screen and what reaches the
       ledger cannot describe different carts.
       ------------------------------------------------------------------ */

    /** The line currently in the entry form, or null if nothing is entered. */
    readEntryLine() {
        const weight = parseFloat(document.getElementById('gold-weight')?.value) || 0;
        if (weight <= 0) return null;
        const rate = this.goldRate[this.selectedPurity] || 0;
        return {
            purityKey: this.selectedPurity,
            purity: PURITY_BY_KEY[this.selectedPurity],
            description: String(document.getElementById('item-description')?.value || '').trim(),
            weightGrams: weight,
            goldPricePerGram: rate,
            metalValue: round2(weight * rate),
            makingChargePercent: this.makingChargePercent,
            makingChargeAmount: round2(this.makingChargeAmount)
        };
    }

    /**
     * Every line on the invoice as it stands: the banked cart, plus whatever is
     * in the entry form. That last part is what keeps a one-item sale a
     * two-keystroke job — the cashier never has to "add" a single item before
     * saving it.
     */
    activeLines() {
        const entry = this.readEntryLine();
        return entry ? [...this.cart, entry] : [...this.cart];
    }

    /** Banks the entry form as a cart line and clears it for the next item. */
    addEntryToCart() {
        const entry = this.readEntryLine();
        if (!entry) {
            alert('Enter a weight for this item before adding it to the invoice.');
            return;
        }
        this.cart.push(entry);

        const weightInput = document.getElementById('gold-weight');
        const descInput = document.getElementById('item-description');
        if (weightInput) weightInput.value = '';
        if (descInput) descInput.value = '';
        if (weightInput) weightInput.focus();

        this.renderCart();
        this.recalculate();
    }

    renderCart() {
        const host = document.getElementById('cart-list');
        if (!host) return;

        if (this.cart.length === 0) {
            host.innerHTML = '';
            return;
        }

        host.innerHTML = `
            <table class="advances-table" style="margin-top:12px;">
                <thead>
                    <tr>
                        <th>#</th><th>Item</th><th class="text-right">Weight</th>
                        <th class="text-right">Rate/g</th><th class="text-right">Making</th><th></th>
                    </tr>
                </thead>
                <tbody>
                    ${this.cart.map((line, i) => `
                        <tr>
                            <td>${i + 1}</td>
                            <td>${escapeHtml(line.description || `Gold ornament (${line.purity})`)}
                                <div class="text-muted-small">${escapeHtml(line.purity)}</div></td>
                            <td class="text-right">${line.weightGrams.toFixed(3)} g</td>
                            <td class="text-right">${money(line.goldPricePerGram)}</td>
                            <td class="text-right">${money(line.makingChargeAmount)}</td>
                            <td class="text-right">
                                <button type="button" class="btn btn-secondary btn-sm cart-remove-btn" data-index="${i}">Remove</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        host.querySelectorAll('.cart-remove-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.cart.splice(Number(btn.dataset.index), 1);
                this.renderCart();
                this.recalculate();
            });
        });
    }

    /* --------------------------------------------------------------- Tenders */

    /** Rupees still unallocated across the tender rows — negative if over. */
    remainingToAllocate() {
        const allocated = this.tenders.reduce((total, t) => total + toPaise(t.amount), 0);
        return round2((toPaise(this.totalAmount) - allocated) / 100);
    }

    renderTenderRows() {
        const host = document.getElementById('tender-rows');
        if (!host) return;

        host.innerHTML = this.tenders.map((t, i) => `
            <div class="form-group-row" style="align-items:flex-end;">
                <div class="form-group">
                    ${i === 0 ? '<label>Method</label>' : ''}
                    <select class="form-control tender-method" data-index="${i}">
                        ${TENDER_METHODS.map(m => `<option value="${m.value}"${m.value === t.method ? ' selected' : ''}>${m.label}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    ${i === 0 ? '<label>Amount (₹)</label>' : ''}
                    <input type="number" class="form-control tender-amount" data-index="${i}"
                           min="0" step="0.01" value="${t.amount || ''}">
                </div>
                <div class="form-group">
                    ${i === 0 ? '<label>Reference (optional)</label>' : ''}
                    <input type="text" class="form-control tender-reference" data-index="${i}"
                           maxlength="100" placeholder="Card slip / UTR" value="${escapeHtml(t.reference)}">
                </div>
                ${this.tenders.length > 1 ? `
                <div class="form-group" style="flex:0 0 auto;">
                    <button type="button" class="btn btn-secondary btn-sm tender-remove-btn" data-index="${i}">✕</button>
                </div>` : ''}
            </div>
        `).join('');

        host.querySelectorAll('.tender-method').forEach(el => {
            el.addEventListener('change', () => {
                this.tenders[Number(el.dataset.index)].method = el.value;
            });
        });
        host.querySelectorAll('.tender-amount').forEach(el => {
            el.addEventListener('input', () => {
                const t = this.tenders[Number(el.dataset.index)];
                t.amount = parseFloat(el.value) || 0;
                // Once a cashier types an amount, stop auto-filling this row —
                // otherwise the next recalculation would overwrite what they
                // deliberately entered.
                t.amountEdited = true;
                this.updateTenderRemaining();
            });
        });
        host.querySelectorAll('.tender-reference').forEach(el => {
            el.addEventListener('input', () => {
                this.tenders[Number(el.dataset.index)].reference = el.value;
            });
        });
        host.querySelectorAll('.tender-remove-btn').forEach(el => {
            el.addEventListener('click', () => {
                this.tenders.splice(Number(el.dataset.index), 1);
                if (this.tenders.length === 1) this.tenders[0].amountEdited = false;
                this.syncTenders();
            });
        });

        this.updateTenderRemaining();
    }

    /**
     * Keeps the tender rows consistent with the bill.
     *
     * The single untouched row simply mirrors the total, so the ordinary case
     * needs no attention at all. Once the cashier has split the payment, their
     * figures are left exactly as typed and only the shortfall is reported —
     * silently "correcting" a split would hide the very mismatch they need to
     * see.
     */
    syncTenders() {
        const autoRow = this.tenders.length === 1 && !this.tenders[0].amountEdited
            ? this.tenders[0]
            : null;

        if (autoRow && autoRow.amount !== this.totalAmount) {
            autoRow.amount = this.totalAmount;
            // Update the field in place rather than rebuilding the rows. This
            // runs on every keystroke in the weight box, and re-rendering the
            // payment section that often would throw away a half-typed
            // reference number.
            const input = document.querySelector('.tender-amount[data-index="0"]');
            if (input) input.value = autoRow.amount || '';
        }
        this.updateTenderRemaining();
    }

    updateTenderRemaining() {
        const el = document.getElementById('tender-remaining');
        if (!el) return;
        const remaining = this.remainingToAllocate();
        if (Math.abs(remaining) < 0.005) {
            el.textContent = 'Payment matches the total.';
            el.style.color = 'var(--color-text-muted)';
        } else if (remaining > 0) {
            el.textContent = `${money(remaining)} still to allocate`;
            el.style.color = 'var(--color-warning)';
        } else {
            el.textContent = `${money(-remaining)} over the total`;
            el.style.color = 'var(--color-danger)';
        }
    }

    recalculateSummaryOnly() {
        const lines = this.activeLines();

        // All money math lives in lib/billingMath.js (discount → tax → advance),
        // now over the whole cart. A one-line cart prices identically to the way
        // this desk always did — the arithmetic below is the same call.
        const totals = computeInvoiceTotals({
            lines: lines.map(l => ({
                metalValue: l.metalValue,
                makingChargeAmount: l.makingChargeAmount
            })),
            discountPercent: this.discountPercent,
            taxSlab: this.taxSlab,
            taxMode: this.taxMode,
            appliedAdvance: this.appliedAdvance,
            customerAdvanceBalance: this.customerAdvanceBalance
        });

        this.discountAmount = totals.discountAmount;
        this.appliedAdvance = totals.appliedAdvance;
        this.totalAmount = totals.totalAmount;
        this.taxableAmount = totals.taxableAmount;
        this.taxAmount = totals.taxAmount;
        const taxAmount = totals.taxAmount;

        // Invoice-level components as they must PRINT: net of the GST shown
        // below them. In exclusive mode these are the gross figures unchanged;
        // in inclusive mode the embedded tax has been carved out so the rows sum
        // correctly.
        const components = totals.components;
        const isInclusive = totals.taxMode === 'Inclusive';

        // The item rows quote the catalogue prices the cashier actually keyed
        // in, which in inclusive mode are the tax-bearing figures — the carving
        // happens in the summary rows below, not here.
        const rowHost = document.getElementById('preview-line-rows');
        if (rowHost) {
            rowHost.innerHTML = lines.length === 0
                ? `<tr><td colspan="4" style="text-align:center; font-style:italic; opacity:0.6;">No items yet</td></tr>`
                // `data-line` / `data-cell` are the stable hook for the
                // Playwright journeys. Positional element ids cannot address a
                // list whose length is not known until the cashier builds it.
                : lines.map((l, i) => `
                    <tr data-line="${i + 1}">
                        <td data-cell="description">${escapeHtml(l.description || 'Gold Ornament')} (${escapeHtml(l.purity)})</td>
                        <td class="text-right" data-cell="weight">${l.weightGrams.toFixed(3)} g</td>
                        <td class="text-right" data-cell="rate">${money(l.goldPricePerGram)}</td>
                        <td class="text-right" data-cell="amount">${money(l.metalValue)}</td>
                    </tr>
                `).join('');
        }

        // Update invoice summary fields
        const sumMetal = document.getElementById('sum-metal-value');
        const sumMakingPct = document.getElementById('sum-making-percent');
        const sumMakingAmt = document.getElementById('sum-making-amount');
        const sumTaxSlab = document.getElementById('sum-tax-slab');
        const sumTaxMode = document.getElementById('sum-tax-mode');
        const sumTaxAmt = document.getElementById('sum-tax-amount');
        const sumDiscountRow = document.getElementById('summary-discount-row');
        const sumDiscountPercent = document.getElementById('sum-discount-percent');
        const sumDiscountAmt = document.getElementById('sum-discount-amount');
        const sumTaxableAmt = document.getElementById('sum-taxable-amount');
        const sumAdvanceRow = document.getElementById('summary-advance-row');
        const sumAdvanceAmt = document.getElementById('sum-advance-amount');
        const sumGrandTotal = document.getElementById('sum-grand-total');

        if (sumMetal) sumMetal.textContent = money(components.metalValue);
        // The percentage is stated only when every line shares it. On a mixed
        // cart there is no single making-charge percentage, and printing one
        // line's rate beside the summed rupees of several would be a wrong
        // statement rather than a missing one.
        if (sumMakingPct) {
            const percents = [...new Set(lines.map(l => l.makingChargePercent))];
            sumMakingPct.textContent = percents.length === 1 ? percents[0] : '—';
        }
        if (sumMakingAmt) sumMakingAmt.textContent = money(components.makingChargeAmount);

        // Only inclusive pricing restates its lines, so only inclusive pricing
        // needs to say so on the invoice.
        const netNote = isInclusive ? ' (net of GST)' : '';
        document.querySelectorAll('.invoice-summary .sum-net-note')
            .forEach(el => { el.textContent = netNote; });

        if (sumTaxableAmt) sumTaxableAmt.textContent = money(this.taxableAmount);
        if (sumTaxSlab) sumTaxSlab.textContent = this.taxSlab;
        if (sumTaxMode) sumTaxMode.textContent = isInclusive ? 'Incl' : 'Excl';
        if (sumTaxAmt) sumTaxAmt.textContent = money(taxAmount);

        if (this.discountPercent > 0 && sumDiscountRow && sumDiscountAmt) {
            if (sumDiscountPercent) sumDiscountPercent.textContent = this.discountPercent;
            sumDiscountAmt.textContent = `-${money(components.discountAmount)}`;
            sumDiscountRow.style.display = 'flex';
        } else if (sumDiscountRow) {
            sumDiscountRow.style.display = 'none';
        }

        if (this.appliedAdvance > 0 && sumAdvanceRow && sumAdvanceAmt) {
            sumAdvanceAmt.textContent = `-${money(this.appliedAdvance)}`;
            sumAdvanceRow.style.display = 'flex';
        } else if (sumAdvanceRow) {
            sumAdvanceRow.style.display = 'none';
        }

        if (sumGrandTotal) sumGrandTotal.textContent = money(this.totalAmount);

        // The bill moved, so the payment rows have to follow it.
        this.syncTenders();
    }

    /**
     * The customer number as it must be filed: read off the field itself
     * rather than off this.customerPhone, because that property is only
     * refreshed by the `input` event — a browser autofill, a paste handled by
     * the OS, or a value restored on back-navigation never fires it, and the
     * desk would then submit a phone the cashier cannot see on screen.
     *
     * Blank is legitimate (a walk-in cash sale has no number). Anything
     * present must be all ten digits, matching the server's own rule at
     * POST /api/sales — the same rule enforced in the same terms on both
     * sides, so the desk never hands over a bill the ledger will reject.
     *
     * @returns {{phone: string, valid: boolean}}
     */
    readCustomerPhone() {
        const phoneInput = document.getElementById('customer-phone');
        const phone = String(phoneInput?.value || '').replace(/\D/g, '').slice(0, 10);
        this.customerPhone = phone;
        return { phone, valid: phone.length === 0 || phone.length === 10 };
    }

    async submitSale() {
        const lines = this.activeLines();
        if (lines.length === 0) {
            alert('Add at least one item to the invoice — enter a weight for the current item, or add items to the cart.');
            return;
        }

        // A partial number used to reach the server, come back as a 400, and
        // surface as a generic "Failed to save invoice" — with the cashier
        // given no clue which field was wrong. Caught here instead, on the
        // field itself, before an invoice number is consumed.
        const { phone, valid: phoneIsValid } = this.readCustomerPhone();
        if (!phoneIsValid) {
            const errorEl = document.getElementById('phone-validation-error');
            if (errorEl) {
                errorEl.textContent =
                    `Customer phone must be exactly 10 digits — ${phone.length} entered. ` +
                    `Clear the field for a cash sale.`;
            }
            const phoneInput = document.getElementById('customer-phone');
            if (phoneInput) {
                phoneInput.focus();
                phoneInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            return;
        }

        // The payment split has to add up before an invoice number is consumed.
        // The server refuses a mismatched split too — this check exists so the
        // cashier is told at the counter, with the figure named, rather than by
        // a rejected save.
        const unallocated = this.remainingToAllocate();
        if (Math.abs(unallocated) >= 0.005) {
            alert(
                unallocated > 0
                    ? `${money(unallocated)} of this bill has not been allocated to a payment method.\n\n`
                        + `Adjust the Payment section so the amounts add up to ${money(this.totalAmount)}.`
                    : `The payments recorded exceed the bill by ${money(-unallocated)}.\n\n`
                        + `Adjust the Payment section so the amounts add up to ${money(this.totalAmount)}.`
            );
            document.getElementById('tender-rows')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }

        // Only what the server actually reads. It prices the invoice itself
        // from its own active rate and tax settings, so sending a metal value,
        // a tax figure or a timestamp here would just be sending numbers that
        // get discarded — and a payload field the server ignores is one a
        // future reader will assume is authoritative.
        //
        // goldPricePerGram and totalAmount are the exceptions, and they are
        // sent to be CHECKED, not used: the server compares them against its
        // own and answers with rateCorrected/totalCorrected so the desk finds
        // out that the on-screen preview is stale.
        const salePayload = {
            customerName: this.customerName || 'Cash Sale',
            customerPhone: this.customerPhone || '',
            lines: lines.map(l => ({
                description: l.description,
                purity: l.purity,
                weightGrams: l.weightGrams,
                goldPricePerGram: l.goldPricePerGram,
                makingChargePercent: l.makingChargePercent,
                makingChargeAmount: l.makingChargeAmount
            })),
            discountPercent: this.discountPercent,
            appliedAdvance: this.appliedAdvance,
            /* HOW IT WAS PAID.

               A single row the cashier never edited is sent as a METHOD WITH NO
               AMOUNT, meaning "the whole bill, this way". The server fills in
               its own total, so an invoice it legitimately reprices — an
               overnight rate sync, a tax slab changed mid-shift — still records
               the payment the cashier intended instead of being refused for
               disagreeing with a stale figure on this screen.

               An actual split sends explicit amounts, which the server requires
               to reconcile exactly. A zero-value row is dropped rather than
               sent: an empty split row the cashier added and thought better of
               should not block a sale that is otherwise correct. */
            tenders: this.tenders.length === 1 && !this.tenders[0].amountEdited
                ? [{ method: this.tenders[0].method, reference: this.tenders[0].reference }]
                : this.tenders
                    .filter(t => Number(t.amount) > 0)
                    .map(t => ({ method: t.method, amount: round2(t.amount), reference: t.reference })),
            totalAmount: this.totalAmount
        };

        try {
            const startPost = Date.now();
            const response = await adminFetch('/api/sales', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(salePayload)
            });

            if (response.ok) {
                logTelemetry('SAVE_SALE_SUCCESS', Date.now() - startPost);
                const result = await response.json();
                if ((result.totalCorrected || result.rateCorrected) && result.sale) {
                    // The server priced it differently (almost always a stale
                    // tab whose gold rate or tax settings changed underneath
                    // it). Say so rather than let the printed slip disagree
                    // with the ledger.
                    const reason = result.rateCorrected
                        ? `the current gold rate of ₹${result.sale.goldPricePerGram.toLocaleString('en-IN')}/g`
                        : 'the current tax settings';
                    alert(
                        `Invoice ${result.invoiceId} saved, but the server recalculated the total to ` +
                        `₹${result.sale.totalAmount.toLocaleString('en-IN')} using ${reason}.\n\n` +
                        `Please reprint the invoice — the preview on screen is out of date.`
                    );
                } else {
                    alert('Invoice Saved Successfully!');
                }
                this.resetForm();
            } else {
                const err = await response.json();
                alert('Failed to save invoice: ' + err.error);
            }
        } catch (err) {
            console.error('API connection failed during sale submission:', err);
            alert('Failed to submit sale to server. Checked errors in diagnostics log.');
        }
    }

    resetForm() {
        const form = document.getElementById('billing-form');
        if (form) form.reset();
        this.customerName = '';
        this.customerPhone = '';
        // A filed invoice takes its items and its payment split with it — the
        // next customer must not inherit either.
        this.cart = [];
        this.tenders = [{ method: 'cash', amount: 0, reference: '', amountEdited: false }];
        this.renderCart();
        this.renderTenderRows();
        this.discountPercent = this.defaultDiscountConfig;
        const discountInput = document.getElementById('manual-discount');
        if (discountInput) discountInput.value = this.discountPercent;
        
        const toggleBtn = document.getElementById('toggle-discount-btn');
        if (toggleBtn && this.defaultDiscountConfig > 0) {
            toggleBtn.textContent = 'Remove';
            toggleBtn.className = 'btn btn-secondary btn-small';
        }
        
        this.discountAmount = 0;
        this.appliedAdvance = 0;
        this.customerAdvanceBalance = 0;
        
        const previewName = document.getElementById('preview-customer-name');
        const previewPhone = document.getElementById('preview-customer-phone');
        if (previewName) previewName.textContent = 'Cash Sale';
        if (previewPhone) previewPhone.textContent = '-';

        this.clearAdvance();
        this.recalculate();
    }
}
