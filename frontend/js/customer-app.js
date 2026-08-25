import { drawQR } from './qrGenerator.js';
// Same status rules the store side and the server use, so the portal can
// never show a customer a balance the counter disagrees with.
import { ADVANCE_STATUS, advanceEntryDelta, normalizeAdvanceStatus } from './lib/billingMath.js';

const AUTH_FLAG_KEY = 'customerAuthenticated';

let customerPhone = '';
let customerName = '';
let balance = 0;
let merchantSettings = {
    companyName: 'Universal Gold POS',
    upiId: '',
    passwordMinLength: 8,
    passwordResetAvailable: false
};
// Held only in memory for the duration of the forced-change screen, so
// the change-password call can supply the temporary password the
// customer just signed in with instead of asking them to retype it.
let pendingTempPassword = '';

(async function loadMerchantSettings() {
    try {
        const res = await fetch('/api/settings/public');
        if (res.ok) {
            merchantSettings = { ...merchantSettings, ...(await res.json()) };
        }
    } catch (err) {
        console.error('Failed to load merchant settings:', err);
    }
})();

/* ==================================================================
   Session plumbing
   ================================================================== */

/** Reads one cookie by name from document.cookie, or '' if absent. */
function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
}

function isCustomerAuthenticated() {
    return localStorage.getItem(AUTH_FLAG_KEY) === '1';
}

function setCustomerAuthenticated(authenticated) {
    if (authenticated) localStorage.setItem(AUTH_FLAG_KEY, '1');
    else localStorage.removeItem(AUTH_FLAG_KEY);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * fetch() with the customer session cookie and, for a mutating request,
 * the CSRF header the cookie can't carry by itself (see
 * requireCustomerSession in backend/customerAuth.js). A 401 means the
 * session expired or was revoked (password change, admin reissue) —
 * clear it and drop back to the sign-in screen rather than leaving a
 * half-loaded portal on screen.
 */
async function customerFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (MUTATING_METHODS.has(method)) {
        headers['X-CSRF-Token'] = readCookie('gp_cust_csrf');
    }
    const res = await fetch(url, { ...options, headers, credentials: 'include' });
    if (res.status === 401) {
        setCustomerAuthenticated(false);
        showAuthView();
    }
    return res;
}

function showAuthView() {
    document.getElementById('auth-view').style.display = 'flex';
    document.getElementById('force-change-view').style.display = 'none';
    document.getElementById('portal-view').style.display = 'none';
}

function showForceChangeView() {
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('force-change-view').style.display = 'flex';
    document.getElementById('portal-view').style.display = 'none';
}

function showPortalView() {
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('force-change-view').style.display = 'none';
    document.getElementById('portal-view').style.display = 'flex';
}

function switchAuthPane(pane) {
    ['login', 'register', 'forgot'].forEach(p => {
        document.getElementById('pane-' + p).style.display = (p === pane) ? 'block' : 'none';
    });
    document.getElementById('auth-tab-login').classList.toggle('active', pane === 'login');
    document.getElementById('auth-tab-register').classList.toggle('active', pane === 'register');
}

/**
 * Applies a successful authentication: the session itself now lives
 * only in the HttpOnly cookie the server just set, so this just flags
 * the tab as signed in, records who we are, and routes to the
 * forced-change screen or the portal.
 */
async function onAuthenticated(customer, usedPassword = '') {
    setCustomerAuthenticated(true);
    customerPhone = customer.phone;
    customerName = customer.name || '';
    if (customer.mustChangePassword) {
        pendingTempPassword = usedPassword;
        showForceChangeView();
        return;
    }
    pendingTempPassword = '';
    applyProfileToUI(customer);
    showPortalView();
    window.switchTab('profile');
    await loadCustomerData();
}

function applyProfileToUI(customer) {
    customerName = customer.name || '';
    document.getElementById('greet-name').textContent = customerName || 'Customer';
    document.getElementById('acct-name').value = customerName;
    document.getElementById('acct-email').value = customer.email || '';
    document.getElementById('acct-notify-email').checked = customer.notifyEmail !== false;

    // Re-evaluated on every profile load, so saving an email in the
    // Account tab clears the prompt without a page reload.
    const prompt = document.getElementById('no-email-prompt');
    if (prompt) prompt.style.display = customer.email ? 'none' : 'block';
}

