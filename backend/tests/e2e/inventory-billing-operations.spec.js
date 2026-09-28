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

    // Reports are intentionally off for a new tenant until the owner accepts
    // their operational definition. This journey is an owner workflow, so it
    // enables the module through the actual Settings UI before exercising it.
    await openTab(page, 'settings-tab');
    await page.click('button.settings-subnav-btn[data-section="billing"]');
    await expect(page.locator('#set-reports-enabled')).toBeVisible();
    await page.selectOption('#set-reports-enabled', 'true');
    await page.click('#save-billing-btn');
    expect(await readAlert(page)).toContain('Billing settings saved');
    await expect(page.locator('#reports-nav-btn')).toBeVisible();

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

test('a slow SKU lookup cannot overwrite a faster one, and leaves the existing cart untouched', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await openTab(page, 'inventory-tab');
    for (const { name, sku } of [
        { name: 'Race Item Slow', sku: 'RACE-SKU-SLOW' },
        { name: 'Race Item Fast', sku: 'RACE-SKU-FAST' }
    ]) {
        await page.click('#inventory-new-item-btn');
        await page.fill('#item-name', name);
        await page.fill('#item-category', 'Rings');
        await page.fill('#item-sku', sku);
        await page.fill('#item-hsn', '7113');
        await page.fill('#item-gross-weight', '3');
        await page.fill('#item-net-weight', '3');
        await page.click('#submit-item-btn');
        await expect(page.locator('#inventory-table-body tr').filter({ hasText: name })).toBeVisible();

        await page.click('#inventory-new-lot-btn');
        await page.selectOption('#lot-item', { label: `${name} (22K)` });
        await page.fill('#lot-weight', '5');
        await page.fill('#lot-label', `${name} opening lot`);
        await page.fill('#lot-huid', `HUID-${sku}`);
        await page.fill('#lot-unit-cost', '4000');
        await page.click('#submit-lot-btn');
    }

    await openTab(page, 'sales-tab');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');

    // One line already committed to the invoice before the race below, so
    // there is something real for a stale lookup to wrongly disturb. This
    // also guards the boot-time module-identity fix (server.js's
    // versionedHtml()): a page that boots app.js twice double-fires this
    // click's handler, clearing the weight field a second time and refusing
    // the add with a false "Enter a weight" alert even though the item was
    // in fact added — see docs/LEDGER.md 2026-09-16.
    await page.fill('#billing-sku', 'RACE-SKU-FAST');
    await page.click('#billing-sku-lookup');
    await expect(page.locator('#billing-sku-status')).toContainText('Race Item Fast');
    await page.click('#add-item-btn');
    await expect(page.locator('#custom-alert-box')).toBeHidden();
    await expect(page.locator('#cart-list tbody tr')).toHaveCount(1);

    let markSlowRequestSeen;
    const slowRequestSeen = new Promise(resolve => { markSlowRequestSeen = resolve; });
    let releaseSlowResponse;
    const slowResponseRelease = new Promise(resolve => { releaseSlowResponse = resolve; });

    // Hold the first SKU's real lookup until the second has already resolved
    // — the exact race a cashier creates scanning two items back to back on
    // a slow counter network.
    await page.route('**/api/inventory/items/by-sku/RACE-SKU-SLOW', async route => {
        markSlowRequestSeen();
        await slowResponseRelease;
        try {
            await route.continue();
        } catch {
            // The browser correctly aborts this route once superseded; there
            // is nothing left to continue.
        }
    });

    await page.fill('#billing-sku', 'RACE-SKU-SLOW');
    await page.click('#billing-sku-lookup');
    await slowRequestSeen;

    await page.fill('#billing-sku', 'RACE-SKU-FAST');
    await page.click('#billing-sku-lookup');
    await expect(page.locator('#billing-sku-status')).toContainText('Race Item Fast');

    releaseSlowResponse();
    await page.waitForTimeout(150);

    // The slow, superseded response must never populate the form once it
    // finally lands.
    await expect(page.locator('#billing-sku-status')).toContainText('Race Item Fast');
    await expect(page.locator('#gold-weight')).toHaveValue('3.000');

    // And the line already committed to the invoice before the race started
    // must be completely untouched by it.
    await expect(page.locator('#cart-list tbody tr')).toHaveCount(1);
});

