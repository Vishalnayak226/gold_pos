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

function backendApp(envName, nodeEnv) {
    return {
        name: `gold-pos-${envName}`,
        script: './backend/server.js',
        cwd: __dirname + '/..',
        instances: 1, // single instance only — the JSON-file DB layer is not multi-writer safe
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '300M',
        env: { NODE_ENV: nodeEnv, ENV_NAME: envName },
        out_file: './backend/logs/pm2-out.log',
        error_file: './backend/logs/pm2-error.log',
        time: true
    };
}

function licensingApp(envName, nodeEnv) {
    return {
        name: `licensing-${envName}`,
        script: './licensing_server/server.js',
        cwd: __dirname + '/..',
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        watch: false,
        max_memory_restart: '300M',
        env: { NODE_ENV: nodeEnv, ENV_NAME: envName },
        time: true
        // No custom out_file/error_file: licensing_server has no auto-created
        // logs/ dir (unlike backend/db.js), so this lets PM2 fall back to its
        // own default log location instead of failing on a missing directory.
    };
}

module.exports = { backendApp, licensingApp };
