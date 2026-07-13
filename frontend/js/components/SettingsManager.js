import { adminFetch, logTelemetry } from '../app.js';

const SECTIONS = [
    { id: 'profile', label: 'Store Profile' },
    { id: 'pricing', label: 'Gold Pricing & Overrides' },
    { id: 'billing', label: 'Billing & Invoice' },
    { id: 'payment', label: 'Payment Gateway' },
    { id: 'backup', label: 'Backup & Email Reports' },
    { id: 'license', label: 'License & Subscription' }
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
                    <input type="text" id="set-company-name" class="form-control" value="${s.companyName || ''}">
                </div>
                <div class="form-group">
                    <label for="set-phone">Phone</label>
                    <input type="text" id="set-phone" class="form-control" value="${s.phone || ''}">
                </div>
            </div>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-address">Address</label>
                    <input type="text" id="set-address" class="form-control" value="${s.address || ''}">
                </div>
                <div class="form-group">
                    <label for="set-gst">GST Number</label>
                    <input type="text" id="set-gst" class="form-control" value="${s.gstNumber || ''}">
                </div>
            </div>
            <div class="form-group" style="max-width:150px;">
                <label for="set-currency">Currency</label>
                <input type="text" id="set-currency" class="form-control" value="${s.currency || 'INR'}">
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
                        <option value="goldapi" ${s.goldApiProvider === 'goldapi' ? 'selected' : ''}>GoldAPI.io</option>
                        <option value="metalsdev" ${s.goldApiProvider === 'metalsdev' ? 'selected' : ''}>Metals.dev</option>
                        <option value="mock" ${s.goldApiProvider === 'mock' ? 'selected' : ''}>Mock (testing only)</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="set-gold-key">API Key (if required)</label>
                    <input type="text" id="set-gold-key" class="form-control" value="${s.goldApiKey || ''}">
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
                    <input type="number" id="price-override-24k" class="form-control" value="${override.price24K || ''}">
                    <span id="raw-internet-24k" class="text-muted-small"></span>
                </div>
                <div class="form-group">
                    <label for="price-override-22k">22K Price / g</label>
                    <input type="number" id="price-override-22k" class="form-control" value="${override.price22K || ''}">
                    <span id="raw-internet-22k" class="text-muted-small"></span>
                </div>
                <div class="form-group">
                    <label for="price-override-18k">18K Price / g</label>
                    <input type="number" id="price-override-18k" class="form-control" value="${override.price18K || ''}">
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
                goldApiKey: document.getElementById('set-gold-key').value,
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
                    <input type="number" id="set-tax-slab" class="form-control" value="${s.goldTaxSlab ?? 3}" step="0.1" min="0">
                </div>
                <div class="form-group">
                    <label for="set-admin-pin">Admin PIN</label>
                    <input type="text" id="set-admin-pin" class="form-control" value="${s.adminPin || '1234'}" maxlength="8">
                </div>
            </div>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-invoice-prefix">Invoice Prefix</label>
                    <input type="text" id="set-invoice-prefix" class="form-control" value="${s.invoicePrefix || 'GOLD'}">
                </div>
                <div class="form-group">
                    <label for="set-invoice-seq">Next Invoice Sequence Number</label>
                    <input type="number" id="set-invoice-seq" class="form-control" value="${s.invoiceSeqStart ?? 1}" min="1">
                    <span class="text-muted-small">Lowering this is a destructive action and requires confirmation — it can create duplicate invoice numbers.</span>
                </div>
            </div>
            <button type="button" id="save-billing-btn" class="btn btn-primary">Save Billing Settings</button>
        `;
    }

    wireBillingSection() {
        document.getElementById('save-billing-btn').addEventListener('click', async () => {
            const requestedSeq = parseInt(document.getElementById('set-invoice-seq').value) || 1;
            const currentSeq = parseInt(this.settings.invoiceSeqStart) || 1;

            const payload = {
                goldTaxSlab: parseFloat(document.getElementById('set-tax-slab').value) || 0,
                adminPin: document.getElementById('set-admin-pin').value || '1234',
                invoicePrefix: document.getElementById('set-invoice-prefix').value || 'GOLD',
                invoiceSeqStart: requestedSeq
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
                    <input type="text" id="set-rzp-key" class="form-control" value="${s.razorpayKeyId || ''}">
                </div>
                <div class="form-group">
                    <label for="set-rzp-secret">Key Secret</label>
                    <input type="password" id="set-rzp-secret" class="form-control" value="${s.razorpayKeySecret || ''}">
                </div>
            </div>
            <p class="text-muted-small">The demo pair <code>rzp_test_xxxxxx</code> / <code>rzp_test_xxxxxx_secret</code> auto-mocks checkout for local testing. Any other value is sent to the real Razorpay API.</p>

            <h3 class="settings-section-title" style="margin-top:24px;">Manual UPI Fallback</h3>
            <div class="form-group" style="max-width:300px;">
                <label for="set-upi-id">UPI ID (VPA)</label>
                <input type="text" id="set-upi-id" class="form-control" value="${s.upiId || ''}" placeholder="yourstore@upi">
            </div>
            <p class="text-muted-small">Used to build the real <code>upi://pay</code> QR code shown to customers when Razorpay isn't used.</p>

            <button type="button" id="save-payment-btn" class="btn btn-primary" style="margin-top:10px;">Save Payment Settings</button>
        `;
    }

    wirePaymentSection() {
        document.getElementById('save-payment-btn').addEventListener('click', async () => {
            const payload = {
                razorpayKeyId: document.getElementById('set-rzp-key').value,
                razorpayKeySecret: document.getElementById('set-rzp-secret').value,
                upiId: document.getElementById('set-upi-id').value
            };
            await this.saveSettings(payload, 'Payment settings saved!');
        });
    }

    // ---------------------------------------------------------------- Backup
    renderBackupSection() {
        const s = this.settings;
        const smtp = s.smtp || {};
        return `
            <h3 class="settings-section-title">Report Recipient</h3>
            <div class="form-group" style="max-width:320px;">
                <label for="set-report-email">Report Email Address</label>
                <input type="email" id="set-report-email" class="form-control" value="${s.reportEmail || ''}">
            </div>

            <h3 class="settings-section-title" style="margin-top:24px;">SMTP Configuration</h3>
            <p class="text-muted-small" style="margin-bottom:12px;">Left blank, report emails are skipped automatically (logged, not an error).</p>
            <div class="form-group-row">
                <div class="form-group">
                    <label for="set-smtp-host">SMTP Host</label>
                    <input type="text" id="set-smtp-host" class="form-control" value="${smtp.host || ''}" placeholder="smtp.example.com">
                </div>
                <div class="form-group">
                    <label for="set-smtp-port">Port</label>
                    <input type="number" id="set-smtp-port" class="form-control" value="${smtp.port || 587}">
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
                    <input type="text" id="set-smtp-user" class="form-control" value="${smtp.user || ''}">
                </div>
                <div class="form-group">
                    <label for="set-smtp-pass">SMTP Password</label>
                    <input type="password" id="set-smtp-pass" class="form-control" value="${smtp.pass || ''}">
                </div>
                <div class="form-group">
                    <label for="set-smtp-fromname">"From" Display Name</label>
                    <input type="text" id="set-smtp-fromname" class="form-control" value="${smtp.fromName || ''}">
                </div>
            </div>
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
                smtp: {
                    host: document.getElementById('set-smtp-host').value,
                    port: parseInt(document.getElementById('set-smtp-port').value) || 587,
                    secure: document.getElementById('set-smtp-secure').checked,
                    user: document.getElementById('set-smtp-user').value,
                    pass: document.getElementById('set-smtp-pass').value,
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
            } catch (err) {
                const block = document.getElementById('license-status-block');
                if (block) block.textContent = 'Failed to load license status.';
            }
        })();

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

    // ---------------------------------------------------------------- Shared
    wireSection(sectionId) {
        const wirers = {
            profile: () => this.wireProfileSection(),
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
                alert('Failed to save settings.');
            }
        } catch (err) {
            alert('Error saving settings: connection failed.');
        }
    }
}
