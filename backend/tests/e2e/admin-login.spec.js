/**
 * ==========================================================================
 * Admin Login & Session — TESTING_CHECKLIST.md Module 1.
 *
 * The HTTP-level auth boundary (wrong PIN refused, lockout after 5 failures,
 * lockout also blocks the correct PIN, logout invalidates the session) is
 * already proven in backend/test_routes.js Groups 2/8/9 and the lockout
 * escalation curve itself in backend/test_suite.js Test 6. None of that
 * proves the FORM works — CLAUDE.md §8: "a green npm test is not proof a
 * form still works." This spec drives the real lock-screen PIN pad in a
 * real browser against a real server, closing that gap for Module 1.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin } from './fixtures.js';

test('a wrong PIN is refused with an inline error and the terminal stays locked', async ({ page, posServer }) => {
    await page.goto(posServer.baseUrl);
    await page.fill('#admin-pin-input', '0000');
    await page.click('#admin-login-btn');

    await expect(page.locator('#admin-login-error')).toContainText('Incorrect PIN');
    await expect(page.locator('#app-viewport')).toBeHidden();
    await expect(page.locator('#admin-login-view')).toBeVisible();
});

test('the correct PIN unlocks into the Dashboard with the sidebar visible', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await expect(page.locator('#app-viewport')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('.nav-btn[data-target="dashboard-tab"]')).toBeVisible();
    // The credential must not linger in the DOM of an unlocked terminal.
    await expect(page.locator('#admin-pin-input')).toHaveValue('');
});

test('repeated wrong PINs lock out further attempts, including the correct PIN', async ({ page, posServer }) => {
    await page.goto(posServer.baseUrl);

    // MAX_FAILED_ATTEMPTS is 5 (adminAuth.js) — loop a couple past that so a
    // future threshold change does not make this test flaky either way.
    let lockedOut = false;
    for (let i = 0; i < 8 && !lockedOut; i++) {
        await page.fill('#admin-pin-input', '9999');
        await page.click('#admin-login-btn');
        const message = await page.locator('#admin-login-error').innerText();
        lockedOut = message.includes('Too many failed PIN attempts');
    }
    expect(lockedOut, 'the lock screen never reported a lockout after 8 wrong PINs').toBe(true);
    await expect(page.locator('#app-viewport')).toBeHidden();

    // The lockout is per source, not per PIN — the CORRECT PIN must be
    // blocked too while it is in effect (test_routes.js proves this at the
    // HTTP level; this proves the lock screen surfaces it the same way).
    await page.fill('#admin-pin-input', posServer.seeded.adminPin);
    await page.click('#admin-login-btn');
    await expect(page.locator('#admin-login-error')).toContainText('Too many failed PIN attempts');
    await expect(page.locator('#app-viewport')).toBeHidden();
});

test('logout returns to the lock screen and a reload does not auto-relogin', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await expect(page.locator('#app-viewport')).toBeVisible();

    await page.click('#admin-logout-btn');
    await expect(page.locator('#admin-login-view')).toBeVisible();
    await expect(page.locator('#app-viewport')).toBeHidden();

    await page.reload();
    await expect(page.locator('#admin-login-view')).toBeVisible();
    await expect(page.locator('#app-viewport')).toBeHidden();
});

test('an authenticated session survives a page reload', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await expect(page.locator('#app-viewport')).toBeVisible();

    await page.reload();
    // No re-prompt: sessionStorage's flag plus the still-valid session cookie
    // together skip straight back to the unlocked dashboard.
    await expect(page.locator('#app-viewport')).toBeVisible();
    await expect(page.locator('#admin-login-view')).toBeHidden();
});
