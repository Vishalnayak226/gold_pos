/**
 * ==========================================================================
 * Settings → Backup & Email — TESTING_CHECKLIST.md §22c "Off-site destination".
 *
 * `backend/test_suite.js` Test 14 already proves `shipOffsite()` itself:
 * verified manifest, SHA-256, retention pruning, and a refused destination —
 * all at the function-call level. What had zero coverage anywhere is the
 * checklist's own literal steps: a real admin toggling the Settings UI,
 * clicking "Create Backup Now", and reading the same status line a tenant
 * would. This file drives exactly that, through the real routes and the real
 * `backupEngine.js`, against a destination directory this spec owns.
 * ==========================================================================
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, loginAsAdmin } from './fixtures.js';

async function openBackupSettings(page) {
    await page.click('button[data-target="settings-tab"]');
    await page.click('button.settings-subnav-btn[data-section="backup"]');
    await expect(page.locator('#set-offsite-enabled')).toBeVisible();
}

function readManifest(offsiteRoot, folder) {
    return JSON.parse(fs.readFileSync(path.join(offsiteRoot, folder, 'manifest.json'), 'utf8'));
}

test('enabling off-site copy and running a backup verifies every file by SHA-256 and writes a manifest', async ({ page, posServer }) => {
    const offsiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-e2e-offsite-'));
    // A stale dated folder from a prior run, old enough that a correctly
    // configured 30-day retention must remove it once this run succeeds —
    // proves retention runs off the real destination, not just returns ok.
    const staleFolder = path.join(offsiteRoot, 'backup_2020-01-01');
    fs.mkdirSync(staleFolder, { recursive: true });
    const sixtyDaysAgo = (Date.now() - 60 * 86400000) / 1000;
    fs.utimesSync(staleFolder, sixtyDaysAgo, sixtyDaysAgo);

    try {
        await loginAsAdmin(page, posServer);
        await openBackupSettings(page);

        await page.check('#set-offsite-enabled');
        await page.fill('#set-offsite-path', offsiteRoot);
        await page.fill('#set-offsite-retention', '30');
        await page.click('#save-backup-btn');
        const box = page.locator('#custom-alert-box');
        await expect(box).toBeVisible();
        await expect(box.locator('p')).toContainText('Backup & email settings saved');
        await box.getByRole('button', { name: 'OK' }).click();

        const status = page.locator('#backup-action-status');
        await page.click('#run-backup-btn');
        await expect(status).toContainText('Backup created:', { timeout: 15_000 });
        await expect(status).toContainText('off-site copy verified');

        expect(fs.existsSync(staleFolder)).toBe(false);
        const folders = fs.readdirSync(offsiteRoot).filter(name => /^backup_\d{4}-\d{2}-\d{2}$/.test(name));
        expect(folders.length).toBe(1);
        const manifest = readManifest(offsiteRoot, folders[0]);
        expect(manifest.files.length).toBeGreaterThan(0);
        for (const file of manifest.files) {
            expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
            const bytesOnDisk = fs.readFileSync(path.join(offsiteRoot, folders[0], file.name));
            expect(bytesOnDisk.length).toBe(file.bytes);
        }
    } finally {
        fs.rmSync(offsiteRoot, { recursive: true, force: true });
    }
});

test('an unavailable off-site destination fails the off-site copy while the local backup still succeeds, and recovers once restored', async ({ page, posServer }) => {
    const offsiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-e2e-offsite-'));

    try {
        await loginAsAdmin(page, posServer);
        await openBackupSettings(page);
        await page.check('#set-offsite-enabled');
        await page.fill('#set-offsite-path', offsiteRoot);
        await page.click('#save-backup-btn');
        await expect(page.locator('#custom-alert-box').locator('p')).toContainText('Backup & email settings saved');
        await page.locator('#custom-alert-box').getByRole('button', { name: 'OK' }).click();

        const status = page.locator('#backup-action-status');

        // Replace the destination with a plain FILE at the same path: a real,
        // portable filesystem failure (mkdirSync recursive over an existing
        // non-directory throws) that needs no OS-specific permission trick.
        fs.rmSync(offsiteRoot, { recursive: true, force: true });
        fs.writeFileSync(offsiteRoot, 'not a directory');

        await page.click('#run-backup-btn');
        await expect(status).toContainText('Backup created:', { timeout: 15_000 });
        await expect(status).toContainText('OFF-SITE COPY FAILED');

        // Restored: the very next run must succeed again, proving the earlier
        // failure was the destination's state and not a wedged retry path.
        fs.rmSync(offsiteRoot, { force: true });
        fs.mkdirSync(offsiteRoot, { recursive: true });
        await page.click('#run-backup-btn');
        await expect(status).toContainText('off-site copy verified', { timeout: 15_000 });
    } finally {
        fs.rmSync(offsiteRoot, { recursive: true, force: true });
    }
});
