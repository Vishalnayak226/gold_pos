/**
 * ==========================================================================
 * Billing Desk — live preview and empty-invoice guard, TESTING_CHECKLIST.md
 * Module 3.
 *
 * Most of Module 3 is already covered: the arithmetic itself by
 * test_billing_math.js ([math automated] items), and full sale journeys —
 * including the partial-phone guard, print-media survival and the
 * "Invoice Saved Successfully" path — by cashier-billing.spec.js,
 * return-desk.spec.js and reprint-desk.spec.js. This file closes pieces of
 * Module 3 nothing else exercised: the rate/g display and rate-type badge
 * actually updating when purity is switched, the empty-cart guard's real
 * message (the checklist's old "Please enter a valid gold weight." text
 * predates the multi-line cart), the form/preview genuinely resetting after
 * a successful save, the discount-toggle button's Remove/Apply round-trip
 * (added 2026-09-26 — a real bug found while writing it, see below), and
 * that a phone with no advance history never shows the Apply Advance box.
 *
 * Real bug found and fixed while adding the discount-toggle coverage
 * (2026-09-26): `SettingsManager.js`'s Billing-settings save handler only
 * refreshed `window.reportsDesk`/`window.schemeDesk` after a successful
 * save, not `window.billingDesk` — so changing the default discount (or tax
 * slab, tax mode, wastage or old-gold settings) never reached the Billing
 * Desk until a page reload, because `billingDesk.fetchSettings()` is
 * otherwise only called once, at login (`app.js`). Fixed by adding the same
 * `fetchSettings()` refresh to that save callback. Guard proven: the
 * non-zero-default test failed with the toggle button hidden (its pre-fix
 * state) before the fix and passes after it.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

test('switching purity updates the live rate/g display and rate-type badge', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    // Seeded rates.json: 24K ₹7,500/g, 22K ₹6,875/g, 18K ₹5,625/g, all 'auto'.
    await page.selectOption('#gold-purity', 'price24K');
    await expect(page.locator('#current-gold-rate-22k')).toContainText('7,500');
    await expect(page.locator('#rate-type-badge')).toContainText('Auto');

    await page.selectOption('#gold-purity', 'price18K');
    await expect(page.locator('#current-gold-rate-22k')).toContainText('5,625');

    await page.selectOption('#gold-purity', 'price22K');
    await expect(page.locator('#current-gold-rate-22k')).toContainText('6,875');
});

test('an empty invoice is refused with a clear message and burns no invoice number', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    // The seeded fixture already carries historical demo sales, so the proof
    // here is that the count does not MOVE, not that it is zero.
    const before = posServer.readLedger('sales').length;

    // Weight left at its default 0 — no line entered, nothing in the cart.
    // This is a pure client-side guard with no server round-trip at all, so
    // the real proof that "no invoice number is burned" is that the ledger
    // gains no row — a sequence is only ever allocated inside the server's
    // own transaction, which this blocked click never reaches.
    await page.click('#generate-invoice-btn');
    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Add at least one item');
    await box.getByRole('button', { name: 'OK' }).click();

    expect(posServer.readLedger('sales').length).toBe(before);
});

test('a successful save resets the form and preview back to blank', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', '2');
    await page.fill('#customer-name', 'Reset Check Buyer');
    await expect(page.locator('#preview-customer-name')).toHaveText('Reset Check Buyer');

    await page.click('#generate-invoice-btn');
    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'OK' }).click();

    await expect(page.locator('#gold-weight')).toHaveValue('');
    await expect(page.locator('#customer-name')).toHaveValue('');
    await expect(page.locator('#preview-customer-name')).toHaveText('Cash Sale');
    await expect(page.locator('#preview-customer-phone')).toHaveText('-');
});

test('with the seeded 0% default discount, the toggle button never appears', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    // seed.js's buildSettings() carries defaultDiscountPercent: 0 — the
    // toggle only has a reason to exist once a non-zero default is set.
    await expect(page.locator('#toggle-discount-btn')).toBeHidden();
});

test('the discount toggle button reflects a non-zero default and Remove/Apply round-trips the total exactly', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await page.click('button[data-target="settings-tab"]');
    await page.click('button.settings-subnav-btn[data-section="billing"]');
    await expect(page.locator('#set-tax-slab')).toBeVisible();
    await page.fill('#set-default-discount', '10');
    await page.click('#save-billing-btn');
    expect(await readAlert(page)).toContain('Billing settings saved');

    // First visit to the Billing Desk this session, so its own fetchSettings()
    // — awaited before #sales-tab is marked data-desk-ready — picks up the
    // save above without needing a page reload.
    await openBillingDesk(page);

    const toggleBtn = page.locator('#toggle-discount-btn');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveText('Remove');

    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', '10');
    const withDiscount = await page.locator('#sum-grand-total').innerText();

    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('Apply');
    await expect(toggleBtn).toHaveClass(/btn-primary/);
    const withoutDiscount = await page.locator('#sum-grand-total').innerText();
    const parseMoney = (s) => parseFloat(s.replace(/[₹,]/g, ''));
    expect(parseMoney(withoutDiscount)).toBeGreaterThan(parseMoney(withDiscount));

    await toggleBtn.click();
    await expect(toggleBtn).toHaveText('Remove');
    await expect(page.locator('#sum-grand-total')).toHaveText(withDiscount);
});

test('a phone with no advance history never shows the Apply Advance box', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    // 9199999999 is outside seed.js's CUSTOMERS range (9000000000-9000000004)
    // and has no advances row at all. Waiting on the real lookup response
    // (rather than just asserting the box is hidden, which would also pass
    // before the fetch ever ran) proves the round trip actually happened and
    // still resolved to "nothing to show", not that the assertion never ran.
    const lookup = page.waitForResponse(res => res.url().includes('/api/advances/lookup') && res.ok());
    await page.fill('#customer-phone', '9199999999');
    await lookup;

    await expect(page.locator('#advance-redeem-container')).toBeHidden();
});
