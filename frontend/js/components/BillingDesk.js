import { logTelemetry, adminFetch } from '../app.js';

export class BillingDesk {
    constructor() {
        this.goldRate = { price24K: 0, price22K: 0, price18K: 0, source: 'auto' };
        this.selectedPurity = 'price22K';
        this.metalValue = 0;
        this.makingChargePercent = 10; // Default 10%
        this.makingChargeAmount = 0;
        this.taxSlab = 3; // Default 3% GST
        this.discount = 0;
        this.totalAmount = 0;
        this.appliedAdvance = 0;
        this.customerAdvanceBalance = 0;
        this.customerPhone = '';
        this.customerName = '';
        
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
            }
        } catch (err) {
            console.error('Failed to fetch settings for logo', err);
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
                                <input type="number" id="tax-slab" class="form-control" value="3.0" step="0.1" min="0">
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
                                <label for="manual-discount">Manual Discount (₹)</label>
                                <input type="number" id="manual-discount" class="form-control" value="0" min="0" step="1">
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
                            <tbody>
                                <tr>
                                    <td>Gold Ornament (<span id="preview-purity">22K</span>)</td>
                                    <td class="text-right" id="preview-weight">0.000 g</td>
                                    <td class="text-right" id="preview-rate">₹0.00</td>
                                    <td class="text-right" id="preview-metal-val">₹0.00</td>
                                </tr>
                            </tbody>
                        </table>
                        
                        <div class="invoice-summary">
                            <div class="summary-row">
                                <span>Metal Value:</span>
                                <span id="sum-metal-value">₹0.00</span>
                            </div>
                            <div class="summary-row">
                                <span>Making Charges (<span id="sum-making-percent">10</span>%):</span>
                                <span id="sum-making-amount">₹0.00</span>
                            </div>
                            <div class="summary-row">
                                <span>GST Tax (<span id="sum-tax-slab">3</span>%):</span>
                                <span id="sum-tax-amount">₹0.00</span>
                            </div>
                            <div class="summary-row" id="summary-discount-row" style="display: none;">
                                <span>Manual Discount:</span>
                                <span id="sum-discount-amount">-₹0.00</span>
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

        // GST Tax changes
        taxInput.addEventListener('input', () => {
            this.taxSlab = parseFloat(taxInput.value) || 0;
            this.recalculate();
        });

        // Discount changes
        discountInput.addEventListener('input', () => {
            this.discount = parseFloat(discountInput.value) || 0;
            this.recalculate();
        });

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
            let intPart = parseInt(percentIntInput.value) || 0;
            let decStr = percentDecInput.value || '0';
            let pct = parseFloat(`${intPart}.${decStr}`);
            
            if (isNaN(pct)) pct = 0;
            if (pct < 1) pct = 1;
            if (pct > 100) pct = 100;
            
            this.makingChargePercent = pct;
            
            // Recalculate amount from percentage
            this.makingChargeAmount = this.metalValue * (pct / 100);
            amountInput.value = Math.round(this.makingChargeAmount * 100) / 100;
            
            this.recalculateSummaryOnly();
        };

        if (percentIntInput) percentIntInput.addEventListener('input', updateMakingChargeFromPercent);
        if (percentDecInput) percentDecInput.addEventListener('input', updateMakingChargeFromPercent);

        amountInput.addEventListener('input', (e) => {
            let amt = parseFloat(e.target.value) || 0;
            if (amt < 0) amt = 0;
            e.target.value = amt;

            this.makingChargeAmount = amt;

            // Recalculate percentage from amount
            if (this.metalValue > 0) {
                let pct = (amt / this.metalValue) * 100;
                // Clamp display value of percent 1-100
                pct = Math.max(1, Math.min(100, pct));
                this.makingChargePercent = Math.round(pct * 100) / 100;
                
                let pctStr = this.makingChargePercent.toString().split('.');
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
                    const totalBeforeAdvance = this.metalValue + this.makingChargeAmount + (this.metalValue + this.makingChargeAmount) * (this.taxSlab / 100) - this.discount;
                    this.appliedAdvance = Math.min(this.customerAdvanceBalance, totalBeforeAdvance);
                    applyAdvanceBtn.textContent = 'Remove Advance';
                    applyAdvanceBtn.classList.remove('btn-secondary');
                    applyAdvanceBtn.classList.add('btn-danger');
                }
                this.recalculateSummaryOnly();
            }
        });

        // Submit Invoice
        submitBtn.addEventListener('click', () => this.submitSale());
    }

    async lookupCustomerAdvance(phone) {
        try {
            const res = await fetch(`/api/advances/lookup?phone=${phone}`);
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

        // 1. Metal Value calculation
        this.metalValue = weight * rateVal;

        // 2. Making Charges recalculation based on percent
        this.makingChargeAmount = this.metalValue * (this.makingChargePercent / 100);
        const amountInput = document.getElementById('making-amount');
        if (amountInput) {
            amountInput.value = Math.round(this.makingChargeAmount * 100) / 100;
        }

        this.recalculateSummaryOnly();
    }

    recalculateSummaryOnly() {
        const weightInput = document.getElementById('gold-weight');
        const weight = parseFloat(weightInput?.value) || 0;
        const rateVal = this.goldRate[this.selectedPurity] || 0;

        // Compute tax
        const taxableAmount = this.metalValue + this.makingChargeAmount;
        const taxAmount = taxableAmount * (this.taxSlab / 100);

        // Adjust applied advance if it exceeds the remaining total
        if (this.appliedAdvance > 0) {
            const totalBeforeAdvance = taxableAmount + taxAmount - this.discount;
            this.appliedAdvance = Math.min(this.customerAdvanceBalance, Math.max(0, totalBeforeAdvance));
        }

        // Calculate grand total
        this.totalAmount = taxableAmount + taxAmount - this.discount - this.appliedAdvance;
        if (this.totalAmount < 0) this.totalAmount = 0;

        // Update previews
        const previewWeight = document.getElementById('preview-weight');
        const previewRate = document.getElementById('preview-rate');
        const previewMetalVal = document.getElementById('preview-metal-val');
        const previewPurity = document.getElementById('preview-purity');

        if (previewWeight) previewWeight.textContent = `${weight.toFixed(3)} g`;
        if (previewRate) previewRate.textContent = `₹${rateVal.toLocaleString('en-IN')}`;
        if (previewMetalVal) previewMetalVal.textContent = `₹${this.metalValue.toLocaleString('en-IN')}`;
        if (previewPurity) previewPurity.textContent = this.selectedPurity === 'price24K' ? '24K' : this.selectedPurity === 'price22K' ? '22K' : '18K';

        // Update invoice summary fields
        const sumMetal = document.getElementById('sum-metal-value');
        const sumMakingPct = document.getElementById('sum-making-percent');
        const sumMakingAmt = document.getElementById('sum-making-amount');
        const sumTaxSlab = document.getElementById('sum-tax-slab');
        const sumTaxAmt = document.getElementById('sum-tax-amount');
        const sumDiscountRow = document.getElementById('summary-discount-row');
        const sumDiscountAmt = document.getElementById('sum-discount-amount');
        const sumAdvanceRow = document.getElementById('summary-advance-row');
        const sumAdvanceAmt = document.getElementById('sum-advance-amount');
        const sumGrandTotal = document.getElementById('sum-grand-total');

        if (sumMetal) sumMetal.textContent = `₹${this.metalValue.toLocaleString('en-IN')}`;
        if (sumMakingPct) sumMakingPct.textContent = this.makingChargePercent;
        if (sumMakingAmt) sumMakingAmt.textContent = `₹${this.makingChargeAmount.toLocaleString('en-IN')}`;
        if (sumTaxSlab) sumTaxSlab.textContent = this.taxSlab;
        if (sumTaxAmt) sumTaxAmt.textContent = `₹${taxAmount.toLocaleString('en-IN')}`;
        
        if (this.discount > 0 && sumDiscountRow && sumDiscountAmt) {
            sumDiscountAmt.textContent = `-₹${this.discount.toLocaleString('en-IN')}`;
            sumDiscountRow.style.display = 'flex';
        } else if (sumDiscountRow) {
            sumDiscountRow.style.display = 'none';
        }

        if (this.appliedAdvance > 0 && sumAdvanceRow && sumAdvanceAmt) {
            sumAdvanceAmt.textContent = `-₹${this.appliedAdvance.toLocaleString('en-IN')}`;
            sumAdvanceRow.style.display = 'flex';
        } else if (sumAdvanceRow) {
            sumAdvanceRow.style.display = 'none';
        }

        if (sumGrandTotal) sumGrandTotal.textContent = `₹${this.totalAmount.toLocaleString('en-IN')}`;
    }

    async submitSale() {
        const weightInput = document.getElementById('gold-weight');
        const weight = parseFloat(weightInput?.value) || 0;
        
        if (weight <= 0) {
            alert('Please enter a valid gold weight.');
            return;
        }

        const salePayload = {
            customerName: this.customerName || 'Cash Sale',
            customerPhone: this.customerPhone || '',
            purity: this.selectedPurity === 'price24K' ? '24K' : this.selectedPurity === 'price22K' ? '22K' : '18K',
            weightGrams: weight,
            goldPricePerGram: this.goldRate[this.selectedPurity],
            metalValue: this.metalValue,
            makingChargePercent: this.makingChargePercent,
            makingChargeAmount: this.makingChargeAmount,
            taxPercent: this.taxSlab,
            discount: this.discount,
            appliedAdvance: this.appliedAdvance,
            totalAmount: this.totalAmount,
            timestamp: Date.now()
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
                alert('Invoice Saved Successfully!');
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
        this.discount = 0;
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
