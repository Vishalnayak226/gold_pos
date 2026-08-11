/**
 * ==========================================================================
 * Reproducible seeded dev/test data.
 *
 *   node backend/seed.js [--out <dir>] [--force]
 *
 * Builds a complete, populated tenant database from nothing: settings, an
 * active licence, fixed gold rates, customer logins, an advances ledger with
 * every status represented, and two years of invoices.
 *
 * Three properties matter, and they are the reason this exists rather than a
 * developer just clicking around for ten minutes:
 *
 *   Reproducible. Every value is either a constant or drawn from the seeded
 *   PRNG below, and dates are derived from a fixed epoch rather than "now".
 *   Two runs a month apart produce byte-identical files, so a Playwright
 *   assertion can name an exact balance and stay true.
 *
 *   Synthetic. Names, phone numbers and emails are invented. Phones use the
 *   90000000xx block and emails the reserved example.test domain, so nothing
 *   here can dial or mail a real person if a fixture leaks into a log, a
 *   screenshot or a support bundle. No production data is ever copied.
 *
 *   Isolated. It refuses to write into the live backend/data directory unless
 *   forced, because fixture debris in a real ledger looks exactly like a bug
 *   (CLAUDE.md §8) — and because a seeded advances.json overwriting a tenant's
 *   is the single most destructive thing a dev script here could do.
 * ==========================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
// Returns are priced by the same function the Return Desk previews with and
// POST /api/returns files with. Hand-computing them here would produce a
// fixture that agrees with itself and disagrees with the app.
import { computeReturnRefund } from '../frontend/js/lib/billingMath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DATA_DIR = path.resolve(path.join(__dirname, 'data'));

/* --------------------------------------------------------------------------
   Determinism
   -------------------------------------------------------------------------- */

