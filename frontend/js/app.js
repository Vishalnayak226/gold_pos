/**
 * ==========================================================================
 * Gold POS - Main Application ESM Entrypoint
 * ==========================================================================
 */

import { BillingDesk } from './components/BillingDesk.js';
import { Dashboard } from './components/Dashboard.js';
import { AdvancesManager } from './components/AdvancesManager.js';
import { CustomerAccountsManager } from './components/CustomerAccountsManager.js';
import { SettingsManager } from './components/SettingsManager.js';

document.addEventListener('DOMContentLoaded', () => {
    initAdminAuth();
    initDiagnosticsDrawer();

    // Initialize components before nav activates the default tab, so the
    // per-tab click handlers below can already reach window.dashboard etc.
    window.billingDesk = new BillingDesk();
    window.dashboard = new Dashboard();
    window.advancesManager = new AdvancesManager();
    window.customerAccountsManager = new CustomerAccountsManager();
    window.settingsManager = new SettingsManager();
    if (sessionStorage.getItem('adminToken')) {
        window.dashboard.refresh();
        window.advancesManager.refresh();
        window.customerAccountsManager.refresh();
        window.settingsManager.refresh();
    }

    initNavigation();

    logTelemetry('System Core initialized. Tab views loaded.');

    // Run SaaS licensing gate check
    checkLicenseStatus();

    // Load a tenant-specific frontend extension, if one has been dropped in.
    // See frontend/js/extensions/ and backend/extensions/README.md for the
    // full contract. Absent by default — a missing file is expected and
    // silently skipped, not an error.
    loadFrontendExtension();
});

async function loadFrontendExtension() {
    try {
        const mod = await import('./extensions/index.js');
        const init = mod.default;
        if (typeof init === 'function') {
            init({
                billingDesk: window.billingDesk,
                dashboard: window.dashboard,
                advancesManager: window.advancesManager,
                customerAccountsManager: window.customerAccountsManager,
                settingsManager: window.settingsManager,
                adminFetch,
                logTelemetry
            });
        }
    } catch (err) {
        // No extension present, or it failed to load — never blocks core boot.
    }
}

/**
 * Wraps fetch() with the admin bearer session token. Use for any endpoint
 * that requires requireAdminSession server-side (settings, sales, etc).
 * On a 401 (missing/expired session) it clears local state and forces the
 * lock screen back up rather than silently failing.
 */
export async function adminFetch(url, options = {}) {
    const token = sessionStorage.getItem('adminToken');
    const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token || ''}` };
    const res = await fetch(url, { ...options, headers });

    if (res.status === 401) {
        sessionStorage.removeItem('adminToken');
        sessionStorage.removeItem('adminAuthenticated');
        const loginView = document.getElementById('admin-login-view');
        const appViewport = document.getElementById('app-viewport');
        if (loginView && appViewport) {
            appViewport.style.display = 'none';
            loginView.style.display = 'flex';
        }
    }
    return res;
}

/**
 * Handles Admin POS Login and Session state
 */
function initAdminAuth() {
    const loginView = document.getElementById('admin-login-view');
    const appViewport = document.getElementById('app-viewport');
    const pinInput = document.getElementById('admin-pin-input');
    const loginBtn = document.getElementById('admin-login-btn');
    const logoutBtn = document.getElementById('admin-logout-btn');

    if (!loginView || !appViewport) return;

    // Check if already authenticated in this session (token may have expired
    // server-side, e.g. after a restart — the first gated adminFetch call
    // will catch that and bounce back to the lock screen)
    if (sessionStorage.getItem('adminToken')) {
        loginView.style.display = 'none';
        appViewport.style.display = 'grid';
    }

    loginBtn.addEventListener('click', async () => {
        const pin = pinInput.value;
        loginBtn.disabled = true;
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            });

            if (res.ok) {
                const data = await res.json();
                sessionStorage.setItem('adminToken', data.token);
                loginView.style.display = 'none';
                appViewport.style.display = 'grid';
                pinInput.value = '';
                if (window.dashboard) window.dashboard.refresh();
                if (window.advancesManager) window.advancesManager.refresh();
                if (window.customerAccountsManager) window.customerAccountsManager.refresh();
                if (window.settingsManager) window.settingsManager.refresh();
                if (window.billingDesk) window.billingDesk.fetchSettings();
            } else {
                alert('Incorrect Admin PIN.');
            }
        } catch (err) {
            alert('Could not reach the server to log in. Please check your connection.');
        } finally {
            loginBtn.disabled = false;
        }
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            const token = sessionStorage.getItem('adminToken');
            sessionStorage.removeItem('adminToken');
            appViewport.style.display = 'none';
            loginView.style.display = 'flex';
            try {
                await fetch('/api/admin/logout', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token || ''}` }
                });
            } catch (err) {
                // best-effort — local session is already cleared either way
            }
        });
    }
}

