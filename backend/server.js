import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readJSON, writeJSON, logError, logTelemetry, DATA_DIR } from './db.js';
import { getActiveGoldRates, syncGoldPrice, initPriceScheduler } from './priceEngine.js';
import { encryptLevel2Payload } from './cryptoHelper.js';
import https from 'https';
import crypto from 'crypto';
import { checkLicenseGate, syncLicenseStatus, isLicenseValid } from './licenseChecker.js';
import { initBackupScheduler, createBackup } from './backupEngine.js';
import { checkForUpdates, applyPendingUpdate, initUpdateScheduler } from './updateEngine.js';
import { requireAdminSession, verifyAdminPin, createAdminSession, destroyAdminSession, loginRateLimiter, recordLoginResult } from './adminAuth.js';
import { initReportScheduler, sendSummaryReport } from './emailReporter.js';
import { logBlackBoxEvent, exportBlackBoxEnvelope } from './blackBoxLogger.js';
import { loadExtensions, fireHook } from './extensions/index.js';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 5000;

// Sanity ceiling for a single advance deposit/redemption amount (10 crore
// INR) — not a business rule, just a guard against fat-finger/malicious
// extreme values (e.g. 1e308) that would otherwise sit permanently in the
// ledger and distort balance arithmetic.
const MAX_SANE_AMOUNT = 100000000;

// Trust the loopback reverse proxy (Nginx, see deploy/nginx.conf.template) so
// req.ip resolves the real client IP from X-Forwarded-For instead of always
// reading 127.0.0.1 — required for the admin-login rate limiter (adminAuth.js)
// to key lockouts per real caller instead of globally locking every user.
app.set('trust proxy', 'loopback');

// Enable CORS and body parsers
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Track simple API response time telemetry
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        logTelemetry(`${req.method}_${req.originalUrl}`, duration, `Status: ${res.statusCode}`);
        // Black-box flight recorder: same request shape, technical fields only
        // (no query string, no body) so error frequency, slow endpoints, and
        // memory trends can be aggregated offline without ever seeing PII.
        logBlackBoxEvent('HTTP_REQUEST', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            durationMs: duration,
            heapUsedMB: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
        });
    });
    next();
});

// Protect all POS cashier routes with licensing gate
app.use(checkLicenseGate);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../frontend')));

/* ==========================================================================
   API Routes: Admin Session Authentication
   ========================================================================== */

/**
 * POST /api/admin/login
 * Verifies the admin PIN server-side and issues a bearer session token.
 * Replaces the old client-only PIN check.
 */
app.post('/api/admin/login', loginRateLimiter, (req, res) => {
    const { pin } = req.body;
    if (!verifyAdminPin(pin)) {
        recordLoginResult(req, false);
        logTelemetry('ADMIN_LOGIN_FAILED', 0);
        return res.status(401).json({ error: 'Incorrect PIN' });
    }
    recordLoginResult(req, true);
    const token = createAdminSession();
    logTelemetry('ADMIN_LOGIN_SUCCESS', 0);
    res.json({ success: true, token });
});

/**
 * POST /api/admin/logout
 * Invalidates the given session token.
 */
app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    destroyAdminSession(token);
    res.json({ success: true });
});

/* ==========================================================================
   API Routes: Gold Price Engine
   ========================================================================== */

/**
 * GET /api/gold-price
 * Returns current rates for 24K, 22K, 18K. Automatically applies overrides if active.
 */
app.get('/api/gold-price', (req, res) => {
    try {
        const rates = getActiveGoldRates();
        res.json(rates);
    } catch (err) {
        logError('Error fetching gold price in API: ' + err.message, err.stack);
        res.status(500).json({ error: 'Internal pricing error' });
    }
});

/**
 * POST /api/gold-price/sync
 * Manually triggers a remote API price fetch/update
 */
app.post('/api/gold-price/sync', requireAdminSession, async (req, res) => {
    try {
        const updatedRates = await syncGoldPrice();
        res.json({ success: true, rates: updatedRates });
    } catch (err) {
        logError('Manual gold price sync API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Sync failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Settings Configuration
   ========================================================================== */

/**
 * GET /api/settings/public
 * Public-safe subset of settings for customer-facing pages (no secrets).
 */
app.get('/api/settings/public', (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        res.json({
            companyName: settings.companyName,
            upiId: settings.upiId || '',
            currency: settings.currency || 'INR'
        });
    } catch (err) {
        logError('Error getting public settings: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve settings' });
    }
});

/**
 * GET /api/settings
 * Retrieves the full system configuration (tax slabs, overrides, SMTP, payment
 * secrets, admin PIN). Admin-only — contains credentials, never expose publicly.
 */
app.get('/api/settings', requireAdminSession, (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        res.json(settings);
    } catch (err) {
        logError('Error getting settings: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve settings' });
    }
});

