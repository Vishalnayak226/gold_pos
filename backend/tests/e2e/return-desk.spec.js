/**
 * ==========================================================================
 * Return Desk — refunding part or all of an invoice that has already been filed.
 *
 * The properties under test are the three the module exists for:
 *
 *   1. The refund is priced by the ORIGINAL invoice, not by today. So the
 *      rate-mover spec moves the gold rate, the slab and the tax mode
 *      underneath a filed sale and asserts the refund is unmoved — the same
 *      shape of check the Reprint Desk gets, for the same reason.
 *   2. Cash and gold refunds differ only in where the money goes. A cash
 *      refund must leave the advances ledger untouched; a gold refund must
 *      land there as spendable credit in the same commit.
 *   3. An invoice cannot give back more than it took. Partial returns
 *      accumulate, and the invoice closes when the weight runs out.
 *
 * The HTTP suite already covers the route's arithmetic and its refusals. What
 * only a browser can catch is the desk quietly re-pricing against live
 * settings, a preview that disagrees with what gets filed, or a credit note
 * that renders blank under print media.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

/** Opens the Billing Desk and waits for its async init to finish. */
async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveClass(/active/);
    // The desk sets this once /api/gold-price and /api/settings have landed and
    // its listeners are wired. Filling the form before that types into a
    // live-looking form whose Save button does nothing.
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

async function openReturnDesk(page) {
    await page.click('button[data-target="returns-tab"]');
    await expect(page.locator('#returns-tab')).toHaveClass(/active/);
    await expect(page.locator('#return-search-btn')).toBeVisible();
}

/**
 * Bills one plain sale and returns the record as it was persisted.
 * 10 g of 22K at ₹6,875/g with the default 10% making and 3% exclusive GST:
 * ₹68,750 metal + ₹6,875 making = ₹75,625 taxable, ₹2,268.75 GST,
 * ₹77,893.75 total.
 */
async function fileASale(page, posServer, { weight = '10', name = 'Return Subject', phone = null } = {}) {
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
    await page.fill('#return-q', query);
    await page.click('#return-search-btn');
}

/**
 * Filing a refund asks for confirmation through a native window.confirm —
 * deliberately, because it moves money out of the till. Playwright dismisses
 * dialogs by default, which would silently make every one of these specs pass
 * by never filing anything, so each accepts explicitly.
 */
function acceptConfirmations(page) {
    page.on('dialog', dialog => dialog.accept());
}

