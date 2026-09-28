/**
 * ==========================================================================
 * Settings → Billing & Invoice — TESTING_CHECKLIST.md Module 7.
 *
 * The Admin-PIN-change half of this module is already covered by
 * store-profile.spec.js's "typing a new PIN over the blank field changes
 * it..." (it saves through this exact section — #save-billing-btn — since
 * the PIN field lives here, not on Store Profile). This file covers what's
 * left: a plain field save, and the typed-confirmation destructive guard on
 * lowering the invoice sequence.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin } from './fixtures.js';

async function openBillingSettings(page) {
    await page.click('button[data-target="settings-tab"]');
    await page.click('button.settings-subnav-btn[data-section="billing"]');
    await expect(page.locator('#set-tax-slab')).toBeVisible();
}

test('changing GST Tax Slab and Invoice Prefix and saving succeeds', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingSettings(page);

    await page.selectOption('#set-tax-slab', '5');
    await page.fill('#set-invoice-prefix', 'LUMINA');
    await page.click('#save-billing-btn');

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Billing settings saved');
    await box.getByRole('button', { name: 'OK' }).click();

    await page.reload();
    await expect(page.locator('#app-viewport')).toBeVisible();
    await openBillingSettings(page);
    await expect(page.locator('#set-invoice-prefix')).toHaveValue('LUMINA');
    await expect(page.locator('#set-tax-slab')).toHaveValue('5');
});

test('lowering the invoice sequence requires typing the exact confirmation phrase; a wrong or cancelled answer saves nothing', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    const before = posServer.readData('settings.json').invoiceSeqStart;

    await openBillingSettings(page);
    await page.fill('#set-invoice-seq', String(Math.max(1, before - 5)));

    page.once('dialog', dialog => {
        expect(dialog.type()).toBe('prompt');
        dialog.accept('not the right phrase');
    });
    await page.click('#save-billing-btn');

    const cancelled = page.locator('#custom-alert-box');
    await expect(cancelled).toBeVisible();
    await expect(cancelled.locator('p')).toContainText('Cancelled');
    await cancelled.getByRole('button', { name: 'OK' }).click();

    expect(posServer.readData('settings.json').invoiceSeqStart).toBe(before);
});

test('typing the confirmation phrase exactly lets the lowered sequence save', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    const before = posServer.readData('settings.json').invoiceSeqStart;
    const lowered = Math.max(1, before - 5);

    await openBillingSettings(page);
    await page.fill('#set-invoice-seq', String(lowered));

    page.once('dialog', dialog => dialog.accept('LOWER SEQUENCE'));
    await page.click('#save-billing-btn');

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Billing settings saved');
    await box.getByRole('button', { name: 'OK' }).click();

    expect(posServer.readData('settings.json').invoiceSeqStart).toBe(lowered);
});
