/**
 * ==========================================================================
 * Customer golden path — sign in, read the balance, deposit, see it land.
 *
 * Runs at both a desktop and a 390px phone viewport (see the projects list in
 * backend/playwright.config.js). Customers reach this portal overwhelmingly on
 * a phone, and a deposit button that falls below the fold or under the bottom
 * nav is a total failure of the feature that no desktop-only run would catch.
 * ==========================================================================
 */

import { test, expect, loginAsCustomer, readAlert } from './fixtures.js';

test.describe('Customer portal journey', () => {
    test('signs in and shows the spendable balance, excluding pending claims', async ({ page, posServer }) => {
        // Rohan: ₹10,000 approved + ₹7,500 still pending counter approval.
        // Only the approved half is spendable — a pending claim rendering as
        // balance is money the store has not seen.
        await loginAsCustomer(page, posServer, 1);

        await expect(page.locator('#portal-view')).toBeVisible();
        await expect(page.locator('#customer-balance-val')).toContainText('10,000');
        await expect(page.locator('#customer-balance-val')).not.toContainText('17,500');
    });

    test('rejects a wrong password and keeps the portal closed', async ({ page, posServer }) => {
        const customer = posServer.seeded.customers[0];
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await page.fill('#login-phone', customer.phone);
        await page.fill('#login-password', 'definitely-not-the-password');
        await page.click('#login-submit-btn');

        await expect(page.locator('#login-error')).not.toBeEmpty();
        await expect(page.locator('#portal-view')).toBeHidden();
    });

    test('deposits through mock checkout and sees the balance and ledger update', async ({ page, posServer }) => {
        // Meera: one rejected claim only, so ₹0 spendable to start.
        const customer = await loginAsCustomer(page, posServer, 2);
        await expect(page.locator('#customer-balance-val')).toContainText('0');

        await page.click('#nav-deposit');
        await expect(page.locator('#tab-deposit')).toBeVisible();

        // The seeded tenant carries the demo Razorpay pair, so checkout takes
        // the mock branch: no network call to the gateway, but the same
        // order → verify handshake against the same server-side amount
        // binding a live payment would use.
        await page.fill('#pay-amount', '5000');
        await page.selectOption('#pay-method', 'RAZORPAY');
        await page.click('#pay-submit-btn');

        expect(await readAlert(page)).toMatch(/verified/i);

        // Persisted, approved, and credited to the session's own phone.
        // Matched on payment method, not on amount: this customer's seeded
        // ledger already holds a REJECTED ₹5,000 claim, which is exactly the
        // row that must not be mistaken for a settled one.
        const advances = posServer.readLedger('advances');
        const deposit = advances.find(a =>
            a.customerPhone === customer.phone && a.type === 'deposit' && a.paymentMethod === 'Razorpay');
        expect(deposit).toBeTruthy();
        expect(deposit.amount).toBe(5000);
        expect(deposit.status).toBe('approved');
        expect(deposit.id).toMatch(/^ADV-[0-9A-F]{12}$/);

        // ...and the seeded rejected row is still rejected and still not money.
        const rejected = advances.filter(a => a.status === 'rejected');
        expect(rejected).toHaveLength(1);

        // The order record is what bound that amount server-side, in paise.
        const order = posServer.readLedger('paymentOrders', customer.phone)
            .find(o => o.customerPhone === customer.phone);
        expect(order).toBeTruthy();
        expect(order.amountPaise).toBe(500000);
        expect(order.currency).toBe('INR');
        expect(order.status).toBe('paid');
        expect(order.depositId).toBe(deposit.id);

        await expect(page.locator('#customer-balance-val')).toContainText('5,000');
    });

    test('records a manual UPI claim as pending, not as balance', async ({ page, posServer }) => {
        const customer = await loginAsCustomer(page, posServer, 2);

        await page.click('#nav-deposit');
        await page.fill('#pay-amount', '2500');
        await page.selectOption('#pay-method', 'UPI');
        await page.fill('#pay-ref', 'E2E-UTR-000123');
        await page.click('#pay-submit-btn');

        await readAlert(page);

        const claim = posServer.readLedger('advances')
            .find(a => a.referenceId === 'E2E-UTR-000123');
        expect(claim).toBeTruthy();
        // The whole point of the manual path: a customer's unverified claim to
        // have sent money is not money until a cashier confirms it.
        expect(claim.status).toBe('pending');
        expect(claim.customerPhone).toBe(customer.phone);

        await expect(page.locator('#customer-balance-val')).not.toContainText('2,500');
    });

    test('refuses a duplicate transaction reference', async ({ page, posServer }) => {
        await loginAsCustomer(page, posServer, 2);
        await page.click('#nav-deposit');

        for (const amount of ['1500', '9000']) {
            await page.fill('#pay-amount', amount);
            await page.selectOption('#pay-method', 'UPI');
            await page.fill('#pay-ref', 'E2E-UTR-DUPLICATE');
            await page.click('#pay-submit-btn');
            await readAlert(page);
        }

        // One real-world transfer, one ledger row — otherwise the same UTR
        // submitted three times gets credited three times, each row looking
        // individually plausible to whoever approves it.
        const claims = posServer.readLedger('advances')
            .filter(a => a.referenceId === 'E2E-UTR-DUPLICATE');
        expect(claims).toHaveLength(1);
        expect(claims[0].amount).toBe(1500);
    });

    /**
     * Signs in as Sanjay, the seeded account that deliberately starts in the
     * forced-password-change state, and clears it so the portal opens. He is
     * the customer the fixture's gold refund belongs to, so his returns can
     * only be asserted on the far side of that screen.
     */
    async function signInPastForcedChange(page, posServer) {
        const customer = await loginAsCustomer(page, posServer, 3);
        await expect(page.locator('#force-change-view')).toBeVisible();
        await page.fill('#fc-password', 'ChosenByMe!2026');
        await page.fill('#fc-password2', 'ChosenByMe!2026');
        await page.click('#fc-submit-btn');
        await expect(page.locator('#portal-view')).toBeVisible();
        return customer;
    }

    /* ----------------------------------------------------------------------
       Returns, as the customer sees them.

       The store issues a refund at the counter; the customer never can. What
       they get is visibility — and these run at 390px too, because a refund
       row the customer cannot find on their phone is a refund they will
       telephone the shop about.
       ---------------------------------------------------------------------- */

    test('a cash refund appears in the history without moving the balance', async ({ page, posServer }) => {
        // Aarti: ₹40,000 deposited, ₹20,000 redeemed — ₹20,000 spendable. The
        // seeded ₹38,946.88 cash refund on her bangle was handed over the
        // counter, so it is a line in her history and NOT a change in credit.
        await loginAsCustomer(page, posServer, 0);
        await expect(page.locator('#portal-view')).toBeVisible();
        await expect(page.locator('#customer-balance-val')).toContainText('20,000');

        await page.click('#nav-history');
        await expect(page.locator('#tab-history')).toBeVisible();

        const refundRow = page.locator('#customer-ledger-rows tr', { hasText: 'CASH REFUND' });
        await expect(refundRow).toHaveCount(1);
        await expect(refundRow).toContainText('SEED-000004-26');
        await expect(refundRow).toContainText('38,946.88');

        // Still ₹20,000 — a cash refund is not credit.
        await expect(page.locator('#customer-balance-val')).toContainText('20,000');
    });

    test('a gold refund shows as return credit and is counted in the balance', async ({ page, posServer }) => {
        // Sanjay returned a ₹33,372 coin and took the value as gold credit.
        // It is his only ledger row, so the balance is the refund exactly.
        await signInPastForcedChange(page, posServer);
        await expect(page.locator('#customer-balance-val')).toContainText('33,372');

        await page.click('#nav-history');
        const creditRow = page.locator('#customer-ledger-rows tr', { hasText: 'RETURN CREDIT' });
        await expect(creditRow).toHaveCount(1);
        // Named against the invoice it came back from — otherwise it reads as
        // a deposit the customer knows they never made.
        await expect(creditRow).toContainText('SEED-000002-26');
        await expect(creditRow).toContainText('33,372');

        // Refund credit is gold-backed like any other deposit, so the
        // appreciation panel accounts for it rather than showing 0 g.
        await page.click('#nav-profile');
        await expect(page.locator('#gold-grams-locked')).not.toContainText('0.000 g');
    });

    test('the portal offers the customer no way to raise a return themselves', async ({ page, posServer }) => {
        // Returns are the store's to issue (POST /api/returns is admin-gated).
        // The portal is read-only on them, and the API agrees: a live customer
        // session is not an admin session, however valid it is.
        await signInPastForcedChange(page, posServer);

        const status = await page.evaluate(async () => {
            const res = await fetch('/api/returns', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('customerToken') || ''}`
                },
                body: JSON.stringify({ invoiceId: 'SEED-000002-26', weightGrams: 1, refundMode: 'gold' })
            });
            return res.status;
        });
        expect(status).toBe(401);

        // Reading their own is fine — that is what the portal is for.
        const readable = await page.evaluate(async () => {
            const res = await fetch('/api/customer/returns', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('customerToken') || ''}` }
            });
            return { status: res.status, body: await res.json() };
        });
        expect(readable.status).toBe(200);
        expect(readable.body.returns).toHaveLength(1);
        expect(readable.body.returns[0].refundMode).toBe('gold');
    });

    test('signs out and cannot reach the portal again without signing in', async ({ page, posServer }) => {
        await loginAsCustomer(page, posServer, 0);
        await expect(page.locator('#portal-view')).toBeVisible();

        await page.click('#logout-btn');
        await expect(page.locator('#portal-view')).toBeHidden();

        await page.reload();
        await expect(page.locator('#portal-view')).toBeHidden();
        await expect(page.locator('#login-phone')).toBeVisible();
    });
});

