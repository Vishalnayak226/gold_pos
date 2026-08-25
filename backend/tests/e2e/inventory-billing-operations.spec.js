/**
 * Phase 44 operator journey: the browser forms and request bodies that join
 * catalogue, lot inventory, billing, exchange/void and management reporting.
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openTab(page, target) {
    await page.click(`button[data-target="${target}"]`);
    await expect(page.locator(`#${target}`)).toHaveClass(/active/);
}

async function scanSku(page, sku = 'E2E-SKU-44') {
    await page.fill('#billing-sku', sku);
    await page.click('#billing-sku-lookup');
    await expect(page.locator('#billing-sku-status')).toContainText('Phase 44 Chain');
    await expect(page.locator('#billing-lot-group')).toBeVisible();
    await expect(page.locator('#gold-weight')).toHaveValue('2.000');
}

test('catalogue lot flows through sale, exchange, void and reports without losing stock history', async ({ page, posServer }) => {
    test.setTimeout(90_000);
    page.on('dialog', async dialog => {
        if (dialog.type() === 'prompt') await dialog.accept('E2E wrong customer');
        else await dialog.accept();
    });

    await loginAsAdmin(page, posServer);

    // Create the catalogue item and its costed opening lot through the real UI.
    await openTab(page, 'inventory-tab');
    await page.click('#inventory-new-item-btn');
    await page.fill('#item-name', 'Phase 44 Chain');
    await page.fill('#item-category', 'Chains');
    await page.fill('#item-sku', 'E2E-SKU-44');
    await page.fill('#item-hsn', '7113');
    await page.fill('#item-gross-weight', '2');
    await page.fill('#item-net-weight', '2');
    await page.click('#submit-item-btn');
    const itemRow = page.locator('#inventory-table-body tr').filter({ hasText: 'Phase 44 Chain' }).first();
    await expect(itemRow).toContainText('E2E-SKU-44');

    await page.click('#inventory-new-lot-btn');
    await page.selectOption('#lot-item', { label: 'Phase 44 Chain (22K)' });
    await page.fill('#lot-weight', '10');
    await page.fill('#lot-label', 'E2E opening lot');
    await page.fill('#lot-huid', 'E2EHUID44');
    await page.fill('#lot-unit-cost', '5000');
    await page.click('#submit-lot-btn');
    await expect(itemRow).toContainText('10.00 g');

    // The scanner lookup fills the line but the filed invoice keeps exact item/lot refs.
    await openTab(page, 'sales-tab');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
    await scanSku(page);
    await page.fill('#customer-name', 'Phase 44 Customer');
    await page.fill('#customer-phone', '9812345672');
    await page.click('#generate-invoice-btn');
    expect(await readAlert(page)).toMatch(/Invoice Saved Successfully|recalculated/);
    const original = posServer.readLedger('sales')[0];
    expect(original.lines[0].inventoryItemId).toBeTruthy();
    expect(original.lines[0].inventoryLotId).toBeTruthy();

    // Exchange restores one gram, creates a marked credit, and binds it once to replacement billing.
    await openTab(page, 'returns-tab');
    await page.fill('#return-q', original.id);
    await page.click('#return-search-btn');
    await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();
    await page.fill('#return-weight', '1');
    await page.check('input[name="return-mode"][value="exchange"]');
    await expect(page.locator('#return-preview')).toContainText('EXCHANGE CREDIT');
    await page.click('#return-file-btn');

    await expect(page.locator('#sales-tab')).toHaveClass(/active/);
    await expect(page.locator('#billing-exchange-banner')).toContainText('Exchange credit');
    await expect(page.locator('#customer-phone')).toHaveValue('9812345672');
    await scanSku(page);
    await expect(page.locator('#apply-advance-btn')).toBeEnabled();
    await page.click('#apply-advance-btn');
    await page.click('#generate-invoice-btn');
    expect(await readAlert(page)).toMatch(/Invoice Saved Successfully|recalculated/);
    const replacement = posServer.readLedger('sales')[0];
    const exchange = posServer.readLedger('returns').find(row => row.originalInvoiceId === original.id);
    expect(exchange.refundMode).toBe('exchange');
    expect(exchange.exchangeInvoiceId).toBeTruthy();
    expect(replacement.appliedAdvance).toBeGreaterThan(0);

    // A second linked sale is voided from the Reprint screen; its filed row remains visible.
    await scanSku(page);
    await page.fill('#gold-weight', '1');
    await page.click('#generate-invoice-btn');
    expect(await readAlert(page)).toMatch(/Invoice Saved Successfully|recalculated/);
    const toVoid = posServer.readLedger('sales')[0];

    await openTab(page, 'reprint-tab');
    await page.fill('#reprint-q', toVoid.id);
    await page.click('#reprint-search-btn');
    const voidRow = page.locator('#reprint-results tbody tr');
    await voidRow.getByRole('button', { name: 'Void' }).click();
    await expect(voidRow.getByRole('button', { name: 'Void' })).toHaveCount(0);
    await voidRow.getByRole('button', { name: 'Open' }).click();
    await expect(page.locator('#reprint-sheet-container')).toContainText('CANCELLED — E2E wrong customer');

    // Report tables state their definition and consume the costed, movement-derived facts.
    await openTab(page, 'reports-tab');
    await page.selectOption('#management-report-kind', 'profitability');
    await page.click('#management-report-run');
    await expect(page.locator('#management-report-output')).toContainText('Gross contribution');
    await expect(page.locator('#management-report-output')).toContainText('Phase 44 Chain');
    await page.selectOption('#management-report-kind', 'ageing');
    await page.click('#management-report-run');
    await expect(page.locator('#management-report-output')).toContainText('7.000 g');
    await expect(page.locator('#management-report-output')).toContainText('35,000.00');

    await openTab(page, 'inventory-tab');
    await expect(itemRow).toContainText('7.00 g');
    await expect(page.locator('#inventory-movements-body')).toContainText('Sale');
    await expect(page.locator('#inventory-movements-body')).toContainText('Return');
    await expect(page.locator('#inventory-movements-body')).toContainText('Void');
});
