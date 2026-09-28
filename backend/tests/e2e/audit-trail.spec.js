/**
 * ==========================================================================
 * Audit Trail tab (admin) — TESTING_CHECKLIST.md §25b "underrepresented
 * admin surfaces". No prior e2e spec ever opened this screen.
 *
 * Two real bugs found and fixed first (see AuditTrail.js):
 *
 * 1. GET /api/audit is gated by requireApprover, a middleware written for
 *    deposit approval — its 403 body reads "Approving a deposit needs a
 *    manager or the owner...". AuditTrail.js used that server message
 *    verbatim when present, so a cashier trying to VIEW the audit trail was
 *    told they were trying to APPROVE A DEPOSIT, which they were not.
 *    Unlike the false-empty-state bugs found in Customer Master, this
 *    screen already correctly distinguished "denied" from "empty" (its own
 *    header comment even says so) — the defect was purely in which message
 *    won. Fixed to always use the screen's own accurately-worded message.
 *
 * 2. The entity-type filter's "Advances" and "Payments" options carried
 *    `value="advance"`/`value="payment"`, but every service in this tree
 *    records those events with entity_type `advance_entry`/`payment_order`
 *    (auditRepository.search() does an exact `entity_type = @entityType`
 *    match — no prefix/LIKE). Selecting either option therefore always
 *    returned zero rows, silently, for as long as this dropdown has
 *    existed — nothing had ever exercised it via a real browser before this
 *    spec. Fixed the two option values to the real stored strings.
 * ==========================================================================
 */

import { test, expect, loginAsAdmin, readAlert } from './fixtures.js';

async function openAuditTab(page) {
    await page.click('button[data-target="audit-tab"]');
    await expect(page.locator('#audit-tab')).toHaveClass(/active/);
}

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

test('a cashier is told plainly they lack permission to view the audit trail — not that they were approving a deposit', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await switchToCashier(page, '135791');
    await openAuditTab(page);

    const message = await page.locator('#audit-table-body').innerText();
    expect(message).toContain('Viewing the audit trail needs a manager or the owner');
    expect(message).not.toContain('Approving a deposit');
});

test('a filter that matches nothing says so, distinct from a genuinely empty trail', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);
    await openAuditTab(page);

    await page.fill('#audit-search', 'no-such-action-zzz-nonsense');
    await expect(page.locator('#audit-table-body')).toContainText('No event matches that filter.');
});

test('opening and closing a cash shift shows up in the trail with the right actor, action and variance', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await page.click('button[data-target="cash-shifts-tab"]');
    await page.fill('#open-float', '2000');
    await page.click('#open-shift-btn');
    await expect(page.locator('#close-shift-btn')).toBeVisible();
    await page.fill('#close-counted', '1980');
    await page.click('#close-shift-btn');
    await readAlert(page);

    await openAuditTab(page);
    await page.fill('#audit-search', 'shift');
    const rows = page.locator('#audit-table-body tr');
    const openedRow = rows.filter({ hasText: /shift opened/i });
    const closedRow = rows.filter({ hasText: /shift closed/i });
    await expect(openedRow).toHaveCount(1);
    await expect(closedRow).toHaveCount(1);
    await expect(closedRow).toContainText('Store Owner');
    await expect(closedRow).toContainText('-20');
});

test('the entity-type filter narrows to Advances after a deposit — real bug: this dropdown\'s "Advances"/"Payments" options carried values ("advance"/"payment") that never matched a real audit row\'s actual entity_type ("advance_entry"/"payment_order"), so those two filters silently returned zero results always, for as long as this dropdown has existed', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await page.click('button[data-target="advances-tab"]');
    await page.click('#advances-new-deposit-btn');
    await page.fill('#deposit-phone', '9800077001');
    await page.fill('#deposit-name', 'Audit Filter Customer');
    await page.fill('#deposit-amount', '30099');
    await page.click('#submit-deposit-btn');
    await readAlert(page);

    // The audit summary for a deposit is "<amount> posted via <method>" — it
    // deliberately does not carry the customer's name (consistent with every
    // other service's audit.record() call in this tree, e.g. an invoice's
    // summary is "Invoice <number> for <total>", also customer-name-free);
    // the entityId is the pointer back to the full record elsewhere. Search
    // by the distinctive amount instead.
    await openAuditTab(page);
    await page.selectOption('#audit-entity', 'advance_entry');
    await expect(page.locator('#audit-table-body')).toContainText('30099 posted');

    await page.selectOption('#audit-entity', 'invoice');
    await expect(page.locator('#audit-table-body')).not.toContainText('30099 posted');
});

test('a recorded action survives a page reload', async ({ page, posServer }) => {
    await loginAsAdmin(page, posServer);

    await page.click('button[data-target="advances-tab"]');
    await page.click('#advances-new-deposit-btn');
    await page.fill('#deposit-phone', '9800077002');
    await page.fill('#deposit-name', 'Reload Audit Customer');
    await page.fill('#deposit-amount', '15077');
    await page.click('#submit-deposit-btn');
    await readAlert(page);

    await page.reload();
    await openAuditTab(page);
    await page.fill('#audit-search', '15077 posted');
    await expect(page.locator('#audit-table-body')).toContainText('15077 posted');
});