// mulberry32: 32-bit, seedable, ~10 lines. Math.random cannot be seeded, and a
// fixture set that changes between runs cannot be asserted against.
function makeRandom(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SEED = 20260808;
const random = makeRandom(SEED);

/** Deterministic integer in [min, max]. */
function pick(min, max) {
    return min + Math.floor(random() * (max - min + 1));
}

/** Deterministic element of an array. */
function choose(items) {
    return items[pick(0, items.length - 1)];
}

// Fixed clock. 2026-01-05T09:00:00Z — a Monday morning, so weekday-sensitive
// reporting has something sensible to group.
const EPOCH = Date.UTC(2026, 0, 5, 9, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

/** A timestamp `days` after the fixed epoch, at a deterministic time of day. */
function at(days, hour = 11, minute = 30) {
    return EPOCH + days * DAY_MS + (hour * 60 + minute) * 60 * 1000;
}

/**
 * Deterministic document ids. Deliberately NOT db.js's newId(): that one is
 * cryptographically random by design, which is correct for a real ledger and
 * fatal for a reproducible fixture.
 */
let idCounter = 0;
function seededId(prefix) {
    idCounter += 1;
    return `${prefix}-SEED${String(idCounter).padStart(4, '0')}`;
}

/* --------------------------------------------------------------------------
   Synthetic people

   Invented names, the 90000000xx phone block, and @example.test addresses
   (RFC 2606 reserves .test — it can never resolve).
   -------------------------------------------------------------------------- */

const CUSTOMERS = [
    { phone: '9000000001', name: 'Aarti Deshmukh', email: 'aarti@example.test', password: 'SeedPass!2026' },
    { phone: '9000000002', name: 'Rohan Iyer', email: 'rohan@example.test', password: 'SeedPass!2026' },
    { phone: '9000000003', name: 'Meera Kulkarni', email: 'meera@example.test', password: 'SeedPass!2026' },
    { phone: '9000000004', name: 'Sanjay Pillai', email: 'sanjay@example.test', password: 'SeedPass!2026' }
];

const WALK_IN_NAMES = ['Kavya Rao', 'Imran Shaikh', 'Nisha Verma', 'Devan Nair', 'Priya Menon'];

// Fixed, not synced. A fixture whose gold rate moves with the market cannot be
// asserted against either.
const SEED_RATES = {
    lastUpdated: new Date(EPOCH).toISOString(),
    status: 'seeded',
    price24K: 7500.0,
    price22K: 6875.0,
    price18K: 5625.0
};

const SEED_ADMIN_PIN = '4729';

/* --------------------------------------------------------------------------
   Builders
   -------------------------------------------------------------------------- */

function buildSettings() {
    return {
        companyName: 'Seedhaven Jewellers (Demo Data)',
        address: '12 Example Bazaar Road, Testville',
        phone: '9000000000',
        gstNumber: '29AASEED1234F1Z',
        goldTaxSlab: 3.0,
        taxMode: 'Exclusive',
        defaultDiscountPercent: 0,
        invoicePrefix: 'SEED',
        // Left where the generated invoices below end, so the next sale a
        // developer books continues the sequence instead of colliding.
        invoiceSeqStart: 1,
        reportEmail: 'reports@example.test',
        smtp: { host: '', port: 587, secure: false, user: '', pass: '', fromName: '' },
        // 'mock' keeps the seeded dataset offline and deterministic — no
        // outbound call to Yahoo Finance on boot. productionGuard.js treats
        // this as a fatal blocker under NODE_ENV=production, which is the
        // intended relationship: seeded data must never boot a live install.
        goldApiProvider: 'mock',
        razorpayKeyId: 'rzp_test_xxxxxx',
        razorpayKeySecret: 'rzp_test_xxxxxx_secret',
        razorpayWebhookSecret: 'seed_webhook_secret_do_not_use_in_production',
        upiId: 'seedhaven@examplebank',
        adminPin: SEED_ADMIN_PIN,
        overrideGoldPrice: { active: false, price24K: 0.0, price22K: 0.0, price18K: 0.0 },
        currency: 'INR',
        publicUrl: ''
    };
}

function buildLicense() {
    return {
        licenseKey: 'SEED-DEMO-0000-0000',
        activated: true,
        status: 'active',
        // Far future: the fixture must not start failing its licence gate
        // because time passed since it was written.
        expiryDate: new Date(Date.UTC(2099, 11, 31)).toISOString(),
        lastHandshakeTime: EPOCH
    };
}

/**
 * The advances ledger, covering every state the balance arithmetic
 * distinguishes — approved, pending, rejected, redeemed — because a fixture
 * that only contains the happy path cannot catch a regression in the others.
 */
function buildAdvances() {
    const rows = [];

    // Aarti: two approved deposits and one redemption against an invoice.
    rows.push({
        id: seededId('ADV'), customerPhone: CUSTOMERS[0].phone, customerName: CUSTOMERS[0].name,
        type: 'deposit', amount: 25000, paymentMethod: 'Razorpay', referenceId: 'pay_seed_aarti_001',
        status: 'approved', lockedGoldRate22K: SEED_RATES.price22K, timestamp: at(2)
    });
    rows.push({
        id: seededId('ADV'), customerPhone: CUSTOMERS[0].phone, customerName: CUSTOMERS[0].name,
        type: 'deposit', amount: 15000, paymentMethod: 'Cash', referenceId: '',
        status: 'approved', lockedGoldRate22K: SEED_RATES.price22K, timestamp: at(9)
    });

    // Rohan: one approved, one still awaiting counter approval. The pending row
    // must NOT read as spendable balance anywhere in the UI.
    rows.push({
        id: seededId('ADV'), customerPhone: CUSTOMERS[1].phone, customerName: CUSTOMERS[1].name,
        type: 'deposit', amount: 10000, paymentMethod: 'UPI', referenceId: 'UTR-SEED-ROHAN-01',
        status: 'approved', lockedGoldRate22K: SEED_RATES.price22K, timestamp: at(4)
    });
    rows.push({
        id: seededId('ADV'), customerPhone: CUSTOMERS[1].phone, customerName: CUSTOMERS[1].name,
        type: 'deposit', amount: 7500, paymentMethod: 'UPI', referenceId: 'UTR-SEED-ROHAN-02',
        status: 'pending', lockedGoldRate22K: SEED_RATES.price22K, timestamp: at(12)
    });

    // Meera: a rejected claim. Must count for nothing at all.
    rows.push({
        id: seededId('ADV'), customerPhone: CUSTOMERS[2].phone, customerName: CUSTOMERS[2].name,
        type: 'deposit', amount: 5000, paymentMethod: 'UPI', referenceId: 'UTR-SEED-MEERA-01',
        status: 'rejected', reviewNote: 'No matching transfer found in the bank statement.',
        lockedGoldRate22K: SEED_RATES.price22K, timestamp: at(6)
    });

    return rows;
}

/**
 * Invoices across two calendar years, so the annual partitioning in
 * /api/sales (sales_YYYY.json) is actually exercised by the fixture.
 */
function buildSales(advances) {
    const sales = { };
    let sequence = 1;

    const addSale = ({ dayOffset, purity, weight, customer, makingPercent, discountPercent, appliedAdvance = 0 }) => {
        const rateKey = purity === '24K' ? 'price24K' : purity === '22K' ? 'price22K' : 'price18K';
        const rate = SEED_RATES[rateKey];
        const metalValue = round2(weight * rate);
        const makingChargeAmount = round2(metalValue * (makingPercent / 100));
        const discount = round2((metalValue + makingChargeAmount) * (discountPercent / 100));
        const taxableAmount = round2(metalValue + makingChargeAmount - discount);
        const taxAmount = round2(taxableAmount * 0.03);
        const totalAmount = round2(taxableAmount + taxAmount - appliedAdvance);

        const timestamp = at(dayOffset, pick(10, 18), pick(0, 59));
        const year = new Date(timestamp).getUTCFullYear();
        const invoiceId = `SEED-${String(sequence).padStart(6, '0')}-${String(year).slice(-2)}`;
        sequence += 1;

        const sale = {
            id: invoiceId,
            timestamp,
            customerName: customer.name,
            customerPhone: customer.phone || '',
            purity,
            weightGrams: weight,
            goldPricePerGram: rate,
            goldRateSource: 'auto',
            metalValue,
            makingChargePercent: makingPercent,
            makingChargeAmount,
            taxPercent: 3.0,
            taxMode: 'Exclusive',
            taxableAmount,
            taxAmount,
            discountPercent,
            discount,
            appliedAdvance,
            totalAmount
        };

        if (!sales[year]) sales[year] = [];
        sales[year].push(sale);
        return sale;
    };

    // A deliberate spread: cash sales, named customers, every purity, a
    // discounted invoice, and one that redeems an advance.
    addSale({ dayOffset: 3, purity: '22K', weight: 8.5, customer: { name: choose(WALK_IN_NAMES), phone: '' }, makingPercent: 12, discountPercent: 0 });
    addSale({ dayOffset: 5, purity: '24K', weight: 4.0, customer: CUSTOMERS[3], makingPercent: 8, discountPercent: 0 });
    addSale({ dayOffset: 11, purity: '18K', weight: 12.25, customer: { name: choose(WALK_IN_NAMES), phone: '' }, makingPercent: 15, discountPercent: 5 });

    // Aarti redeems ₹20,000 of her ₹40,000 approved balance.
    const redeemed = 20000;
    const redemptionSale = addSale({
        dayOffset: 14, purity: '22K', weight: 15.0, customer: CUSTOMERS[0],
        makingPercent: 10, discountPercent: 0, appliedAdvance: redeemed
    });
    advances.push({
        id: seededId('RED'),
        customerPhone: CUSTOMERS[0].phone,
        customerName: CUSTOMERS[0].name,
        type: 'redeem',
        amount: redeemed,
        invoiceId: redemptionSale.id,
        timestamp: redemptionSale.timestamp
    });

    // Second year, so sales_2027.json exists alongside sales_2026.json.
    addSale({ dayOffset: 372, purity: '22K', weight: 6.0, customer: CUSTOMERS[2], makingPercent: 12, discountPercent: 0 });
    addSale({ dayOffset: 380, purity: '24K', weight: 2.5, customer: { name: choose(WALK_IN_NAMES), phone: '' }, makingPercent: 9, discountPercent: 0 });

    return { sales, nextSequence: sequence };
}

/**
 * Returns against two of the seeded invoices — one refunded in cash, one in
 * gold credit — so the Return Desk, the credit note, and the customer
 * portal's return rows all have something real to render on a fresh seed.
 *
 * A gold refund writes a matching approved deposit into the advances ledger,
 * exactly as POST /api/returns does, so the fixture's balances stay consistent
 * with the rows that explain them.
 */
function buildReturns(sales, advances) {
    const allSales = Object.values(sales).flat();
    const byId = (id) => allSales.find(s => s.id === id);
    const rows = [];

    const file = (sale, { weight, refundMode, dayOffset, note }) => {
        const priced = computeReturnRefund({ sale, returnWeightGrams: weight });
        if (!priced.ok) throw new Error(`Seed return could not be priced: ${priced.error}`);

        const returnId = seededId('RET');
        const timestamp = at(dayOffset, 15, 20);
        const record = {
            id: returnId,
            timestamp,
            originalInvoiceId: sale.id,
            originalTimestamp: sale.timestamp,
            customerName: sale.customerName,
            customerPhone: sale.customerPhone || '',
            purity: priced.purity,
            weightGrams: priced.weightGrams,
            originalWeightGrams: sale.weightGrams,
            goldPricePerGram: priced.goldPricePerGram,
            makingChargePercent: priced.makingChargePercent,
            discountPercent: priced.discountPercent,
            taxPercent: priced.taxPercent,
            taxMode: priced.taxMode,
            metalValue: priced.components.metalValue,
            makingChargeAmount: priced.components.makingChargeAmount,
            discount: priced.components.discountAmount,
            taxableAmount: priced.components.taxableAmount,
            taxAmount: priced.components.taxAmount,
            itemised: true,
            refundAmount: priced.refundAmount,
            refundMode,
            closesInvoice: priced.closesInvoice,
            note: note || ''
        };

        if (refundMode === 'gold') {
            const creditId = seededId('ADV');
            record.advanceCreditId = creditId;
            record.lockedGoldRate22K = SEED_RATES.price22K;
            advances.push({
                id: creditId,
                customerPhone: sale.customerPhone,
                customerName: sale.customerName,
                type: 'deposit',
                amount: priced.refundAmount,
                paymentMethod: 'Return Credit',
                referenceId: '',
                status: 'approved',
                source: 'return',
                invoiceId: sale.id,
                returnId,
                lockedGoldRate22K: SEED_RATES.price22K,
                timestamp
            });
        }

        rows.push(record);
        return record;
    };

    // A walk-in with no phone brings back part of an 8.5 g chain — cash only,
    // because there is no account to credit.
    file(byId('SEED-000001-26'), {
        weight: 3.5, refundMode: 'cash', dayOffset: 9,
        note: 'Clasp faulty — partial return, remainder kept.'
    });

    // Sanjay returns his 24K coin outright and takes the value as gold credit,
    // which shows on his portal immediately.
    file(byId('SEED-000002-26'), {
        weight: 4.0, refundMode: 'gold', dayOffset: 16,
        note: 'Returned unopened; customer opted for gold credit.'
    });

    // Aarti returns 5 g of the 15 g bangle she part-paid with advance credit,
    // refunded in cash. The interesting case: the refund is a share of what
    // the invoice CHARGED (₹20,000 of advance included), not of the cash she
    // handed over — and taking it in cash leaves her advance balance alone.
    file(byId('SEED-000004-26'), {
        weight: 5.0, refundMode: 'cash', dayOffset: 21,
        note: 'Resized down; difference refunded in cash.'
    });

    // Partitioned by the year the refund happened, like sales.
    const byYear = {};
    for (const row of rows) {
        const year = new Date(row.timestamp).getUTCFullYear();
        (byYear[year] ||= []).push(row);
    }
    return byYear;
}

/** Local copy of billingMath's rounding, so seeding needs no cross-imports. */
function round2(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Customer portal logins.
 *
 * customerAuth.hashPassword() cannot be used here: it draws a random salt,
 * which is exactly right for a real account and fatal for a reproducible
 * fixture — customer_auth.json would differ on every run. These accounts are
 * synthetic and their passwords are printed on stdout, so a fixed salt costs
 * nothing.
 *
 * Drift is prevented by verification rather than by sharing the generator:
 * every record produced below is fed back through the real verifyPassword()
 * before the file is written, so a change to the stored-hash format fails the
 * seeder loudly instead of silently producing accounts nobody can log into.
 */
const SEED_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

async function buildCustomerAuth() {
    const { verifyPassword } = await import('./customerAuth.js');

    return CUSTOMERS.map((customer, index) => {
        // Salt derived from the account itself: stable across runs, still
        // distinct per account (so the fixture does not accidentally model
        // every user sharing one salt).
        const salt = crypto.createHash('sha256')
            .update(`gold-pos-seed:${SEED}:${customer.phone}`)
            .digest('hex')
            .slice(0, 32);
        const derived = crypto.scryptSync(customer.password, salt, SEED_SCRYPT.keylen, {
            N: SEED_SCRYPT.N, r: SEED_SCRYPT.r, p: SEED_SCRYPT.p
        });
        const passwordHash = `scrypt$${SEED_SCRYPT.N}$${SEED_SCRYPT.r}$${SEED_SCRYPT.p}$${derived.toString('hex')}`;

        if (!verifyPassword(customer.password, { passwordHash, salt })) {
            throw new Error(
                `Seeded credentials for ${customer.phone} do not verify against customerAuth.verifyPassword(). ` +
                'The stored password-hash format has changed — update SEED_SCRYPT in backend/seed.js to match.'
            );
        }

        return {
            phone: customer.phone,
            name: customer.name,
            email: customer.email,
            passwordHash,
            salt,
            // One account deliberately starts in the forced-change state, so
            // that branch of the login flow has a fixture too.
            mustChangePassword: index === 3,
            notifyEmail: true,
            notifyPush: false,
            resetTokenHash: null,
            resetExpires: 0,
            resetAttempts: 0,
            failedAttempts: 0,
            lockedUntil: 0,
            sessions: [],
            createdAt: at(index),
            updatedAt: at(index)
        };
    });
}

/* --------------------------------------------------------------------------
   Entry point
   -------------------------------------------------------------------------- */

function parseArgs(argv) {
    const args = { out: null, force: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') args.out = argv[++i];
        else if (argv[i] === '--force') args.force = true;
    }
    return args;
}

export async function seed({ out, force = false } = {}) {
    const target = path.resolve(
        out || process.env.GOLD_POS_DATA_DIR || process.env.GOLDPOS_DATA_DIR || path.join(__dirname, 'data-seed')
    );

    if (target === LIVE_DATA_DIR && !force) {
        throw new Error(
            `Refusing to seed over the live database at ${LIVE_DATA_DIR}.\n` +
            'Seeding replaces settings.json, advances.json and every sales file in the target.\n' +
            'Pass --out <dir> to write elsewhere, or --force if you genuinely mean to overwrite it.'
        );
    }

    fs.mkdirSync(target, { recursive: true });

    // Point db.js at the target BEFORE customerAuth.js is imported below.
    // db.js resolves DATA_DIR once at import time and initialises the files it
    // finds missing, so without this a seed run into --out would still touch
    // the default backend/data directory on the way past.
    if (!process.env.GOLD_POS_DATA_DIR && !process.env.GOLDPOS_DATA_DIR) {
        process.env.GOLD_POS_DATA_DIR = target;
    }

    const advances = buildAdvances();
    const { sales, nextSequence } = buildSales(advances);
    // After buildSales — a return needs the invoice it reverses to exist, and
    // a gold refund appends its credit row to the same advances ledger.
    const returns = buildReturns(sales, advances);

    const settings = buildSettings();
    settings.invoiceSeqStart = nextSequence;

    const files = {
        'settings.json': settings,
        'license.json': buildLicense(),
        'rates.json': SEED_RATES,
        // Sorted newest-first, matching what /api/advances serves, so a fixture
        // read straight off disk and one read through the API agree.
        'advances.json': advances.sort((a, b) => b.timestamp - a.timestamp),
        'customer_auth.json': await buildCustomerAuth(),
        'payment_orders.json': [],
        'payment_events.json': []
    };

    for (const [year, rows] of Object.entries(sales)) {
        files[`sales_${year}.json`] = rows;
    }

    for (const [year, rows] of Object.entries(returns)) {
        files[`returns_${year}.json`] = rows;
    }

    for (const [name, data] of Object.entries(files)) {
        fs.writeFileSync(path.join(target, name), JSON.stringify(data, null, 2), 'utf8');
    }

    return {
        target,
        files: Object.keys(files).sort(),
        adminPin: SEED_ADMIN_PIN,
        // Where the invoice sequence is left, so a test can assert that a
        // refused sale did not consume a number.
        nextInvoiceSeq: nextSequence,
        customers: CUSTOMERS.map(c => ({ phone: c.phone, name: c.name, password: c.password })),
        salesCount: Object.values(sales).reduce((sum, rows) => sum + rows.length, 0),
        advancesCount: advances.length,
        returnsCount: Object.values(returns).reduce((sum, rows) => sum + rows.length, 0)
    };
}

// Only when run directly, never on import — the Playwright fixture imports
// seed() and calls it against its own temp directory.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    const args = parseArgs(process.argv.slice(2));
    seed(args).then(result => {
        console.log(`\nSeeded ${result.salesCount} invoices, ${result.returnsCount} returns and ${result.advancesCount} advance rows into:`);
        console.log(`  ${result.target}\n`);
        console.log('Files written: ' + result.files.join(', '));
        console.log(`\nAdmin PIN:  ${result.adminPin}`);
        console.log('Customer logins (portal at /customer.html):');
        result.customers.forEach(c => console.log(`  ${c.phone}  ${c.password}   (${c.name})`));
        console.log('\nRun the server against it with:');
        console.log(`  GOLD_POS_DATA_DIR="${result.target}" node backend/server.js`);
        console.log(`  $env:GOLD_POS_DATA_DIR="${result.target}"; node backend/server.js   # PowerShell\n`);
    }).catch(err => {
        console.error('\nSeeding failed:\n' + err.message + '\n');
        process.exit(1);
    });
}

export { CUSTOMERS as SEED_CUSTOMERS, SEED_ADMIN_PIN, SEED_RATES };
