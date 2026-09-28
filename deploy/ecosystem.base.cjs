/**
 * Shared PM2 app-config factories for the platform owner's internal
 * dev/sandbox/live pipeline (see deploy/README.md "Multi-environment
 * pipeline"). Each ecosystem.<env>.config.cjs file below picks a factory
 * and supplies only what's environment-specific (PM2 app name, NODE_ENV) —
 * this is what keeps 5 processes on one VPS from colliding on PM2 app name,
 * without hand-duplicating the full config 5 times.
 *
 * Not used by the single-tenant runbook (deploy/ecosystem.config.cjs) —
 * that one stays as-is for a normal one-tenant-per-server deployment.
 */

const path = require('path');
const REPO_ROOT = path.join(__dirname, '..');

function backendApp(envName, nodeEnv) {
    return {
        name: `gold-pos-${envName}`,
        script: './backend/server.js',
        cwd: REPO_ROOT,
        instances: 1, // single instance only — one SQLite file per tenant, one writer
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '300M',
        /* PM2 sends SIGINT and then SIGKILLs after kill_timeout, which defaults
           to 1600ms. server.js drains for up to SHUTDOWN_GRACE_MS (10s), so the
           default would kill the process mid-sale and make the drain decorative.
           This must stay comfortably above that grace period. */
        kill_timeout: 15000,
        /* server.js's very first import is `dotenv/config`, which defaults to
           reading `.env` from process.cwd() — but cwd here is the checkout
           root, not `backend/`, where provision-pipeline.sh actually writes
           the file. Without this, PORT/LICENSING_SERVER_URL/PUBLIC_URL and any
           later-added GOLD_POS_SECRET_KEY silently never load: dotenv finds no
           file at the wrong path and no-ops rather than erroring. */
        env: { NODE_ENV: nodeEnv, ENV_NAME: envName, DOTENV_CONFIG_PATH: path.join(REPO_ROOT, 'backend', '.env') },
        out_file: './backend/logs/pm2-out.log',
        error_file: './backend/logs/pm2-error.log',
        time: true
    };
}

function licensingApp(envName, nodeEnv) {
    return {
        name: `licensing-${envName}`,
        script: './licensing_server/server.js',
        cwd: REPO_ROOT,
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '300M',
        // Same cwd-vs-.env-location mismatch as backendApp above, for the
        // freshly generated ADMIN_SECRET in licensing_server/.env.
        env: { NODE_ENV: nodeEnv, ENV_NAME: envName, DOTENV_CONFIG_PATH: path.join(REPO_ROOT, 'licensing_server', '.env') },
        time: true
        // No custom out_file/error_file: licensing_server has no auto-created
        // logs/ dir (unlike backend/db.js), so this lets PM2 fall back to its
        // own default log location instead of failing on a missing directory.
    };
}

module.exports = { backendApp, licensingApp };
