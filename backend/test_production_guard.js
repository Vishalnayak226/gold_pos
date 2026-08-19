/**
 * ==========================================================================
 * Production startup guard suite.
 *
 * findProductionBlockers() is pure and takes both settings and env as
 * arguments precisely so it can be asserted without setting NODE_ENV=production
 * in a test process (which would arm the real assertProductionReady() and kill
 * the runner).
 *
 * The final case boots a real server process with NODE_ENV=production against
 * a deliberately unsafe database, and asserts it exits non-zero — because a
 * guard that is only unit-tested is a guard nobody has confirmed is wired in.
 *
 * Native assert only. Zero extra dependencies.
 * ==========================================================================
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { findProductionBlockers } from './productionGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(label, fn) {
    fn();
    passed++;
    console.log(`  ✅ ${label}`);
}

/** A settings object that should pass every check, before we break one field. */
function safeSettings(overrides = {}) {
    return {
        razorpayKeyId: 'rzp_live_realkey',
        razorpayKeySecret: 'a-real-secret',
        razorpayWebhookSecret: 'a-real-webhook-secret',
        publicUrl: 'https://pos.example.com',
        adminPin: '8391',
        goldApiProvider: 'public',
        ...overrides
    };
}

console.log('======================================================================');
console.log('PRODUCTION STARTUP GUARD');
console.log('======================================================================');

/* ==========================================================================
   A safe configuration must not be blocked. This is the case that keeps the
   guard from becoming something people work around.
   ========================================================================== */
check('a fully configured production install passes', () => {
    assert.deepStrictEqual(findProductionBlockers(safeSettings(), {}), []);
});

check('ENV_NAME=production alongside NODE_ENV=production passes', () => {
    assert.deepStrictEqual(findProductionBlockers(safeSettings(), { ENV_NAME: 'production' }), []);
});

check('PUBLIC_URL from the environment satisfies the public-URL requirement', () => {
    const blockers = findProductionBlockers(
        safeSettings({ publicUrl: '' }),
        { PUBLIC_URL: 'https://pos.example.com' }
    );
    assert.deepStrictEqual(blockers, []);
});

/* ==========================================================================
   Each hazard, in isolation.
   ========================================================================== */
check('demo Razorpay key id is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ razorpayKeyId: 'rzp_test_xxxxxx' }), {});
    assert.strictEqual(blockers.length, 1, `expected exactly one blocker, got: ${blockers.join(' | ')}`);
    assert.match(blockers[0], /demo credentials/i);
});

check('demo Razorpay secret is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ razorpayKeySecret: 'rzp_test_xxxxxx_secret' }), {});
    assert.match(blockers.join(' '), /demo credentials/i);
});

check('missing Razorpay credentials are blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ razorpayKeyId: '', razorpayKeySecret: '' }), {});
    assert.match(blockers.join(' '), /not configured/i);
});

check('a missing webhook secret is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ razorpayWebhookSecret: '' }), {});
    assert.strictEqual(blockers.length, 1);
    assert.match(blockers[0], /webhook secret/i);
});

check('the default admin PIN is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ adminPin: '1234' }), {});
    assert.strictEqual(blockers.length, 1);
    assert.match(blockers[0], /shipped default/i);
});

check('an empty admin PIN is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ adminPin: '' }), {});
    assert.match(blockers.join(' '), /No admin PIN/i);
});

check('a missing public URL is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ publicUrl: '' }), {});
    assert.strictEqual(blockers.length, 1);
    assert.match(blockers[0], /public URL/i);
});

check('a plaintext http public URL is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ publicUrl: 'http://pos.example.com' }), {});
    assert.strictEqual(blockers.length, 1);
    assert.match(blockers[0], /https/i);
});

check('the mock gold price provider is blocked', () => {
    const blockers = findProductionBlockers(safeSettings({ goldApiProvider: 'mock' }), {});
    assert.strictEqual(blockers.length, 1);
    assert.match(blockers[0], /mock/i);
});

check('NODE_ENV=production with ENV_NAME=staging is blocked as environment confusion', () => {
    const blockers = findProductionBlockers(safeSettings(), { ENV_NAME: 'staging' });
    assert.strictEqual(blockers.length, 1);
    assert.match(blockers[0], /ENV_NAME/);
});

/* ==========================================================================
   Every hazard at once — an operator must get the whole list in one pass, not
   one failed boot per mistake.
   ========================================================================== */
