/**
 * ==========================================================================
 * Cash Shifts tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces". No prior e2e spec ever opened this screen at all;
 * coverage was service/route-level only (CashShiftManager.js, server.js's
 * /api/cash-shifts/* routes, services/reconciliationService.js).
 *
 * Not covered here: a "permission-denied" state. Every /api/cash-shifts/*
 * route is `requireAdminSession` with no role restriction — any cashier,
 * manager or owner can open/close a shift — and the nav button carries no
 * role-based hide/disable, unlike Management Reports or Settings. There is
 * genuinely no denied state for this module to exercise.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openCashShiftsTab(page) {
    await page.click('button[data-target="cash-shifts-tab"]');
    await expect(page.locator('#cash-shifts-tab')).toHaveClass(/active/);
}

test('empty state: no shift open shows the opening form, and history is empty', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCashShiftsTab(page);

    await expect(page.locator('#shift-current-panel')).toContainText('No shift is open');
    await expect(page.locator('#open-shift-btn')).toBeVisible();
    await expect(page.locator('#shift-history-body')).toContainText('No shifts recorded yet.');
});

test('opening with no float entered is refused client-side, before any request is sent', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCashShiftsTab(page);

    // Deliberately leave #open-float blank — parseFloat('') is NaN, which
    // must fail the `openingFloat >= 0` guard the same way a negative value
    // would (the number input's own min="0" already blocks a typed negative
    // at the browser level, so blank is the reachable way to hit this path).
    await page.click('#open-shift-btn');

    await expect(page.locator('#open-shift-status')).toHaveText('Enter a valid opening float.');
    // Refused before reaching the server: the form is still the "open" form,
    // not a shift-in-progress panel.
    await expect(page.locator('#shift-current-panel')).toContainText('No shift is open');
});

test('opening a shift shows the live expected-cash breakdown, and it survives a reload', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCashShiftsTab(page);

    await page.fill('#open-float', '2000');
    await page.fill('#open-note', 'Morning float — e2e drill');
    await page.click('#open-shift-btn');

    await expect(page.locator('#shift-current-panel')).toContainText('Shift open since');
    await expect(page.locator('#shift-current-panel')).toContainText('Morning float — e2e drill');
    // Fresh shift, no sales/deposits/refunds yet: expected must equal the float exactly.
    const table = page.locator('#shift-current-panel table');
    await expect(table).toContainText('₹2000.00');
    await expect(page.locator('#close-counted')).toBeVisible();

    // Reload proves this is server-persisted state, not in-memory JS state —
    // the whole point of the "reload" coverage this module was missing.
    await page.reload();
    await openCashShiftsTab(page);
    await expect(page.locator('#shift-current-panel')).toContainText('Shift open since');
    await expect(page.locator('#close-counted')).toBeVisible();
});

test('closing with no counted amount entered is refused client-side', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCashShiftsTab(page);

    await page.fill('#open-float', '1000');
    await page.click('#open-shift-btn');
    await expect(page.locator('#close-shift-btn')).toBeVisible();

    await page.click('#close-shift-btn');
    await expect(page.locator('#close-shift-status')).toHaveText('Enter what was actually counted.');
    // Still open — a failed client-side validation must not have posted anything.
    await expect(page.locator('#shift-current-panel')).toContainText('Shift open since');
});

test('closing a shift reports the variance and moves it into shift history', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCashShiftsTab(page);

    await page.fill('#open-float', '3000');
    await page.click('#open-shift-btn');
    await expect(page.locator('#close-shift-btn')).toBeVisible();

    // No cash sales were rung up this shift, so expected == float == 3000;
    // counting 2950 must show a −50 variance, an easy-to-verify exact figure.
    await page.fill('#close-counted', '2950');
    await page.fill('#close-note', 'Short by fifty — e2e drill');
    await page.click('#close-shift-btn');

    const message = await readAlert(page);
    expect(message).toContain('Shift closed');
    expect(message).toContain('Variance: ₹-50.00');

    // Back to the empty "no shift open" state, and the closed shift appears
    // in history with its frozen figures.
    await expect(page.locator('#shift-current-panel')).toContainText('No shift is open');
    const row = page.locator('#shift-history-body tr').first();
    await expect(row).toContainText('₹3000.00'); // float
    await expect(row).toContainText('₹2950.00'); // counted
    await expect(row).toContainText('₹-50.00'); // variance
    await expect(row).toContainText('Short by fifty — e2e drill');
});

test('a second terminal trying to open a shift after the first already has is refused with a clear message', async ({ page, posServer, context }) => {
    // Simulates two counters sharing one branch — a real, reachable race this
    // screen's own UI cannot otherwise exercise (once a shift is open, the
    // "open" form is no longer rendered on the page that opened it).
    await loginAsAdmin(page, posServer);
    await openCashShiftsTab(page);

    const secondPage = await context.newPage();
    await loginAsAdmin(secondPage, posServer);
    await openCashShiftsTab(secondPage);
    // Both terminals see the empty state before either has acted.
    await expect(secondPage.locator('#open-shift-btn')).toBeVisible();

    await page.fill('#open-float', '1500');
    await page.click('#open-shift-btn');
    await expect(page.locator('#shift-current-panel')).toContainText('Shift open since');

    // The second terminal still has its stale "open" form on screen — submit
    // it anyway, exactly as an unlucky double-click at two counters would.
    await secondPage.fill('#open-float', '500');
    await secondPage.click('#open-shift-btn');
    await expect(secondPage.locator('#open-shift-status')).toContainText('already open');

    await secondPage.close();
});