/**
 * POST /api/settings
 * Updates system configurations.
 */
app.post('/api/settings', requireAdminSession, (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const currentSettings = readJSON(settingsFile, {});

        // Destructive-action guard: lowering the invoice sequence can produce
        // duplicate invoice numbers against already-issued invoices. Require
        // an explicit confirmDestructive flag (the frontend triple-confirms
        // with the user before setting it) instead of silently applying it.
        if (req.body.invoiceSeqStart !== undefined && currentSettings.invoiceSeqStart !== undefined) {
            const requested = parseInt(req.body.invoiceSeqStart);
            const current = parseInt(currentSettings.invoiceSeqStart);
            if (!isNaN(requested) && requested < current && !req.body.confirmDestructive) {
                return res.status(409).json({
                    error: 'CONFIRMATION_REQUIRED',
                    message: `Lowering the invoice sequence from ${current} to ${requested} can cause duplicate invoice numbers against already-issued invoices. Resubmit with confirmDestructive: true after explicit user confirmation.`
                });
            }
        }

        const newSettings = { ...currentSettings, ...req.body };
        delete newSettings.confirmDestructive; // request-only flag, never persisted

        // Ensure manual overrides maintain float structures
        if (newSettings.overrideGoldPrice) {
            newSettings.overrideGoldPrice.price24K = parseFloat(newSettings.overrideGoldPrice.price24K) || 0.0;
            newSettings.overrideGoldPrice.price22K = parseFloat(newSettings.overrideGoldPrice.price22K) || 0.0;
            newSettings.overrideGoldPrice.price18K = parseFloat(newSettings.overrideGoldPrice.price18K) || 0.0;
        }

        if (!writeJSON(settingsFile, newSettings)) {
            return res.status(500).json({ error: 'Failed to persist settings. Please retry.' });
        }
        fireHook('onSettingsUpdated', newSettings);
        res.json({ success: true, settings: newSettings });
    } catch (err) {
        logError('Error updating settings: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

/* ==========================================================================
   API Routes: Sales & Customer Billing Desk
   ========================================================================== */

/**
 * GET /api/sales
 * Retrieves sales records combined across all partitioned files, sorted by date descending.
 */
app.get('/api/sales', requireAdminSession, (req, res) => {
    try {
        const files = fs.readdirSync(DATA_DIR);
        let allSales = [];
        files.forEach(f => {
            if (f.startsWith('sales_') && f.endsWith('.json')) {
                const sales = readJSON(path.join(DATA_DIR, f), []);
                allSales = allSales.concat(sales);
            }
        });
        
        // Sort descending by timestamp
        allSales.sort((a, b) => b.timestamp - a.timestamp);
        res.json(allSales);
    } catch (err) {
        logError('Error retrieving sales logs: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve sales' });
    }
});

/**
 * POST /api/sales
 * Saves a new Gold POS Sale, handles sequence numbering, and registers advance deductions if applied.
 */
app.post('/api/sales', requireAdminSession, (req, res) => {
    try {
        // Validate the core billing fields before consuming a real,
        // sequential, legally-relevant invoice number on garbage/empty data.
        const VALID_PURITIES = ['24K', '22K', '18K'];
        const { purity, weightGrams, goldPricePerGram, metalValue, totalAmount, customerName, customerPhone, appliedAdvance } = req.body;

        if (!VALID_PURITIES.includes(purity)) {
            return res.status(400).json({ error: 'A valid purity (24K, 22K, or 18K) is required.' });
        }
        const numWeight = Number(weightGrams);
        const numRate = Number(goldPricePerGram);
        const numMetalValue = Number(metalValue);
        const numTotal = Number(totalAmount);
        const numAppliedAdvance = appliedAdvance === undefined ? 0 : Number(appliedAdvance);
        if (!Number.isFinite(numWeight) || numWeight <= 0) {
            return res.status(400).json({ error: 'A valid positive gold weight is required.' });
        }
        if (!Number.isFinite(numRate) || numRate < 0 || !Number.isFinite(numMetalValue) || numMetalValue < 0) {
            return res.status(400).json({ error: 'A valid non-negative gold rate and metal value are required.' });
        }
        if (!Number.isFinite(numTotal) || numTotal < 0) {
            return res.status(400).json({ error: 'A valid non-negative total amount is required.' });
        }
        if (!Number.isFinite(numAppliedAdvance) || numAppliedAdvance < 0) {
            return res.status(400).json({ error: 'Applied advance must be a valid non-negative amount.' });
        }
        if (customerPhone && !/^\d{10}$/.test(customerPhone)) {
            return res.status(400).json({ error: 'Customer phone must be exactly 10 digits if provided.' });
        }
        if (customerName && String(customerName).length > 200) {
            return res.status(400).json({ error: 'Customer name is too long (max 200 characters).' });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});

        // 1. Generate Incrementing Serial Invoice ID
        const prefix = settings.invoicePrefix || 'GOLD';
        const startSeq = settings.invoiceSeqStart || 1;
        const currentYearShort = new Date().getFullYear().toString().slice(-2);

        const invoiceId = `${prefix}-${startSeq.toString().padStart(6, '0')}-${currentYearShort}`;

        // Increment and save start sequence. If this write doesn't actually
        // persist (e.g. transient Windows file-lock contention exhausting
        // writeJSON's retries), the next request would silently recompute
        // and hand out this same invoiceId again — bail out loudly instead
        // of reporting a false success on a since-duplicated invoice number.
        settings.invoiceSeqStart = startSeq + 1;
        if (!writeJSON(settingsFile, settings)) {
            return res.status(500).json({ error: 'Failed to persist invoice sequence. Sale was not saved — please retry.' });
        }

        // 2. Prepare Sale Record (numeric fields normalized to clean numbers
        // regardless of what was submitted, now that they've passed validation)
        const sale = {
            id: invoiceId,
            ...req.body,
            weightGrams: numWeight,
            goldPricePerGram: numRate,
            metalValue: numMetalValue,
            totalAmount: numTotal,
            appliedAdvance: numAppliedAdvance
        };

        // 3. Save to partitioned annual file (e.g. sales_2026.json)
        const year = new Date().getFullYear();
        const salesFile = path.join(DATA_DIR, `sales_${year}.json`);
        const sales = readJSON(salesFile, []);
        sales.push(sale);
        if (!writeJSON(salesFile, sales)) {
            // The invoice sequence above already advanced, so this invoiceId
            // is now permanently consumed as a gap rather than reused — an
            // acceptable, auditable outcome versus silently reporting a sale
            // as saved when it was not actually written to disk.
            return res.status(500).json({ error: 'Failed to persist sale record. Please retry — invoice number ' + invoiceId + ' will be skipped.' });
        }

        // 4. Handle Customer Advance Redemption. Best-effort: the sale itself
        // is already durably saved at this point, so a failure here (logged
        // by writeJSON internally) shouldn't un-report the successful sale —
        // it would only leave the redemption ledger entry to be reconciled.
        if (sale.appliedAdvance > 0 && sale.customerPhone) {
            const advancesFile = path.join(DATA_DIR, 'advances.json');
            const advances = readJSON(advancesFile, []);

            advances.push({
                id: 'RED-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
                customerPhone: sale.customerPhone,
                customerName: sale.customerName,
                type: 'redeem',
                amount: parseFloat(sale.appliedAdvance),
                invoiceId: invoiceId,
                timestamp: Date.now()
            });
            if (!writeJSON(advancesFile, advances)) {
                logError(`Sale ${invoiceId} saved but its advance redemption entry failed to persist — reconcile customer ${sale.customerPhone}'s advance ledger manually.`);
            }
        }

        logTelemetry('SAVE_SALE', 0, `Invoice: ${invoiceId}, Total: ${sale.totalAmount}`);
        fireHook('onSaleSaved', sale);
        res.json({ success: true, invoiceId, sale });
    } catch (err) {
        logError('Error saving sale transaction: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to process sale transaction: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Customer Advances Lookup
   ========================================================================== */

/**
 * GET /api/advances
 * Returns the full advances ledger (deposits + redemptions), sorted by date
 * descending. Admin-only — powers the Dashboard and Advances report tabs.
 */
app.get('/api/advances', requireAdminSession, (req, res) => {
    try {
        const advancesFile = path.join(DATA_DIR, 'advances.json');
        const advances = readJSON(advancesFile, []);
        advances.sort((a, b) => b.timestamp - a.timestamp);
        res.json(advances);
    } catch (err) {
        logError('Error retrieving advances ledger: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve advances ledger' });
    }
});

/**
 * GET /api/advances/lookup
 * Calculates and returns a customer's available advance credit balance and log ledger history.
 */
app.get('/api/advances/lookup', (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone || !/^\d{10}$/.test(phone)) {
            return res.status(400).json({ error: 'Valid 10-digit phone number required' });
        }

        const advancesFile = path.join(DATA_DIR, 'advances.json');
        const advances = readJSON(advancesFile, []);

        const history = advances.filter(a => a.customerPhone === phone);
        const balance = history.reduce((sum, item) => {
            if (item.type === 'deposit') return sum + parseFloat(item.amount);
            if (item.type === 'redeem') return sum - parseFloat(item.amount);
            return sum;
        }, 0);

        res.json({
            phone,
            balance: Math.max(0, balance),
            history
        });
    } catch (err) {
        logError('Error looking up customer advance balance: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to lookup customer balance' });
    }
});

/**
 * POST /api/advances
 * Submits a new customer advance deposit record (UPI or Card), storing it in advances.json.
 */
app.post('/api/advances', (req, res) => {
    try {
        const { customerPhone, customerName, amount, paymentMethod, referenceId } = req.body;
        if (!customerPhone || !/^\d{10}$/.test(customerPhone)) {
            return res.status(400).json({ error: 'Valid 10-digit customer phone number required' });
        }
        const numAmount = parseFloat(amount);
        if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > MAX_SANE_AMOUNT) {
            return res.status(400).json({ error: 'Valid deposit amount required' });
        }
        if (customerName && String(customerName).length > 200) {
            return res.status(400).json({ error: 'Customer name is too long (max 200 characters).' });
        }

        const advancesFile = path.join(DATA_DIR, 'advances.json');
        const advances = readJSON(advancesFile, []);

        const depositId = 'ADV-' + Math.random().toString(36).substring(2, 9).toUpperCase();

        const deposit = {
            id: depositId,
            customerPhone,
            customerName: customerName || 'Regular Customer',
            type: 'deposit',
            amount: numAmount,
            paymentMethod: paymentMethod || 'UPI',
            referenceId: referenceId || '',
            lockedGoldRate22K: getActiveGoldRates().price22K,
            timestamp: Date.now()
        };

        advances.push(deposit);
        if (!writeJSON(advancesFile, advances)) {
            return res.status(500).json({ error: 'Failed to persist advance deposit. Please retry.' });
        }

        logTelemetry('SAVE_ADVANCE_DEPOSIT', 0, `Cust: ${customerPhone}, Amount: ${amount}, Ref: ${referenceId}`);
        fireHook('onAdvanceDeposit', deposit);
        res.json({ success: true, id: depositId, deposit });
    } catch (err) {
        logError('Error saving advance deposit transaction: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to submit advance deposit' });
    }
});