/** Restores an existing session on load, if one is still valid. */
(async function restoreSession() {
    if (!isCustomerAuthenticated()) return;
    try {
        const res = await customerFetch('/api/customer/me');
        if (!res.ok) return;
        const data = await res.json();
        await onAuthenticated(data.customer);
    } catch (err) {
        // Offline or server down — the sign-in screen is already showing.
    }
})();

/* ==================================================================
   Auth screen wiring
   ================================================================== */

document.getElementById('auth-tab-login').addEventListener('click', () => switchAuthPane('login'));
document.getElementById('auth-tab-register').addEventListener('click', () => switchAuthPane('register'));
/*
 * The pane always opens. It used to refuse with an alert() whenever
 * the store had no SMTP configured, which left the customer staring
 * at a dismissed dialog on the sign-in screen with nothing to do —
 * the exact dead-end that sent them to the counter. Now the reason is
 * stated inside the pane, next to the field it applies to, and the
 * send button is disabled rather than the whole flow being hidden.
 */
document.getElementById('show-forgot-btn').addEventListener('click', () => {
    switchAuthPane('forgot');
    document.getElementById('forgot-step-1').style.display = 'block';
    document.getElementById('forgot-step-2').style.display = 'none';
    applyResetAvailability();
});

/** Reflects whether this store can actually send a reset code. */
function applyResetAvailability() {
    const available = !!merchantSettings.passwordResetAvailable;
    const notice = document.getElementById('forgot-unavailable-note');
    const btn = document.getElementById('forgot-submit-btn');
    if (notice) notice.style.display = available ? 'none' : 'block';
    if (btn) btn.disabled = !available;
}
document.getElementById('back-to-login-btn').addEventListener('click', () => {
    document.getElementById('forgot-step-1').style.display = 'block';
    document.getElementById('forgot-step-2').style.display = 'none';
    switchAuthPane('login');
});

