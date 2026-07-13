/**
 * ==========================================================================
 * Gold POS Central Licensing Server
 * Serverless-ready, portable microservice for managing client activations.
 * ==========================================================================
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NOTE: port 6000 is deliberately avoided — it's on the WHATWG Fetch spec's
// forbidden-port list (X11's reserved port), so Node's built-in fetch()
// refuses to connect to it. The POS client's licenseChecker.js talks to this
// server via fetch(), so that port choice would silently break every
// license handshake. Keep PORT out of the forbidden list if you override it.
const PORT = process.env.PORT || 6060;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'MASTER-ADMIN-SECRET-12345';
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_DIR = path.join(__dirname, 'keys');

// Create folders if missing
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(KEYS_DIR)) fs.mkdirSync(KEYS_DIR, { recursive: true });

// Initialize database file
const dbFile = path.join(DATA_DIR, 'licenses.json');
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify([
        {
            licenseKey: "DEMO-KEY-12345",
            customerName: "Demo Gold Jewelers Ltd",
            expiryDate: "2028-12-31",
            status: "active",
            billingCycle: "yearly",
            amount: 0,
            nextDueDate: "2028-12-31"
        }
    ], null, 2));
}

// Platform-wide config (currently just the latest published client version —
// POS clients poll GET /api/version and show a non-blocking "update
// available" banner if their own package.json version is older).
const configFile = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({ latestVersion: "1.0.0" }, null, 2));
}

// Automatically generate RSA key pairs for signing license tokens if missing
const privateKeyPath = path.join(KEYS_DIR, 'license_private.pem');
const publicKeyPath = path.join(KEYS_DIR, 'license_public.pem');

if (!fs.existsSync(privateKeyPath)) {
    console.log('[Licensing Server] Generating licensing RSA-2048 key pairs...');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(privateKeyPath, privateKey);
    fs.writeFileSync(publicKeyPath, publicKey);
}

const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

const app = express();
app.use(cors());
app.use(express.json());

/* ==========================================================================
   PORTABLE DATABASE ADAPTER (Easily replace JSON with CF KV / Mongo / Postgres)
   ========================================================================== */
class DatabaseAdapter {
    static async getLicenses() {
        try {
            // Local file implementation - Swap with DB driver fetch if migrating
            const content = fs.readFileSync(dbFile, 'utf8');
            return JSON.parse(content);
        } catch (_) {
            return [];
        }
    }

    static async saveLicenses(licenses) {
        // Local file implementation - Swap with DB driver save if migrating
        fs.writeFileSync(dbFile, JSON.stringify(licenses, null, 2));
    }

    static async findKey(key) {
        const licenses = await this.getLicenses();
        return licenses.find(l => l.licenseKey === key);
    }
}

/* ==========================================================================
   API Routes: Client Verification Gate
   ========================================================================== */

/**
 * POST /api/license/verify
 * Validates a client's license and returns an RSA-signed verification payload.
 */
app.post('/api/license/verify', async (req, res) => {
    try {
        const { licenseKey, systemFingerprint } = req.body;
        if (!licenseKey) {
            return res.status(400).json({ error: 'License key is required' });
        }

        const licenseRecord = await DatabaseAdapter.findKey(licenseKey);

        if (!licenseRecord) {
            return res.json({
                success: false,
                status: 'invalid',
                message: 'License key does not exist on central verification server.'
            });
        }

        const isExpired = new Date(licenseRecord.expiryDate) < new Date();
        const activeStatus = (licenseRecord.status === 'active' && !isExpired) ? 'active' : (isExpired ? 'expired' : 'suspended');

        // Create the activation payload token
        const payload = {
            licenseKey,
            customerName: licenseRecord.customerName,
            expiryDate: licenseRecord.expiryDate,
            status: activeStatus,
            billingCycle: licenseRecord.billingCycle || null,
            amount: licenseRecord.amount || 0,
            nextDueDate: licenseRecord.nextDueDate || null,
            systemFingerprint: systemFingerprint || 'unknown',
            timestamp: Date.now()
        };

        const payloadStr = JSON.stringify(payload);

        // Sign the token with licensing private key
        const signer = crypto.createSign('sha256');
        signer.update(payloadStr);
        const signature = signer.sign(privateKey, 'base64');

        res.json({
            success: activeStatus === 'active',
            payload: payloadStr,
            signature
        });
    } catch (err) {
        console.error('Verify exception:', err);
        res.status(500).json({ error: 'Internal licensing engine error' });
    }
});

/* ==========================================================================
   API Routes: Platform Version Check
   ========================================================================== */

