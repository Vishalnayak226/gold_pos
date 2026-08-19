/**
 * ==========================================================================
 * Production startup guard — refuse to boot in a state that can take money
 * it cannot honour.
 *
 * The demo-credential checks this replaces were all per-request: /api/payment/
 * order and /api/payment/verify each noticed that a mock Razorpay key was
 * configured and returned 503. That is far too late. A production process
 * would start cleanly, serve the storefront, let staff sign in with the
 * shipped default PIN of 1234, take counter sales all day, and only surface
 * the misconfiguration at the moment a real customer tried to pay — by which
 * point the install has been publicly reachable and quietly wrong for hours.
 *
 * Nothing here is a new rule. Every condition below was already treated as
 * fatal somewhere in the codebase; this module just moves the discovery to
 * the one moment when the fix is free — before the port is bound.
 *
 * Deliberately inert unless NODE_ENV === 'production'. Local development and
 * every test suite run with demo keys ON PURPOSE, and a guard that fired
 * there would either be disabled within a week or trained around.
 * ==========================================================================
 */

import { logError, DATA_DIR } from './db.js';
import { resolveKey } from './secretVault.js';
import { readSettings } from './settingsStore.js';
import { verifyPinHash } from './adminAuth.js';

// The shipped placeholders. Matching these exactly is what identifies an
// install that was deployed without anyone opening Settings.
const DEMO_RAZORPAY_KEY_ID = 'rzp_test_xxxxxx';
const DEMO_RAZORPAY_SECRET = 'rzp_test_xxxxxx_secret';
const DEFAULT_ADMIN_PIN = '1234';

/**
 * Collects every reason this configuration must not run in production.
 *
 * Returns all of them rather than throwing on the first: an operator fixing a
 * deployment wants the whole list in one pass, not one more failed boot per
 * mistake.
 *
 * @param {object} settings the tenant's settings.json
 * @param {object} env      process.env, injected so this is testable
 * @returns {string[]} human-readable failures; empty means safe to boot
 */
export function findProductionBlockers(settings = {}, env = process.env) {
    const blockers = [];

    // --- Payment credentials ----------------------------------------------
    if (!settings.razorpayKeyId || !settings.razorpayKeySecret) {
        blockers.push('Razorpay credentials are not configured (settings.razorpayKeyId / razorpayKeySecret are empty).');
    } else if (settings.razorpayKeyId === DEMO_RAZORPAY_KEY_ID || settings.razorpayKeySecret === DEMO_RAZORPAY_SECRET) {
        blockers.push('Razorpay is still configured with the shipped demo credentials. Real checkout cannot work, and mock checkout must never be reachable in production.');
    }

    // A key pair without a webhook secret means the only confirmation that a
    // payment was captured is the customer's own browser completing a round
    // trip — so a closed tab silently loses the credit for money already taken.
    if (!settings.razorpayWebhookSecret) {
        blockers.push('No Razorpay webhook secret is configured, so captured payments cannot be confirmed server-to-server. Add the webhook in the Razorpay dashboard and save its secret in Settings → Payments.');
    }

    // --- Reachability ------------------------------------------------------
    // Razorpay has to be able to reach this install to deliver that webhook.
    const publicUrl = String(settings.publicUrl || env.PUBLIC_URL || '').trim();
    if (!publicUrl) {
        blockers.push('No public URL is configured (Settings → Payments, or the PUBLIC_URL environment variable). Razorpay cannot deliver webhooks to an address we cannot state.');
    } else if (!/^https:\/\/[^\s/]+/i.test(publicUrl)) {
        blockers.push(`The configured public URL "${publicUrl}" is not an https:// origin. Payment callbacks and customer sessions must not traverse plaintext HTTP.`);
    }

    /* --- Credentials -------------------------------------------------------

       The master PIN is stored as a scrypt hash, so "is it still 1234?" is
       answered by hashing 1234 against this tenant's salt and comparing — not by
       a string equality that would silently stop finding anything the moment
       hashing shipped. A settings.json restored from an older backup can still
       hold a plaintext `adminPin`, which is checked directly for the same reason
       the migration still looks for it. */
    const storedHash = settings.adminPinHash;
    const storedPlain = settings.adminPin;
    if (!storedHash && !storedPlain) {
        blockers.push('No admin PIN is set, so the admin terminal would fall back to the shipped default.');
    } else if (storedPlain && String(storedPlain) === DEFAULT_ADMIN_PIN) {
        blockers.push('The admin PIN is still the shipped default (1234). Anyone who can reach this install can open the admin terminal.');
    } else if (storedHash && settings.authSalt
        && verifyPinHash(DEFAULT_ADMIN_PIN, settings.authSalt, storedHash)) {
        blockers.push('The admin PIN is still the shipped default (1234). Anyone who can reach this install can open the admin terminal.');
    }

    // --- Pricing -----------------------------------------------------------
    // 'mock' generates a synthetic random drift around $2350/oz. Billing real
    // customers against invented gold prices is a straightforward way to give
    // away stock, and it is silent — the invoices look entirely normal.
    if (settings.goldApiProvider === 'mock') {
        blockers.push('The gold price provider is set to "mock", which generates synthetic rates. Real invoices would be priced against invented gold prices.');
    }

    // --- Environment confusion ---------------------------------------------
    // NODE_ENV=production alongside ENV_NAME=staging is the classic footgun:
    // a staging box pointed at live payment credentials, or the reverse.
    const envName = String(env.ENV_NAME || '').trim().toLowerCase();
    if (envName && !['production', 'live', 'prod'].includes(envName)) {
        blockers.push(`NODE_ENV is "production" but ENV_NAME is "${env.ENV_NAME}". Refusing to guess which one is right — make them agree.`);
    }

    return blockers;
}

