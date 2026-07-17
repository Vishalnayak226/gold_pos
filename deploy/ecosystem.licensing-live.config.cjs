/**
 * PM2 config for the production licensing_server instance (branch: main) —
 * the real central control plane used by the Live backend environment (and,
 * per the per-tenant runbook, by every real paying tenant).
 * Usage: pm2 start deploy/ecosystem.licensing-live.config.cjs
 * See deploy/README.md "Multi-environment pipeline".
 */
const { licensingApp } = require('./ecosystem.base.cjs');

module.exports = {
    apps: [licensingApp('live', 'production')]
};