/**
 * GET /api/version
 * Public — POS clients poll this on boot to compare against their own
 * package.json version and surface a non-blocking "update available"
 * banner. Never auto-updates anything (see docs/PROJECT_PLAN.md §5.1).
 */
app.get('/api/version', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        res.json({ latestVersion: config.latestVersion || '1.0.0' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read platform version config' });
    }
});

/* ==========================================================================
   API Routes: Management & Control Panel
   ========================================================================== */

// Simple Admin Authenticator Middleware
const authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized administrative token' });
    }
    next();
};

/**
 * GET /api/admin/keys
 * Lists all registered licenses.
 */
app.get('/api/admin/keys', authenticateAdmin, async (req, res) => {
    const licenses = await DatabaseAdapter.getLicenses();
    res.json(licenses);
});

/**
 * POST /api/admin/keys
 * Upserts a license key configuration.
 */
app.post('/api/admin/keys', authenticateAdmin, async (req, res) => {
    try {
        const { licenseKey, customerName, expiryDate, status, billingCycle, amount, nextDueDate } = req.body;
        if (!licenseKey || !customerName || !expiryDate) {
            return res.status(400).json({ error: 'Missing mandatory license registration parameters' });
        }

        const licenses = await DatabaseAdapter.getLicenses();
        const existingIdx = licenses.findIndex(l => l.licenseKey === licenseKey);

        const record = {
            licenseKey,
            customerName,
            expiryDate,
            status: status || 'active',
            billingCycle: billingCycle || 'monthly',
            amount: parseFloat(amount) || 0,
            nextDueDate: nextDueDate || expiryDate
        };

        if (existingIdx >= 0) {
            licenses[existingIdx] = record;
        } else {
            licenses.push(record);
        }

        await DatabaseAdapter.saveLicenses(licenses);
        res.json({ success: true, record });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write license update' });
    }
});

/**
 * POST /api/admin/version
 * Updates the platform-wide "latest published version" flag POS clients
 * check on boot.
 */
app.post('/api/admin/version', authenticateAdmin, (req, res) => {
    try {
        const { latestVersion } = req.body;
        if (!latestVersion) {
            return res.status(400).json({ error: 'latestVersion is required' });
        }
        fs.writeFileSync(configFile, JSON.stringify({ latestVersion }, null, 2));
        res.json({ success: true, latestVersion });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update platform version' });
    }
});

/**
 * DELETE /api/admin/keys/:key
 * Revokes a license key configuration.
 */
app.delete('/api/admin/keys/:key', authenticateAdmin, async (req, res) => {
    try {
        const key = req.params.key;
        let licenses = await DatabaseAdapter.getLicenses();
        licenses = licenses.filter(l => l.licenseKey !== key);
        await DatabaseAdapter.saveLicenses(licenses);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete license' });
    }
});

/**
 * GET /
 * Administrative Web Control Dashboard (PDF style, print-ledger look)
 */
