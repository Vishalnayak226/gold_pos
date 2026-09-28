/**
 * ==========================================================================
 * Management Reports tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces".
 *
 * Deliberately NOT re-covered here: Gross Profitability, Inventory Ageing,
 * and the local-vs-UTC date-default bug (found and fixed 2026-09-19) are
 * already exercised by `inventory-billing-operations.spec.js` ("Module 22"
 * per ReportsDesk.js's own header comment) as part of a concurrent session's
 * work landing in this same tree today. This file covers the remaining gap:
 * the Settlement and Reconciliation reports (zero prior coverage), the
 * invalid-date-range error path, the ageing-report's date-input-disabling
 * behaviour, and the module's hidden-by-default state.
 *
 * All money assertions here use a date range of exactly TODAY on both ends —
 * seed.js's synthetic sales are all dated 3+ days in the past (no
 * `dayOffset: 0` entry exists), so this isolates the report to only the one
 * invoice this spec itself files, making an exact-figure assertion safe
 * rather than fragile against seed data drift.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

function todayIso() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function enableManagementReports(page) {
    await page.click('button[data-target="settings-tab"]');
    await page.click('button[data-section="billing"]');
    await page.selectOption('#set-reports-enabled', 'true');
    await page.click('#save-billing-btn');
    const message = await readAlert(page);
    expect(message).toContain('Billing settings saved');
}

async function openReportsTab(page) {
    await page.click('button[data-target="reports-tab"]');
    await expect(page.locator('#reports-tab')).toHaveClass(/active/);
}

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

test('Management Reports stays fully hidden until the owner turns it on', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await expect(page.locator('#reports-nav-btn')).toBeHidden();
});

test('the Settlement report shows a real cash sale filed today, with the right tender total and net settlement', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await openBillingDesk(page);
    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', '10');
    await page.fill('#customer-name', 'Settlement Report Customer');
    await page.click('#generate-invoice-btn');
    expect(await readAlert(page)).toContain('Invoice Saved Successfully');

    await enableManagementReports(page);
    await openReportsTab(page);
    const today = todayIso();
    await page.fill('#management-report-from', today);
    await page.fill('#management-report-to', today);
    await page.selectOption('#management-report-kind', 'settlement');
    await page.click('#management-report-run');

    const output = page.locator('#management-report-output');
    await expect(output).toContainText('Filed tender totals by capture method');
    // 10g of 22K at the seeded ₹6,875/g, 10% making, 3% GST exclusive = 77,893.75 total,
    // same known figure cashier-billing.spec.js relies on for this exact input.
    await expect(output).toContainText('77,893.75');
    const cashRow = page.locator('#management-report-output tbody tr', { hasText: 'cash' });
    await expect(cashRow).toContainText('1'); // one tender entry, no voids yet
});

test('the Reconciliation report shows zero exceptions for a cleanly-filed sale', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await openBillingDesk(page);
    await page.selectOption('#gold-purity', 'price18K');
    await page.fill('#gold-weight', '4');
    await page.fill('#customer-name', 'Reconciliation Report Customer');
    await page.click('#generate-invoice-btn');
    await readAlert(page);

    await enableManagementReports(page);
    await openReportsTab(page);
    const today = todayIso();
    await page.fill('#management-report-from', today);
    await page.fill('#management-report-to', today);
    await page.selectOption('#management-report-kind', 'reconciliation');
    await page.click('#management-report-run');

    const output = page.locator('#management-report-output');
    await expect(output).toContainText('0 exception(s)');
    await expect(output).toContainText('No reconciliation exceptions in this period.');
});

test('an invalid date range (from after to) shows a clear error rather than a broken report', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableManagementReports(page);
    await openReportsTab(page);

    await page.fill('#management-report-from', '2027-01-01');
    await page.fill('#management-report-to', '2020-01-01');
    await page.selectOption('#management-report-kind', 'settlement');
    await page.click('#management-report-run');

    await expect(page.locator('#management-report-output')).toContainText('The "from" date cannot be after the "to" date.');
});

test('choosing Inventory Ageing disables the date range, since ageing has none; switching back re-enables it', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await enableManagementReports(page);
    await openReportsTab(page);

    await expect(page.locator('#management-report-from')).toBeEnabled();
    await page.selectOption('#management-report-kind', 'ageing');
    await expect(page.locator('#management-report-from')).toBeDisabled();
    await expect(page.locator('#management-report-to')).toBeDisabled();

    await page.selectOption('#management-report-kind', 'settlement');
    await expect(page.locator('#management-report-from')).toBeEnabled();
    await expect(page.locator('#management-report-to')).toBeEnabled();
});
