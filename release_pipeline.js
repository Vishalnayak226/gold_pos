/**
 * ==========================================================================
 * Gold POS Platform Release Pipeline
 * Bundles production-ready clean assets and packages them into a ZIP archive.
 * Excludes developer keys, sales transaction history, and node_modules.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const RELEASE_ZIP = path.join(ROOT_DIR, 'gold_pos_release.zip');

console.log('[Pipeline] Initiating Gold POS Platform bundle release...');

// 1. Clean previous release folders
if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
if (fs.existsSync(RELEASE_ZIP)) {
    fs.unlinkSync(RELEASE_ZIP);
}

fs.mkdirSync(DIST_DIR);

/**
 * Recursively copy directories while excluding specific paths
 */
function copyRecursive(src, dest, excludes = []) {
    const stats = fs.statSync(src);
    const basename = path.basename(src);

    // Skip excluded directories or files
    if (excludes.some(ex => src.includes(path.normalize(ex)) || basename === ex)) {
        return;
    }

    if (stats.isDirectory()) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        const children = fs.readdirSync(src);
        children.forEach(child => {
            copyRecursive(path.join(src, child), path.join(dest, child), excludes);
        });
    } else {
        // Ensure parent folder exists
        const parent = path.dirname(dest);
        if (!fs.existsSync(parent)) {
            fs.mkdirSync(parent, { recursive: true });
        }
        fs.copyFileSync(src, dest);
    }
}

// 2. Define Exclusions (sensitive keys, temporary databases, and local dependency libraries)
const backendExcludes = [
    'node_modules',
    '.tmp',
    'logs',
    'developer_doomsday_keys',
    'keys/developer_private.pem',
    'backups',
    'data/sales_' // exclude transaction partitions
];

const licensingExcludes = [
    'node_modules',
    'data/licenses.json',
    'keys/license_private.pem'
];

// 3. Copy Backend Module
console.log('[Pipeline] Bundling Client POS Backend...');
copyRecursive(path.join(ROOT_DIR, 'backend'), path.join(DIST_DIR, 'backend'), backendExcludes);

// 4. Copy Frontend Assets
console.log('[Pipeline] Bundling Frontend POS Interface...');
copyRecursive(path.join(ROOT_DIR, 'frontend'), path.join(DIST_DIR, 'frontend'));

// 5. Copy Licensing Server Module
console.log('[Pipeline] Bundling Central Licensing microservice...');
copyRecursive(path.join(ROOT_DIR, 'licensing_server'), path.join(DIST_DIR, 'licensing_server'), licensingExcludes);

// 6. Copy documentation and handover manifests
console.log('[Pipeline] Bundling documentation ledgers...');
copyRecursive(path.join(ROOT_DIR, 'docs'), path.join(DIST_DIR, 'docs'));

// 7. Setup clean production database templates
console.log('[Pipeline] Setting up clean production database structures...');
const prodDataDir = path.join(DIST_DIR, 'backend', 'data');
if (!fs.existsSync(prodDataDir)) fs.mkdirSync(prodDataDir, { recursive: true });
if (!fs.existsSync(path.join(DIST_DIR, 'backend', 'logs'))) fs.mkdirSync(path.join(DIST_DIR, 'backend', 'logs'), { recursive: true });
if (!fs.existsSync(path.join(DIST_DIR, 'backend', 'keys'))) fs.mkdirSync(path.join(DIST_DIR, 'backend', 'keys'), { recursive: true });

// Copy public developer key for L2 secure exports verification
fs.copyFileSync(
    path.join(ROOT_DIR, 'backend', 'keys', 'developer_public.pem'),
    path.join(DIST_DIR, 'backend', 'keys', 'developer_public.pem')
);

// Populate default settings schemas
const cleanSettings = {
    companyName: "Universal Gold POS Ltd",
    address: "100 Gold Plaza, Retail District",
    phone: "9999999999",
    gstNumber: "29AABCDE1234F1Z",
    goldTaxSlab: 3.0,
    reportEmail: "reports@goldpos.com",
    smtp: null,
    goldApiProvider: "public",
    goldApiKey: "",
    razorpayKeyId: "",
    razorpayKeySecret: "",
    overrideGoldPrice: {
        active: false,
        price24K: 0.0,
        price22K: 0.0,
        price18K: 0.0
    },
    currency: "INR"
};

const cleanLicense = {
    licenseKey: "DEMO-KEY-12345",
    activated: false,
    status: "inactive",
    expiryDate: null,
    lastHandshakeTime: 0
};

fs.writeFileSync(path.join(prodDataDir, 'settings.json'), JSON.stringify(cleanSettings, null, 2));
fs.writeFileSync(path.join(prodDataDir, 'license.json'), JSON.stringify(cleanLicense, null, 2));
fs.writeFileSync(path.join(prodDataDir, 'advances.json'), JSON.stringify([], null, 2));

// 8. Compress package using system utilities (ZIP)
console.log('[Pipeline] Compressing clean bundle into zip archive...');
try {
    if (process.platform === 'win32') {
        // Use PowerShell Compress-Archive
        execSync(`powershell -Command "Compress-Archive -Path '${DIST_DIR}\\*' -DestinationPath '${RELEASE_ZIP}' -Force"`);
    } else {
        // Use Unix zip
        execSync(`zip -r '${RELEASE_ZIP}' '${DIST_DIR}'`);
    }
    console.log(`[Pipeline] Release package created successfully: ${RELEASE_ZIP}`);
} catch (zipErr) {
    console.warn(`[Pipeline] Native compression failed: ${zipErr.message}`);
    console.info(`[Pipeline] You can manually compress the compiled folder located at: ${DIST_DIR}`);
}

console.log('[Pipeline] Bundle completed.');
