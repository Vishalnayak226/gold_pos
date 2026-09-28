/**
 * ==========================================================================
 * Dashboard tab — TESTING_CHECKLIST.md Module 2.
 *
 * Dashboard.js's own docstring explains why this screen no longer downloads
 * the ledger: stat tiles come from the server's own `totals`/`summary`
 * aggregates and the two lists ask for exactly the rows they draw, rather
 * than summing a page of rows client-side. Nothing here proves that
 * arithmetic (billing/advance suites already do) — this proves the tiles,
 * lists and Refresh control actually reflect real data filed through the
 * app, in a real browser.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin } from './fixtures.js';

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

/** Posts an advance deposit with the real session cookie + CSRF header, the
    same pattern cashier-billing.spec.js uses — Module 4's own deposit UI is
    covered separately, so this test only needs the ledger to have a row. */
async function postAdvanceDeposit(page, { customerPhone, customerName, amount }) {
    return page.evaluate(async ({ customerPhone, customerName, amount }) => {
        const csrf = document.cookie.match(/(?:^|; )gp_admin_csrf=([^;]*)/);
        const res = await fetch('/api/advances', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ? decodeURIComponent(csrf[1]) : '' },
            body: JSON.stringify({ customerPhone, customerName, amount, paymentMethod: 'UPI', referenceId: 'DASH-E2E-' + Date.now() })
        });
        return res.status;
    }, { customerPhone, customerName, amount });
}

test('stat tiles and recent lists reflect data filed through the app, after Refresh', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openBillingDesk(page);

    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', '3');
    await page.fill('#customer-name', 'Dashboard E2E Buyer');
    await page.click('#generate-invoice-btn');
    await expect(page.locator('#custom-alert-box')).toBeVisible();
    await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

    const depositStatus = await postAdvanceDeposit(page, {
        customerPhone: '9812340099', customerName: 'Dashboard E2E Depositor', amount: 750
    });
    expect(depositStatus).toBe(200);

    await page.click('button[data-target="dashboard-tab"]');
    await page.click('#dashboard-refresh-btn');
    await expect(page.locator('#dashboard-refresh-btn')).toHaveText('Refresh', { timeout: 5000 });

    // Today's revenue must reflect the sale just filed — not the ₹0.00/0
    // invoices state that is only correct on a truly empty day.
    await expect(page.locator('#stat-today-revenue')).not.toHaveText('₹0.00');
    await expect(page.locator('#stat-today-count')).not.toHaveText('0 invoices');
    await expect(page.locator('#stat-outstanding-advances')).not.toHaveText('₹0.00');

    await expect(page.locator('#recent-transactions-list')).toContainText('Dashboard E2E Buyer');
    await expect(page.locator('#recent-advances-list')).toContainText('Dashboard E2E Depositor');
    await expect(page.locator('#recent-advances-list')).toContainText('₹750');
});

test('the Refresh button shows a loading state, then updates the timestamp', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    // Dashboard is the default landing tab after login — no tab click needed.
    // Slow one of its four parallel fetches so the loading state is
    // observable in this test rather than racing past it on a fast local
    // server.
    await page.route('**/api/gold-price', async route => {
        await new Promise(r => setTimeout(r, 400));
        await route.continue();
    });

    const refreshBtn = page.locator('#dashboard-refresh-btn');
    await refreshBtn.click();
    await expect(refreshBtn).toHaveText('Loading...');
    await expect(refreshBtn).toBeDisabled();

    await expect(refreshBtn).toHaveText('Refresh', { timeout: 5000 });
    await expect(refreshBtn).toBeEnabled();
    await expect(page.locator('#dashboard-updated-at')).toContainText('Updated');
});

test('the recent lists show their empty state before any data exists for a brand-new session', async ({ page, posServer }) => {
    // The seeded fixture already carries historical demo data, so this
    // exercises the SAME rendering branch (`renderRecentTransactions`/
    // `renderRecentAdvances`'s `.length === 0` path) by requesting a
    // narrow-enough recency window is not an option — the API has no such
    // filter — so this instead confirms the empty-state markup exists and is
    // reachable by checking it is what a truly empty list renders, driven
    // directly against the component rather than requiring a second empty
    // database just for this one string.
    await loginAsAdmin(page, posServer);
    await page.evaluate(() => window.dashboard.renderRecentTransactions([]));
    await expect(page.locator('#recent-transactions-list')).toContainText('No transactions yet.');
    await page.evaluate(() => window.dashboard.renderRecentAdvances([]));
    await expect(page.locator('#recent-advances-list')).toContainText('No advance deposits yet.');
});