app.get('/', (req, res) => {
    // Return HTML dashboard page
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SaaS License Center</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
                background-color: #f8fafc;
                margin: 0;
                padding: 40px 20px;
                color: #0f172a;
            }
            .container {
                max-width: 800px;
                margin: 0 auto;
                background: white;
                border: 1px solid #e2e8f0;
                padding: 30px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }
            h1 {
                font-size: 22px;
                letter-spacing: -0.02em;
                margin-top: 0;
                border-bottom: 2px solid #0f172a;
                padding-bottom: 10px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
                font-size: 13px;
            }
            th, td {
                padding: 10px;
                text-align: left;
                border-bottom: 1px solid #e2e8f0;
            }
            th {
                background-color: #f1f5f9;
                font-weight: 600;
            }
            .badge {
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 500;
            }
            .badge-active { background: #dcfce7; color: #166534; }
            .badge-suspended { background: #fee2e2; color: #991b1b; }
            .form-grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 10px;
                margin-top: 25px;
                border-top: 1px dashed #cbd5e1;
                padding-top: 20px;
            }
            input, select, button {
                padding: 8px 12px;
                font-size: 13px;
                border: 1px solid #cbd5e1;
                border-radius: 4px;
            }
            button {
                background-color: #0f172a;
                color: white;
                cursor: pointer;
                border: none;
            }
            button:hover { background-color: #1e293b; }
            .password-prompt {
                text-align: center;
                margin-top: 100px;
            }
        </style>
    </head>
    <body>
        <div class="container" id="admin-panel" style="display:none;">
            <h1>SaaS LICENSE CONTROL PANEL</h1>

            <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
                <strong style="font-size:13px;">Latest Published Version:</strong>
                <input type="text" id="latest-version-input" placeholder="1.0.0" style="width:100px;">
                <button onclick="updateVersion()">Update</button>
                <span id="version-status" style="font-size:12px; color:#64748b;"></span>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>License Key</th>
                        <th>Client / Name</th>
                        <th>Expiry Date</th>
                        <th>Status</th>
                        <th>Billing</th>
                        <th>Amount</th>
                        <th>Next Due</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="keys-tbody"></tbody>
            </table>

            <div class="form-grid" style="grid-template-columns: repeat(4, 1fr);">
                <input type="text" id="new-key" placeholder="License Key">
                <input type="text" id="new-name" placeholder="Client Name">
                <input type="date" id="new-expiry">
                <select id="new-status">
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                </select>
                <select id="new-billing-cycle">
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                </select>
                <input type="number" id="new-amount" placeholder="Amount" min="0" step="1">
                <input type="date" id="new-due-date" placeholder="Next Due Date">
                <button onclick="upsertKey()">SAVE / UPDATE LICENSE</button>
            </div>
        </div>

        <div class="password-prompt" id="auth-panel">
            <h2>Enter Administrative Secret</h2>
            <input type="password" id="admin-pass" placeholder="Enter Token">
            <button onclick="login()">Enter Dashboard</button>
        </div>

        <script>
            let adminToken = '';

            function login() {
                const pass = document.getElementById('admin-pass').value;
                adminToken = pass;
                loadKeys();
            }

            async function loadKeys() {
                const res = await fetch('/api/admin/keys', {
                    headers: { 'Authorization': 'Bearer ' + adminToken }
                });
                if (res.ok) {
                    document.getElementById('auth-panel').style.display = 'none';
                    document.getElementById('admin-panel').style.display = 'block';
                    const data = await res.json();
                    const tbody = document.getElementById('keys-tbody');
                    tbody.innerHTML = '';
                    data.forEach(k => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = \`
                            <td><strong>\${k.licenseKey}</strong></td>
                            <td>\${k.customerName}</td>
                            <td>\${k.expiryDate}</td>
                            <td><span class="badge badge-\${k.status}">\${k.status.toUpperCase()}</span></td>
                            <td>\${k.billingCycle || '—'}</td>
                            <td>\${k.amount ? k.amount.toLocaleString() : '—'}</td>
                            <td>\${k.nextDueDate || '—'}</td>
                            <td>
                                <button onclick="deleteKey('\${k.licenseKey}')" style="background:#ef4444; padding: 4px 8px; font-size:11px;">Revoke</button>
                            </td>
                        \`;
                        tbody.appendChild(tr);
                    });
                } else {
                    alert('Invalid admin credentials.');
                }

                try {
                    const verRes = await fetch('/api/version');
                    if (verRes.ok) {
                        const verData = await verRes.json();
                        document.getElementById('latest-version-input').value = verData.latestVersion;
                    }
                } catch (e) { /* non-fatal */ }
            }

            async function upsertKey() {
                const licenseKey = document.getElementById('new-key').value;
                const customerName = document.getElementById('new-name').value;
                const expiryDate = document.getElementById('new-expiry').value;
                const status = document.getElementById('new-status').value;
                const billingCycle = document.getElementById('new-billing-cycle').value;
                const amount = document.getElementById('new-amount').value;
                const nextDueDate = document.getElementById('new-due-date').value;

                if(!licenseKey || !customerName || !expiryDate) {
                    alert('Please fill out all fields.');
                    return;
                }

                const res = await fetch('/api/admin/keys', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + adminToken
                    },
                    body: JSON.stringify({ licenseKey, customerName, expiryDate, status, billingCycle, amount, nextDueDate })
                });

                if (res.ok) {
                    document.getElementById('new-key').value = '';
                    document.getElementById('new-name').value = '';
                    document.getElementById('new-expiry').value = '';
                    document.getElementById('new-amount').value = '';
                    document.getElementById('new-due-date').value = '';
                    loadKeys();
                } else {
                    alert('Failed to update key.');
                }
            }

            async function updateVersion() {
                const latestVersion = document.getElementById('latest-version-input').value.trim();
                if (!latestVersion) return;
                const statusEl = document.getElementById('version-status');
                const res = await fetch('/api/admin/version', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + adminToken
                    },
                    body: JSON.stringify({ latestVersion })
                });
                statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
            }

            async function deleteKey(key) {
                if(!confirm('Are you sure you want to revoke this license?')) return;
                const res = await fetch('/api/admin/keys/' + key, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + adminToken }
                });
                if(res.ok) {
                    loadKeys();
                } else {
                    alert('Delete failed.');
                }
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Licensing Server] Control panel running on http://localhost:${PORT}`);
    console.log(`[Licensing Server] Admin token: ${ADMIN_SECRET}`);
});