/**
 * Initializes single-page tab-switching navigation
 */
function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const panels = document.querySelectorAll('.tab-panel');

    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');

            // Deactivate all nav buttons and panels
            navButtons.forEach(b => b.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));

            // Activate current
            btn.classList.add('active');
            const targetPanel = document.getElementById(targetId);
            if (targetPanel) {
                targetPanel.classList.add('active');
            }

            if (targetId === 'dashboard-tab' && window.dashboard && sessionStorage.getItem('adminToken')) {
                window.dashboard.refresh();
            }
            if (targetId === 'advances-tab' && window.advancesManager && sessionStorage.getItem('adminToken')) {
                window.advancesManager.refresh();
            }
            if (targetId === 'customer-accounts-tab' && window.customerAccountsManager && sessionStorage.getItem('adminToken')) {
                window.customerAccountsManager.refresh();
            }
            if (targetId === 'settings-tab' && window.settingsManager && sessionStorage.getItem('adminToken')) {
                window.settingsManager.refresh();
            }

            sessionStorage.setItem('activeAdminTab', targetId);
            logTelemetry(`Navigated to tab: ${targetId}`);
        });
    });

    // Restore active tab or default to first
    const savedTab = sessionStorage.getItem('activeAdminTab');
    if (savedTab) {
        const btn = document.querySelector(`.nav-btn[data-target="${savedTab}"]`);
        if (btn) btn.click();
    } else if (navButtons.length > 0) {
        navButtons[0].click();
    }
}

/**
 * Handles Level 1 Telemetry Debug Drawer collapse/expansion
 */
function initDiagnosticsDrawer() {
    const drawer = document.getElementById('debug-drawer');
    const toggleBtn = document.getElementById('toggle-debug-btn');

    if (toggleBtn && drawer) {
        toggleBtn.addEventListener('click', () => {
            drawer.classList.toggle('collapsed');
        });
    }

    // Connect action buttons
    const pullTechBtn = document.getElementById('pull-technical-logs');
    const pullEmergencyBtn = document.getElementById('pull-emergency-logs');
    const pullBlackBoxBtn = document.getElementById('pull-blackbox-export');

    if (pullTechBtn) {
        pullTechBtn.addEventListener('click', async () => {
            logTelemetry('Requesting Level 1 technical logs...');
            try {
                const res = await adminFetch('/api/diagnostics/telemetry');
                if (res.ok) {
                    const data = await res.json();
                    logTelemetry(`Level 1 OK: uptime ${Math.round(data.metrics.uptime)}s, heap ${Math.round(data.metrics.memory.heapUsed / 1024 / 1024)}MB, ${data.telemetry.length} telemetry entries, ${(data.errors.match(/ERROR:/g) || []).length} recent errors.`);
                } else {
                    logTelemetry('Level 1 pull failed: ' + res.status);
                }
            } catch (err) {
                logTelemetry('Level 1 pull failed: connection error.');
            }
        });
    }

    if (pullEmergencyBtn) {
        pullEmergencyBtn.addEventListener('click', async () => {
            logTelemetry('Requesting Level 2 encrypted export envelope...');
            try {
                const res = await adminFetch('/api/diagnostics/export');
                if (res.ok) {
                    const data = await res.json();
                    logTelemetry(`Level 2 export ready (${data.status}, exported ${data.exportedAt}). Envelope is encrypted client-side-unreadable — hand it to the developer for offline decryption.`);
                } else {
                    logTelemetry('Level 2 export failed: ' + res.status);
                }
            } catch (err) {
                logTelemetry('Level 2 export failed: connection error.');
            }
        });
    }

    if (pullBlackBoxBtn) {
        pullBlackBoxBtn.addEventListener('click', async () => {
            logTelemetry('Requesting black-box encrypted flight-recorder export...');
            try {
                const res = await adminFetch('/api/diagnostics/blackbox-export');
                if (res.ok) {
                    const data = await res.json();
                    logTelemetry(`Black-box export ready (exported ${data.exportedAt}). Decryptable only offline by the platform owner via developer_blackbox_keys/analyze_blackbox.js.`);
                } else {
                    logTelemetry('Black-box export failed: ' + res.status);
                }
            } catch (err) {
                logTelemetry('Black-box export failed: connection error.');
            }
        });
    }
}

