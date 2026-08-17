/**
 * ==========================================================================
 * Cashier golden path — sign in, bill a customer, redeem an advance.
 *
 * The value of driving this through a browser rather than through the HTTP
 * suite is that it exercises the parts no route test can reach: that the
 * Billing Desk's preview arithmetic and the server's recomputation agree, that
 * the advance a cashier applies is the balance the customer actually has, and
 * that what lands in sales_YYYY.json matches what the cashier was shown.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

/** Opens the Billing Desk and waits for its async init to finish.
 *
 * BillingDesk.init() renders, then awaits /api/gold-price and /api/settings,
 * and only wires its event listeners afterwards. Filling the form before that
 * resolves types into a live-looking form whose Save button does nothing, so
 * every spec waits for the rate to appear in the preview first — that is the
 * observable proof the fetches landed.
 */
async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveClass(/active/);
    // The desk sets this once /api/gold-price and /api/settings have landed and
    // its listeners are wired. Filling the form before that types into a
    // live-looking form whose Save button does nothing.
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

test.describe('Cashier billing journey', () => {
    test('signs in, bills a plain cash sale, and files the server’s own arithmetic', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openBillingDesk(page);

        // 10g of 22K at the seeded ₹6,875/g, 10% making, 3% GST exclusive.
        //   metal    = 10      × 6875 = 68,750.00
        //   making   = 68,750  × 0.10 =  6,875.00
        //   taxable                   = 75,625.00
        //   GST      = 75,625 × 0.03  =  2,268.75
        //   total                     = 77,893.75
        await page.selectOption('#gold-purity', 'price22K');
        await page.fill('#gold-weight', '10');
        await page.fill('#customer-name', 'E2E Walk-in');

        await expect(page.locator('#sum-metal-value')).toContainText('68,750');
        await expect(page.locator('#sum-taxable-amount')).toContainText('75,625');
        await expect(page.locator('#sum-tax-amount')).toContainText('2,268.75');

        await page.click('#generate-invoice-btn');

        // No recalculation warning means the browser's preview and the
        // server's recomputation agreed to the paisa.
        expect(await readAlert(page)).toContain('Invoice Saved Successfully');

        // Newest first — the invoice this journey just filed is [0].
        const saved = posServer.readLedger('sales')[0];
        expect(saved.customerName).toBe('E2E Walk-in');
        expect(saved.purity).toBe('22K');
        expect(saved.weightGrams).toBe(10);
        // The rate is the server's, resolved from rates.json — never the
        // number the browser sent.
        expect(saved.goldPricePerGram).toBe(6875);
        expect(saved.metalValue).toBe(68750);
        expect(saved.taxableAmount).toBe(75625);
        expect(saved.taxAmount).toBe(2268.75);
        expect(saved.totalAmount).toBe(77893.75);
        expect(saved.goldRateSource).toBe('auto');

        // Server clock, and a server-issued invoice number.
        expect(typeof saved.timestamp).toBe('number');
        expect(saved.timestamp).toBeGreaterThan(Date.now() - 120_000);
        expect(saved.id).toMatch(/^SEED-\d{6}-\d{2}$/);
    });

    test('applies a seeded advance and writes the redemption into the same ledger', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openBillingDesk(page);

        const customer = posServer.seeded.customers[0]; // Aarti: ₹40,000 in, ₹20,000 already redeemed
        await page.selectOption('#gold-purity', 'price22K');
        await page.fill('#gold-weight', '5');
        await page.fill('#customer-phone', customer.phone);
        await page.locator('#customer-phone').blur();

        // The desk looks the balance up through the admin API. The seeded
        // ledger leaves exactly ₹20,000 spendable on this account — the
        // ₹7,500 pending row on another customer must not appear here, and
        // Aarti's own earlier ₹20,000 redemption must already be deducted.
        const applyAdvance = page.locator('#apply-advance-btn');
        await expect(applyAdvance).toBeEnabled();
        await applyAdvance.click();
        await expect(page.locator('#sum-advance-amount')).toContainText('20,000');

        await page.click('#generate-invoice-btn');
        expect(await readAlert(page)).toMatch(/Invoice Saved Successfully|recalculated/);

        const saved = posServer.readLedger('sales')[0];
        expect(saved.appliedAdvance).toBe(20000);
        expect(saved.customerPhone).toBe(customer.phone);

        // The redemption row is the other half of the same transaction: an
        // invoice that consumed an advance but left no ledger entry would show
        // the customer a balance they no longer have.
        const advances = posServer.readLedger('advances');
        const redemption = advances.find(a => a.type === 'redeem' && a.invoiceId === saved.id);
        expect(redemption).toBeTruthy();
        expect(redemption.amount).toBe(20000);
        expect(redemption.customerPhone).toBe(customer.phone);
        // Cryptographically strong ledger id, not the old Math.random form.
        expect(redemption.id).toMatch(/^RED-[0-9A-F]{12}$/);
    });

    test('tells the cashier when the server repriced the invoice', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openBillingDesk(page);

        await page.selectOption('#gold-purity', 'price22K');
        await page.fill('#gold-weight', '4');

        // The rate moves after the desk drew its preview — an overnight sync,
        // or an override edited mid-shift. The cashier is holding a printed
        // slip quoting the old one.
        await page.evaluate(() => {
            window.billingDesk.goldRate.price22K = 1000;
            window.billingDesk.recalculate();
        });
        await expect(page.locator('#sum-metal-value')).toContainText('4,000');

        await page.click('#generate-invoice-btn');
        const message = await readAlert(page);

        // The invoice must be filed at the store's rate, and the desk must be
        // told to reprint rather than let the slip and the ledger diverge.
        expect(message).toContain('recalculated');
        expect(message).toContain('reprint');

        const saved = posServer.readLedger('sales')[0];
        expect(saved.goldPricePerGram).toBe(6875);
        expect(saved.metalValue).toBe(27500); // 4 × 6875, not 4 × 1000
    });

    test('refuses an advance larger than the customer’s real balance', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);

        // Posted from the page with the real session cookie the login just set
        // (the browser attaches it automatically) plus its CSRF header, so
        // this asserts the server's guard rather than the Billing Desk's
        // input validation — a tampered client is exactly the case the
        // server-side check exists for.
        const response = await page.evaluate(async () => {
            const csrf = document.cookie.match(/(?:^|; )gp_admin_csrf=([^;]*)/);
            const res = await fetch('/api/sales', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrf ? decodeURIComponent(csrf[1]) : ''
                },
                body: JSON.stringify({
                    purity: '22K',
                    weightGrams: 5,
                    makingChargeAmount: 0,
                    discountPercent: 0,
                    totalAmount: 1,
                    customerName: 'Overdraw Attempt',
                    customerPhone: '9000000001',
                    appliedAdvance: 999999
                })
            });
            return { status: res.status, body: await res.json() };
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('exceeds');

        /* A refused sale must file nothing at all.
         *
         * This used to assert that settings.json's `invoiceSeqStart` had not
         * moved. Phase 29 made `document_sequences` the allocator and left
         * `invoiceSeqStart` as nothing but its seed, so that assertion could
         * no longer fail — it passed whether or not the sale was refused. */
        expect(posServer.readLedger('sales').find(s => s.customerName === 'Overdraw Attempt'))
            .toBeUndefined();
    });

    test('refuses to file a sale against a partial customer number', async ({ page, posServer }) => {
        await loginAsAdmin(page, posServer);
        await openBillingDesk(page);

        await page.fill('#gold-weight', '5');
        await page.fill('#customer-name', 'Half A Number');
        await page.fill('#customer-phone', '98765');

        await page.click('#generate-invoice-btn');

        /* The desk stops this, not the server.
         *
         * POST /api/sales has always rejected a phone that is not ten digits,
         * but the desk sent it anyway and surfaced the refusal as a generic
         * "Failed to save invoice" with no indication of which field was
         * wrong. The cashier is now told on the field itself, before the
         * request goes anywhere. */
        await expect(page.locator('#phone-validation-error'))
            .toContainText('exactly 10 digits');
        await expect(page.locator('#custom-alert-box')).toBeHidden();
        await expect(page.locator('#customer-phone')).toBeFocused();

        // Nothing was filed.
        expect(posServer.readLedger('sales').find(s => s.customerName === 'Half A Number'))
            .toBeUndefined();

        // Completing the number clears the block and the sale files normally.
        await page.fill('#customer-phone', '9876543210');
        await page.click('#generate-invoice-btn');
        expect(await readAlert(page)).toContain('Invoice Saved Successfully');

        const saved = posServer.readLedger('sales')[0];
        expect(saved.customerPhone).toBe('9876543210');

        /* ...and it took the number the blocked attempt would have taken, which
           is what proves the refusal burned nothing. The allocator is
           `document_sequences` now, so this is the observable end of it. */
        expect(saved.id).toContain(String(posServer.seeded.nextInvoiceSeq).padStart(6, '0'));
    });

    test('a blank customer number still files as a cash sale', async ({ page, posServer }) => {
        // The 10-digit rule must not turn an optional field into a required
        // one — a walk-in who does not give a number is the common case.
        await loginAsAdmin(page, posServer);
        await openBillingDesk(page);

        await page.fill('#gold-weight', '5');
        await page.fill('#customer-name', 'No Number Given');
        await page.click('#generate-invoice-btn');

        expect(await readAlert(page)).toContain('Invoice Saved Successfully');
        expect(posServer.readLedger('sales')[0].customerPhone).toBe('');
    });
});
