/**
 * ==========================================================================
 * Reprint Desk — a second copy of an invoice that has already been filed.
 *
 * The property under test is the one the module exists for: a reprint shows
 * what was FILED, not what today's settings would price. That cannot be
 * checked from the HTTP suite, because the interesting failure is a browser
 * re-deriving figures from live settings and rendering something the ledger
 * never said. So each spec bills a sale, moves the store's configuration
 * underneath it, and then asserts the duplicate still quotes the original.
 *
 * It also covers the two things a blank-page print bug hides: that the sheet
 * renders at all, and that it is stamped as a duplicate.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

/** Opens the Billing Desk and waits for its async init to finish (see cashier-billing.spec.js). */
async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveClass(/active/);
    // The desk sets this once /api/gold-price and /api/settings have landed and
    // its listeners are wired. Filling the form before that types into a
    // live-looking form whose Save button does nothing.
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

async function openReprintDesk(page) {
    await page.click('button[data-target="reprint-tab"]');
    await expect(page.locator('#reprint-tab')).toHaveClass(/active/);
    await expect(page.locator('#reprint-search-btn')).toBeVisible();
}

/** Bills one plain sale and returns the record as it was persisted. */
async function fileASale(page, posServer, { weight = '10', name = 'Reprint Subject', phone = null } = {}) {
    await openBillingDesk(page);
    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', weight);
    await page.fill('#customer-name', name);
    if (phone) await page.fill('#customer-phone', phone);

    await page.click('#generate-invoice-btn');
    expect(await readAlert(page)).toContain('Invoice Saved Successfully');

    // Newest first, bounded at now — see readLedger.mjs.
    return posServer.readLedger('sales')[0];
}

async function search(page, query) {
    await page.fill('#reprint-q', query);
    await page.click('#reprint-search-btn');
}

test.describe('Reprint desk', () => {
    test('finds a filed invoice by its number and reprints it stamped as a duplicate', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer);

        await openReprintDesk(page);
        await search(page, filed.id);

        const row = page.locator('#reprint-results tbody tr');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(filed.id);
        await expect(row).toContainText('Reprint Subject');

        await row.getByRole('button', { name: 'Open' }).click();

        const sheet = page.locator('#reprint-sheet-container .invoice-sheet');
        await expect(sheet).toBeVisible();
        // The stamp is the difference between a reprint and a second bill.
        await expect(sheet).toContainText('DUPLICATE — REPRINT');
        await expect(sheet).toContainText(filed.id);

        // 10g @ ₹6,875/g, 10% making, 3% GST exclusive — the same figures the
        // cashier-billing journey pins down, now read back off the ledger.
        await expect(sheet).toContainText('75,625.00');   // taxable value
        await expect(sheet).toContainText('2,268.75');    // GST
        await expect(sheet).toContainText('77,893.75');   // grand total
        await expect(sheet).toContainText('Taxable Value (Metal + Making)');
    });

    test('reprints the FILED figures after the gold rate and tax settings have moved', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer, { name: 'Rate Mover' });
        expect(filed.goldPricePerGram).toBe(6875);
        expect(filed.taxMode).toBe('Exclusive');

        // Move the store underneath the invoice: a different rate, a different
        // slab, and the opposite tax mode. A desk that re-priced on open would
        // now show a materially different bill.
        const token = await page.evaluate(() => sessionStorage.getItem('adminToken'));
        const patch = await page.evaluate(async ({ token }) => {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    goldTaxSlab: 18,
                    taxMode: 'Inclusive',
                    overrideGoldPrice: {
                        active: true,
                        price24K: 10908,
                        price22K: 9999,
                        price18K: 8181
                    }
                })
            });
            return res.status;
        }, { token });
        expect(patch).toBe(200);

        // Reloaded so the desk starts from the CHANGED settings, with no
        // in-memory copy of the old ones to accidentally get it right.
        // sessionStorage keeps the admin token across the reload, so the app
        // comes straight back up rather than showing the PIN screen.
        await page.reload();
        await expect(page.locator('#app-viewport')).toBeVisible();
        await openReprintDesk(page);
        await search(page, filed.id);
        await page.locator('#reprint-results tbody tr').getByRole('button', { name: 'Open' }).click();

        const sheet = page.locator('#reprint-sheet-container .invoice-sheet');
        await expect(sheet).toBeVisible();

        // The invoice as filed: 3% Exclusive at ₹6,875/g.
        await expect(sheet).toContainText('6,875.00');
        await expect(sheet).toContainText('3% Excl');
        await expect(sheet).toContainText('2,268.75');
        await expect(sheet).toContainText('77,893.75');

        // And emphatically NOT today's configuration.
        await expect(sheet).not.toContainText('9,999.00');
        await expect(sheet).not.toContainText('18% Incl');
    });

    test('finds an invoice by customer phone, and reports an honest miss', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer, { name: 'Phone Search', phone: '9812345670' });
        expect(filed.customerPhone).toBe('9812345670');

        await openReprintDesk(page);
        await search(page, '9812345670');
        await expect(page.locator('#reprint-results tbody tr')).toHaveCount(1);
        await expect(page.locator('#reprint-results')).toContainText(filed.id);

        // A number with no sale against it must say so, not show an empty table.
        await search(page, '9000000009');
        await expect(page.locator('#reprint-results tbody tr')).toHaveCount(0);
        await expect(page.locator('#reprint-results')).toContainText('No filed invoice matches that');
    });

    test('refuses to search on nothing rather than returning the whole ledger', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openReprintDesk(page);

        await page.click('#reprint-search-btn');
        await expect(page.locator('#reprint-results')).toContainText('Enter an invoice number');
        await expect(page.locator('#reprint-results tbody tr')).toHaveCount(0);
    });

    test('keeps the invoice sheet on the page when printing, rather than hiding it', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer, { name: 'Print Target' });

        await openReprintDesk(page);
        await search(page, filed.id);
        await page.locator('#reprint-results tbody tr').getByRole('button', { name: 'Open' }).click();

        const sheet = page.locator('#reprint-sheet-container .invoice-sheet');
        await expect(sheet).toBeVisible();

        /* The regression this guards.
         *
         * The print stylesheet used to hide `.tab-panel:not(#tab-billing)` —
         * an id that exists nowhere in the markup — so under print media it
         * matched every panel INCLUDING the one holding the invoice, and
         * PRINT INVOICE produced a blank page. Emulating print media is the
         * only way to catch that; it is invisible on screen.
         */
        await page.emulateMedia({ media: 'print' });
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText('DUPLICATE — REPRINT');
        await expect(sheet).toContainText('77,893.75');

        // Screen chrome and controls stay off the customer's copy.
        await expect(page.locator('#sidebar')).toBeHidden();
        await expect(page.locator('#reprint-print-btn')).toBeHidden();

        await page.emulateMedia({ media: 'screen' });
    });

    test('the Billing Desk invoice also survives print media', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openBillingDesk(page);
        await page.fill('#gold-weight', '10');

        const sheet = page.locator('#sales-tab .invoice-sheet');
        await expect(sheet).toBeVisible();

        await page.emulateMedia({ media: 'print' });
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText('75,625.00');
        // The input column is cashier workspace, not part of the invoice.
        await expect(page.locator('.billing-inputs-card')).toBeHidden();

        await page.emulateMedia({ media: 'screen' });
    });
});
