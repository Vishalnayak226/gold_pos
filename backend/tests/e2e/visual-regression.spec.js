/**
 * ==========================================================================
 * Visual regression baselines — TESTING_CHECKLIST.md §25b item 3.
 *
 * Screenshot comparisons for the six screens that checklist item names: lock
 * screen, billing-desk print preview, return-desk credit note, the
 * warning/confirmation overlay, Settings, and the customer portal.
 *
 * Baseline PNGs are committed to the repo (Playwright's default
 * `*-snapshots/` layout next to this file) — that IS the review workflow: a
 * pixel change shows up as a diff in the PR, not as a silent drift. Update a
 * baseline deliberately with `npm run test:e2e:update-snapshots` after
 * visually confirming the new look is correct, never as a reflex to turn a
 * red run green.
 *
 * Desktop screens are asserted at 100/125/200% zoom via the CSS `zoom`
 * property — non-standard CSS, but supported by Chromium, which is all this
 * project's Playwright config drives (desktop-chromium/mobile-chromium).
 * The admin desk (`index.html`) has no responsive breakpoints at all (see
 * `frontend/css/app.css`) — it is desktop-only by design, per the "counter
 * runs on a desktop" reasoning already in `playwright.config.js` — so those
 * five screens are exercised across zoom, not viewport width. The customer
 * portal is the opposite: phone-first, so it is exercised at the smallest
 * supported phone size (390×844, the exact figure CLAUDE.md and
 * customer-portal.spec.js already name) via an explicit viewport override,
 * rather than the `mobile-chromium` project's 412px Pixel 7 preset which is
 * a stand-in for "a phone", not the smallest one. It also gets one desktop
 * capture, since the admin sidebar's "Open Customer Login" link opens it on
 * a desktop browser too.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, loginAsCustomer, readAlert } from './fixtures.js';

const ZOOM_LEVELS = [1, 1.25, 2];
const SMALLEST_PHONE = { width: 390, height: 844 };

async function setZoom(page, zoom) {
    await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, zoom);
}

/** Google Fonts ('Outfit') can still be swapping in when a screenshot fires,
 *  which is the other half (with playwright.config.js's maxDiffPixelRatio)
 *  of keeping these baselines from flaking on glyph-edge antialiasing. */
async function waitForFonts(page) {
    await page.evaluate(() => document.fonts.ready);
}

async function openBillingDesk(page) {
    await page.click('button[data-target="sales-tab"]');
    await expect(page.locator('#sales-tab')).toHaveAttribute('data-desk-ready', 'true');
}

async function openReturnDesk(page) {
    await page.click('button[data-target="returns-tab"]');
    await expect(page.locator('#returns-tab')).toHaveClass(/active/);
}

async function openSettingsProfile(page) {
    await page.click('button[data-target="settings-tab"]');
    await page.click('button.settings-subnav-btn[data-section="profile"]');
    await expect(page.locator('#set-company-name')).toBeVisible();
}

function acceptConfirmations(page) {
    page.on('dialog', dialog => dialog.accept());
}

/** Bills one plain sale and returns the record as it was persisted. */
async function fileASale(page, posServer, { weight = '10', name = 'Visual Regression Subject', phone = null } = {}) {
    await openBillingDesk(page);
    await page.selectOption('#gold-purity', 'price22K');
    await page.fill('#gold-weight', weight);
    await page.fill('#customer-name', name);
    if (phone) await page.fill('#customer-phone', phone);
    await page.click('#generate-invoice-btn');
    expect(await readAlert(page)).toContain('Invoice Saved Successfully');
    return posServer.readLedger('sales')[0];
}

