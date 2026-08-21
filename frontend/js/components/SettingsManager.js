import { adminFetch, logTelemetry } from '../app.js';
import { normalizeTaxMode } from '../lib/billingMath.js';

function escapeHtmlAttr(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

const SECTIONS = [
    { id: 'profile', label: 'Store Profile' },
    { id: 'staff', label: 'Staff & Roles' },
    { id: 'pricing', label: 'Gold Pricing & Overrides' },
    { id: 'billing', label: 'Billing & Invoice' },
    { id: 'payment', label: 'Payment Gateway' },
    { id: 'backup', label: 'Backup & Email Reports' },
    { id: 'license', label: 'License & Subscription' }
];

/** Must match OPERATOR_ROLES in backend/defaultSettings.js. */
const OPERATOR_ROLES = [
    { value: 'owner', label: 'Owner — full access, can approve deposits' },
    { value: 'manager', label: 'Manager — can approve deposits' },
    { value: 'cashier', label: 'Cashier — bills and refunds, cannot approve' },
    { value: 'auditor', label: 'Auditor — read-only' }
];

/**
 * System Configurations tab, reorganized into sub-sections (Store Profile,
 * Gold Pricing & Overrides, Billing & Invoice, Payment Gateway, Backup &
 * Email Reports, License & Subscription). Loads /api/settings once and lets
 * each section save its own slice via a partial POST /api/settings.
 */
export class SettingsManager {
    constructor() {
        this.settings = {};
        this.activeSection = 'profile';
        this.currentLogoBase64 = null;
        this.render();
    }

    render() {
        const container = document.querySelector('#settings-tab .panel-body');
        if (!container) return;

        container.innerHTML = `
            <div class="settings-shell">
                <nav class="settings-subnav">
                    ${SECTIONS.map(s => `<button type="button" class="settings-subnav-btn${s.id === this.activeSection ? ' active' : ''}" data-section="${s.id}">${s.label}</button>`).join('')}
                </nav>
                <div class="settings-content" id="settings-content"></div>
            </div>
        `;

        container.querySelectorAll('.settings-subnav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.activeSection = btn.getAttribute('data-section');
                container.querySelectorAll('.settings-subnav-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.renderSection();
            });
        });
    }

    async refresh() {
        try {
            const res = await adminFetch('/api/settings');
            this.settings = res.ok ? await res.json() : {};
            // Any in-progress staff edits belong to the copy that was just
            // replaced, so they are dropped rather than saved against new data.
            this.staffDraft = null;
            this.renderSection();
        } catch (err) {
            console.error('Failed to load settings:', err);
        }
    }

    renderSection() {
        const content = document.getElementById('settings-content');
        if (!content) return;

        const renderers = {
            profile: () => this.renderProfileSection(),
            staff: () => this.renderStaffSection(),
            pricing: () => this.renderPricingSection(),
            billing: () => this.renderBillingSection(),
            payment: () => this.renderPaymentSection(),
            backup: () => this.renderBackupSection(),
            license: () => this.renderLicenseSection()
        };
        content.innerHTML = (renderers[this.activeSection] || renderers.profile)();
        this.wireSection(this.activeSection);
    }

    // ---------------------------------------------------------------- Profile
    renderProfileSection() {
        const s = this.settings;
        return `
            <h3 class="settings-section-title">Store Profile</h3>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-company-name">Company Name</label>
                    <input type="text" id="set-company-name" class="form-control" value="${escapeHtmlAttr(s.companyName || '')}">
                </div>
                <div class="form-group">
                    <label for="set-phone">Phone</label>
                    <input type="text" id="set-phone" class="form-control" value="${escapeHtmlAttr(s.phone || '')}">
                </div>
            </div>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-address">Address</label>
                    <input type="text" id="set-address" class="form-control" value="${escapeHtmlAttr(s.address || '')}">
                </div>
                <div class="form-group">
                    <label for="set-gst">GST Number</label>
                    <input type="text" id="set-gst" class="form-control" value="${escapeHtmlAttr(s.gstNumber || '')}">
                </div>
            </div>
            <div class="form-group" style="max-width:150px;">
                <label for="set-currency">Currency</label>
                <select id="set-currency" class="form-control">
                    <option value="INR" ${(!s.currency || s.currency === 'INR') ? 'selected' : ''}>INR (₹)</option>
                    <option value="USD" ${s.currency === 'USD' ? 'selected' : ''}>USD ($)</option>
                    <option value="EUR" ${s.currency === 'EUR' ? 'selected' : ''}>EUR (€)</option>
                    <option value="GBP" ${s.currency === 'GBP' ? 'selected' : ''}>GBP (£)</option>
                    <option value="AED" ${s.currency === 'AED' ? 'selected' : ''}>AED (د.إ)</option>
                    <option value="SGD" ${s.currency === 'SGD' ? 'selected' : ''}>SGD (S$)</option>
                </select>
            </div>

            <h3 class="settings-section-title" style="margin-top:24px;">Company Logo</h3>
            <p class="text-muted-small" style="margin-bottom:12px;">Displayed on printed invoices. Max size: 5MB.</p>
            <div style="display:flex; align-items:flex-start; gap:20px;">
                <div style="display:flex; flex-direction:column; gap:10px;">
                    <input type="file" id="company-logo-upload" accept="image/*" style="font-size:13px;">
                    <button type="button" id="clear-logo-btn" class="btn btn-danger">Clear Logo</button>
                </div>
                <div style="border:1px dashed var(--color-border-dark); padding:10px; border-radius:4px; background:var(--color-bg-base); min-width:150px; min-height:80px; display:flex; align-items:center; justify-content:center;">
                    <img id="logo-preview" src="${this.currentLogoBase64 || s.companyLogo || ''}" alt="No Logo Selected" style="max-width:150px; max-height:80px; display:${(this.currentLogoBase64 || s.companyLogo) ? 'block' : 'none'};">
                    <span id="logo-preview-placeholder" style="font-size:12px; color:var(--color-text-light); display:${(this.currentLogoBase64 || s.companyLogo) ? 'none' : 'block'};">No Logo</span>
                </div>
            </div>

            <button type="button" id="save-profile-btn" class="btn btn-primary" style="margin-top:20px;">Save Store Profile</button>
        `;
    }

    wireProfileSection() {
        const logoUpload = document.getElementById('company-logo-upload');
        const logoPreview = document.getElementById('logo-preview');
        const logoPlaceholder = document.getElementById('logo-preview-placeholder');
        const clearLogoBtn = document.getElementById('clear-logo-btn');

        if (logoUpload) {
            logoUpload.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (evt) => {
                        this.currentLogoBase64 = evt.target.result;
                        logoPreview.src = this.currentLogoBase64;
                        logoPreview.style.display = 'block';
                        logoPlaceholder.style.display = 'none';
                    };
                    reader.readAsDataURL(file);
                }
            });
        }
        if (clearLogoBtn) {
            clearLogoBtn.addEventListener('click', () => {
                this.currentLogoBase64 = null;
                if (logoUpload) logoUpload.value = '';
                logoPreview.src = '';
                logoPreview.style.display = 'none';
                logoPlaceholder.style.display = 'block';
            });
        }

        document.getElementById('save-profile-btn').addEventListener('click', async () => {
            const payload = {
                companyName: document.getElementById('set-company-name').value,
                phone: document.getElementById('set-phone').value,
                address: document.getElementById('set-address').value,
                gstNumber: document.getElementById('set-gst').value,
                currency: document.getElementById('set-currency').value,
                companyLogo: this.currentLogoBase64 !== null ? this.currentLogoBase64 : (this.settings.companyLogo || null)
            };
            await this.saveSettings(payload, 'Store profile saved!');
        });
    }

    // ---------------------------------------------------------------- Pricing
    renderPricingSection() {
        const s = this.settings;
        const override = s.overrideGoldPrice || {};
        return `
            <h3 class="settings-section-title">Gold Rate Source</h3>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-gold-provider">API Provider</label>
                    <select id="set-gold-provider" class="form-control">
                        <option value="public" ${s.goldApiProvider === 'public' ? 'selected' : ''}>Public (Yahoo Finance, keyless)</option>
                        <option value="mock" ${s.goldApiProvider === 'mock' ? 'selected' : ''}>Mock (testing only)</option>
                    </select>
                </div>
            </div>
            <button type="button" id="sync-gold-price-btn" class="btn btn-secondary">Sync Price Now</button>

            <h3 class="settings-section-title" style="margin-top:24px;">Manual Overrides</h3>
            <p class="text-muted-small" style="margin-bottom:12px;">Setting a value here bypasses the daily automatic internet sync for that specific carat.</p>
            <label style="display:flex; align-items:center; gap:8px; margin-bottom:15px; font-size:13px; font-weight:600;">
                <input type="checkbox" id="set-override-active" ${override.active ? 'checked' : ''}> Enable manual overrides
            </label>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="price-override-24k">24K Price / g</label>
                    <input type="number" id="price-override-24k" class="form-control" value="${Number(override.price24K) || ''}">
                    <span id="raw-internet-24k" class="text-muted-small"></span>
                </div>
                <div class="form-group">
                    <label for="price-override-22k">22K Price / g</label>
                    <input type="number" id="price-override-22k" class="form-control" value="${Number(override.price22K) || ''}">
                    <span id="raw-internet-22k" class="text-muted-small"></span>
                </div>
                <div class="form-group">
                    <label for="price-override-18k">18K Price / g</label>
                    <input type="number" id="price-override-18k" class="form-control" value="${Number(override.price18K) || ''}">
                    <span id="raw-internet-18k" class="text-muted-small"></span>
                </div>
            </div>
            <button type="button" id="save-price-override" class="btn btn-primary">Save Pricing Settings</button>
        `;
    }

    wirePricingSection() {
        document.getElementById('sync-gold-price-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Syncing...';
            try {
                const res = await adminFetch('/api/gold-price/sync', { method: 'POST' });
                if (res.ok) {
                    alert('Success: Gold price synced!');
                    if (window.billingDesk) await window.billingDesk.fetchGoldRate();
                    if (window.dashboard) window.dashboard.refresh();
                } else {
                    alert('Sync failed.');
                }
            } catch (err) {
                alert('Sync failed: connection error.');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Sync Price Now';
            }
        });

        (async () => {
            try {
                const res = await fetch('/api/gold-price');
                if (res.ok) {
                    const data = await res.json();
                    if (data.raw) {
                        const r24 = document.getElementById('raw-internet-24k');
                        const r22 = document.getElementById('raw-internet-22k');
                        const r18 = document.getElementById('raw-internet-18k');
                        if (r24) r24.textContent = `Live Market: ₹${data.raw.price24K}/g`;
                        if (r22) r22.textContent = `Live Market: ₹${data.raw.price22K}/g`;
                        if (r18) r18.textContent = `Live Market: ₹${data.raw.price18K}/g`;
                    }
                }
            } catch (err) { /* non-fatal, badges just stay empty */ }
        })();

        document.getElementById('save-price-override').addEventListener('click', async () => {
            const payload = {
                goldApiProvider: document.getElementById('set-gold-provider').value,
                overrideGoldPrice: {
                    active: document.getElementById('set-override-active').checked,
                    price24K: parseFloat(document.getElementById('price-override-24k').value) || 0,
                    price22K: parseFloat(document.getElementById('price-override-22k').value) || 0,
                    price18K: parseFloat(document.getElementById('price-override-18k').value) || 0
                }
            };
            await this.saveSettings(payload, 'Gold pricing settings saved!', async () => {
                if (window.billingDesk) await window.billingDesk.fetchGoldRate();
                if (window.dashboard) window.dashboard.refresh();
            });
        });
    }

    // ---------------------------------------------------------------- Billing
    renderBillingSection() {
        const s = this.settings;
        return `
            <h3 class="settings-section-title">Tax & Invoice Numbering</h3>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-tax-slab">Default GST Tax Slab (%)</label>
                    <select id="set-tax-slab" class="form-control">
                        <option value="0" ${s.goldTaxSlab == 0 ? 'selected' : ''}>0%</option>
                        <option value="3" ${s.goldTaxSlab == 3 || s.goldTaxSlab == null ? 'selected' : ''}>3% (Gold & Silver)</option>
                        <option value="5" ${s.goldTaxSlab == 5 ? 'selected' : ''}>5%</option>
                        <option value="12" ${s.goldTaxSlab == 12 ? 'selected' : ''}>12%</option>
                        <option value="18" ${s.goldTaxSlab == 18 ? 'selected' : ''}>18%</option>
                        <option value="28" ${s.goldTaxSlab == 28 ? 'selected' : ''}>28%</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="set-tax-mode">Tax Mode</label>
                    <select id="set-tax-mode" class="form-control">
                        <option value="Exclusive" ${normalizeTaxMode(s.taxMode) !== 'Inclusive' ? 'selected' : ''}>Exclusive (Added to Total)</option>
                        <option value="Inclusive" ${normalizeTaxMode(s.taxMode) === 'Inclusive' ? 'selected' : ''}>Inclusive (Included in Total)</option>
                    </select>
                </div>
            </div>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-default-discount">Default Discount (%)</label>
                    <input type="number" id="set-default-discount" class="form-control" value="${Number(s.defaultDiscountPercent) || 0}" step="1" min="0" max="99">
                </div>
                <div class="form-group">
                    <label for="set-admin-pin">Admin PIN</label>
                    <input type="password" id="set-admin-pin" class="form-control" value="" maxlength="8" placeholder="${s.adminPinConfigured ? 'Configured — leave blank to keep' : 'Enter a new PIN'}">
                </div>
            </div>
            <p class="text-muted-small">The saved Admin PIN is never sent to this screen. Leave the field blank to keep it, or enter a replacement.</p>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-invoice-prefix">Invoice Prefix</label>
                    <input type="text" id="set-invoice-prefix" class="form-control" value="${escapeHtmlAttr(s.invoicePrefix || 'GOLD')}">
                </div>
                <div class="form-group">
                    <label for="set-invoice-seq">Next Invoice Sequence Number</label>
                    <input type="number" id="set-invoice-seq" class="form-control" value="${Number(s.invoiceSeqStart) || 1}" min="1">
                    <span class="text-muted-small">Lowering this is a destructive action and requires confirmation — it can create duplicate invoice numbers.</span>
                </div>
            </div>
            <h3 class="settings-section-title" style="margin-top:30px;">Old-Gold Exchange</h3>
            <p style="font-size:13px; color:var(--color-text-muted); max-width:80ch; margin-bottom:16px;">
                Off by default. When on, the Billing Desk can weigh, test and credit gold a customer
                trades in — the credit posts as an ordinary advance, redeemable like any other.
                <strong>Buying gold from a customer's GST/reverse-charge treatment is not handled
                here</strong> and remains a legal question for your CA before relying on this at
                scale.
            </p>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-oldgold-enabled">Accept Old-Gold Exchange</label>
                    <select id="set-oldgold-enabled" class="form-control">
                        <option value="false"${s.oldGoldExchangeEnabled ? '' : ' selected'}>No</option>
                        <option value="true"${s.oldGoldExchangeEnabled ? ' selected' : ''}>Yes</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="set-oldgold-deduction">Deduction (%)</label>
                    <input type="number" id="set-oldgold-deduction" class="form-control"
                           value="${Number(s.oldGoldDeductionPercent) || 0}" step="0.5" min="0" max="100">
                    <span class="text-muted-small">Covers refining loss and margin — subtracted from the tested weight before it is valued.</span>
                </div>
            </div>
            <h3 class="settings-section-title" style="margin-top:30px;">Gold Savings Schemes</h3>
            <p style="font-size:13px; color:var(--color-text-muted); max-width:80ch; margin-bottom:16px;">
                Off by default. Terms below are an engineering placeholder — an "11 installments +
                1 free" structure typical of Indian gold-scheme practice — <strong>not a legally
                reviewed product.</strong> Real terms and Indian legal/CA review of customer-money
                treatment, advertising, cancellation and nomination rules still gate enabling this
                for a live tenant. Changing these terms only affects customers who enroll AFTER the
                change — an existing enrollment keeps the terms it started with.
            </p>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-scheme-enabled">Offer Gold Schemes</label>
                    <select id="set-scheme-enabled" class="form-control">
                        <option value="false"${s.goldSchemeEnabled ? '' : ' selected'}>No</option>
                        <option value="true"${s.goldSchemeEnabled ? ' selected' : ''}>Yes</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="set-scheme-installments">Installment Count</label>
                    <input type="number" id="set-scheme-installments" class="form-control"
                           value="${Number(s.goldSchemeInstallmentCount) || 11}" step="1" min="1" max="60">
                </div>
                <div class="form-group">
                    <label for="set-scheme-bonus">Bonus Installments</label>
                    <input type="number" id="set-scheme-bonus" class="form-control"
                           value="${Number(s.goldSchemeBonusInstallments) || 0}" step="1" min="0" max="12">
                </div>
            </div>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-scheme-grace">Default Grace (days)</label>
                    <input type="number" id="set-scheme-grace" class="form-control"
                           value="${Number(s.goldSchemeDefaultGraceDays) || 30}" step="1" min="1" max="365">
                </div>
                <div class="form-group">
                    <label for="set-scheme-penalty">Early Closure Penalty (%)</label>
                    <input type="number" id="set-scheme-penalty" class="form-control"
                           value="${Number(s.goldSchemeEarlyClosurePenaltyPercent) || 0}" step="0.5" min="0" max="100">
                </div>
            </div>
            <button type="button" id="save-billing-btn" class="btn btn-primary">Save Billing Settings</button>
        `;
    }

    wireBillingSection() {
        const discountInput = document.getElementById('set-default-discount');
        if (discountInput) {
            discountInput.addEventListener('input', (e) => {
                let val = parseInt(e.target.value, 10);
                if (isNaN(val)) {
                    e.target.value = '';
                } else {
                    if (val > 99) val = 99;
                    if (val < 0) val = 0;
                    e.target.value = val;
                }
            });
        }

        document.getElementById('save-billing-btn').addEventListener('click', async () => {
            const requestedSeq = parseInt(document.getElementById('set-invoice-seq').value) || 1;
            const currentSeq = parseInt(this.settings.invoiceSeqStart) || 1;

            let discountPct = parseInt(document.getElementById('set-default-discount').value, 10) || 0;
            if (discountPct >= 100) discountPct = 99;

            const payload = {
                goldTaxSlab: parseFloat(document.getElementById('set-tax-slab').value) || 0,
                taxMode: document.getElementById('set-tax-mode').value,
                defaultDiscountPercent: discountPct,
                adminPin: document.getElementById('set-admin-pin').value.trim() || null,
                invoicePrefix: document.getElementById('set-invoice-prefix').value || 'GOLD',
                invoiceSeqStart: requestedSeq,
                oldGoldExchangeEnabled: document.getElementById('set-oldgold-enabled').value === 'true',
                oldGoldDeductionPercent: parseFloat(document.getElementById('set-oldgold-deduction').value) || 0,
                goldSchemeEnabled: document.getElementById('set-scheme-enabled').value === 'true',
                goldSchemeInstallmentCount: parseInt(document.getElementById('set-scheme-installments').value, 10) || 11,
                goldSchemeBonusInstallments: parseInt(document.getElementById('set-scheme-bonus').value, 10) || 0,
                goldSchemeDefaultGraceDays: parseInt(document.getElementById('set-scheme-grace').value, 10) || 30,
                goldSchemeEarlyClosurePenaltyPercent: parseFloat(document.getElementById('set-scheme-penalty').value) || 0
            };

            if (requestedSeq < currentSeq) {
                const confirmation = prompt(
                    `You are lowering the invoice sequence from ${currentSeq} to ${requestedSeq}. This can create DUPLICATE invoice numbers against invoices already issued.\n\nType LOWER SEQUENCE (exactly) to confirm:`
                );
                if (confirmation !== 'LOWER SEQUENCE') {
                    alert('Cancelled: confirmation phrase did not match. No changes were saved.');
                    return;
                }
                payload.confirmDestructive = true;
            }

            await this.saveSettings(payload, 'Billing settings saved!');
        });
    }

    // ---------------------------------------------------------------- Payment
    renderPaymentSection() {
        const s = this.settings;
        return `
            <h3 class="settings-section-title">Razorpay Online Checkout</h3>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-rzp-key">Key ID</label>
                    <input type="text" id="set-rzp-key" class="form-control" value="${escapeHtmlAttr(s.razorpayKeyId || '')}">
                </div>
                <div class="form-group">
                    <label for="set-rzp-secret">Key Secret</label>
                    <input type="password" id="set-rzp-secret" class="form-control" value="" placeholder="${s.razorpayKeySecretConfigured ? 'Configured — leave blank to keep' : 'Enter key secret'}">
                </div>
            </div>
            <p class="text-muted-small">The demo pair <code>rzp_test_xxxxxx</code> / <code>rzp_test_xxxxxx_secret</code> auto-mocks checkout for local testing. Any other value is sent to the real Razorpay API.</p>
            <p class="text-muted-small">A saved Key Secret is never sent to this screen. Leave the field blank to keep it, or enter a replacement.</p>

            <div class="form-group-row" style="margin-top:16px;">
                <div class="form-group">
                    <label for="set-rzp-webhook-secret">Webhook Secret</label>
                    <input type="password" id="set-rzp-webhook-secret" class="form-control" value="" placeholder="${s.razorpayWebhookSecretConfigured ? 'Configured — leave blank to keep' : 'Enter webhook secret'}">
                </div>
                <div class="form-group">
                    <label for="set-public-url">Public URL</label>
                    <input type="text" id="set-public-url" class="form-control" value="${escapeHtmlAttr(s.publicUrl || '')}" placeholder="https://pos.yourstore.com">
                </div>
            </div>
            <p class="text-muted-small">
                Razorpay confirms payments server-to-server, which is what credits a customer whose
                browser closed before the success screen. In the Razorpay dashboard add a webhook for
                the <code>payment.captured</code> and <code>payment.failed</code> events pointing at
                <code>${(s.publicUrl || 'https://your-public-url').replace(/\/+$/, '')}/api/payment/webhook</code>,
                then paste the secret it gives you above.
            </p>
            <p class="text-muted-small">
                Until a webhook secret is saved, that endpoint rejects every delivery — a callback that
                cannot be verified is never allowed to credit a ledger. Online payments still work
                without it; they just rely on the customer's browser completing the return trip.
            </p>

            <h3 class="settings-section-title" style="margin-top:24px;">Manual UPI Fallback</h3>
            <div class="form-group" style="max-width:300px;">
                <label for="set-upi-id">UPI ID (VPA)</label>
                <input type="text" id="set-upi-id" class="form-control" value="${escapeHtmlAttr(s.upiId || '')}" placeholder="yourstore@upi">
            </div>
            <p class="text-muted-small">Used to build the real <code>upi://pay</code> QR code shown to customers when Razorpay isn't used.</p>

            <button type="button" id="save-payment-btn" class="btn btn-primary" style="margin-top:10px;">Save Payment Settings</button>
        `;
    }

    wirePaymentSection() {
        document.getElementById('save-payment-btn').addEventListener('click', async () => {
            const payload = {
                razorpayKeyId: document.getElementById('set-rzp-key').value,
                razorpayKeySecret: document.getElementById('set-rzp-secret').value || null,
                // null, not '', so a blank field keeps the stored secret rather
                // than wiping it — same write-only contract as the key secret.
                razorpayWebhookSecret: document.getElementById('set-rzp-webhook-secret').value || null,
                publicUrl: document.getElementById('set-public-url').value.trim(),
                upiId: document.getElementById('set-upi-id').value
            };
            await this.saveSettings(payload, 'Payment settings saved!');
        });
    }

    // ---------------------------------------------------------------- Backup
    /**
     * States, on the SMTP screen itself, whether customers can currently reset
     * their own passwords.
     *
     * SMTP reads here as a reporting setting, so a store that never wanted the
     * daily email leaves it blank and has no way to know it has also switched
     * off every customer's self-service reset — the counter then absorbs every
     * lockout without anyone connecting the two. The consequence belongs next
     * to the cause.
     *
     * Mirrors the same three-field test as GET /api/settings/public's
     * passwordResetAvailable, which is what the portal actually gates on;
     * `pass` arrives here only as the write-only passConfigured flag.
     */
    renderResetAvailabilityNotice(smtp) {
        const live = !!(smtp.host && smtp.user && smtp.passConfigured);
        return live
            ? `<p class="text-muted-small" style="color:#166534; background:#f0fdf4; border:1px solid #86efac; border-radius:6px; padding:10px 12px; margin:12px 0;">
                   <strong>Customer password reset is live.</strong> Customers with an email saved on
                   their account can reset their own password from the portal without coming in.
               </p>`
            : `<p class="text-muted-small" style="color:#92400e; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:10px 12px; margin:12px 0;">
                   <strong>Customer password reset is off.</strong> Until SMTP host, username and
                   password are all set, "Forgot password" in the customer portal cannot send a
                   code — every locked-out customer has to be reset by hand under
                   <strong>Customer Logins</strong>.
               </p>`;
    }

    renderBackupSection() {
        const s = this.settings;
        const smtp = s.smtp || {};
        return `
            <h3 class="settings-section-title">Report Recipient</h3>
            <div class="form-group" style="max-width:320px;">
                <label for="set-report-email">Report Email Address</label>
                <input type="email" id="set-report-email" class="form-control" value="${escapeHtmlAttr(s.reportEmail || '')}">
            </div>
            <div class="form-group" style="max-width:320px;">
                <label for="set-alert-email">Ops Alert Email Address</label>
                <input type="email" id="set-alert-email" class="form-control" value="${escapeHtmlAttr(s.alertEmail || '')}" placeholder="Blank = send to Report Email above">
                <p class="text-muted-small">Payment/webhook failures, ledger drift, backup and rate problems go here instead of the daily summary inbox.</p>
            </div>

            <h3 class="settings-section-title" style="margin-top:24px;">SMTP Configuration</h3>
            <p class="text-muted-small" style="margin-bottom:12px;">Left blank, report emails are skipped automatically (logged, not an error).</p>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-smtp-host">SMTP Host</label>
                    <input type="text" id="set-smtp-host" class="form-control" value="${escapeHtmlAttr(smtp.host || '')}" placeholder="smtp.example.com">
                </div>
                <div class="form-group">
                    <label for="set-smtp-port">Port</label>
                    <input type="number" id="set-smtp-port" class="form-control" value="${Number(smtp.port) || 587}">
                </div>
                <div class="form-group">
                    <label style="display:flex; align-items:center; gap:8px; margin-top:22px;">
                        <input type="checkbox" id="set-smtp-secure" ${smtp.secure ? 'checked' : ''}> Use TLS (secure)
                    </label>
                </div>
            </div>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-smtp-user">SMTP Username</label>
                    <input type="text" id="set-smtp-user" class="form-control" value="${escapeHtmlAttr(smtp.user || '')}">
                </div>
                <div class="form-group">
                    <label for="set-smtp-pass">SMTP Password</label>
                    <input type="password" id="set-smtp-pass" class="form-control" value="" placeholder="${smtp.passConfigured ? 'Configured — leave blank to keep' : 'Enter SMTP password'}">
                </div>
                <div class="form-group">
                    <label for="set-smtp-fromname">"From" Display Name</label>
                    <input type="text" id="set-smtp-fromname" class="form-control" value="${escapeHtmlAttr(smtp.fromName || '')}">
                </div>
            </div>
            <p class="text-muted-small">A saved SMTP Password is never sent to this screen. Leave the field blank to keep it, or enter a replacement.</p>
            ${this.renderResetAvailabilityNotice(smtp)}
            <button type="button" id="save-backup-btn" class="btn btn-primary">Save Backup & Email Settings</button>

            <h3 class="settings-section-title" style="margin-top:24px;">Manual Actions</h3>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                <button type="button" id="run-backup-btn" class="btn btn-secondary">Create Backup Now</button>
                <button type="button" id="send-daily-report-btn" class="btn btn-secondary">Send Daily Report Now</button>
                <button type="button" id="send-monthly-report-btn" class="btn btn-secondary">Send Monthly Report Now</button>
            </div>
            <p id="backup-action-status" class="text-muted-small" style="margin-top:10px;"></p>
        `;
    }

    wireBackupSection() {
        document.getElementById('save-backup-btn').addEventListener('click', async () => {
            const payload = {
                reportEmail: document.getElementById('set-report-email').value,
                alertEmail: document.getElementById('set-alert-email').value,
                smtp: {
                    host: document.getElementById('set-smtp-host').value,
                    port: parseInt(document.getElementById('set-smtp-port').value) || 587,
                    secure: document.getElementById('set-smtp-secure').checked,
                    user: document.getElementById('set-smtp-user').value,
                    pass: document.getElementById('set-smtp-pass').value || null,
                    fromName: document.getElementById('set-smtp-fromname').value
                }
            };
            await this.saveSettings(payload, 'Backup & email settings saved!');
        });

        const statusEl = document.getElementById('backup-action-status');

        document.getElementById('run-backup-btn').addEventListener('click', async () => {
            statusEl.textContent = 'Running backup...';
            try {
                const res = await adminFetch('/api/backup/run', { method: 'POST' });
                const data = await res.json();
                statusEl.textContent = data.success ? `Backup created: ${data.folder}` : `Backup failed: ${data.error || 'unknown error'}`;
            } catch (err) {
                statusEl.textContent = 'Backup failed: connection error.';
            }
        });

        const sendReport = async (period, btnId) => {
            statusEl.textContent = `Sending ${period.toLowerCase()} report...`;
            try {
                const res = await adminFetch('/api/reports/send-now', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ period })
                });
                const data = await res.json();
                statusEl.textContent = data.success ? `${period} report sent successfully.` : `Not sent: ${data.reason || data.error || 'unknown reason'}`;
            } catch (err) {
                statusEl.textContent = 'Report send failed: connection error.';
            }
        };

        document.getElementById('send-daily-report-btn').addEventListener('click', () => sendReport('Daily'));
        document.getElementById('send-monthly-report-btn').addEventListener('click', () => sendReport('Monthly'));
    }

    // ---------------------------------------------------------------- License
    renderLicenseSection() {
        return `
            <h3 class="settings-section-title">License & Subscription Status</h3>
            <div id="license-status-block" class="text-muted-small">Loading license status...</div>

            <div class="form-group" style="max-width:320px; margin-top:20px;">
                <label for="set-license-key">License Activation Key</label>
                <input type="text" id="set-license-key" class="form-control">
            </div>
            <button type="button" id="resync-license-btn" class="btn btn-primary">Activate / Re-sync License</button>

            <h3 class="settings-section-title" style="margin-top:30px;">Platform Updates</h3>
            <div id="update-status-block" class="text-muted-small">Loading update status...</div>
            <div style="display:flex; gap:10px; margin-top:12px;">
                <button type="button" id="check-updates-btn" class="btn btn-secondary">Check for Updates Now</button>
                <button type="button" id="apply-update-btn" class="btn btn-primary" style="display:none;">Apply Update Now</button>
            </div>
        `;
    }

    wireLicenseSection() {
        (async () => {
            try {
                const res = await fetch('/api/license/status');
                const data = await res.json();
                const block = document.getElementById('license-status-block');
                const license = data.license || {};
                const keyInput = document.getElementById('set-license-key');
                if (keyInput) keyInput.value = license.licenseKey || '';
                if (block) {
                    block.innerHTML = `
                        <table style="font-size:13px; border-collapse:collapse;">
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">License Key</td><td><strong>${license.licenseKey || '—'}</strong></td></tr>
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">Status</td><td><strong>${data.isValid ? 'Valid ✓' : 'Invalid / Expired ✗'}</strong> (${license.status || 'unknown'})</td></tr>
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">Expiry Date</td><td>${license.expiryDate ? new Date(license.expiryDate).toLocaleDateString() : '—'}</td></tr>
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">Last Handshake</td><td>${license.lastHandshakeTime ? new Date(license.lastHandshakeTime).toLocaleString() : 'Never'}</td></tr>
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">Software Version</td><td>${license.currentVersion || '—'}${license.updateAvailable ? ` <span style="color:var(--color-warning); font-weight:600;">(v${license.latestVersion} available)</span>` : ''}</td></tr>
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">Billing Cycle</td><td>${license.billingCycle || '—'}</td></tr>
                            <tr><td style="padding:4px 12px 4px 0; color:var(--color-text-muted);">Next Due Date</td><td>${license.nextDueDate ? new Date(license.nextDueDate).toLocaleDateString() : '—'}</td></tr>
                        </table>
                    `;
                }
                this.renderUpdateStatusBlock(license);
            } catch (err) {
                const block = document.getElementById('license-status-block');
                if (block) block.textContent = 'Failed to load license status.';
            }
        })();

        document.getElementById('check-updates-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            btn.disabled = true;
            btn.textContent = 'Checking...';
            try {
                const res = await adminFetch('/api/admin/update/check', { method: 'POST' });
                const data = await res.json();
                if (res.ok) {
                    this.renderUpdateStatusBlock({ pendingRelease: data.pendingRelease, lastAppliedRelease: data.lastAppliedRelease });
                } else {
                    alert('Update check failed: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                alert('Could not reach the server to check for updates.');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Check for Updates Now';
            }
        });

        document.getElementById('apply-update-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            const pending = this._pendingRelease;
            if (!pending) return;
            if (!confirm(`Apply v${pending.version} (${pending.channel}) now? A full backup and code snapshot are taken first, and this will restart the server.`)) return;
            btn.disabled = true;
            btn.textContent = 'Applying...';
            try {
                const res = await adminFetch('/api/admin/update/apply', { method: 'POST' });
                const data = await res.json();
                if (res.ok) {
                    alert(`Update v${data.version} applied. If the server does not restart automatically (no PM2 in this environment), restart it manually now.`);
                    this.renderSection();
                } else {
                    alert('Apply failed: ' + (data.error || 'Unknown error') + (data.rolledBack ? ' (automatically rolled back — nothing was left half-applied)' : ''));
                }
            } catch (err) {
                alert('Could not reach the server to apply the update — it may already be restarting.');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Apply Update Now';
            }
        });

        document.getElementById('resync-license-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            const key = document.getElementById('set-license-key').value.trim();
            if (!key) {
                alert('Enter a license key first.');
                return;
            }
            btn.disabled = true;
            btn.textContent = 'Activating...';
            try {
                const res = await fetch('/api/license/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ licenseKey: key })
                });
                if (res.ok) {
                    alert('Success: license re-synced!');
                    this.renderSection();
                } else {
                    const data = await res.json();
                    alert('Activation failed: ' + (data.error || 'Invalid license key'));
                }
            } catch (err) {
                alert('Connection to licensing server failed.');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Activate / Re-sync License';
            }
        });
    }

    /**
     * Renders the pending/last-applied release status and shows the "Apply
     * Update Now" button only when a human-approved (feature/patch)
     * release is actually waiting — security releases auto-apply and never
     * sit pending, so there's nothing to manually approve for those.
     */
    renderUpdateStatusBlock(license) {
        const block = document.getElementById('update-status-block');
        const applyBtn = document.getElementById('apply-update-btn');
        if (!block) return;

        this._pendingRelease = license.pendingRelease || null;

        const lines = [];
        if (license.pendingRelease) {
            const p = license.pendingRelease;
            lines.push(`<strong style="color:var(--color-warning);">Update available: v${escapeHtmlAttr(p.version)} (${escapeHtmlAttr(p.channel)})</strong>`);
            if (p.changelog) lines.push(`<div style="margin-top:4px;">${escapeHtmlAttr(p.changelog)}</div>`);
            if (applyBtn) applyBtn.style.display = 'inline-block';
        } else {
            lines.push('Up to date — no pending update.');
            if (applyBtn) applyBtn.style.display = 'none';
        }
        if (license.lastAppliedRelease) {
            const a = license.lastAppliedRelease;
            lines.push(`<div style="margin-top:8px; color:var(--color-text-muted); font-size:12px;">Last applied: v${escapeHtmlAttr(a.version)} (${escapeHtmlAttr(a.channel)}) on ${new Date(a.appliedAt).toLocaleString()}${a.auto ? ' — auto-applied' : ' — manually approved'}</div>`);
        }
        block.innerHTML = lines.join('');
    }

    /* ------------------------------------------------------------------ Staff

       The roster that puts a NAME on every invoice, refund and approval.

       Until this existed, one shared PIN gated the whole desk, so a sale, a
       discount, a counter rate override and a cash refund were all filed with
       nobody attached — and "a manager reconciled this deposit" described a
       control the software could not enforce, because it had no idea who a
       manager was. Each person here gets their own PIN; entering it at the lock
       screen both authenticates and identifies them.

       Editing is local until Save: the roster is held in `this.staffDraft` so a
       half-typed row cannot be written to disk, and a PIN left blank on an
       existing person means "leave theirs alone" rather than "clear it". */

    renderStaffSection() {
        // The draft survives a re-render (adding a row repaints the table), but
        // is rebuilt from the server's copy whenever the section is opened fresh.
        if (!this.staffDraft) this.staffDraft = this.cloneRoster();

        const rows = this.staffDraft.map((op, i) => `
            <tr data-row="${i}">
                <td><input type="text" class="form-control staff-name" data-row="${i}" value="${escapeHtmlAttr(op.name)}" maxlength="60" placeholder="Full name"></td>
                <td>
                    <select class="form-control staff-role" data-row="${i}">
                        ${OPERATOR_ROLES.map(r => `<option value="${r.value}"${r.value === op.role ? ' selected' : ''}>${escapeHtmlAttr(r.label)}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <input type="password" class="form-control staff-pin" data-row="${i}" maxlength="8"
                           placeholder="${op.pinConfigured ? 'unchanged' : '4–8 digits'}" autocomplete="new-password">
                </td>
                <td style="text-align:center;">
                    <input type="checkbox" class="staff-active" data-row="${i}"${op.active !== false ? ' checked' : ''}>
                </td>
                <td style="text-align:center; white-space:nowrap;">
                    ${op.id ? (op.mfaEnabled
                        ? `<span style="color:var(--color-success, #0f766e); font-weight:600; font-size:12px;">On</span>
                           <div class="text-muted-small">${op.recoveryCodesRemaining} recovery code${op.recoveryCodesRemaining === 1 ? '' : 's'} left</div>
                           <button type="button" class="btn btn-secondary btn-sm staff-mfa-off" data-row="${i}" style="margin-top:4px;">Turn off</button>`
                        : `<button type="button" class="btn btn-secondary btn-sm staff-mfa-on" data-row="${i}">Set up</button>`)
                      : '<span class="text-muted-small">Save first</span>'}
                </td>
                <td class="text-right">
                    <button type="button" class="btn btn-secondary btn-sm staff-remove" data-row="${i}">Remove</button>
                </td>
            </tr>
        `).join('');

        return `
            <h3 class="settings-section-title">Counter Staff</h3>
            <p style="font-size:13px; color:var(--color-text-muted); max-width:80ch; margin-bottom:16px;">
                Everyone who works the counter, each with their own PIN. Whoever's PIN unlocks the
                terminal is the name recorded on every invoice, refund and advance filed from that
                session — so a discount, a rate override or a cash refund can always be traced to a
                person. <strong>Approving a customer's unverified UPI deposit needs an Owner or a
                Manager</strong>; a Cashier is refused.
            </p>
            <p style="font-size:13px; color:var(--color-text-muted); max-width:80ch; margin-bottom:18px;">
                Leaving this list empty is fine — the terminal then falls back to the store's master
                PIN (Billing &amp; Invoice section), which signs in as the owner. Unticking
                <strong>Active</strong> stops someone signing in without erasing their name from the
                invoices they already filed.
            </p>

            <table class="advances-table">
                <thead>
                    <tr>
                        <th style="width:24%;">Name</th>
                        <th style="width:26%;">Role</th>
                        <th style="width:13%;">PIN</th>
                        <th style="width:7%; text-align:center;">Active</th>
                        <th style="width:18%; text-align:center;">Two-factor</th>
                        <th style="width:12%;"></th>
                    </tr>
                </thead>
                <tbody id="staff-rows">
                    ${rows || `<tr><td colspan="6" style="text-align:center; padding:24px; color:var(--color-text-light); font-style:italic;">No named staff yet — the store master PIN signs in as the owner.</td></tr>`}
                </tbody>
            </table>

            <div style="display:flex; gap:10px; margin-top:18px;">
                <button type="button" id="staff-add-btn" class="btn btn-secondary">+ Add Person</button>
                <button type="button" id="staff-save-btn" class="btn btn-primary">Save Staff &amp; Roles</button>
            </div>

            <div id="staff-mfa-panel" style="margin-top:20px;"></div>

            <h3 class="settings-section-title" style="margin-top:30px;">Controls on releasing money</h3>
            <p style="font-size:13px; color:var(--color-text-muted); max-width:80ch; margin-bottom:16px;">
                Two limits on the actions that move money out of the store. Both are off by default,
                so nothing changes until you set them.
            </p>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-refund-threshold">Refund needing an Owner/Manager (₹)</label>
                    <input type="number" id="set-refund-threshold" class="form-control" min="0" step="100"
                           value="${Number(s.refundApprovalThreshold) || 0}">
                    <span class="text-muted-small">
                        A refund at or above this amount is refused for a Cashier. <strong>0 means no
                        limit</strong> — any signed-in person can refund any amount, which is how the
                        till has always worked.
                    </span>
                </div>
                <div class="form-group">
                    <label for="set-require-mfa">Require two-factor to release money</label>
                    <select id="set-require-mfa" class="form-control">
                        <option value="false"${s.requireMfaForApprovers ? '' : ' selected'}>No</option>
                        <option value="true"${s.requireMfaForApprovers ? ' selected' : ''}>Yes</option>
                    </select>
                    <span class="text-muted-small">
                        When Yes, approving a customer's UPI deposit or a refund over the limit needs a
                        session that passed an authenticator code. <strong>The shared master PIN cannot
                        satisfy this</strong> — there is no person to enrol — so turn it on only once at
                        least one Owner or Manager above has two-factor set up.
                    </span>
                </div>
            </div>
            <button type="button" id="money-controls-save-btn" class="btn btn-primary" style="margin-top:6px;">Save Money Controls</button>

            <h3 class="settings-section-title" style="margin-top:30px;">Who is signed in right now</h3>
            <p style="font-size:13px; color:var(--color-text-muted); max-width:80ch; margin-bottom:12px;">
                Every live sign-in on every terminal. Sessions last 12 hours. Removing somebody from the
                roster, deactivating them, changing their PIN or changing their role ends their sessions
                automatically — this list is for when you see one you did not expect.
            </p>
            <div id="staff-sessions"></div>
        `;
    }

    /** A fresh editable copy of the roster the server last sent. */
    cloneRoster() {
        return (Array.isArray(this.settings.operators) ? this.settings.operators : []).map(op => ({
            id: op.id || '',
            name: op.name || '',
            role: op.role || 'cashier',
            active: op.active !== false,
            // Whether a PIN exists on disk — the value itself is never sent to
            // the browser (see redactSettingsForBrowser in backend/server.js).
            pinConfigured: !!op.pinConfigured,
            pin: null,
            // Second-factor state is read-only here: it is changed through the
            // dedicated enrol/disable routes, which prove possession of the
            // authenticator and of the caller's own PIN respectively.
            mfaEnabled: !!op.mfaEnabled,
            recoveryCodesRemaining: Number(op.recoveryCodesRemaining) || 0
        }));
    }

    wireStaffSection() {
        // Read every field back into the draft on change, so adding or removing
        // a row never discards what was typed into the others.
        const sync = () => {
            document.querySelectorAll('.staff-name').forEach(el => {
                this.staffDraft[el.dataset.row].name = el.value;
            });
            document.querySelectorAll('.staff-role').forEach(el => {
                this.staffDraft[el.dataset.row].role = el.value;
            });
            document.querySelectorAll('.staff-active').forEach(el => {
                this.staffDraft[el.dataset.row].active = el.checked;
            });
            document.querySelectorAll('.staff-pin').forEach(el => {
                // Blank means "keep the stored PIN" — null, not '' — which is
                // the same write-only contract as every other credential here.
                this.staffDraft[el.dataset.row].pin = el.value.trim() === '' ? null : el.value.trim();
            });
        };

        document.getElementById('staff-add-btn').addEventListener('click', () => {
            sync();
            this.staffDraft.push({ id: '', name: '', role: 'cashier', active: true, pinConfigured: false, pin: null });
            this.renderSection();
        });

        document.querySelectorAll('.staff-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                sync();
                const row = Number(btn.dataset.row);
                const person = this.staffDraft[row];
                if (person.name && !confirm(
                    `Remove ${person.name} from the roster?\n\nInvoices they already filed keep their name. `
                    + `If you only want to stop them signing in, untick Active instead.`
                )) return;
                this.staffDraft.splice(row, 1);
                this.renderSection();
            });
        });

        // Two-factor: per person, and never editable as a plain field — enrolling
        // requires proving the authenticator app works, and disabling requires
        // re-entering your own PIN.
        document.querySelectorAll('.staff-mfa-on').forEach(btn => {
            btn.addEventListener('click', () => {
                sync();
                this.beginMfaEnrolment(this.staffDraft[Number(btn.dataset.row)]);
            });
        });
        document.querySelectorAll('.staff-mfa-off').forEach(btn => {
            btn.addEventListener('click', () => {
                sync();
                this.disableMfa(this.staffDraft[Number(btn.dataset.row)]);
            });
        });

        document.getElementById('money-controls-save-btn').addEventListener('click', () => {
            const threshold = Number(document.getElementById('set-refund-threshold').value);
            if (!Number.isFinite(threshold) || threshold < 0) {
                alert('The refund limit must be zero or a positive amount.');
                return;
            }
            const requireMfa = document.getElementById('set-require-mfa').value === 'true';
            // A store that turns this on with nobody enrolled locks itself out of
            // its own approvals, so it is caught here rather than at the counter.
            const enrolledApprovers = (this.settings.operators || []).filter(op =>
                op.mfaEnabled && op.active !== false && (op.role === 'owner' || op.role === 'manager')
            );
            if (requireMfa && enrolledApprovers.length === 0) {
                alert(
                    'No active Owner or Manager has two-factor set up yet, so turning this on would '
                    + 'leave nobody able to approve a deposit or a large refund.\n\n'
                    + 'Set up two-factor for at least one of them first (the Two-factor column above).'
                );
                return;
            }
            this.saveSettings(
                { refundApprovalThreshold: threshold, requireMfaForApprovers: requireMfa },
                'Money controls saved.'
            );
        });

        this.renderSessions();

        document.getElementById('staff-save-btn').addEventListener('click', () => {
            sync();
            const payload = this.staffDraft.map(op => {
                const row = { name: op.name.trim(), role: op.role, active: op.active };
                if (op.id) row.id = op.id;
                // Omit the key entirely when unchanged: an absent pin means
                // "keep what is on disk" server-side, and a new person with no
                // PIN is rejected there with a message naming them.
                if (op.pin !== null) row.pin = op.pin;
                return row;
            });
            this.saveSettings(
                { operators: payload },
                'Staff and roles saved. New PINs work at the lock screen immediately.',
                async () => {
                    // Re-seed the draft from what was actually persisted, so the
                    // PIN placeholders flip to "unchanged" and generated ids land.
                    this.staffDraft = null;
                    this.renderSection();
                }
            );
        });
    }

    /* ---------------------------------------------------------- Two-factor */

    /**
     * Step one: get a secret and a QR to scan. Nothing is stored yet, so an
     * abandoned setup leaves no half-enrolled operator behind.
     */
    async beginMfaEnrolment(person) {
        const panel = document.getElementById('staff-mfa-panel');
        if (!panel || !person || !person.id) return;
        panel.innerHTML = '<p class="text-muted-small">Preparing…</p>';
        try {
            const res = await adminFetch('/api/admin/mfa/begin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operatorId: person.id })
            });
            const data = await res.json();
            if (!res.ok) {
                panel.innerHTML = `<p class="text-muted-small" style="color:var(--color-danger);">${escapeHtmlAttr(data.message || data.error)}</p>`;
                return;
            }

            panel.innerHTML = `
                <div class="new-deposit-form">
                    <h3 style="margin:0 0 6px; font-size:15px;">Set up two-factor for ${escapeHtmlAttr(person.name)}</h3>
                    <p class="text-muted-small" style="max-width:70ch;">
                        Scan this with Google Authenticator, Authy, or any TOTP app, then type the
                        6-digit code it shows to confirm it works. Nothing is saved until you do —
                        that check is what stops the store enrolling a secret nobody actually holds.
                    </p>
                    <div style="display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap; margin-top:12px;">
                        <img src="${data.qrDataUri}" alt="Two-factor QR code" style="width:220px; height:220px; background:#fff; border:1px solid var(--color-border-dark); border-radius:8px;">
                        <div style="flex:1; min-width:240px;">
                            <label class="text-muted-small">Can't scan? Enter this key by hand:</label>
                            <div style="font-family:var(--font-mono); font-size:13px; word-break:break-all; background:var(--color-bg-panel); border:1px solid var(--color-border-dark); border-radius:6px; padding:8px 10px; margin:4px 0 14px;">${escapeHtmlAttr(data.secret)}</div>
                            <label for="mfa-confirm-code">6-digit code from the app</label>
                            <input type="text" id="mfa-confirm-code" class="form-control" inputmode="numeric" maxlength="6" placeholder="000000" style="letter-spacing:4px; text-align:center;">
                            <div style="display:flex; gap:10px; margin-top:12px;">
                                <button type="button" id="mfa-confirm-btn" class="btn btn-primary">Confirm &amp; Enable</button>
                                <button type="button" id="mfa-cancel-btn" class="btn btn-secondary">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>
            `;

            document.getElementById('mfa-cancel-btn').addEventListener('click', () => { panel.innerHTML = ''; });
            document.getElementById('mfa-confirm-btn').addEventListener('click', () =>
                this.confirmMfaEnrolment(person, data.secret)
            );
            document.getElementById('mfa-confirm-code').focus();
        } catch (err) {
            panel.innerHTML = '<p class="text-muted-small" style="color:var(--color-danger);">Could not reach the server.</p>';
        }
    }

    /**
     * Step two: prove the app is configured, then show the recovery codes.
     *
     * The codes are displayed ONCE and stored only as hashes, so this panel is
     * the single opportunity to write them down. It says so plainly, because a
     * store that loses both the phone and the codes is locked out of its own
     * approvals.
     */
    async confirmMfaEnrolment(person, secret) {
        const code = document.getElementById('mfa-confirm-code').value;
        const panel = document.getElementById('staff-mfa-panel');
        try {
            const res = await adminFetch('/api/admin/mfa/enrol', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operatorId: person.id, secret, code })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data.message || data.error || 'That code was not accepted.');
                return;
            }
            panel.innerHTML = `
                <div class="new-deposit-form" style="border-color:var(--color-warning);">
                    <h3 style="margin:0 0 6px; font-size:15px;">Two-factor is on for ${escapeHtmlAttr(person.name)}</h3>
                    <p style="font-size:13px; color:#92400e; background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:10px 12px; max-width:75ch;">
                        <strong>Write these recovery codes down now and keep them somewhere safe.</strong>
                        Each one works once, and this is the only time they can be shown — they are
                        stored hashed. If the phone is lost and these are gone, ${escapeHtmlAttr(person.name)}
                        cannot approve money until the owner turns two-factor off for them.
                    </p>
                    <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:8px; font-family:var(--font-mono); font-size:14px; margin:12px 0;">
                        ${data.recoveryCodes.map(c => `<div style="background:var(--color-bg-panel); border:1px solid var(--color-border-dark); border-radius:6px; padding:8px; text-align:center;">${escapeHtmlAttr(c)}</div>`).join('')}
                    </div>
                    <div style="display:flex; gap:10px;">
                        <button type="button" id="mfa-print-btn" class="btn btn-secondary">Print these codes</button>
                        <button type="button" id="mfa-done-btn" class="btn btn-primary">I have saved them</button>
                    </div>
                </div>
            `;
            document.getElementById('mfa-print-btn').addEventListener('click', () => window.print());
            document.getElementById('mfa-done-btn').addEventListener('click', async () => {
                panel.innerHTML = '';
                await this.refresh();
                this.activeSection = 'staff';
                this.renderSection();
            });
        } catch (err) {
            alert('Could not reach the server to finish setup.');
        }
    }

    async disableMfa(person) {
        if (!person || !person.id) return;
        const pin = prompt(
            `Turn off two-factor for ${person.name}?\n\n`
            + 'Enter YOUR OWN PIN to confirm. (Asked for so an unattended signed-in terminal '
            + 'cannot be used to strip this protection in one click.)'
        );
        if (!pin) return;
        try {
            const res = await adminFetch('/api/admin/mfa/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operatorId: person.id, pin })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data.message || data.error || 'Could not turn it off.');
                return;
            }
            alert(`Two-factor is off for ${person.name}.`
                + (data.sessionsRevoked ? ` ${data.sessionsRevoked} of their sign-ins were ended.` : ''));
            await this.refresh();
            this.activeSection = 'staff';
            this.renderSection();
        } catch (err) {
            alert('Could not reach the server.');
        }
    }

    /* ------------------------------------------------------- Live sessions */

    async renderSessions() {
        const host = document.getElementById('staff-sessions');
        if (!host) return;
        try {
            const res = await adminFetch('/api/admin/sessions');
            if (res.status === 403) {
                host.innerHTML = '<p class="text-muted-small">Only an Owner or Manager can see who is signed in.</p>';
                return;
            }
            if (!res.ok) {
                host.innerHTML = '<p class="text-muted-small">Could not load the session list.</p>';
                return;
            }
            const data = await res.json();
            if (!data.results.length) {
                host.innerHTML = '<p class="text-muted-small">No live sign-ins.</p>';
                return;
            }

            host.innerHTML = `
                <table class="advances-table">
                    <thead>
                        <tr>
                            <th>Person</th><th>Role</th><th>Signed in</th><th>Expires</th>
                            <th>Two-factor</th><th>From</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${data.results.map(row => {
                            const isMe = row.handle === data.currentHandle;
                            return `
                            <tr${isMe ? ' style="font-weight:600;"' : ''}>
                                <td>${escapeHtmlAttr(row.actor.name)}${isMe ? ' <span class="text-muted-small">(this browser)</span>' : ''}</td>
                                <td>${escapeHtmlAttr(row.actor.role)}</td>
                                <td>${new Date(row.createdAt).toLocaleString()}</td>
                                <td>${new Date(row.expiresAt).toLocaleTimeString()}</td>
                                <td>${row.mfaUsed ? 'Yes' : '<span class="text-muted-small">No</span>'}</td>
                                <td class="text-muted-small">${escapeHtmlAttr(row.ip || '—')}</td>
                                <td class="text-right">${isMe ? ''
                                    : `<button type="button" class="btn btn-secondary btn-sm session-revoke-btn" data-handle="${escapeHtmlAttr(row.handle)}">Sign out</button>`}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            `;

            host.querySelectorAll('.session-revoke-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (!confirm('End this sign-in? Whoever is using that terminal will be returned to the lock screen on their next action.')) return;
                    const res2 = await adminFetch('/api/admin/sessions/revoke', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ handle: btn.dataset.handle })
                    });
                    const body = await res2.json().catch(() => ({}));
                    if (!res2.ok) alert(body.message || body.error || 'Could not end that sign-in.');
                    this.renderSessions();
                });
            });
        } catch (err) {
            host.innerHTML = '<p class="text-muted-small">Could not load the session list.</p>';
        }
    }

    // ---------------------------------------------------------------- Shared
    wireSection(sectionId) {
        const wirers = {
            profile: () => this.wireProfileSection(),
            staff: () => this.wireStaffSection(),
            pricing: () => this.wirePricingSection(),
            billing: () => this.wireBillingSection(),
            payment: () => this.wirePaymentSection(),
            backup: () => this.wireBackupSection(),
            license: () => this.wireLicenseSection()
        };
        (wirers[sectionId] || wirers.profile)();
    }

    async saveSettings(partialPayload, successMessage, afterSave) {
        try {
            const res = await adminFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(partialPayload)
            });
            if (res.ok) {
                const data = await res.json();
                this.settings = data.settings || { ...this.settings, ...partialPayload };
                alert(successMessage);
                logTelemetry('Settings saved.');
                if (afterSave) await afterSave();
            } else if (res.status === 409) {
                const data = await res.json();
                alert(data.message || 'Confirmation required.');
            } else {
                // Say WHAT was wrong. The server rejects a settings save with a
                // specific reason — a duplicate operator PIN, an unknown role —
                // and swallowing it behind a generic failure left the admin with
                // no way to fix the form. One place, so every section benefits.
                const data = await res.json().catch(() => ({}));
                alert(data.message || data.error || 'Failed to save settings.');
            }
        } catch (err) {
            alert('Error saving settings: connection failed.');
        }
    }
}
