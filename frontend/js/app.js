/**
 * ==========================================================================
 * Gold POS - Main Application ESM Entrypoint
 * ==========================================================================
 */

import { BillingDesk } from './components/BillingDesk.js';
import { ReprintDesk } from './components/ReprintDesk.js';
import { ReturnDesk } from './components/ReturnDesk.js';
import { Dashboard } from './components/Dashboard.js';
import { AdvancesManager } from './components/AdvancesManager.js';
import { CustomerAccountsManager } from './components/CustomerAccountsManager.js';
import { AuditTrail } from './components/AuditTrail.js';
import { SettingsManager } from './components/SettingsManager.js';

document.addEventListener('DOMContentLoaded', () => {
    initAdminAuth();
    initDiagnosticsDrawer();

    // Initialize components before nav activates the default tab, so the
    // per-tab click handlers below can already reach window.dashboard etc.
    window.billingDesk = new BillingDesk();
    window.reprintDesk = new ReprintDesk();
    window.returnDesk = new ReturnDesk();
    window.dashboard = new Dashboard();
    window.advancesManager = new AdvancesManager();
    window.customerAccountsManager = new CustomerAccountsManager();
    window.auditTrail = new AuditTrail();
    window.settingsManager = new SettingsManager();
    if (isAdminAuthenticated()) {
        window.dashboard.refresh();
        window.reprintDesk.refresh();
        window.returnDesk.refresh();
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
                reprintDesk: window.reprintDesk,
                returnDesk: window.returnDesk,
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

/* ==========================================================================
   Who is signed in

   The desk needs the logged-in person for two different reasons: to show whose
   name is going on the next invoice, and to hide the controls their role cannot
   use. Held here, in the module every component already imports adminFetch
   from, so there is one answer to "who is at the counter" rather than each
   screen keeping its own.

   NOT a security boundary. Hiding the Approve button is a courtesy so a cashier
   is not offered an action that will be refused; the actual refusal is
   requireApprover on the server, which is the only place it counts.
   ========================================================================== */

let currentActor = null;
let currentCanApprove = false;

/** The signed-in person, or null before login. */
export function getActor() {
    return currentActor;
}

/** Whether the signed-in person may approve a money claim. */
export function canApprove() {
    return currentCanApprove;
}

function setActor(actor, approver) {
    currentActor = actor || null;
    currentCanApprove = Boolean(approver);
    const label = document.getElementById('signed-in-as');
    if (label) {
        label.textContent = currentActor
            ? `Signed in: ${currentActor.name} (${currentActor.role})`
            : '';
    }
}

/**
 * Re-establishes the identity behind the session cookie on reload. The
 * cookie is the authority, not anything cached in the browser, so the name
 * is asked for rather than remembered.
 */
async function loadActor() {
    try {
        const res = await adminFetch('/api/admin/me');
        if (!res.ok) return;
        const data = await res.json();
        setActor(data.actor, data.canApprove);
    } catch (err) {
        // Offline or mid-restart — the next gated call bounces to the lock
        // screen, which is where a missing identity gets resolved.
    }
}

/** Reads one cookie by name from document.cookie, or '' if absent. */
function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
}

/** Whether this tab has a live admin sign-in. A UI hint only — the server is
 *  the one place that actually trusts the (HttpOnly, unreadable-by-JS)
 *  session cookie on every request. */
function isAdminAuthenticated() {
    return sessionStorage.getItem('adminAuthenticated') === '1';
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Wraps fetch() with the admin session cookie and, for a mutating request,
 * the CSRF header the cookie can't carry by itself (see requireAdminSession
 * in backend/adminAuth.js). Use for any endpoint that requires
 * requireAdminSession server-side (settings, sales, etc).
 * On a 401 (missing/expired session) it clears local state and forces the
 * lock screen back up rather than silently failing.
 */
export async function adminFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (MUTATING_METHODS.has(method)) {
        headers['X-CSRF-Token'] = readCookie('gp_admin_csrf');
    }
    const res = await fetch(url, { ...options, headers, credentials: 'include' });

    if (res.status === 401) {
        sessionStorage.removeItem('adminAuthenticated');
        setActor(null, false);
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

    // Check if already authenticated in this session (the cookie may have
    // expired server-side, e.g. after a restart — the first gated adminFetch
    // call will catch that and bounce back to the lock screen)
    if (isAdminAuthenticated()) {
        loginView.style.display = 'none';
        appViewport.style.display = 'grid';
        loadActor();
    }

    const mfaBlock = document.getElementById('admin-mfa-block');
    const totpInput = document.getElementById('admin-totp-input');
    const recoveryToggle = document.getElementById('admin-recovery-toggle');
    const recoveryInput = document.getElementById('admin-recovery-input');
    const loginError = document.getElementById('admin-login-error');

    if (recoveryToggle && recoveryInput) {
        recoveryToggle.addEventListener('click', () => {
            const showing = recoveryInput.style.display !== 'none';
            recoveryInput.style.display = showing ? 'none' : 'block';
            recoveryToggle.textContent = showing
                ? 'Lost your phone? Use a recovery code'
                : 'Use my authenticator code instead';
            (showing ? totpInput : recoveryInput).focus();
        });
    }

    const showLoginError = (message) => {
        if (loginError) loginError.textContent = message || '';
    };

    loginBtn.addEventListener('click', async () => {
        const pin = pinInput.value;
        loginBtn.disabled = true;
        showLoginError('');
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pin,
                    totpCode: totpInput ? totpInput.value : '',
                    recoveryCode: recoveryInput ? recoveryInput.value : ''
                })
            });

            /* A correct PIN belonging to somebody with a second factor comes back
               as MFA_CODE_REQUIRED rather than a plain 401. The PIN box keeps its
               value: the cashier has typed it correctly and should not have to
               retype it just because a code is now being asked for. */
            if (res.status === 401) {
                const err = await res.json().catch(() => ({}));
                if (err.error === 'MFA_CODE_REQUIRED') {
                    if (mfaBlock) mfaBlock.style.display = 'block';
                    if (totpInput) totpInput.focus();
                    showLoginError(err.message || 'Enter your authenticator code.');
                    return;
                }
                if (err.error === 'MFA_CODE_INVALID') {
                    if (mfaBlock) mfaBlock.style.display = 'block';
                    if (totpInput) { totpInput.value = ''; totpInput.focus(); }
                    if (recoveryInput) recoveryInput.value = '';
                    showLoginError(err.message || 'That code is not valid.');
                    return;
                }
                showLoginError('Incorrect PIN.');
                return;
            }

            if (res.ok) {
                const data = await res.json();
                sessionStorage.setItem('adminAuthenticated', '1');
                // The PIN identified a person, not just "authenticated" — see
                // resolveActor() in backend/adminAuth.js.
                setActor(data.actor, data.canApprove);
                // Clear the credential fields so they are not left in the DOM of
                // an unlocked terminal.
                pinInput.value = '';
                if (totpInput) totpInput.value = '';
                if (recoveryInput) recoveryInput.value = '';
                if (mfaBlock) mfaBlock.style.display = 'none';
                loginView.style.display = 'none';
                appViewport.style.display = 'grid';
                if (window.dashboard) window.dashboard.refresh();
                if (window.reprintDesk) window.reprintDesk.refresh();
                if (window.returnDesk) window.returnDesk.refresh();
                if (window.advancesManager) window.advancesManager.refresh();
                if (window.customerAccountsManager) window.customerAccountsManager.refresh();
                if (window.settingsManager) window.settingsManager.refresh();
                if (window.billingDesk) window.billingDesk.fetchSettings();
            } else {
                const err = await res.json().catch(() => ({}));
                showLoginError(err.message || err.error || 'Could not sign in.');
            }
        } catch (err) {
            showLoginError('Could not reach the server to log in. Check your connection.');
        } finally {
            loginBtn.disabled = false;
        }
    });

    // Enter submits from any of the three fields — a counter terminal is used by
    // touch-typists who never reach for the mouse.
    [pinInput, totpInput, recoveryInput].forEach(field => {
        if (!field) return;
        field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') loginBtn.click();
        });
    });

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            sessionStorage.removeItem('adminAuthenticated');
            setActor(null, false);
            // Back to the plain PIN prompt — the next person at this terminal may
            // not be the one who just signed out.
            if (mfaBlock) mfaBlock.style.display = 'none';
            if (recoveryInput) { recoveryInput.value = ''; recoveryInput.style.display = 'none'; }
            if (totpInput) totpInput.value = '';
            showLoginError('');
            appViewport.style.display = 'none';
            loginView.style.display = 'flex';
            try {
                await adminFetch('/api/admin/logout', { method: 'POST' });
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

            if (targetId === 'dashboard-tab' && window.dashboard && isAdminAuthenticated()) {
                window.dashboard.refresh();
            }
            if (targetId === 'reprint-tab' && window.reprintDesk && isAdminAuthenticated()) {
                window.reprintDesk.refresh();
            }
            if (targetId === 'returns-tab' && window.returnDesk && isAdminAuthenticated()) {
                window.returnDesk.refresh();
            }
            if (targetId === 'advances-tab' && window.advancesManager && isAdminAuthenticated()) {
                window.advancesManager.refresh();
            }
            if (targetId === 'customer-accounts-tab' && window.customerAccountsManager && isAdminAuthenticated()) {
                window.customerAccountsManager.refresh();
            }
            if (targetId === 'audit-tab' && window.auditTrail && isAdminAuthenticated()) {
                window.auditTrail.refresh();
            }
            if (targetId === 'settings-tab' && window.settingsManager && isAdminAuthenticated()) {
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
