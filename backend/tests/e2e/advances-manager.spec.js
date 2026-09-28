/**
 * ==========================================================================
 * Customer Advances tab (admin) — TESTING_CHECKLIST.md Module 4.
 *
 * No existing e2e spec drove this screen at all — cashier-billing.spec.js and
 * return-desk.spec.js exercise the Billing Desk's "Apply Advance" box, but
 * nothing had ever opened the admin Advances tab itself: the manual-deposit
 * form, its validation, the search filter, or the per-customer drill-down.
 * This file closes that gap end to end, including the one property that
 * spans two screens: a redemption filed at the counter must show up here as
 * a "Redeemed at Billing" ledger entry against the right invoice.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin } from './fixtures.js';

async function openAdvancesTab(page) {
    await page.click('button[data-target="advances-tab"]');
    await expect(page.locator('#advances-tab')).toHaveClass(/active/);
    await expect(page.locator('#advances-new-deposit-btn')).toBeVisible();
}

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

test('the new-deposit form validates the phone before submitting', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openAdvancesTab(page);

    await page.click('#advances-new-deposit-btn');
    await expect(page.locator('#new-deposit-form')).toBeVisible();

    await page.fill('#deposit-phone', '98765');
    await page.fill('#deposit-amount', '500');
    await page.click('#submit-deposit-btn');

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Valid 10-digit phone number required');
    await box.getByRole('button', { name: 'OK' }).click();

    // Refused before it reached the server — no deposit was ever recorded.
    expect(posServer.readLedger('advances').some(a => a.customerPhone === '98765')).toBe(false);
});

test('a valid manual deposit succeeds, clears the form, and appears in the table with the right balance', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openAdvancesTab(page);

    await page.click('#advances-new-deposit-btn');
    await page.fill('#deposit-phone', '9800011122');
    await page.fill('#deposit-name', 'Advances Tab Depositor');
    await page.fill('#deposit-amount', '2500');
    await page.selectOption('#deposit-method', { index: 0 });
    await page.click('#submit-deposit-btn');

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.locator('p')).toContainText('Success');
    await box.getByRole('button', { name: 'OK' }).click();

    await expect(page.locator('#new-deposit-form')).toBeHidden();
    await expect(page.locator('#deposit-phone')).toHaveValue('');
    await expect(page.locator('#deposit-amount')).toHaveValue('');

    const row = page.locator('#advances-table-body tr', { hasText: 'Advances Tab Depositor' });
    await expect(row).toContainText('2,500');
});

test('the search box filters the table live by phone or name', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openAdvancesTab(page);

    await page.click('#advances-new-deposit-btn');
    await page.fill('#deposit-phone', '9800022233');
    await page.fill('#deposit-name', 'Findable Filter Customer');
    await page.fill('#deposit-amount', '750');
    await page.click('#submit-deposit-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await page.fill('#advances-search', 'Findable Filter');
    await expect(page.locator('#advances-table-body')).toContainText('Findable Filter Customer');
    await expect(page.locator('#advances-table-body tr')).toHaveCount(1);

    await page.fill('#advances-search', '9800022233');
    await expect(page.locator('#advances-table-body')).toContainText('Findable Filter Customer');
    await expect(page.locator('#advances-table-body tr')).toHaveCount(1);
});

test('View expands a per-customer ledger drill-down, and Hide collapses it', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openAdvancesTab(page);

    await page.click('#advances-new-deposit-btn');
    await page.fill('#deposit-phone', '9800033344');
    await page.fill('#deposit-name', 'Drilldown Customer');
    await page.fill('#deposit-amount', '1200');
    await page.click('#submit-deposit-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await page.fill('#advances-search', '9800033344');
    const viewBtn = page.locator('#advances-table-body tr', { hasText: 'Drilldown Customer' }).getByRole('button', { name: 'View' });
    await viewBtn.click();

    const drilldown = page.locator('#advances-table-body');
    await expect(drilldown).toContainText('Deposit');
    await expect(drilldown).toContainText('+₹1,200');

    const hideBtn = page.locator('#advances-table-body').getByRole('button', { name: 'Hide' });
    await expect(hideBtn).toBeVisible();
    await hideBtn.click();
    await expect(page.locator('#advances-table-body').getByRole('button', { name: 'View' })).toBeVisible();
});

test('redeeming an advance at Billing Desk shows up here as a "Redeemed at Billing" entry against the invoice', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openAdvancesTab(page);

    await page.click('#advances-new-deposit-btn');
    await page.fill('#deposit-phone', '9800044455');
    await page.fill('#deposit-name', 'Redemption Customer');
    await page.fill('#deposit-amount', '5000');
    await page.click('#submit-deposit-btn');
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await openBillingDesk(page);
    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', '20');
    await page.fill('#customer-phone', '9800044455');
    await page.locator('#customer-phone').blur();
    const applyAdvance = page.locator('#apply-advance-btn');
    await expect(applyAdvance).toBeEnabled();
    await applyAdvance.click();
    await page.click('#generate-invoice-btn');
    await expect(page.locator('#custom-alert-box')).toBeVisible();
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    const filed = posServer.readLedger('sales')[0];
    expect(filed.customerPhone).toBe('9800044455');
    expect(filed.appliedAdvance).toBeGreaterThan(0);

    await openAdvancesTab(page);
    await page.fill('#advances-search', '9800044455');
    const row = page.locator('#advances-table-body tr', { hasText: 'Redemption Customer' });
    // 5000 deposited, some redeemed on this bill — the balance must have moved down from 5,000.
    await expect(row).not.toContainText('5,000');

    await row.getByRole('button', { name: 'View' }).click();
    const drilldown = page.locator('#advances-table-body');
    await expect(drilldown).toContainText('Redeemed at Billing');
    await expect(drilldown).toContainText(filed.id);
});
