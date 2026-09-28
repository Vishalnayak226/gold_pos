/**
 * ==========================================================================
 * Quotes & Holds tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces". No prior e2e spec ever opened this screen or exercised
 * the Billing Desk's HOLD/QUOTE buttons that feed it (BillingDesk.js's
 * saveDraft(), QuotesHoldsManager.js).
 *
 * Not covered here: a "permission-denied" state — /api/sale-drafts* is
 * `requireAdminSession` with no role restriction, same as Cash Shifts, and
 * the nav button carries no role-gating either.
 *
 * Discard uses the browser's native confirm() (never overridden to the
 * custom alert box, unlike alert() — a consistent choice across this app's
 * other destructive-action confirmations, not unique to this screen), so
 * this file is the first e2e spec to drive a real page.on('dialog') flow.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

async function openQuotesHoldsTab(page) {
    await page.click('button[data-target="quotes-holds-tab"]');
    await expect(page.locator('#quotes-holds-tab')).toHaveClass(/active/);
}

async function addOneLine(page, { purity = 'price22K', weight = '10', name = '', phone = '' } = {}) {
    await page.selectOption('#gold-purity', purity);
    await page.fill('#gold-weight', weight);
    if (name) await page.fill('#customer-name', name);
    if (phone) await page.fill('#customer-phone', phone);
}

test('empty state: no quotes or holds saved yet', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openQuotesHoldsTab(page);

    await expect(page.locator('#drafts-table-body')).toContainText('Nothing saved yet — use HOLD or QUOTE on the Billing Desk.');
});

test('HOLD with an empty cart is refused client-side, before any request is sent', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    await page.click('#save-hold-btn');
    const message = await readAlert(page);
    expect(message).toContain('Add at least one item');

    await openQuotesHoldsTab(page);
    await expect(page.locator('#drafts-table-body')).toContainText('Nothing saved yet');
});

test('saving a HOLD resets the Billing Desk cart and the hold appears under Quotes & Holds', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);
    await addOneLine(page, { purity: 'price22K', weight: '12', name: 'Hold Test Customer', phone: '9800055566' });

    await page.click('#save-hold-btn');
    const message = await readAlert(page);
    expect(message).toContain('Hold saved');

    // The form must have reset — the whole point of parking a cart is
    // freeing the counter for the next customer immediately.
    await expect(page.locator('#customer-name')).toHaveValue('');
    await expect(page.locator('#gold-weight')).toHaveValue('');

    await openQuotesHoldsTab(page);
    const row = page.locator('#drafts-table-body tr', { hasText: 'Hold Test Customer' });
    await expect(row).toContainText('Hold');
    await expect(row).toContainText('9800055566');
    await expect(row).toContainText('12.00 g');
});

test('saving a QUOTE is distinguished from a HOLD, and the kind filter narrows the list to each', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);
    await addOneLine(page, { weight: '5', name: 'Quote Test Customer', phone: '9800066677' });
    await page.click('#save-quote-btn');
    await (await readAlert(page));
    expect(await page.locator('#customer-name').inputValue()).toBe('');

    await openBillingDesk(page);
    await addOneLine(page, { weight: '7', name: 'Hold Filter Customer', phone: '9800077788' });
    await page.click('#save-hold-btn');
    await readAlert(page);

    await openQuotesHoldsTab(page);
    await expect(page.locator('#drafts-table-body')).toContainText('Quote Test Customer');
    await expect(page.locator('#drafts-table-body')).toContainText('Hold Filter Customer');

    await page.selectOption('#drafts-kind-filter', 'quote');
    await expect(page.locator('#drafts-table-body')).toContainText('Quote Test Customer');
    await expect(page.locator('#drafts-table-body')).not.toContainText('Hold Filter Customer');

    await page.selectOption('#drafts-kind-filter', 'hold');
    await expect(page.locator('#drafts-table-body')).toContainText('Hold Filter Customer');
    await expect(page.locator('#drafts-table-body')).not.toContainText('Quote Test Customer');
});

test('Resume loads the saved cart back into the Billing Desk and removes it from the open list', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);
    await addOneLine(page, { purity: 'price18K', weight: '15', name: 'Resume Test Customer', phone: '9800088899' });
    await page.click('#save-hold-btn');
    await readAlert(page);

    await openQuotesHoldsTab(page);
    const row = page.locator('#drafts-table-body tr', { hasText: 'Resume Test Customer' });
    await row.getByRole('button', { name: 'Resume' }).click();

    // Resuming navigates straight back to the Billing Desk with the cart
    // restored — the saved line lands in the banked #cart-list table (the
    // entry form's #gold-weight is only ever the NEXT line to add, not a
    // display of what a draft carried).
    await expect(page.locator('#sales-tab')).toHaveClass(/active/);
    await expect(page.locator('#customer-name')).toHaveValue('Resume Test Customer');
    await expect(page.locator('#customer-phone')).toHaveValue('9800088899');
    await expect(page.locator('#cart-list')).toContainText('15.000 g');
    await expect(page.locator('#cart-list')).toContainText('18K');

    await openQuotesHoldsTab(page);
    await expect(page.locator('#drafts-table-body')).not.toContainText('Resume Test Customer');
});

test('Discard asks for confirmation; declining keeps it, accepting removes it', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);
    await addOneLine(page, { weight: '3', name: 'Discard Test Customer', phone: '9800099900' });
    await page.click('#save-hold-btn');
    await readAlert(page);

    await openQuotesHoldsTab(page);
    const row = page.locator('#drafts-table-body tr', { hasText: 'Discard Test Customer' });

    page.once('dialog', dialog => dialog.dismiss());
    await row.getByRole('button', { name: 'Discard' }).click();
    // Declined — still there.
    await expect(page.locator('#drafts-table-body')).toContainText('Discard Test Customer');

    page.once('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#drafts-table-body')).not.toContainText('Discard Test Customer');
});

test('a saved hold survives a page reload', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);
    await addOneLine(page, { weight: '9', name: 'Reload Test Customer', phone: '9800011234' });
    await page.click('#save-hold-btn');
    await readAlert(page);

    await page.reload();
    await openQuotesHoldsTab(page);
    await expect(page.locator('#drafts-table-body')).toContainText('Reload Test Customer');
});
