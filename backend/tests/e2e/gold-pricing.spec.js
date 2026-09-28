/**
 * ==========================================================================
 * Settings → Gold Pricing & Overrides — TESTING_CHECKLIST.md Module 6.
 *
 * "Sync Price Now" needs real internet access to Yahoo Finance and is left
 * untested here on purpose — an e2e suite that depends on a live third-party
 * API is exactly the kind of non-deterministic test this project avoids. The
 * manual-override on/off path needs no network at all and is fully covered.
 *
 * No reload is needed between saving and checking Billing Desk/Dashboard:
 * `wirePricingSection()`'s save handler already calls
 * `window.billingDesk.fetchGoldRate()` and `window.dashboard.refresh()`
 * itself once the save succeeds — both components are singletons that exist
 * in the page regardless of which tab is visible.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin } from './fixtures.js';

async function openPricingSettings(page) {
    await page.click('button[data-target="settings-tab"]');
    await page.click('button.settings-subnav-btn[data-section="pricing"]');
    await expect(page.locator('#set-override-active')).toBeVisible();
}

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

async function openDashboard(page) {
    await page.click('button[data-target="dashboard-tab"]');
    await expect(page.locator('#dashboard-tab')).toHaveClass(/active/);
}

test('enabling manual overrides shows the custom rates with a Manual Override badge on both Billing Desk and Dashboard', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openPricingSettings(page);

    await page.check('#set-override-active');
    await page.fill('#price-override-24k', '9000');
    await page.fill('#price-override-22k', '8250');
    await page.fill('#price-override-18k', '6750');
    await page.click('#save-price-override');

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Gold pricing settings saved');
    await box.getByRole('button', { name: 'OK' }).click();

    await openBillingDesk(page);
    await expect(page.locator('#current-gold-rate-22k')).toContainText('8,250');
    await expect(page.locator('#rate-type-badge')).toContainText('Manual Override');

    await openDashboard(page);
    await page.click('#dashboard-refresh-btn');
    await expect(page.locator('#stat-gold-rate')).toContainText('8,250');
    await expect(page.locator('#stat-gold-rate-badge')).toContainText('Manual Override');
});

test('disabling overrides reverts both screens to the auto-synced rate', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openPricingSettings(page);

    // Turn overrides on first so there is something real to turn back off.
    await page.check('#set-override-active');
    await page.fill('#price-override-24k', '9000');
    await page.fill('#price-override-22k', '8250');
    await page.fill('#price-override-18k', '6750');
    await page.click('#save-price-override');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await openBillingDesk(page);
    await expect(page.locator('#rate-type-badge')).toContainText('Manual Override');

    await openPricingSettings(page);
    await expect(page.locator('#set-override-active')).toBeChecked();
    await page.uncheck('#set-override-active');
    await page.click('#save-price-override');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    // Seeded auto rate: 22K ₹6,875/g (cashier-billing.spec.js pins the same figure).
    await openBillingDesk(page);
    await expect(page.locator('#current-gold-rate-22k')).toContainText('6,875');
    await expect(page.locator('#rate-type-badge')).toContainText('Auto');
    await expect(page.locator('#rate-type-badge')).not.toContainText('Manual Override');
});
