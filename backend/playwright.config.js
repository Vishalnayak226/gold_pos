/**
 * ==========================================================================
 * Playwright configuration — cashier and customer end-to-end journeys.
 *
 * These are NOT part of `npm test`. The four Node suites there run on a bare
 * checkout with zero installed packages, which is the property that keeps this
 * project's "no build step" posture honest; Playwright needs a browser binary
 * and cannot preserve it. Run them deliberately:
 *
 *     cd backend
 *     npm install                    # brings in @playwright/test
 *     npx playwright install chromium
 *     npm run test:e2e
 *
 * Each spec boots its own server against its own seeded, throwaway database
 * (see tests/e2e/fixtures.js), so nothing here ever touches backend/data/ or
 * collides with a dev server on :5000.
 *
 * The specs live under backend/ with every other suite, rather than at the
 * repo root: backend/package.json is already the ESM marker and already owns
 * node_modules, so a root-level tests/ directory would have needed a second
 * package.json of its own just to be loadable.
 * ==========================================================================
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    // Money journeys are sequential by nature — a sale consumes an invoice
    // number and an advance redemption changes a balance. Running them in
    // parallel against one server would make assertions order-dependent.
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
    timeout: 60_000,
    expect: { timeout: 10_000 },
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off'
    },
    projects: [
        {
            name: 'desktop-chromium',
            use: { ...devices['Desktop Chrome'] }
        },
        {
            // The counter runs on a desktop; customers are overwhelmingly on a
            // phone. The roadmap's exit criterion names both viewports, so the
            // customer portal journey is asserted at 390px too.
            name: 'mobile-chromium',
            use: { ...devices['Pixel 7'] },
            testMatch: /customer-portal\.spec\.js/
        }
    ]
});