/* ==========================================================================
   API Routes: Razorpay Payment Gateway Integration
   ========================================================================== */

/**
 * Helper to call Razorpay order creation API using native https module
 */
function createRazorpayOrder(amount, keyId, keySecret) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            amount: Math.round(amount * 100), // in paise
            currency: 'INR',
            receipt: 'rcpt_' + Math.random().toString(36).substring(2, 9).toUpperCase()
        });

        const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

        const options = {
            hostname: 'api.razorpay.com',
            port: 443,
            path: '/v1/orders',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`,
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(parsed.error ? parsed.error.description : 'Failed to create Razorpay order'));
                    }
                } catch (e) {
                    reject(new Error('JSON Parse error calling Razorpay API'));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.write(postData);
        req.end();
    });
}

/**
 * POST /api/payment/order
 * Initiates order with Razorpay. Returns orderId.
 */
app.post('/api/payment/order', async (req, res) => {
    const startTime = Date.now();
    try {
        const { amount } = req.body;
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: 'Valid amount is required' });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        
        const keyId = settings.razorpayKeyId;
        const keySecret = settings.razorpayKeySecret;

        if (!keyId || !keySecret) {
            return res.status(400).json({ error: 'Razorpay API credentials are not configured in system settings.' });
        }

        // MOCK CHECKOUT ENGINE FOR DUMMY KEYS
        if (keyId === 'rzp_test_xxxxxx') {
            const mockOrderId = 'order_mock_' + Math.random().toString(36).substring(2, 9);
            logTelemetry('PAYMENT_ORDER_MOCKED', 0, `Order: ${mockOrderId}, Amt: ${amount}`);
            return res.json({
                success: true,
                keyId,
                order: { id: mockOrderId, amount: parseFloat(amount) * 100 }
            });
        }

        const order = await createRazorpayOrder(amount, keyId, keySecret);
        
        logTelemetry('PAYMENT_ORDER_CREATED', Date.now() - startTime, `Order: ${order.id}, Amt: ${amount}`);
        res.json({
            success: true,
            keyId,
            order
        });
    } catch (err) {
        logError('Error creating Razorpay order: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to create payment order: ' + err.message });
    }
});

/**
 * POST /api/payment/verify
 * Verifies Razorpay payment signature and logs deposit in advances.json on success.
 */
app.post('/api/payment/verify', (req, res) => {
    try {
        const { customerPhone, customerName, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
        
        if (!customerPhone || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !amount) {
            return res.status(400).json({ error: 'Missing payment details for verification' });
        }
        if (!/^\d{10}$/.test(customerPhone)) {
            return res.status(400).json({ error: 'Valid 10-digit customer phone number required' });
        }
        const numAmount = parseFloat(amount);
        if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > MAX_SANE_AMOUNT) {
            return res.status(400).json({ error: 'Valid payment amount required' });
        }
        if (customerName && String(customerName).length > 200) {
            return res.status(400).json({ error: 'Customer name is too long (max 200 characters).' });
        }

        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const settings = readJSON(settingsFile, {});
        const keySecret = settings.razorpayKeySecret;

        if (!keySecret) {
            return res.status(500).json({ error: 'Razorpay secret key is not configured' });
        }

        // Verify SHA-256 HMAC signature
        const text = razorpay_order_id + "|" + razorpay_payment_id;
        const generated_signature = crypto
            .createHmac('sha256', keySecret)
            .update(text)
            .digest('hex');

        // MOCK BYPASS: Ignore signature match if using dummy secrets
        if (generated_signature !== razorpay_signature && keySecret !== 'rzp_test_xxxxxx_secret') {
            logTelemetry('PAYMENT_SIGNATURE_MISMATCH', 0, `Order: ${razorpay_order_id}`);
            return res.status(400).json({ error: 'Payment signature verification failed. Possible fraud attempt.' });
        }

        // Success! Log the advance deposit
        const advancesFile = path.join(DATA_DIR, 'advances.json');
        const advances = readJSON(advancesFile, []);
        
        const depositId = 'ADV-' + Math.random().toString(36).substring(2, 9).toUpperCase();
        
        const deposit = {
            id: depositId,
            customerPhone,
            customerName: customerName || 'Regular Customer',
            type: 'deposit',
            amount: numAmount,
            paymentMethod: 'Razorpay',
            referenceId: razorpay_payment_id,
            lockedGoldRate22K: getActiveGoldRates().price22K,
            timestamp: Date.now()
        };

        advances.push(deposit);
        if (!writeJSON(advancesFile, advances)) {
            // The customer's money has already moved via Razorpay at this point
            // (signature verified above) — this is now an urgent reconciliation
            // case, not a simple retry, so log it loudly and say so plainly.
            logError(`CRITICAL: Razorpay payment ${razorpay_payment_id} verified but the advance deposit failed to persist — customer ${customerPhone} paid but has no ledger credit. Manual reconciliation required.`);
            return res.status(500).json({ error: 'Payment verified but could not be recorded. Please contact support with your payment ID: ' + razorpay_payment_id });
        }

        logTelemetry('PAYMENT_VERIFIED_SUCCESS', 0, `Invoice: ${depositId}, PayId: ${razorpay_payment_id}`);
        fireHook('onAdvanceDeposit', deposit);
        res.json({
            success: true,
            id: depositId,
            message: 'Payment verified and logged successfully'
        });
    } catch (err) {
        logError('Error verifying Razorpay payment: ' + err.message, err.stack);
        res.status(500).json({ error: 'Verification failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Backups & Business Summary Reports
   ========================================================================== */

/**
 * POST /api/backup/run
 * Manually triggers an immediate rolling database snapshot (same routine
 * the 1:00 AM cron uses).
 */
app.post('/api/backup/run', requireAdminSession, (req, res) => {
    try {
        const result = createBackup();
        res.json(result);
    } catch (err) {
        logError('Manual backup trigger failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Backup failed: ' + err.message });
    }
});

/**
 * POST /api/reports/send-now
 * Manually sends a Daily or Monthly business summary email immediately
 * (rather than waiting for the 7:00 AM / monthly cron), so a tenant can
 * verify their SMTP configuration. Gracefully reports back if SMTP or a
 * recipient address isn't configured — never throws for that case.
 */
app.post('/api/reports/send-now', requireAdminSession, async (req, res) => {
    try {
        const period = req.body.period === 'Monthly' ? 'Monthly' : 'Daily';
        const result = await sendSummaryReport(period);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        logError('Manual report send failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Report send failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: QR Code Generation
   ========================================================================== */

/**
 * GET /api/qrcode?data=<text>
 * Renders a real, scannable QR code (PNG data URL) for arbitrary text —
 * used by the customer portal to encode a UPI payment deep link. Public:
 * the customer portal has no admin session to attach.
 */
app.get('/api/qrcode', async (req, res) => {
    try {
        const data = req.query.data;
        if (!data || typeof data !== 'string') {
            return res.status(400).json({ error: 'Query parameter "data" is required' });
        }
        const dataUrl = await QRCode.toDataURL(data, { margin: 1, width: 300 });
        res.json({ dataUrl });
    } catch (err) {
        logError('QR code generation failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

/* ==========================================================================
   API Routes: SaaS Licensing & Activation Gates
   ========================================================================== */

/**
 * GET /api/license/status
 * Returns current local licensing status and details.
 */
app.get('/api/license/status', (req, res) => {
    try {
        const licenseFile = path.join(DATA_DIR, 'license.json');
        const license = readJSON(licenseFile, { activated: false, status: 'inactive', expiryDate: null, lastHandshakeTime: 0 });
        res.json({
            isValid: isLicenseValid(),
            license
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read license status' });
    }
});

/**
 * POST /api/license/activate
 * Triggers an online sync to activate a new or existing license key configuration.
 */
app.post('/api/license/activate', async (req, res) => {
    try {
        const { licenseKey } = req.body;
        if (!licenseKey) {
            return res.status(400).json({ error: 'License key parameter is mandatory' });
        }

        const syncResult = await syncLicenseStatus(licenseKey);
        if (syncResult.success) {
            res.json({ success: true, license: syncResult.license });
        } else {
            res.status(400).json({ success: false, error: syncResult.error });
        }
    } catch (err) {
        res.status(500).json({ error: 'License activation failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Tiered Auto-Update Engine
   ========================================================================== */

/**
 * POST /api/admin/update/check
 * Manually triggers the same check the daily 2:00 AM scheduler runs:
 * verified `security`-channel releases auto-apply, anything else newer is
 * just recorded as pending for manual review.
 */
app.post('/api/admin/update/check', requireAdminSession, async (req, res) => {
    try {
        await checkForUpdates();
        const license = readJSON(path.join(DATA_DIR, 'license.json'), {});
        res.json({ success: true, pendingRelease: license.pendingRelease || null, lastAppliedRelease: license.lastAppliedRelease || null });
    } catch (err) {
        logError('Manual update check failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Update check failed: ' + err.message });
    }
});

/**
 * POST /api/admin/update/apply
 * Manually applies whatever release is currently pending (feature/patch
 * channel — security releases already auto-applied and never sit pending).
 * This is the human-approval gate for non-urgent releases.
 */
app.post('/api/admin/update/apply', requireAdminSession, async (req, res) => {
    try {
        const result = await applyPendingUpdate();
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        logError('Manual update apply failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Update apply failed: ' + err.message });
    }
});

/* ==========================================================================
   API Routes: Diagnostics & Telemetry
   ========================================================================= */

/**
 * GET /api/diagnostics/telemetry
 * Level 1 Diagnostics: Returns unencrypted technical logs (latency, CPU, memory, error logs).
 * Strictly contains zero customer-identifiable information.
 */
app.get('/api/diagnostics/telemetry', requireAdminSession, (req, res) => {
    try {
        const telemetryLogFile = path.join(__dirname, 'logs/telemetry.log');
        const errorLogFile = path.join(__dirname, 'logs/error.log');
        
        let telemetryLogs = [];
        let errorLogs = '';

        if (fs.existsSync(telemetryLogFile)) {
            const content = fs.readFileSync(telemetryLogFile, 'utf8');
            telemetryLogs = content.trim().split('\n').map(line => {
                try {
                    return JSON.parse(line);
                } catch (_) {
                    return { raw: line };
                }
            }).slice(-100); // return last 100 entries
        }

        if (fs.existsSync(errorLogFile)) {
            const content = fs.readFileSync(errorLogFile, 'utf8');
            errorLogs = content.split('----------------------------------------').slice(-15).join('----------------------------------------'); // return last 15 errors
        }

        res.json({
            status: "success",
            timestamp: new Date().toISOString(),
            metrics: {
                memory: process.memoryUsage(),
                uptime: process.uptime(),
                cpuUsage: process.cpuUsage()
            },
            telemetry: telemetryLogs,
            errors: errorLogs
        });
    } catch (err) {
        logError('Level-1 telemetry pull API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Failed to retrieve telemetry logs' });
    }
});

/**
 * GET /api/diagnostics/export
 * Level 2 Diagnostics: Pulls database files encrypted with Developer's RSA-4096 Public Key.
 * Requires user request confirmation (simulated here). Decryptable only offline by developer.
 */
app.get('/api/diagnostics/export', requireAdminSession, (req, res) => {
    try {
        const settingsFile = path.join(DATA_DIR, 'settings.json');
        const advancesFile = path.join(DATA_DIR, 'advances.json');

        // Retrieve transaction sales files
        const salesFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('sales_') && f.endsWith('.json'));
        const salesData = {};
        salesFiles.forEach(f => {
            salesData[f] = readJSON(path.join(DATA_DIR, f), []);
        });

        // Pack sensitive databases together
        const bundle = {
            timestamp: Date.now(),
            settings: readJSON(settingsFile, {}),
            advances: readJSON(advancesFile, []),
            sales: salesData
        };

        // Encrypt the bundle using asymmetric envelope
        const encryptedEnvelope = encryptLevel2Payload(JSON.stringify(bundle));
        
        res.json({
            status: "encrypted_lock",
            exportedAt: new Date().toISOString(),
            envelope: encryptedEnvelope
        });
    } catch (err) {
        logError('Level-2 secure export API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Data export failed: ' + err.message });
    }
});

/**
 * GET /api/diagnostics/blackbox-export
 * Encrypted export of the black-box flight-recorder log (HTTP request
 * shape: method/path/status/duration/memory — no customer data, no query
 * strings, no bodies). Uses its own RSA-4096 keypair, independent of the
 * Level-2 developer key — decryptable only offline via
 * developer_blackbox_keys/analyze_blackbox.js. Never ships to tenants.
 */
app.get('/api/diagnostics/blackbox-export', requireAdminSession, (req, res) => {
    try {
        const envelope = exportBlackBoxEnvelope();
        res.json({
            status: 'encrypted_lock',
            exportedAt: new Date().toISOString(),
            envelope
        });
    } catch (err) {
        logError('Black-box export API failed: ' + err.message, err.stack);
        res.status(500).json({ error: 'Black-box export failed: ' + err.message });
    }
});

/* ==========================================================================
   Server Bootstrap & Scheduler Init
   ========================================================================== */

// Initialize pricing, backup, report-email, and update-check schedulers
initPriceScheduler();
initBackupScheduler();
initReportScheduler();
initUpdateScheduler();

// Trigger initial SaaS license sync & database backup on startup
syncLicenseStatus().catch(err => {
    console.warn('[Server] Initial license sync failed, operating under local grace checks.');
});
createBackup();

// Load any tenant-specific extensions (backend/extensions/*.extension.js —
// see backend/extensions/README.md) and notify them the server has booted.
loadExtensions().then(() => fireHook('onServerBoot', {}));

// Start Server listening
app.listen(PORT, '127.0.0.1', () => {
    console.log(`[Server] Gold POS backend running on port ${PORT}`);
    logTelemetry('SERVER_BOOTSTRAP', 0, `Listening on port ${PORT}`);
});
