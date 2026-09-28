/**
 * ==========================================================================
 * Diagnostics tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces". No prior e2e spec ever opened this screen. Unlike every
 * other module in this batch, Diagnostics has no dedicated manager class —
 * its three action buttons (Level 1 telemetry, Level 2 encrypted export,
 * black-box export) are wired directly in app.js, with results appended as
 * plain lines to a <pre> console (#log-output) rather than rendered into a
 * table.
 *
 * Real bug found and fixed first (see app.js): all three buttons' failure
 * branch was `logTelemetry('... failed: ' + res.status)` — a cashier or
 * manager denied by the owner-only `requireRole('owner')` gate on every
 * /api/diagnostics/* route saw a bare "failed: 403" with no indication of
 * what that meant or what to do about it. Fixed to name the real reason for
 * the 403 case specifically, leaving other status codes as-is (a genuine
 * unexpected failure is exactly where the raw code remains useful).
 *
 * Also noted, not fixed (out of this unit's scope — a dead-code cleanup, not
 * a defect this test coverage effort should quietly patch): app.js still
 * wires a `#toggle-debug-btn` click handler, but no element with that id
 * exists anywhere in index.html — the code's own `if (toggleBtn && drawer)`
 * guard already makes this a silent no-op, not a broken feature.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin } from './fixtures.js';

async function openDiagnosticsTab(page) {
    await page.click('button[data-target="diagnostics-tab"]');
    await expect(page.locator('#diagnostics-tab')).toHaveClass(/active/);
}

async function switchToRole(page, name, role, pin) {
    await page.evaluate(async ({ name, role, pin }) => {
        const csrf = decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('gp_admin_csrf='))?.split('=')[1] || '');
        const res = await fetch('/api/settings', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify({ operators: [{ name, role, pin, active: true }] })
        });
        if (!res.ok) throw new Error(`Failed to seed ${role} operator: HTTP ${res.status}`);
    }, { name, role, pin });

    await page.click('#admin-logout-btn');
    await expect(page.locator('#admin-pin-input')).toBeVisible();
    await page.fill('#admin-pin-input', pin);
    await page.click('#admin-login-btn');
    await expect(page.locator('#app-viewport')).toBeVisible();
}

test('a manager (not just a cashier) is told plainly this needs the owner account — not a bare status code', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await switchToRole(page, 'E2E Manager', 'manager', '975312');
    await openDiagnosticsTab(page);

    await page.click('#pull-technical-logs');
    const log = page.locator('#log-output');
    await expect(log).toContainText('this needs the owner account');
    await expect(log).not.toContainText('failed: 403');
});

test('the owner can pull Level 1 telemetry and see real metrics, not a placeholder', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openDiagnosticsTab(page);

    await page.click('#pull-technical-logs');
    await expect(page.locator('#log-output')).toContainText(/Level 1 OK: uptime \d+s, heap \d+MB/);
});

test('the owner can request the Level 2 encrypted export envelope', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openDiagnosticsTab(page);

    await page.click('#pull-emergency-logs');
    await expect(page.locator('#log-output')).toContainText('Level 2 export ready');
    await expect(page.locator('#log-output')).toContainText('encrypted client-side-unreadable');
});

test('the owner can request the black-box flight-recorder export', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openDiagnosticsTab(page);

    await page.click('#pull-blackbox-export');
    await expect(page.locator('#log-output')).toContainText('Black-box export ready');
    await expect(page.locator('#log-output')).toContainText('Decryptable only offline by the platform owner');
});

test('each pull appends to the console rather than replacing it, so a session of several pulls stays readable', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openDiagnosticsTab(page);

    await page.click('#pull-technical-logs');
    await expect(page.locator('#log-output')).toContainText('Level 1 OK');
    await page.click('#pull-emergency-logs');

    const log = page.locator('#log-output');
    await expect(log).toContainText('Level 1 OK');
    await expect(log).toContainText('Level 2 export ready');
    await expect(log).toContainText('System initialized. Awaiting queries...');
});