/**
 * Fails the process if this production configuration cannot safely take money.
 *
 * Called from bootstrapServer() before the listener binds, so a bad deploy
 * fails its health check and rolls back instead of serving.
 *
 * @param {{exit?: boolean}} [options] `exit: false` reports without killing
 *        the process — used by the test suite.
 * @returns {string[]} the blockers found (empty when safe)
 */
/**
 * Print the standard refusal and (optionally) kill the process.
 *
 * Shared so that every way this install can be unfit for production says so in
 * the same shape — one numbered list, on both stderr and the log file.
 */
function refuse(blockers, exit) {
    const message =
        '\n========================================================================\n' +
        ' REFUSING TO START IN PRODUCTION\n' +
        '========================================================================\n' +
        blockers.map((b, i) => `  ${i + 1}. ${b}`).join('\n') +
        '\n\n Fix the items above, or start without NODE_ENV=production to run this\n' +
        ' install in demo mode.\n' +
        '========================================================================\n';

    // Both channels on purpose: the log file is what a support engineer reads
    // after the fact, stderr is what the operator watching the deploy sees.
    console.error(message);
    logError(`Production startup blocked: ${blockers.join(' | ')}`);

    if (exit) process.exit(1);
    return blockers;
}

/**
 * Refuses a production boot that has no secret-vault key.
 *
 * SEPARATE FROM assertProductionReady, AND CALLED BEFORE IT, for a boot-order
 * reason: reading settings.json now means decrypting it, and the first thing
 * bootstrapServer() does is migrateStoredPins(), which reads settings long
 * before the main guard runs. Without this, a production install with no
 * GOLD_POS_SECRET_KEY dies inside the PIN migration with a raw stack trace
 * instead of the numbered refusal an operator can act on.
 *
 * @param {{exit?: boolean}} [options]
 * @returns {string[]} the blockers found (empty when the key resolves)
 */
export function assertVaultKeyReady({ exit = true } = {}) {
    if (process.env.NODE_ENV !== 'production') return [];
    try {
        resolveKey(DATA_DIR);
        return [];
    } catch (error) {
        return refuse([
            'GOLD_POS_SECRET_KEY is not set or is not 64 hexadecimal characters, so the credentials ' +
            'in settings.json cannot be decrypted. Production will not fall back to a keyfile inside ' +
            'the data directory, because a key stored beside the data it protects defends against ' +
            `nothing. (${error && error.message ? error.message.split('.')[0] : 'key unavailable'}.) ` +
            'See docs/RUNBOOKS.md - "Rotating the secret-vault key".'
        ], exit);
    }
}

/**
 * Fails the process if this production configuration cannot safely take money.
 *
 * Called from bootstrapServer() before the listener binds, so a bad deploy
 * fails its health check and rolls back instead of serving.
 *
 * @param {{exit?: boolean}} [options] `exit: false` reports without killing
 *        the process — used by the test suite.
 * @returns {string[]} the blockers found (empty when safe)
 */
export function assertProductionReady({ exit = true } = {}) {
    if (process.env.NODE_ENV !== 'production') return [];

    /* Defence in depth. assertVaultKeyReady() runs first in the real boot path,
       so by here the key normally resolves; a caller that skipped it still gets
       a numbered refusal rather than a stack trace. */
    const keyBlockers = assertVaultKeyReady({ exit: false });
    if (keyBlockers.length > 0) return exit ? process.exit(1) : keyBlockers;

    const settings = readSettings();
    const blockers = findProductionBlockers(settings, process.env);
    if (blockers.length === 0) return [];

    return refuse(blockers, exit);
}