test.describe('Return desk', () => {
    test('files a partial cash refund and issues a credit note that adds up', async ({ page, posServer }) => {
        acceptConfirmations(page);
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer);
        const advancesBefore = posServer.readLedger('advances').length;

        await openReturnDesk(page);
        await search(page, filed.id);

        const row = page.locator('#return-results tbody tr');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText('Return Subject');
        await row.getByRole('button', { name: 'Return' }).click();

        // The form opens defaulted to the whole returnable weight.
        await expect(page.locator('#return-weight')).toHaveValue('10.000');

        // 4 g: ₹27,500 metal + ₹2,750 making = ₹30,250 taxable, 3% = ₹907.50.
        await page.fill('#return-weight', '4');
        const preview = page.locator('#return-preview');
        await expect(preview).toContainText('27,500.00');
        await expect(preview).toContainText('2,750.00');
        await expect(preview).toContainText('907.50');
        await expect(preview).toContainText('31,157.50');
        await expect(preview).toContainText('REFUND (CASH)');
        await expect(preview).toContainText('6.000 g would remain returnable');

        await page.fill('#return-note', 'Clasp faulty');
        await page.click('#return-file-btn');

        const note = page.locator('#return-note-container .invoice-sheet');
        await expect(note).toBeVisible();
        await expect(note).toContainText('CREDIT NOTE');
        await expect(note).toContainText('RETURN & REFUND');
        await expect(note).toContainText(filed.id);
        // The preview figure and the filed figure are the same number, which
        // is the point of both running through computeReturnRefund().
        await expect(note).toContainText('31,157.50');
        await expect(note).toContainText('REFUNDED (CASH)');
        await expect(note).toContainText('Partial return');

        const filedReturns = posServer.readLedger('returns')
            .filter(r => r.originalInvoiceId === filed.id);
        expect(filedReturns).toHaveLength(1);
        expect(filedReturns[0].refundAmount).toBe(31157.5);
        expect(filedReturns[0].refundMode).toBe('cash');
        expect(filedReturns[0].note).toBe('Clasp faulty');

        // Cash is handed over the counter. It must not also become credit.
        expect(posServer.readLedger('advances')).toHaveLength(advancesBefore);

        // And the invoice itself is untouched — a reprint must still reproduce it.
        const sale = posServer.readLedger('sales').find(s => s.id === filed.id);
        expect(sale.totalAmount).toBe(77893.75);
        expect(sale.weightGrams).toBe(10);
    });

    test('a gold refund becomes spendable credit on the customer’s account', async ({ page, posServer }) => {
        acceptConfirmations(page);
        await loginAsAdmin(page, posServer);
        // A phone that carries no seeded advance history, so the balance after
        // the refund is the refund alone and nothing else.
        const filed = await fileASale(page, posServer, { name: 'Gold Refund', phone: '9812345671' });

        await openReturnDesk(page);
        await search(page, filed.id);
        await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();

        await page.check('input[name="return-mode"][value="gold"]');
        const preview = page.locator('#return-preview');
        await expect(preview).toContainText('REFUND (GOLD CREDIT)');
        await expect(preview).toContainText('77,893.75');
        await expect(preview).toContainText('closes the invoice');

        await page.click('#return-file-btn');
        await expect(page.locator('#return-note-container .invoice-sheet')).toContainText('REFUNDED (GOLD CREDIT)');
        await expect(page.locator('#return-note-container .invoice-sheet'))
            .toContainText('credited to your account');

        // By invoice, not just by source — the seeded fixture already carries
        // a return credit of its own.
        const credit = posServer.readLedger('advances')
            .find(a => a.source === 'return' && a.invoiceId === filed.id);
        expect(credit).toBeTruthy();
        expect(credit.type).toBe('deposit');
        expect(credit.status).toBe('approved');
        expect(credit.amount).toBe(77893.75);
        expect(credit.customerPhone).toBe('9812345671');
        expect(credit.invoiceId).toBe(filed.id);

        // Spendable immediately: the Billing Desk offers it on the next bill,
        // with no approval step in between.
        await openBillingDesk(page);
        await page.fill('#gold-weight', '20');
        await page.fill('#customer-phone', '9812345671');
        await page.locator('#customer-phone').blur();
        const applyAdvance = page.locator('#apply-advance-btn');
        await expect(applyAdvance).toBeEnabled();
        await applyAdvance.click();
        await expect(page.locator('#sum-advance-amount')).toContainText('77,893.75');
    });

    test('prices the refund from the invoice after the rate and tax settings move', async ({ page, posServer }) => {
        acceptConfirmations(page);
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer, { name: 'Rate Mover' });
        expect(filed.goldPricePerGram).toBe(6875);

        // Move the store underneath the invoice. A desk that re-priced the
        // return against live settings would now refund a different number —
        // ₹9,999/g at 18% inclusive rather than ₹6,875/g at 3% exclusive.
        const token = await page.evaluate(() => sessionStorage.getItem('adminToken'));
        const patch = await page.evaluate(async ({ token }) => {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    goldTaxSlab: 18,
                    taxMode: 'Inclusive',
                    overrideGoldPrice: { active: true, price24K: 10908, price22K: 9999, price18K: 8181 }
                })
            });
            return res.status;
        }, { token });
        expect(patch).toBe(200);

        // Reloaded so the desk starts from the CHANGED settings, with no
        // in-memory copy of the old ones to accidentally get it right.
        await page.reload();
        await expect(page.locator('#app-viewport')).toBeVisible();
        await openReturnDesk(page);
        await search(page, filed.id);
        await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();

        const preview = page.locator('#return-preview');
        await expect(preview).toContainText('6,875.00');
        await expect(preview).toContainText('77,893.75');
        await expect(preview).not.toContainText('9,999.00');

        await page.click('#return-file-btn');
        // Waiting on the credit note, not just on the click: the POST is in
        // flight until the note renders, and reading the ledger before then
        // races it.
        await expect(page.locator('#return-note-container .invoice-sheet')).toBeVisible();

        const record = posServer.readLedger('returns')
            .find(r => r.originalInvoiceId === filed.id);
        expect(record.refundAmount).toBe(77893.75);
        expect(record.goldPricePerGram).toBe(6875);
        expect(record.taxPercent).toBe(3);
        expect(record.taxMode).toBe('Exclusive');
    });

    test('accumulates partial returns and closes the invoice when the weight runs out', async ({ page, posServer }) => {
        acceptConfirmations(page);
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer, { name: 'Two Trips' });

        await openReturnDesk(page);
        await search(page, filed.id);
        await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();
        await page.fill('#return-weight', '4');
        await page.click('#return-file-btn');
        await expect(page.locator('#return-note-container .invoice-sheet')).toBeVisible();

        // Second trip: the desk measures against what is LEFT, not the original.
        await search(page, filed.id);
        const row = page.locator('#return-results tbody tr');
        await expect(row).toContainText('4.000 g returned');
        await row.getByRole('button', { name: 'Return' }).click();
        await expect(page.locator('#return-weight')).toHaveValue('6.000');
        await expect(page.locator('#return-form-container')).toContainText('6.000 g remains returnable');

        // Asking for more than remains is refused before it can be filed.
        await page.fill('#return-weight', '7');
        await expect(page.locator('#return-preview')).toContainText('Only 6.000g');
        await expect(page.locator('#return-file-btn')).toBeDisabled();

        await page.fill('#return-weight', '6');
        await expect(page.locator('#return-preview')).toContainText('46,736.25');
        await page.click('#return-file-btn');
        await expect(page.locator('#return-note-container .invoice-sheet')).toContainText('fully returned');

        // The two refunds sum to exactly what the invoice charged.
        const rows = posServer.readLedger('returns')
            .filter(r => r.originalInvoiceId === filed.id);
        expect(rows).toHaveLength(2);
        expect(Math.round(rows.reduce((sum, r) => sum + r.refundAmount, 0) * 100) / 100).toBe(77893.75);

        // And the closed invoice can no longer be opened for a third return.
        await search(page, filed.id);
        await expect(page.locator('#return-results tbody tr')).toContainText('Fully returned');
        await expect(page.locator('#return-results tbody tr').getByRole('button', { name: 'Closed' }))
            .toBeDisabled();
    });

    test('offers only a cash refund on a walk-in invoice with no account to credit', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        // Seeded walk-in: a real invoice filed with no customer phone on it.
        await openReturnDesk(page);
        await search(page, 'SEED-000001-26');
        await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();

        await expect(page.locator('input[name="return-mode"][value="gold"]')).toBeDisabled();
        await expect(page.locator('#return-form-container')).toContainText('no customer phone number');
        await expect(page.locator('input[name="return-mode"][value="cash"]')).toBeChecked();
    });

    test('the credit note survives print media, and the controls do not', async ({ page, posServer }) => {
        acceptConfirmations(page);
        await loginAsAdmin(page, posServer);
        const filed = await fileASale(page, posServer, { name: 'Print Target' });

        await openReturnDesk(page);
        await search(page, filed.id);
        await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();
        await page.click('#return-file-btn');

        const note = page.locator('#return-note-container .invoice-sheet');
        await expect(note).toBeVisible();

        await page.emulateMedia({ media: 'print' });
        await expect(note).toBeVisible();
        await expect(note).toContainText('CREDIT NOTE');
        await expect(note).toContainText('77,893.75');

        // Screen chrome and the desk's own controls stay off the customer's copy.
        await expect(page.locator('#sidebar')).toBeHidden();
        await expect(page.locator('#return-print-btn')).toBeHidden();
        await expect(page.locator('#return-recent')).toBeHidden();

        await page.emulateMedia({ media: 'screen' });
    });

    test('lists filed returns and reopens any credit note from the history', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openReturnDesk(page);

        // Three returns ship in the seeded fixture: two cash, one gold credit.
        const recent = page.locator('#return-recent tbody tr');
        await expect(recent).toHaveCount(3);
        await expect(page.locator('#return-recent')).toContainText('GOLD CREDIT');
        await expect(page.locator('#return-recent')).toContainText('CASH');

        await recent.first().getByRole('button', { name: 'Note' }).click();
        await expect(page.locator('#return-note-container .invoice-sheet')).toContainText('CREDIT NOTE');
    });
});
