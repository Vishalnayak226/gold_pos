/**
 * PM2 process manager config for a single tenant's POS backend.
 * Usage: pm2 start deploy/ecosystem.config.cjs
 * See deploy/README.md for the full provisioning runbook.
 */
module.exports = {
    apps: [
        {
            name: 'gold-pos-backend',
            script: './backend/server.js',
            cwd: __dirname + '/..',
            instances: 1, // single instance only — the JSON-file DB layer is not multi-writer safe
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'production'
            },
            out_file: './backend/logs/pm2-out.log',
            error_file: './backend/logs/pm2-error.log',
            time: true
        }
    ]
};