test.describe('Visual regression — admin desk, desktop zoom levels', () => {
    for (const zoom of ZOOM_LEVELS) {
        const pct = Math.round(zoom * 100);

        test(`lock screen at ${pct}% zoom`, async ({ page, posServer }) => {
            await page.goto(posServer.baseUrl);
            await expect(page.locator('#admin-login-view')).toBeVisible();
            await setZoom(page, zoom);
            await waitForFonts(page);
            await expect(page).toHaveScreenshot(`lock-screen-${pct}pct.png`);
        });

        test(`billing desk print preview at ${pct}% zoom`, async ({ page, posServer }) => {
            await loginAsAdmin(page, posServer);
            await openBillingDesk(page);
            await page.selectOption('#gold-purity', 'price22K');
            await page.fill('#gold-weight', '10');
            const sheet = page.locator('#sales-tab .invoice-sheet');
            await expect(sheet).toBeVisible();
            await setZoom(page, zoom);
            await waitForFonts(page);
            await expect(sheet).toHaveScreenshot(`billing-print-preview-${pct}pct.png`);
        });

        test(`return desk credit note at ${pct}% zoom`, async ({ page, posServer }) => {
            acceptConfirmations(page);
            await loginAsAdmin(page, posServer);
            const filed = await fileASale(page, posServer);

            await openReturnDesk(page);
            await page.fill('#return-q', filed.id);
            await page.click('#return-search-btn');
            await page.locator('#return-results tbody tr').getByRole('button', { name: 'Return' }).click();
            await page.fill('#return-note', 'Visual regression baseline');
            await page.click('#return-file-btn');

            const note = page.locator('#return-note-container .invoice-sheet');
            await expect(note).toBeVisible();
            // The footer's "Issued <timestamp>" line is wall-clock time, not
            // fixture data — overwrite it with a fixed string so this baseline
            // isn't inherently flaky. (Playwright's `mask` option was tried
            // first but left the real text in place at 125%/200% zoom —
            // rewriting the DOM directly is simpler and zoom-independent.)
            await note.locator('p', { hasText: 'Issued' }).evaluate(el => {
                el.textContent = el.textContent.replace(/Issued .*/, 'Issued [fixed for baseline].');
            });
            await setZoom(page, zoom);
            await waitForFonts(page);
            await expect(note).toHaveScreenshot(`return-credit-note-${pct}pct.png`);
        });

        test(`warning/confirmation overlay at ${pct}% zoom`, async ({ page, posServer }) => {
            await loginAsAdmin(page, posServer);
            await openBillingDesk(page);
            // Empty cart, no weight entered — the client-side refusal alert,
            // the error-styled sibling of the success overlay every other
            // screenshot in this file would otherwise only ever show.
            await page.click('#generate-invoice-btn');
            const box = page.locator('#custom-alert-box');
            await expect(box).toBeVisible();
            await setZoom(page, zoom);
            await waitForFonts(page);
            await expect(box).toHaveScreenshot(`warning-overlay-${pct}pct.png`);
        });

        test(`settings — store profile at ${pct}% zoom`, async ({ page, posServer }) => {
            await loginAsAdmin(page, posServer);
            await openSettingsProfile(page);
            await setZoom(page, zoom);
            await waitForFonts(page);
            await expect(page.locator('#settings-tab')).toHaveScreenshot(`settings-profile-${pct}pct.png`);
        });
    }

    test('customer portal (desktop) — sign-in screen', async ({ page, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await expect(page.locator('#auth-view')).toBeVisible();
        await waitForFonts(page);
        await expect(page).toHaveScreenshot('customer-portal-signin-desktop.png');
    });
});

test.describe('Visual regression — customer portal, smallest supported phone (390×844)', () => {
    test.use({ viewport: SMALLEST_PHONE });

    test('sign-in screen', async ({ page, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await expect(page.locator('#auth-view')).toBeVisible();
        await waitForFonts(page);
        await expect(page).toHaveScreenshot('customer-portal-signin-390.png');
    });

    test('signed-in dashboard', async ({ page, posServer }) => {
        await loginAsCustomer(page, posServer, 1);
        await expect(page.locator('#portal-view')).toBeVisible();
        await waitForFonts(page);
        await expect(page).toHaveScreenshot('customer-portal-dashboard-390.png');
    });
});
