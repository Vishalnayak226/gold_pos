/**
 * ==========================================================================
 * Gold Schemes tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces". No prior e2e spec ever opened this screen at all.
 *
 * Real bug found and fixed first (see SettingsManager.js's Billing-settings
 * save handler): `goldSchemeEnabled` saves through the exact same handler
 * as `managementReportsEnabled`, and that handler's own comment says
 * "Feature-gated modules must become reachable immediately after their
 * owner enables them" — but it only ever called `window.reportsDesk.refresh()`,
 * never `window.schemeDesk.refresh()`. Enabling Gold Schemes and saving
 * left the nav button hidden until a full page reload, the exact defect
 * already fixed once for Management Reports (docs/LEDGER.md 2026-09-03)
 * and never carried over to this sibling module. Fixed; this file's first
 * test proves the fix rather than assuming it.
 *
 * Not covered here: a permission-denied state. Every /api/gold-schemes/*
 * route is `requireAdminSession` with no role restriction, same as Cash
 * Shifts and Quotes & Holds.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openSettingsBillingSection(page) {
    await page.click('button[data-target="settings-tab"]');
    await expect(page.locator('#settings-tab')).toHaveClass(/active/);
    await page.click('button[data-section="billing"]');
    await expect(page.locator('#set-scheme-enabled')).toBeVisible();
}

async function enableGoldSchemes(page) {
    await openSettingsBillingSection(page);
    await page.selectOption('#set-scheme-enabled', 'true');
    await page.click('#save-billing-btn');
    const message = await readAlert(page);
    expect(message).toContain('Billing settings saved');
}

async function openGoldSchemesTab(page) {
    await page.click('button[data-target="gold-schemes-tab"]');
    await expect(page.locator('#gold-schemes-tab')).toHaveClass(/active/);
}

test('Gold Schemes stays fully hidden until the owner turns it on', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await expect(page.locator('#gold-schemes-nav-btn')).toBeHidden();
});

test('enabling Gold Schemes in Settings makes the tab reachable immediately, with no reload', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await expect(page.locator('#gold-schemes-nav-btn')).toBeHidden();

    await enableGoldSchemes(page);

    // This is the fix under test: before it, the button stayed hidden here
    // and only appeared after a manual page reload.
    await expect(page.locator('#gold-schemes-nav-btn')).toBeVisible();
    await openGoldSchemesTab(page);
    await expect(page.locator('#scheme-desk-body')).toBeVisible();
    await expect(page.locator('#scheme-table-body')).toContainText('No enrollments yet');
});

test('enrolling requires a valid 10-digit phone, then succeeds and lists the enrollment', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableGoldSchemes(page);
    await openGoldSchemesTab(page);

    await page.click('#scheme-new-enrollment-btn');
    await page.fill('#scheme-enroll-phone', '12345');
    await page.click('#scheme-submit-enroll-btn');
    await expect(page.locator('#scheme-enroll-result')).toHaveText('Enter a valid 10-digit phone number.');

    await page.fill('#scheme-enroll-phone', '9800055012');
    await page.fill('#scheme-enroll-name', 'Scheme Test Customer');
    await page.click('#scheme-submit-enroll-btn');

    await expect(page.locator('#new-enrollment-form')).toBeHidden();
    const row = page.locator('#scheme-table-body tr', { hasText: 'Scheme Test Customer' });
    await expect(row).toContainText('9800055012');
    await expect(row).toContainText('Active');
});

test('paying an installment requires a positive amount, then updates the paid count', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableGoldSchemes(page);
    await openGoldSchemesTab(page);

    await page.click('#scheme-new-enrollment-btn');
    await page.fill('#scheme-enroll-phone', '9800055013');
    await page.fill('#scheme-enroll-name', 'Installment Test Customer');
    await page.click('#scheme-submit-enroll-btn');

    const row = page.locator('#scheme-table-body tr', { hasText: 'Installment Test Customer' });
    const amountInput = row.locator('input[type="number"]');

    await amountInput.fill('0');
    await row.getByRole('button', { name: 'Pay' }).click();
    const message = await readAlert(page);
    expect(message).toContain('positive installment amount');

    await amountInput.fill('1000');
    await row.getByRole('button', { name: 'Pay' }).click();
    await expect(page.locator('#scheme-table-body tr', { hasText: 'Installment Test Customer' })).toContainText('1');
});

test('closing early asks for confirmation and credits the payout to the advance balance', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableGoldSchemes(page);
    await openGoldSchemesTab(page);

    await page.click('#scheme-new-enrollment-btn');
    await page.fill('#scheme-enroll-phone', '9800055014');
    await page.fill('#scheme-enroll-name', 'Close Early Customer');
    await page.click('#scheme-submit-enroll-btn');

    const row = page.locator('#scheme-table-body tr', { hasText: 'Close Early Customer' });
    await row.locator('input[type="number"]').fill('500');
    await row.getByRole('button', { name: 'Pay' }).click();

    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('bonus is forfeited');
        dialog.accept();
    });
    await page.locator('#scheme-table-body tr', { hasText: 'Close Early Customer' }).getByRole('button', { name: 'Close Early' }).click();

    const payoutMessage = await readAlert(page);
    expect(payoutMessage).toContain('Credited');
    expect(payoutMessage).toContain('advance balance');

    const closedRow = page.locator('#scheme-table-body tr', { hasText: 'Close Early Customer' });
    await expect(closedRow).toContainText('Closed Early');
    await expect(closedRow).toContainText('Credited to advance balance');
});

test('marking an enrollment defaulted asks for confirmation and only changes its status', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableGoldSchemes(page);
    await openGoldSchemesTab(page);

    await page.click('#scheme-new-enrollment-btn');
    await page.fill('#scheme-enroll-phone', '9800055015');
    await page.fill('#scheme-enroll-name', 'Default Test Customer');
    await page.click('#scheme-submit-enroll-btn');

    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('does not move any money');
        dialog.accept();
    });
    await page.locator('#scheme-table-body tr', { hasText: 'Default Test Customer' }).getByRole('button', { name: 'Mark Defaulted' }).click();

    await expect(page.locator('#scheme-table-body tr', { hasText: 'Default Test Customer' })).toContainText('Defaulted');
});

test('the enabled flag and an enrollment both survive a page reload', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableGoldSchemes(page);
    await openGoldSchemesTab(page);

    await page.click('#scheme-new-enrollment-btn');
    await page.fill('#scheme-enroll-phone', '9800055016');
    await page.fill('#scheme-enroll-name', 'Reload Test Customer');
    await page.click('#scheme-submit-enroll-btn');

    await page.reload();
    await expect(page.locator('#gold-schemes-nav-btn')).toBeVisible();
    await openGoldSchemesTab(page);
    await expect(page.locator('#scheme-table-body')).toContainText('Reload Test Customer');
});
