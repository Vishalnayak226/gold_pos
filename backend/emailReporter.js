/**
 * ==========================================================================
 * Backup & Business Summary Report Emails
 * Wires the already-installed nodemailer dependency into daily/monthly HTML
 * summary emails. Gracefully no-ops (logs + returns) whenever SMTP creds or
 * a recipient address aren't configured — the same "degrade, don't crash"
 * pattern the gold price/Razorpay integrations already use for missing keys.
 * ==========================================================================
 */

import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { readJSON, DATA_DIR, logError, logTelemetry } from './db.js';

function getTransporter(settings) {
    const smtp = settings.smtp;
    if (!smtp || !smtp.host || !smtp.user || !smtp.pass) return null;
    return nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port || 587,
        secure: !!smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass }
    });
}

/**
 * Aggregates sales + advances activity since periodStart, plus the most
 * recent backup snapshot folder, into a plain summary object.
 */
function computeSummary(periodStart) {
    const files = fs.readdirSync(DATA_DIR);

    let sales = [];
    files.forEach(f => {
        if (f.startsWith('sales_') && f.endsWith('.json')) {
            sales = sales.concat(readJSON(path.join(DATA_DIR, f), []));
        }
    });
    const periodSales = sales.filter(s => (s.timestamp || 0) >= periodStart);
    const revenue = periodSales.reduce((sum, s) => sum + (parseFloat(s.totalAmount) || 0), 0);

    const advances = readJSON(path.join(DATA_DIR, 'advances.json'), []);
    const periodDeposits = advances.filter(a => a.type === 'deposit' && (a.timestamp || 0) >= periodStart);
    const depositTotal = periodDeposits.reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);

    const balances = new Map();
    advances.forEach(a => {
        const delta = a.type === 'deposit' ? parseFloat(a.amount) : -parseFloat(a.amount);
        balances.set(a.customerPhone, (balances.get(a.customerPhone) || 0) + (delta || 0));
    });
    let outstandingTotal = 0;
    balances.forEach(b => { if (b > 0) outstandingTotal += b; });

    const backupsDir = path.join(process.cwd(), 'backups');
    let latestBackup = 'None';
    if (fs.existsSync(backupsDir)) {
        const folders = fs.readdirSync(backupsDir).filter(f => f.startsWith('backup_')).sort();
        if (folders.length > 0) latestBackup = folders[folders.length - 1];
    }

    return {
        invoiceCount: periodSales.length,
        revenue,
        depositCount: periodDeposits.length,
        depositTotal,
        outstandingTotal,
        latestBackup
    };
}

function buildSummaryHtml(summary, periodLabel, companyName) {
    const inr = (n) => `₹${(n || 0).toLocaleString('en-IN')}`;
    return `
        <div style="font-family:Arial,sans-serif; max-width:520px; margin:0 auto; color:#1e293b;">
            <h2 style="border-bottom:2px solid #0f172a; padding-bottom:10px;">${periodLabel} Business Summary — ${companyName || 'Gold POS'}</h2>
            <table style="width:100%; border-collapse:collapse; font-size:14px; margin-top:15px;">
                <tr><td style="padding:8px 0; color:#64748b;">Invoices (${periodLabel.toLowerCase()})</td><td style="text-align:right; font-weight:bold;">${summary.invoiceCount}</td></tr>
                <tr><td style="padding:8px 0; color:#64748b;">Revenue (${periodLabel.toLowerCase()})</td><td style="text-align:right; font-weight:bold;">${inr(summary.revenue)}</td></tr>
                <tr><td style="padding:8px 0; color:#64748b;">Advance deposits (${periodLabel.toLowerCase()})</td><td style="text-align:right; font-weight:bold;">${summary.depositCount} (${inr(summary.depositTotal)})</td></tr>
                <tr><td style="padding:8px 0; color:#64748b;">Total outstanding advances</td><td style="text-align:right; font-weight:bold;">${inr(summary.outstandingTotal)}</td></tr>
                <tr><td style="padding:8px 0; color:#64748b;">Latest database backup</td><td style="text-align:right; font-weight:bold;">${summary.latestBackup}</td></tr>
            </table>
            <p style="font-size:11px; color:#94a3b8; margin-top:20px;">Automated report from your Gold POS system. No customer-identifiable data is included beyond aggregate totals.</p>
        </div>
    `;
}