test('a stock adjustment is a destructive action: it names the item and delta, and dismissing it changes nothing', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await openTab(page, 'inventory-tab');
    await page.click('#inventory-new-item-btn');
    await page.fill('#item-name', 'Adjust Confirm Ring');
    await page.fill('#item-category', 'Rings');
    await page.fill('#item-sku', 'E2E-ADJUST-CONFIRM');
    await page.fill('#item-hsn', '7113');
    await page.fill('#item-gross-weight', '4');
    await page.fill('#item-net-weight', '4');
    await page.click('#submit-item-btn');
    const itemRow = page.locator('#inventory-table-body tr').filter({ hasText: 'Adjust Confirm Ring' }).first();
    await expect(itemRow).toBeVisible();

    await page.click('#inventory-new-lot-btn');
    await page.selectOption('#lot-item', { label: 'Adjust Confirm Ring (22K)' });
    await page.fill('#lot-weight', '10');
    await page.fill('#lot-label', 'E2E adjust-confirm lot');
    await page.fill('#lot-huid', 'HUID-ADJUST-CONFIRM');
    await page.fill('#lot-unit-cost', '4500');
    await page.click('#submit-lot-btn');
    await expect(itemRow).toContainText('10.00 g');

    await itemRow.getByRole('button', { name: 'View Lots' }).click();
    const lotRow = page.locator('#inventory-table-body tr').filter({ hasText: 'E2E adjust-confirm lot' });
    await lotRow.locator('summary').click();
    await lotRow.locator('input[id^="adjust-delta-"]').fill('-3');
    await lotRow.locator('input[id^="adjust-reason-"]').fill('E2E stock count correction');

    // Dismissing the confirmation must leave the lot, and its item's rollup
    // weight, completely untouched — the confirm() is a real gate, not a
    // no-op decoration in front of a request that fires regardless.
    let dialogMessage = '';
    page.once('dialog', async dialog => {
        dialogMessage = dialog.message();
        await dialog.dismiss();
    });
    await lotRow.locator('button.submit-adjust-btn').click();
    await expect.poll(() => dialogMessage).toContain('Adjust Confirm Ring');
    expect(dialogMessage).toContain('-3');
    await expect(itemRow).toContainText('10.00 g');

    // Accepting it applies the same adjustment for real.
    page.once('dialog', dialog => dialog.accept());
    await lotRow.locator('button.submit-adjust-btn').click();
    await expect(itemRow).toContainText('7.00 g');
});

// §24b keyboard-path audit (2026-09-17): the app's `window.alert` override
// (frontend/js/adminAlertOverride.js) is a hand-rolled `#custom-alert-box`
// overlay, not a native dialog — every admin-desk message, including the
// outcome of a destructive action, funnels through it. It used to leave
// focus wherever it already was and ignore Escape, so a keyboard-only
// operator had no reliable way to reach or dismiss it. This proves the fix:
// OK gets focus on open, Escape dismisses it, and focus returns to the
// control that triggered it.
test('the notification overlay is keyboard accessible: OK gets focus, Escape dismisses it, and focus returns to the trigger', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await openTab(page, 'settings-tab');
    await page.click('button.settings-subnav-btn[data-section="billing"]');
    await expect(page.locator('#set-reports-enabled')).toBeVisible();
    await page.selectOption('#set-reports-enabled', 'true');

    const saveBtn = page.locator('#save-billing-btn');
    await saveBtn.click();

    const box = page.locator('#custom-alert-box');
    await expect(box).toBeVisible();
    await expect(box.getByRole('button', { name: 'OK' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
    await expect(saveBtn).toBeFocused();
});

test('Management Reports default their date range to LOCAL today, not UTC today', async ({ page, posServer }) => {
    // 02:00 IST on the 15th is 20:30 UTC on the 14th — the exact window where
    // `toISOString().slice(0, 10)` used to disagree with local calendar date
    // and silently default the report's "To" field to yesterday, excluding
    // every sale rung today. Reproduced with a fixed clock rather than
    // waiting for the real clock to cross this boundary again.
    await page.clock.setFixedTime(new Date('2026-01-15T02:00:00+05:30'));

    await loginAsAdmin(page, posServer);
    await openTab(page, 'settings-tab');
    await page.click('button.settings-subnav-btn[data-section="billing"]');
    await expect(page.locator('#set-reports-enabled')).toBeVisible();
    await page.selectOption('#set-reports-enabled', 'true');
    await page.click('#save-billing-btn');
    await expect(page.locator('#custom-alert-box')).toBeVisible();
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    await openTab(page, 'reports-tab');
    await expect(page.locator('#management-report-to')).toHaveValue('2026-01-15');
    await expect(page.locator('#management-report-from')).toHaveValue('2026-01-01');
});
