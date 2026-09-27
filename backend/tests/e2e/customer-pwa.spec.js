/**
 * ==========================================================================
 * Customer portal PWA — installability and offline fallback.
 *
 * Static-asset/service-worker checks only: no login, no money paths. Verifies
 * the manifest is linked and valid, the service worker activates scoped to
 * customer.html only (never controlling the admin desk), and a genuinely
 * offline reload shows the cached fallback page instead of the browser's
 * own offline screen.
 * ==========================================================================
 */

import { test, expect } from './fixtures.js';

test.describe('Customer portal PWA', () => {
    test('links a valid manifest with the expected installability fields', async ({ page, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);

        const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
        expect(manifestHref).toBe('manifest.json');

        const res = await page.request.get(`${posServer.baseUrl}/manifest.json`);
        const manifest = await res.json();

        expect(manifest.name).toBe('Gold Savings Portal');
        expect(manifest.display).toBe('standalone');
        expect(manifest.scope).toBe('/customer.html');
        expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
        expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    });

    test('activates a service worker scoped to customer.html only', async ({ page, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);

        const registration = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready;
            return { scope: reg.scope, hasActive: !!reg.active };
        });

        expect(registration.hasActive).toBe(true);
        expect(registration.scope).toBe(`${posServer.baseUrl}/customer.html`);
    });

    test('does not let the customer-portal worker control the admin desk', async ({ page, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);
        await page.evaluate(() => navigator.serviceWorker.ready);

        // Same context/origin, different page — proves the scope pin, not
        // just fresh-context isolation.
        await page.goto(posServer.baseUrl);

        const manifestCount = await page.locator('link[rel="manifest"]').count();
        const controller = await page.evaluate(() => navigator.serviceWorker.controller);

        expect(manifestCount).toBe(0);
        expect(controller).toBeNull();
    });

    test('shows the cached offline page when the network drops mid-session', async ({ page, context, posServer }) => {
        await page.goto(`${posServer.baseUrl}/customer.html`);
        // Let the service worker install and activate (and precache
        // offline.html) before pulling the network out from under it.
        await page.evaluate(() => navigator.serviceWorker.ready);

        await context.setOffline(true);
        await page.reload();

        await expect(page.locator('h1')).toContainText("You're offline");

        await context.setOffline(false);
    });
});
