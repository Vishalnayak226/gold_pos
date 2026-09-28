/**
 * ==========================================================================
 * Settings → Store Profile — TESTING_CHECKLIST.md Module 5.
 *
 * No existing e2e spec had ever opened Store Profile — `inventory-billing-
 * operations.spec.js` only ever touched the Billing subsection. This covers
 * the plain field save, the logo upload/clear round trip against the
 * Billing Desk invoice preview, and the credential-preservation guarantee
 * CLAUDE.md treats as load-bearing: saving an unrelated field must never
 * overwrite the admin PIN, and the field itself must never echo the real one.
 * ==========================================================================
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, loginAsAdmin } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TINY_LOGO = path.join(__dirname, 'fixtures', 'tiny-logo.png');

async function openStoreProfile(page) {
    await page.click('button[data-target="settings-tab"]');
    await page.click('button.settings-subnav-btn[data-section="profile"]');
    await expect(page.locator('#set-company-name')).toBeVisible();
}

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

test('editing Store Profile fields and saving shows a success alert and persists', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openStoreProfile(page);

    await page.fill('#set-company-name', 'Updated Jewellers Co');
    await page.fill('#set-phone', '9911223344');
    await page.fill('#set-address', '221B Baker Street');
    await page.fill('#set-gst', 'GSTIN9988');
    await page.selectOption('#set-currency', { index: 0 });
    await page.click('#save-profile-btn');

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Store profile saved');
    await box.getByRole('button', { name: 'OK' }).click();

    await page.reload();
    await expect(page.locator('#app-viewport')).toBeVisible();
    await openStoreProfile(page);
    await expect(page.locator('#set-company-name')).toHaveValue('Updated Jewellers Co');
    await expect(page.locator('#set-phone')).toHaveValue('9911223344');
    await expect(page.locator('#set-gst')).toHaveValue('GSTIN9988');
});

test('uploading a logo replaces the company name on the invoice; Clear Logo restores it', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openStoreProfile(page);

    await expect(page.locator('#logo-preview')).toBeHidden();
    await expect(page.locator('#logo-preview-placeholder')).toBeVisible();

    await page.setInputFiles('#company-logo-upload', TINY_LOGO);
    await expect(page.locator('#logo-preview')).toBeVisible();
    await expect(page.locator('#logo-preview-placeholder')).toBeHidden();

    await page.click('#save-profile-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    // BillingDesk.fetchSettings() runs once at init, not on every tab switch —
    // a reload is what actually picks up the logo, matching the pattern every
    // other "settings moved underneath the desk" spec in this suite uses.
    await page.reload();
    await expect(page.locator('#app-viewport')).toBeVisible();
    await openBillingDesk(page);
    await expect(page.locator('#invoice-company-logo')).toBeVisible();
    await expect(page.locator('#invoice-company-name')).toBeHidden();

    // Clear it, save, and the invoice must revert to the text company name.
    await openStoreProfile(page);
    await page.click('#clear-logo-btn');
    await expect(page.locator('#logo-preview')).toBeHidden();
    await page.click('#save-profile-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await page.reload();
    await expect(page.locator('#app-viewport')).toBeVisible();
    await openBillingDesk(page);
    await expect(page.locator('#invoice-company-logo')).toBeHidden();
    await expect(page.locator('#invoice-company-name')).toBeVisible();
});

test('the Admin PIN field never echoes the real PIN, and saving an unrelated field does not overwrite it', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openStoreProfile(page);

    await page.click('button.settings-subnav-btn[data-section="billing"]');
    const pinField = page.locator('#set-admin-pin');
    await expect(pinField).toHaveValue('');
    await expect(pinField).toHaveAttribute('placeholder', /Configured/);

    // Edit a completely unrelated section and save — the PIN field on this
    // screen was never touched.
    await page.click('button.settings-subnav-btn[data-section="profile"]');
    await page.fill('#set-company-name', 'PIN Safety Co');
    await page.click('#save-profile-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await page.click('#admin-logout-btn');
    await expect(page.locator('#admin-login-view')).toBeVisible();
    await page.fill('#admin-pin-input', posServer.seeded.adminPin);
    await page.click('#admin-login-btn');
    await expect(page.locator('#app-viewport')).toBeVisible();
});

test('typing a new PIN over the blank field changes it, and the old PIN stops working', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openStoreProfile(page);
    await page.click('button.settings-subnav-btn[data-section="billing"]');

    await page.fill('#set-admin-pin', '432198');
    await page.click('#save-billing-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await page.click('#admin-logout-btn');
    await expect(page.locator('#admin-login-view')).toBeVisible();

    // The old PIN is dead.
    await page.fill('#admin-pin-input', posServer.seeded.adminPin);
    await page.click('#admin-login-btn');
    await expect(page.locator('#admin-login-error')).toContainText('Incorrect PIN');
    await expect(page.locator('#app-viewport')).toBeHidden();

    // The new one works.
    await page.fill('#admin-pin-input', '432198');
    await page.click('#admin-login-btn');
    await expect(page.locator('#app-viewport')).toBeVisible();
});