check('a stock demo install reports every blocker at once', () => {
    const blockers = findProductionBlockers({
        razorpayKeyId: 'rzp_test_xxxxxx',
        razorpayKeySecret: 'rzp_test_xxxxxx_secret',
        razorpayWebhookSecret: '',
        publicUrl: '',
        adminPin: '1234',
        goldApiProvider: 'mock'
    }, { ENV_NAME: 'staging' });

    assert.strictEqual(blockers.length, 6, `expected 6 blockers, got ${blockers.length}: ${blockers.join(' | ')}`);
});

/* ==========================================================================
   Wiring: the real server process must actually die.
   ========================================================================== */
function bootProductionServer(settings, envOverrides = {}) {
    return new Promise((resolve) => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-pos-guard-'));
        const dataDir = path.join(tempRoot, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));

        const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
            cwd: __dirname,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                ENV_NAME: 'production',
                // Port 0 lets the OS assign, so a guard that WRONGLY allows the
                // boot cannot collide with a dev server on :5000.
                PORT: '0',
                GOLD_POS_DATA_DIR: dataDir,
                GOLD_POS_LOGS_DIR: path.join(tempRoot, 'logs'),
                /* A valid vault key by default. In production the secret vault
                   refuses to invent one, and that refusal fires before any other
                   check — so without this every boot below would stop at the key
                   and never reach the blocker it is actually testing. The boot
                   that tests the key itself overrides this back to ''. */
                GOLD_POS_SECRET_KEY: 'a'.repeat(64),
                ...envOverrides
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let output = '';
        child.stdout.on('data', c => { output += c; });
        child.stderr.on('data', c => { output += c; });

        // If the guard fails to fire, the process stays up serving — so treat
        // "still alive" as the failure it is rather than hanging the suite.
        const timer = setTimeout(() => {
            child.kill();
            resolve({ code: null, output, timedOut: true, tempRoot });
        }, 15000);

        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, output, timedOut: false, tempRoot });
        });
    });
}

const unsafeBoot = await bootProductionServer({
    companyName: 'Guard Test',
    razorpayKeyId: 'rzp_test_xxxxxx',
    razorpayKeySecret: 'rzp_test_xxxxxx_secret',
    razorpayWebhookSecret: '',
    publicUrl: '',
    adminPin: '1234',
    goldApiProvider: 'mock'
});
fs.rmSync(unsafeBoot.tempRoot, { recursive: true, force: true });

check('the real server exits non-zero when started in production with demo settings', () => {
    assert.strictEqual(unsafeBoot.timedOut, false,
        'server was still running 15s after boot — the production guard did not fire');
    assert.strictEqual(unsafeBoot.code, 1, `expected exit code 1, got ${unsafeBoot.code}`);
});

const noKeyBoot = await bootProductionServer({
    companyName: 'Guard Test',
    razorpayKeyId: 'rzp_live_real',
    razorpayKeySecret: 'rzp_live_real_secret',
    razorpayWebhookSecret: 'whsec_real',
    publicUrl: 'https://app.example.com',
    adminPin: '481625',
    goldApiProvider: 'public'
}, { GOLD_POS_SECRET_KEY: '' });
fs.rmSync(noKeyBoot.tempRoot, { recursive: true, force: true });

check('a production boot with no vault key is refused, and says so as a blocker', () => {
    assert.strictEqual(noKeyBoot.timedOut, false,
        'server was still running 15s after boot — the vault-key guard did not fire');
    assert.strictEqual(noKeyBoot.code, 1, `expected exit code 1, got ${noKeyBoot.code}`);
    // The point of the separate early check: an operator gets the numbered
    // refusal, not a stack trace out of the PIN migration.
    assert.match(noKeyBoot.output, /REFUSING TO START IN PRODUCTION/);
    assert.match(noKeyBoot.output, /GOLD_POS_SECRET_KEY/);
    assert.ok(!/at resolveKey/.test(noKeyBoot.output),
        'the refusal leaked a stack trace instead of reporting a blocker');
    // Everything else about this install is production-valid, so the key must
    // be the ONLY thing it complains about.
    assert.ok(!/demo credentials/i.test(noKeyBoot.output));
});

check('the refusal names every problem on stderr for the operator', () => {
    assert.match(unsafeBoot.output, /REFUSING TO START IN PRODUCTION/);
    assert.match(unsafeBoot.output, /demo credentials/i);
    assert.match(unsafeBoot.output, /admin PIN/i);
    assert.match(unsafeBoot.output, /public URL/i);
    assert.match(unsafeBoot.output, /webhook secret/i);
    assert.match(unsafeBoot.output, /mock/i);
});

console.log('======================================================================');
console.log(`✅ PRODUCTION GUARD SUITE PASSED (${passed} checks)`);
console.log('======================================================================');