/* ==========================================================================
   Getting back in without the store's help.

   A forgotten password used to mean a trip to the counter for anyone whose
   account had no email on it, and the "Forgot password?" link refused to even
   open when the store had no SMTP configured — it fired an alert() and left
   the customer back on the sign-in screen with nothing to act on. These cover
   the paths that make the reset self-service instead.
   ========================================================================== */
test.describe('Customer self-service password reset', () => {
    test('the forgot-password pane opens and explains itself when the store has no SMTP', async ({ page, posServer }) => {
        // The seeded store has blank SMTP, so passwordResetAvailable is false.
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await page.click('#show-forgot-btn');

        // The pane opens. Previously this dead-ended in a dismissed alert.
        await expect(page.locator('#pane-forgot')).toBeVisible();
        await expect(page.locator('#custom-alert-box')).toBeHidden();

        // And says why, next to the button it has disabled.
        await expect(page.locator('#forgot-unavailable-note')).toBeVisible();
        await expect(page.locator('#forgot-unavailable-note')).toContainText('not switched on');
        await expect(page.locator('#forgot-submit-btn')).toBeDisabled();
    });

    test('self-registration will not create an account with no way back into it', async ({ page, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await page.click('#auth-tab-register');

        await page.fill('#reg-name', 'No Email Person');
        await page.fill('#reg-phone', '9000000077');
        await page.fill('#reg-password', 'SelfServe!2026');
        await page.fill('#reg-password2', 'SelfServe!2026');
        await page.click('#register-submit-btn');

        await expect(page.locator('#register-error')).toContainText('valid email address');
        await expect(page.locator('#portal-view')).toBeHidden();

        // With an email it goes through, and the account carries the address
        // that makes a future reset possible.
        await page.fill('#reg-email', 'noemail@example.test');
        await page.click('#register-submit-btn');
        await expect(page.locator('#portal-view')).toBeVisible();

        const account = posServer.readLedger('customerAccounts')
            .find(a => a.phone === '9000000077');
        expect(account.email).toBe('noemail@example.test');
    });

    test('an account issued at the counter is prompted to add the email it lacks', async ({ page, posServer }) => {
        // Counter-issued logins are the population that predates the required
        // email at signup, and the one that cannot self-reset today.
        const issued = await page.evaluate(async ({ baseUrl, pin }) => {
            const login = await fetch(`${baseUrl}/api/admin/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            }).then(r => r.json());

            const res = await fetch(`${baseUrl}/api/customer-accounts/issue-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${login.token}` },
                body: JSON.stringify({ phone: '9000000088', name: 'Counter Issued' })
            });
            return res.json();
        }, { baseUrl: posServer.baseUrl, pin: posServer.seeded.adminPin });

        expect(issued.success).toBe(true);
        // The counter screen is told there is no email, so the cashier can say so.
        expect(issued.hasEmail).toBe(false);

        // Sign in with the temporary password and clear the forced change.
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await page.fill('#login-phone', '9000000088');
        await page.fill('#login-password', issued.tempPassword);
        await page.click('#login-submit-btn');

        await expect(page.locator('#force-change-view')).toBeVisible();
        await page.fill('#fc-password', 'ChosenByMe!2026');
        await page.fill('#fc-password2', 'ChosenByMe!2026');
        await page.click('#fc-submit-btn');

        await expect(page.locator('#portal-view')).toBeVisible();

        // The prompt is on the landing tab, where it cannot be missed.
        const prompt = page.locator('#no-email-prompt');
        await expect(prompt).toBeVisible();
        await expect(prompt).toContainText('reset your own password');

        // And it takes them to the field rather than describing where it is.
        await page.click('#no-email-fix-btn');
        await expect(page.locator('#tab-account')).toBeVisible();
        await expect(page.locator('#acct-email')).toBeFocused();

        // Saving an address clears the prompt without a reload, and the
        // account can now receive a reset code.
        await page.fill('#acct-email', 'counter.issued@example.test');
        await page.click('#acct-save-btn');
        await readAlert(page);
        await expect(prompt).toBeHidden();

        const account = posServer.readLedger('customerAccounts')
            .find(a => a.phone === '9000000088');
        expect(account.email).toBe('counter.issued@example.test');
    });
});
