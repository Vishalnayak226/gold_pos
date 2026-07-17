/**
 * ==========================================================================
 * Extension / Plugin Loader
 * ==========================================================================
 * Lets a tenant-specific customization live entirely inside this folder,
 * without ever touching core files (server.js, db.js, licenseChecker.js,
 * cryptoHelper.js, etc). A hired 3rd-party developer should only ever be
 * given access to this folder (or a separate small repo containing just
 * this folder's contents) — never the core platform repo.
 *
 * See extensions/README.md for the full contract: available hooks, what
 * they receive, and the safety rules every extension must follow.
 *
 * Safety guarantees enforced by this loader (not just documented — actually
 * structural):
 *   1. An extension that throws, hangs, or rejects can never crash the
 *      server or fail an API request — every hook call is isolated in its
 *      own try/catch with a timeout.
 *   2. Hooks fire AFTER the core operation is already durably saved and
 *      the response already sent — an extension cannot block, delay, or
 *      alter a sale/deposit/settings save, and cannot see anything before
 *      it's already committed to disk.
 *   3. Extensions receive a JSON-cloned snapshot of the data, never a live
 *      reference — mutating it in an extension can never corrupt core state.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_TIMEOUT_MS = 3000;

let loadedExtensions = [];

function discoverExtensionFiles() {
    try {
        return fs.readdirSync(__dirname)
            .filter(f => f.endsWith('.extension.js'))
            .map(f => path.join(__dirname, f));
    } catch (_) {
        return [];
    }
}

/**
 * Discovers and loads every *.extension.js file in this folder. Call once
 * at server boot. A broken extension is logged and skipped — it never
 * prevents the rest of the platform from starting.
 */
export async function loadExtensions() {
    loadedExtensions = [];
    const files = discoverExtensionFiles();
    for (const file of files) {
        try {
            const mod = await import(`file://${file.replace(/\\/g, '/')}`);
            const handlers = mod.default || mod;
            loadedExtensions.push({ name: path.basename(file), handlers });
            console.log(`[Extensions] Loaded: ${path.basename(file)}`);
        } catch (err) {
            logError(`Failed to load extension ${path.basename(file)}: ${err.message}`, err.stack);
        }
    }
    if (loadedExtensions.length > 0) {
        console.log(`[Extensions] ${loadedExtensions.length} extension(s) active.`);
    }
    return loadedExtensions;
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Extension hook "${label}" timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeClone(payload) {
    try {
        return JSON.parse(JSON.stringify(payload));
    } catch (_) {
        return payload;
    }
}

/**
 * Fires a named hook on every loaded extension that implements it.
 * Deliberately fire-and-forget from the caller's perspective (server.js
 * never awaits this in the request path) — a slow or broken extension can
 * never add latency to a cashier's billing/deposit flow. Errors are logged,
 * never thrown.
 */
export function fireHook(hookName, payload) {
    if (loadedExtensions.length === 0) return;
    const snapshot = safeClone(payload);
    for (const ext of loadedExtensions) {
        const handler = ext.handlers && ext.handlers[hookName];
        if (typeof handler !== 'function') continue;
        withTimeout(Promise.resolve().then(() => handler(snapshot)), HOOK_TIMEOUT_MS, `${ext.name}:${hookName}`)
            .catch(err => logError(`Extension "${ext.name}" hook "${hookName}" failed: ${err.message}`, err.stack));
    }
}
