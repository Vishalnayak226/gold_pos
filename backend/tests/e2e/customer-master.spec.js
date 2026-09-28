/**
 * ==========================================================================
 * Customer Master tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces". No prior e2e spec ever opened this screen.
 *
 * Real bug found and fixed while building this spec (see CustomerAccountsManager.js):
 * GET /api/customer-accounts is `requireRole('owner','manager')` server-side,
 * but the "Customers" nav button carries no role-gating, and refresh()
 * silently turned ANY non-ok response — a 403 included — into an empty
 * array. A cashier opening this tab saw a plausible-looking "No customer on
 * record yet" with no indication they lacked permission, indistinguishable
 * from a genuinely new install. Fixed to name the real reason; this file's
 * "cashier cannot see the customer master" test below asserts the fix.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openCustomerMasterTab(page) {
    await page.click('button[data-target="customer-accounts-tab"]');
    await expect(page.locator('#customer-accounts-tab')).toHaveClass(/active/);
}

/** Adds a cashier operator via the same authenticated session (skips the
 * Settings screen's own operator-management UI, which is out of scope for
 * this file and covered separately), then signs out the owner and signs
 * back in as that cashier. */
async function switchToCashier(page, pin) {
    await page.evaluate(async (pin) => {
        const csrf = decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('gp_admin_csrf='))?.split('=')[1] || '');
        const res = await fetch('/api/settings', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify({ operators: [{ name: 'E2E Cashier', role: 'cashier', pin, active: true }] })
        });
        if (!res.ok) throw new Error(`Failed to seed cashier operator: HTTP ${res.status}`);
    }, pin);

    await page.click('#admin-logout-btn');
    await expect(page.locator('#admin-pin-input')).toBeVisible();
    await page.fill('#admin-pin-input', pin);
    await page.click('#admin-login-btn');
    await expect(page.locator('#app-viewport')).toBeVisible();
}

test('a cashier cannot see the customer master and gets a real explanation, not a false empty state', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await switchToCashier(page, '135791');
    await openCustomerMasterTab(page);

    const message = await page.locator('#accounts-table-body').innerText();
    expect(message).toContain('do not have permission');
    expect(message).not.toContain('No customer on record yet');
});

test('issuing a login for a fresh phone number requires a valid 10-digit number', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCustomerMasterTab(page);

    await page.click('#accounts-issue-btn');
    await page.fill('#issue-phone', '12345');
    await page.click('#submit-issue-btn');

    const message = await readAlert(page);
    expect(message).toContain('valid 10-digit mobile number');
});

test('issuing a login shows the one-time temporary password and the account appears as "Temp password"', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCustomerMasterTab(page);

    await page.click('#accounts-issue-btn');
    await page.fill('#issue-phone', '9800012345');
    await page.fill('#issue-name', 'Freshly Issued Customer');
    await page.click('#submit-issue-btn');

    const result = page.locator('#issue-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Login created');
    // The temp password is a real value, not a placeholder — assert its shape
    // rather than its exact text, since it is generated fresh each run.
    const passwordText = await result.locator('p', { hasText: /^\S{6,}$/ }).last().innerText().catch(() => '');
    expect(passwordText.trim().length).toBeGreaterThan(0);

    const row = page.locator('#accounts-table-body tr', { hasText: 'Freshly Issued Customer' });
    await expect(row).toContainText('Temp password');
    await expect(row).toContainText('9800012345');
});

test('resetting an existing login asks for confirmation, signs the customer out, and issues a new password', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCustomerMasterTab(page);
    await page.fill('#accounts-search', posServer.seeded.customers[0].phone);
    const row = page.locator('#accounts-table-body tr', { hasText: posServer.seeded.customers[0].phone });
    await expect(row).toBeVisible();

    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('signs that customer out of every device');
        dialog.accept();
    });
    await row.getByRole('button', { name: 'Reset password' }).click();

    const result = page.locator('#issue-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Password reset');
});

test('correcting a customer record validates the required fields and saves a real edit', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCustomerMasterTab(page);
    await page.fill('#accounts-search', posServer.seeded.customers[1].phone);
    const row = page.locator('#accounts-table-body tr', { hasText: posServer.seeded.customers[1].phone });
    await row.getByRole('button', { name: 'Correct' }).click();

    await expect(page.locator('#edit-customer-form')).toBeVisible();
    await page.fill('#edit-name', '');
    await page.click('#submit-edit-btn');
    await expect(page.locator('#edit-form-status')).toHaveText('Name is required.');

    await page.fill('#edit-name', 'Corrected Customer Name');
    await page.click('#submit-edit-btn');
    await expect(page.locator('#edit-customer-form')).toBeHidden();

    await page.fill('#accounts-search', posServer.seeded.customers[1].phone);
    await expect(page.locator('#accounts-table-body')).toContainText('Corrected Customer Name');
});

test('an owner can anonymise a customer; the record is scrubbed and further edits are blocked', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openCustomerMasterTab(page);
    await page.fill('#accounts-search', posServer.seeded.customers[2].phone);
    const row = page.locator('#accounts-table-body tr', { hasText: posServer.seeded.customers[2].phone });
    await expect(row.getByRole('button', { name: 'Anonymise' })).toBeVisible();

    page.once('dialog', dialog => {
        expect(dialog.message()).toContain('cannot be undone');
        dialog.accept();
    });
    await row.getByRole('button', { name: 'Anonymise' }).click();

    await page.fill('#accounts-search', posServer.seeded.customers[2].phone);
    const anonRow = page.locator('#accounts-table-body tr', { hasText: 'Anonymised Customer' });
    await expect(anonRow).toBeVisible();
    await expect(anonRow).toContainText('Anonymised');
    await expect(anonRow).not.toContainText('Correct');
});