document.getElementById('login-submit-btn').addEventListener('click', async () => {
    const btn = document.getElementById('login-submit-btn');
    const errorEl = document.getElementById('login-error');
    const phone = document.getElementById('login-phone').value.replace(/\D/g, '');
    const password = document.getElementById('login-password').value;

    errorEl.textContent = '';
    if (phone.length !== 10) {
        errorEl.textContent = 'Please enter a valid 10-digit mobile number.';
        return;
    }
    if (!password) {
        errorEl.textContent = 'Please enter your password.';
        return;
    }

    btn.disabled = true;
    try {
        const res = await fetch('/api/customer/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.message || 'Sign-in failed.';
            return;
        }
        document.getElementById('login-password').value = '';
        await onAuthenticated(data.customer, password);
    } catch (err) {
        errorEl.textContent = 'Could not reach the store server. Please try again.';
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('register-submit-btn').addEventListener('click', async () => {
    const btn = document.getElementById('register-submit-btn');
    const errorEl = document.getElementById('register-error');
    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.replace(/\D/g, '');
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;

    errorEl.textContent = '';
    if (!name) { errorEl.textContent = 'Please enter your name.'; return; }
    if (phone.length !== 10) { errorEl.textContent = 'Please enter a valid 10-digit mobile number.'; return; }
    // Enforced client-side only: the server accepts an email-less
    // account because counter-issued logins legitimately start without
    // one. What must not happen is a customer creating their own
    // account with no way back into it, which is what this stops.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorEl.textContent = 'Please enter a valid email address — it is how you reset your own password later.';
        return;
    }
    if (password.length < merchantSettings.passwordMinLength) {
        errorEl.textContent = `Password must be at least ${merchantSettings.passwordMinLength} characters.`;
        return;
    }
    if (password !== password2) { errorEl.textContent = 'The two passwords do not match.'; return; }

    btn.disabled = true;
    try {
        const res = await fetch('/api/customer/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, phone, email, password })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.message || data.error || 'Could not create your account.';
            return;
        }
        document.getElementById('reg-password').value = '';
        document.getElementById('reg-password2').value = '';
        await onAuthenticated(data.customer, password);
    } catch (err) {
        errorEl.textContent = 'Could not reach the store server. Please try again.';
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('forgot-submit-btn').addEventListener('click', async () => {
    const btn = document.getElementById('forgot-submit-btn');
    const errorEl = document.getElementById('forgot-error');
    const phone = document.getElementById('forgot-phone').value.replace(/\D/g, '');

    errorEl.textContent = '';
    if (phone.length !== 10) {
        errorEl.textContent = 'Please enter a valid 10-digit mobile number.';
        return;
    }

    btn.disabled = true;
    try {
        const res = await fetch('/api/customer/password/forgot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.message || 'Could not send a reset code.';
            return;
        }
        document.getElementById('forgot-sent-note').textContent = data.message;
        document.getElementById('forgot-step-1').style.display = 'none';
        document.getElementById('forgot-step-2').style.display = 'block';
    } catch (err) {
        errorEl.textContent = 'Could not reach the store server. Please try again.';
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('reset-submit-btn').addEventListener('click', async () => {
    const btn = document.getElementById('reset-submit-btn');
    const errorEl = document.getElementById('reset-error');
    const phone = document.getElementById('forgot-phone').value.replace(/\D/g, '');
    const code = document.getElementById('reset-code').value.trim();
    const newPassword = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-password2').value;

    errorEl.textContent = '';
    if (!code) { errorEl.textContent = 'Please enter the reset code from your email.'; return; }
    if (newPassword.length < merchantSettings.passwordMinLength) {
        errorEl.textContent = `Password must be at least ${merchantSettings.passwordMinLength} characters.`;
        return;
    }
    if (newPassword !== confirm) { errorEl.textContent = 'The two passwords do not match.'; return; }

    btn.disabled = true;
    try {
        const res = await fetch('/api/customer/password/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, code, newPassword })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error || 'Could not reset your password.';
            return;
        }
        alert('Password updated successfully! Please sign in with your new password.');
        document.getElementById('forgot-step-1').style.display = 'block';
        document.getElementById('forgot-step-2').style.display = 'none';
        document.getElementById('login-phone').value = phone;
        switchAuthPane('login');
    } catch (err) {
        errorEl.textContent = 'Could not reach the store server. Please try again.';
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('fc-submit-btn').addEventListener('click', async () => {
    const btn = document.getElementById('fc-submit-btn');
    const errorEl = document.getElementById('fc-error');
    const newPassword = document.getElementById('fc-password').value;
    const confirm = document.getElementById('fc-password2').value;

    errorEl.textContent = '';
    if (newPassword.length < merchantSettings.passwordMinLength) {
        errorEl.textContent = `Password must be at least ${merchantSettings.passwordMinLength} characters.`;
        return;
    }
    if (newPassword !== confirm) { errorEl.textContent = 'The two passwords do not match.'; return; }

    btn.disabled = true;
    try {
        const res = await customerFetch('/api/customer/password/change', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword: pendingTempPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error || 'Could not set your password.';
            return;
        }

        // The change invalidated every session including this one, so
        // sign straight back in with the new password rather than
        // bouncing the customer to a login screen they just came from.
        const loginRes = await fetch('/api/customer/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: customerPhone, password: newPassword })
        });
        const loginData = await loginRes.json();
        document.getElementById('fc-password').value = '';
        document.getElementById('fc-password2').value = '';
        if (loginRes.ok) {
            await onAuthenticated(loginData.customer, newPassword);
        } else {
            setCustomerAuthenticated(false);
            showAuthView();
            alert('Password set successfully! Please sign in.');
        }
    } catch (err) {
        errorEl.textContent = 'Could not reach the store server. Please try again.';
    } finally {
        btn.disabled = false;
    }
});

/* ==================================================================
   Portal
   ================================================================== */

window.switchTab = function(tabName) {
    ['profile', 'deposit', 'history', 'account'].forEach(t => {
        document.getElementById('tab-' + t).style.display = 'none';
        document.getElementById('nav-' + t).style.color = '#64748b';
    });
    document.getElementById('tab-' + tabName).style.display = 'block';
    document.getElementById('nav-' + tabName).style.color = '#fff';
};

// Wired here rather than as onclick="" attributes on the buttons
// (security audit C5) — an inline handler needs CSP's scriptSrcAttr
// to allow 'unsafe-inline', which is exactly the gap C4's stored-XSS
// finding depended on. Each button already carries the id its tab
// name derives from.
['profile', 'deposit', 'history', 'account'].forEach(t => {
    document.getElementById('nav-' + t).addEventListener('click', () => window.switchTab(t));
});

// Takes the customer straight to the field the prompt is about, rather
// than telling them where to find it and leaving them to navigate.
document.getElementById('no-email-fix-btn').addEventListener('click', () => {
    window.switchTab('account');
    const emailInput = document.getElementById('acct-email');
    emailInput.focus();
    emailInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

async function loadCustomerData() {
    try {
        // Live 22K rate for the Gold Appreciation calculator
        let currentLiveRate22K = 7000;
        try {
            const priceRes = await fetch('/api/gold-price');
            if (priceRes.ok) {
                const priceData = await priceRes.json();
                currentLiveRate22K = priceData.rates.price22K;
            }
        } catch (e) {}

        // Session-scoped: the server decides whose ledger this is from
        // the bearer token — the phone is never sent by the client.
        const res = await customerFetch('/api/customer/advances');
        if (!res.ok) return;

        const data = await res.json();
        balance = data.balance;

        /* Returns the store has filed against this customer.

           Read-only here by design — a refund is issued at the counter,
           never from the phone (see GET /api/customer/returns). The
           portal's job is that the customer can SEE it the moment it
           happens instead of wondering whether the shop actually
           processed it.

           Only CASH refunds are merged into the table below. A gold
           refund already appears, because crediting it wrote a real
           deposit row into the ledger above — listing the return
           alongside its own credit row would show the same rupees
           twice and make the history disagree with the balance. */
        let cashReturns = [];
        try {
            const returnsRes = await customerFetch('/api/customer/returns');
            if (returnsRes.ok) {
                const returnsData = await returnsRes.json();
                cashReturns = (returnsData.returns || [])
                    .filter(r => r.refundMode !== 'gold')
                    .map(r => ({ ...r, type: 'return' }));
            }
        } catch (e) {
            // History still renders the advance ledger without them.
        }
        data.history = data.history.concat(cashReturns);

        document.getElementById('customer-balance-val').textContent = `₹${balance.toLocaleString('en-IN')}`;
        document.getElementById('customer-profile-info').textContent =
            `Phone: ${customerPhone.replace(/(\d{5})(\d{5})/, '$1-$2')}`;

        // Without this, a customer who has just submitted a UPI reference
        // sees an unchanged balance and concludes their money is lost.
        const pendingNote = document.getElementById('customer-pending-note');
        if (data.pendingCount > 0) {
            pendingNote.style.display = 'block';
            pendingNote.textContent =
                `₹${Number(data.pendingTotal).toLocaleString('en-IN')} awaiting the store's confirmation` +
                `${data.pendingCount > 1 ? ` (${data.pendingCount} deposits)` : ''}. ` +
                `It is added to your balance once they verify the transfer.`;
        } else {
            pendingNote.style.display = 'none';
        }

        let totalGramsLocked = 0;
        let totalCashDeposited = 0;

        const tbody = document.getElementById('customer-ledger-rows');
        tbody.innerHTML = '';

        if (data.history.length === 0) {
            const empty = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 4;
            cell.style.cssText = 'text-align: center; color: var(--color-text-light);';
            cell.textContent = 'No deposit or return history found.';
            empty.appendChild(cell);
            tbody.appendChild(empty);
        } else {
            data.history.sort((a, b) => b.timestamp - a.timestamp);
            data.history.forEach(item => {
                const isDeposit = item.type === 'deposit';
                // A cash refund is money handed over the counter, not a
                // movement in this ledger — it never touches the balance
                // or the grams, it is listed so the customer has a record.
                const isReturn = item.type === 'return';
                // Gold refunds arrive here as ordinary approved deposits;
                // `source` is what distinguishes credit the store gave
                // back from money the customer paid in.
                const isReturnCredit = isDeposit && item.source === 'return';
                const status = normalizeAdvanceStatus(item);
                // A deposit awaiting the store's confirmation holds no
                // credit, so it must not contribute grams to the Gold
                // Appreciation figure either — that panel and the balance
                // above it have to describe the same money.
                const counts = advanceEntryDelta(item) !== 0;
                const typeColor = isReturn
                    ? 'color: #b45309; font-weight: 600;'
                    : !counts
                        ? 'color: var(--color-text-light); text-decoration: line-through;'
                        : isDeposit
                            ? 'color: var(--color-success); font-weight: 600;'
                            : 'color: var(--color-danger);';

                if (counts) {
                    const lockedRate = item.lockedGoldRate22K || currentLiveRate22K;
                    if (isDeposit) {
                        totalGramsLocked += (item.amount / lockedRate);
                        totalCashDeposited += item.amount;
                    } else {
                        totalGramsLocked -= (item.amount / lockedRate);
                        totalCashDeposited -= item.amount;
                    }
                }

                // textContent throughout: referenceId is customer- and
                // gateway-supplied, and this table renders it back out.
                const row = document.createElement('tr');
                if (!counts && !isReturn) row.style.opacity = '0.7';
                const dateCell = document.createElement('td');
                dateCell.textContent = new Date(item.timestamp).toLocaleDateString();
                const idCell = document.createElement('td');
                idCell.textContent = item.id;
                const typeCell = document.createElement('td');
                typeCell.style.cssText = typeColor;
                // The invoice a refund came back from is named on the
                // row. Without it a credit the customer never paid in
                // reads as an unexplained deposit.
                typeCell.textContent = isReturn
                    ? `RETURN — CASH REFUND (${item.originalInvoiceId || ''})`
                    : isReturnCredit
                        ? `RETURN CREDIT (${item.invoiceId || ''})`
                        : isDeposit && status === ADVANCE_STATUS.PENDING
                            ? 'AWAITING APPROVAL'
                            : isDeposit && status === ADVANCE_STATUS.REJECTED
                                ? 'NOT RECEIVED'
                                : String(item.type || '').toUpperCase();
                const amountCell = document.createElement('td');
                amountCell.className = 'text-right';
                amountCell.style.cssText = typeColor;
                amountCell.textContent =
                    `₹${Number(isReturn ? item.refundAmount : item.amount).toLocaleString('en-IN')}`;

                row.append(dateCell, idCell, typeCell, amountCell);
                tbody.appendChild(row);
            });
        }

        const currentWorth = totalGramsLocked * currentLiveRate22K;
        const profit = currentWorth - totalCashDeposited;

        document.getElementById('gold-grams-locked').textContent = totalGramsLocked.toFixed(3) + ' g';
        document.getElementById('gold-current-worth').textContent =
            '₹' + currentWorth.toLocaleString('en-IN', { maximumFractionDigits: 0 });

        const appreciationEl = document.getElementById('gold-appreciation');
        if (profit >= 0) {
            appreciationEl.textContent = '+₹' + profit.toLocaleString('en-IN', { maximumFractionDigits: 0 });
            appreciationEl.style.color = '#166534';
        } else {
            appreciationEl.textContent = '-₹' + Math.abs(profit).toLocaleString('en-IN', { maximumFractionDigits: 0 });
            appreciationEl.style.color = '#b91c1c';
        }

        updateQR();
    } catch (err) {
        alert('Connection error. Please try again in a moment.');
    }
}

document.getElementById('logout-btn').addEventListener('click', async () => {
    setCustomerAuthenticated(false);
    customerPhone = '';
    customerName = '';
    document.getElementById('login-phone').value = '';
    document.getElementById('login-password').value = '';
    switchAuthPane('login');
    showAuthView();
    try {
        await customerFetch('/api/customer/logout', { method: 'POST' });
    } catch (err) {
        // Local session is already cleared either way.
    }
});

document.getElementById('acct-save-btn').addEventListener('click', async () => {
    const btn = document.getElementById('acct-save-btn');
    btn.disabled = true;
    try {
        const res = await customerFetch('/api/customer/me', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('acct-name').value.trim(),
                email: document.getElementById('acct-email').value.trim(),
                notifyEmail: document.getElementById('acct-notify-email').checked
            })
        });
        const data = await res.json();
        if (res.ok) {
            applyProfileToUI(data.customer);
            alert('Your details were saved successfully.');
        } else {
            alert('Could not save: ' + (data.error || 'Unknown error'));
        }
    } catch (err) {
        alert('Could not reach the store server.');
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('cp-submit-btn').addEventListener('click', async () => {
    const btn = document.getElementById('cp-submit-btn');
    const errorEl = document.getElementById('cp-error');
    const currentPassword = document.getElementById('cp-current').value;
    const newPassword = document.getElementById('cp-new').value;
    const confirm = document.getElementById('cp-new2').value;

    errorEl.textContent = '';
    if (newPassword.length < merchantSettings.passwordMinLength) {
        errorEl.textContent = `Password must be at least ${merchantSettings.passwordMinLength} characters.`;
        return;
    }
    if (newPassword !== confirm) { errorEl.textContent = 'The two passwords do not match.'; return; }

    btn.disabled = true;
    try {
        const res = await customerFetch('/api/customer/password/change', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) {
            errorEl.textContent = data.error || 'Could not change your password.';
            return;
        }
        setCustomerAuthenticated(false);
        document.getElementById('cp-current').value = '';
        document.getElementById('cp-new').value = '';
        document.getElementById('cp-new2').value = '';
        document.getElementById('login-phone').value = customerPhone;
        switchAuthPane('login');
        showAuthView();
        alert('Password changed successfully! Please sign in again.');
    } catch (err) {
        errorEl.textContent = 'Could not reach the store server. Please try again.';
    } finally {
        btn.disabled = false;
    }
});

/* ==================================================================
   Deposit flow
   ================================================================== */

document.getElementById('pay-method').addEventListener('change', (e) => {
    const upiBox = document.getElementById('upi-payment-box');
    const refGroup = document.getElementById('ref-group');
    if (e.target.value === 'UPI') {
        upiBox.style.display = 'block';
        refGroup.style.display = 'block';
        updateQR();
    } else {
        upiBox.style.display = 'none';
        refGroup.style.display = 'none';
    }
});

document.getElementById('pay-amount').addEventListener('input', () => {
    if (document.getElementById('pay-method').value === 'UPI') {
        updateQR();
    }
});

function updateQR() {
    const amountInput = document.getElementById('pay-amount');
    const amount = parseFloat(amountInput.value) || 1000; // preview default
    const displayEl = document.getElementById('upi-string-display');
    const canvas = document.getElementById('qr-canvas');

    if (!merchantSettings.upiId) {
        if (displayEl) {
            displayEl.textContent = 'UPI QR not available — store has not configured a UPI ID yet. Please use Online Payment instead.';
        }
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        return;
    }

    // Build a real, scannable Standard India UPI deep link
    const merchantName = encodeURIComponent(merchantSettings.companyName || 'Gold POS');
    const upiLink = `upi://pay?pa=${encodeURIComponent(merchantSettings.upiId)}&pn=${merchantName}&am=${amount}.00&cu=INR`;

    if (displayEl) {
        displayEl.textContent = `UPI: ${merchantSettings.upiId} | ₹${amount}`;
    }
    if (canvas) {
        drawQR(canvas, upiLink);
    }
}

document.getElementById('pay-submit-btn').addEventListener('click', async () => {
    const amountInput = document.getElementById('pay-amount');
    const methodSelect = document.getElementById('pay-method');
    const refInput = document.getElementById('pay-ref');

    const amount = parseFloat(amountInput.value) || 0;
    const method = methodSelect.value;
    const refId = refInput.value.trim();

    if (amount <= 100) {
        alert('Minimum deposit amount is ₹100.');
        return;
    }

    if (method === 'RAZORPAY') {
        try {
            // 1. Create order on backend (customer-session gated)
            const orderRes = await customerFetch('/api/payment/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount })
            });

            if (!orderRes.ok) {
                const err = await orderRes.json();
                alert('Order initiation failed: ' + (err.error || err.message || 'Unknown error'));
                return;
            }

            const orderData = await orderRes.json();

            // MOCK FRONTEND BYPASS FOR DUMMY KEYS
            if (orderData.keyId === 'rzp_test_xxxxxx') {
                const verifyRes = await customerFetch('/api/payment/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // No amount: the server credits what the stored order
                    // was created for, and ignores anything sent here.
                    body: JSON.stringify({
                        razorpay_order_id: orderData.order.id,
                        razorpay_payment_id: 'pay_mock_' + Math.random().toString(36).substring(2, 9),
                        razorpay_signature: 'mock_signature'
                    })
                });
                if (verifyRes.ok) {
                    alert('TEST MODE: Razorpay mock payment verified successfully!');
                    amountInput.value = '';
                    await loadCustomerData();
                } else {
                    const err = await verifyRes.json();
                    alert('Mock Verification failed: ' + (err.error || err.message));
                }
                return;
            }

            // 2. Open Razorpay Popup
            const options = {
                "key": orderData.keyId,
                "amount": orderData.order.amount,
                "currency": "INR",
                "name": merchantSettings.companyName || "Universal Gold POS",
                "description": "Monthly Gold Advance Deposit",
                "order_id": orderData.order.id,
                "handler": async function (response) {
                    // 3. Verify on backend
                    try {
                        const verifyRes = await customerFetch('/api/payment/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            // No amount: the server credits the stored
                            // order's amount, not a client-supplied one.
                            body: JSON.stringify({
                                razorpay_order_id: response.razorpay_order_id,
                                razorpay_payment_id: response.razorpay_payment_id,
                                razorpay_signature: response.razorpay_signature
                            })
                        });

                        if (verifyRes.ok) {
                            alert('Razorpay payment verified and registered successfully!');
                            amountInput.value = '';
                            await loadCustomerData();
                        } else {
                            const err = await verifyRes.json();
                            alert('Payment verification failed: ' + (err.error || err.message));
                        }
                    } catch (e) {
                        alert('Error verifying payment.');
                    }
                },
                "prefill": {
                    "name": customerName,
                    "contact": customerPhone
                },
                "theme": {
                    "color": "#0f172a"
                }
            };

            const rzp = new window.Razorpay(options);
            rzp.on('payment.failed', function (response) {
                alert("Payment failed: " + response.error.description);
            });
            rzp.open();

        } catch (err) {
            alert('Failed to connect to checkout servers: ' + err.message);
        }
    } else {
        // Manual UPI Verification Flow
        if (!refId) {
            alert('Please enter the transaction reference number.');
            return;
        }

        try {
            // Phone and name come from the session server-side — this
            // request cannot credit anyone else's account.
            const res = await customerFetch('/api/customer/advances', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, referenceId: refId })
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                // Says "not yet credited" explicitly: the balance above
                // deliberately will not move until the store confirms,
                // and a vaguer message would read as a failure.
                alert(
                    `Submitted for verification.\n\n` +
                    `₹${amount.toLocaleString('en-IN')} against reference ${refId} has been sent to the store. ` +
                    `It is not yet in your balance — it is added once they confirm the transfer.`
                );
                amountInput.value = '';
                refInput.value = '';
                await loadCustomerData();
            } else if (data.code === 'DUPLICATE_REFERENCE') {
                alert('That transaction reference has already been submitted. Each transfer can only be claimed once — check your history below.');
            } else {
                alert('Failed to submit payment: ' + (data.error || data.message || `HTTP ${res.status}`));
            }
        } catch (err) {
            alert('Connection failure to POS servers.');
        }
    }
});