/**
 * Sends one arbitrary transactional email through the tenant's configured
 * SMTP transport — the customer password-reset mail, and later the scheme
 * due/overdue reminders, all share this one path.
 *
 * Follows the same "degrade, don't crash" contract as sendSummaryReport():
 * returns `{success:false, reason}` when SMTP isn't configured instead of
 * throwing, so a store that never set up email still gets a clear message
 * rather than a 500.
 */
export async function sendMailIfConfigured({ to, subject, html }) {
    const settings = readJSON(path.join(DATA_DIR, 'settings.json'), {});
    const transporter = getTransporter(settings);
    if (!transporter) {
        return { success: false, reason: 'SMTP is not configured on this store. Please contact the store directly.' };
    }
    if (!to) {
        return { success: false, reason: 'No recipient email address available.' };
    }

    const fromName = (settings.smtp && settings.smtp.fromName) || settings.companyName || 'Gold POS';
    try {
        await transporter.sendMail({
            from: `"${fromName}" <${settings.smtp.user}>`,
            to,
            subject,
            html
        });
        logTelemetry('TRANSACTIONAL_EMAIL_SENT', 0, `Subject: ${subject}`);
        return { success: true };
    } catch (err) {
        logError(`Failed to send transactional email "${subject}": ${err.message}`, err.stack);
        return { success: false, reason: err.message };
    }
}

/**
 * Sends a Daily or Monthly summary report. Returns a result object rather
 * than throwing, so callers (cron ticks, the manual "send now" endpoint)
 * can report success/skip/failure without a try/catch at every call site.
 */
export async function sendSummaryReport(periodLabel = 'Daily') {
    const settingsFile = path.join(DATA_DIR, 'settings.json');
    const settings = readJSON(settingsFile, {});

    const transporter = getTransporter(settings);
    if (!transporter) {
        logTelemetry('REPORT_EMAIL_SKIPPED', 0, `${periodLabel} report skipped — SMTP not configured.`);
        return { success: false, reason: 'SMTP not configured. Set Host/User/Password in Settings > Backup & Email.' };
    }
    if (!settings.reportEmail) {
        logTelemetry('REPORT_EMAIL_SKIPPED', 0, `${periodLabel} report skipped — no recipient configured.`);
        return { success: false, reason: 'No report recipient email configured.' };
    }

    const now = new Date();
    const periodStart = periodLabel === 'Monthly'
        ? new Date(now.getFullYear(), now.getMonth(), 1).getTime()
        : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    const summary = computeSummary(periodStart);
    const html = buildSummaryHtml(summary, periodLabel, settings.companyName);
    const fromName = settings.smtp.fromName || settings.companyName || 'Gold POS';

    try {
        await transporter.sendMail({
            from: `"${fromName}" <${settings.smtp.user}>`,
            to: settings.reportEmail,
            subject: `${periodLabel} Business Summary — ${settings.companyName || 'Gold POS'}`,
            html
        });
        logTelemetry('REPORT_EMAIL_SENT', 0, `${periodLabel} report sent to ${settings.reportEmail}`);
        return { success: true };
    } catch (err) {
        logError(`Failed to send ${periodLabel} report email: ${err.message}`, err.stack);
        return { success: false, reason: err.message };
    }
}

/**
 * Cron Scheduler
 * Daily: 7:00 AM. Monthly: 1st of the month at 7:30 AM (after the 1:00 AM
 * backup and any midnight price sync have both already run).
 */
export function initReportScheduler() {
    cron.schedule('0 7 * * *', () => {
        console.log('[Scheduler] Sending daily business summary report...');
        sendSummaryReport('Daily');
    });
    cron.schedule('30 7 1 * *', () => {
        console.log('[Scheduler] Sending monthly business summary report...');
        sendSummaryReport('Monthly');
    });
    console.log('[Scheduler] Daily 7:00 AM / Monthly 1st 7:30 AM report email scheduler initialized.');
}