/**
 * Logs a unencrypted message to the technical telemetry console output
 * @param {string} msg 
 */
export function logTelemetry(msg) {
    const output = document.getElementById('log-output');
    if (output) {
        const time = new Date().toLocaleTimeString();
        output.textContent += `\n[${time}] ${msg}`;
        output.scrollTop = output.scrollHeight;
    }
}

/**
 * SaaS License Checking & UI Lock Overlay Injector
 */
async function checkLicenseStatus() {
    try {
        const res = await fetch('/api/license/status');
        if (res.ok) {
            const data = await res.json();
            if (!data.isValid) {
                showLicenseLockOverlay(data.license);
            }
            showUpdateBannerIfNeeded(data.license);
        }
    } catch (e) {
        console.warn('Licensing offline check deferred to grace constraints.');
    }
}

/**
 * Non-blocking "update available" banner — informational only. This
 * project's release model is manual/version-flagged (see
 * docs/PROJECT_PLAN.md §5.1): nothing here downloads or installs anything,
 * it just tells the platform owner/tenant a newer version has been
 * published so they know to schedule a manual upgrade.
 */
function showUpdateBannerIfNeeded(licenseInfo) {
    const banner = document.getElementById('update-available-banner');
    if (!banner) return;
    if (licenseInfo && licenseInfo.updateAvailable) {
        banner.style.display = 'block';
        banner.textContent = `Update available: v${licenseInfo.latestVersion} (running v${licenseInfo.currentVersion}). Contact your platform provider to schedule an upgrade.`;
    } else {
        banner.style.display = 'none';
    }
}

/**
 * Handles the SaaS License Lock Screen
 */
function showLicenseLockOverlay(licenseInfo) {
    if (document.getElementById('license-lock-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'license-lock-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(15, 23, 42, 0.98)'; // Dark slate almost opaque
    overlay.style.color = '#f8fafc';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = '999999';
    overlay.style.fontFamily = 'monospace';
    overlay.style.padding = '20px';

    const statusMsg = licenseInfo.status === 'expired' ? 'EXPIRED' : 'INACTIVE / SUSPENDED';

    overlay.innerHTML = `
        <div style="max-width: 450px; width: 100%; border: 1px dashed #ef4444; padding: 30px; background-color: #1e293b; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
            <h2 style="color: #ef4444; margin-top: 0; letter-spacing: 0.05em; text-align: center;">SYSTEM LOCK: LICENSE ${statusMsg}</h2>
            <p style="font-size: 13px; line-height: 1.5; color: #cbd5e1; margin-bottom: 25px;">
                Your POS system license is currently invalid. This could be due to billing expiration, suspension, or key deactivation on the central server.
            </p>
            <div style="margin-bottom: 20px;">
                <label style="display: block; font-size: 11px; margin-bottom: 5px; color: #94a3b8; text-transform: uppercase;">License Activation Key</label>
                <input type="text" id="activation-key-input" style="width: 100%; padding: 10px; background: #0f172a; border: 1px solid #475569; color: #fff; font-family: monospace; border-radius: 4px; box-sizing: border-box;" value="${licenseInfo.licenseKey || ''}" placeholder="ENTER KEY">
            </div>
            <button id="activate-system-btn" style="width: 100%; padding: 12px; background: #0284c7; color: white; border: none; font-weight: bold; cursor: pointer; border-radius: 4px; letter-spacing: 0.05em;">ACTIVATE SYSTEM</button>
            <p style="text-align: center; margin-top: 15px; font-size: 10px; color: #64748b;">
                Universal Gold POS Licensing Gate
            </p>
        </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('activate-system-btn').addEventListener('click', async () => {
        const key = document.getElementById('activation-key-input').value.trim();
        if (!key) {
            alert('Please enter a license key.');
            return;
        }

        try {
            const btn = document.getElementById('activate-system-btn');
            btn.textContent = 'ACTIVATING...';
            btn.disabled = true;

            const res = await fetch('/api/license/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ licenseKey: key })
            });

            if (res.ok) {
                alert('License successfully activated! System unlocked.');
                window.location.reload();
            } else {
                const data = await res.json();
                alert('Activation failed: ' + (data.error || 'Invalid license key'));
                btn.textContent = 'ACTIVATE SYSTEM';
                btn.disabled = false;
            }
        } catch (e) {
            alert('Connection to licensing server failed.');
            btn.textContent = 'ACTIVATE SYSTEM';
            btn.disabled = false;
        }
    });
}
