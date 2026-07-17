/**
 * PM2 config for the shared non-production licensing_server instance
 * (branch: develop) — used by both the Dev and Sandbox backend environments
 * so pipeline testing never touches real tenant license/billing data.
 * Usage: pm2 start deploy/ecosystem.licensing-nonprod.config.cjs
 * See deploy/README.md "Multi-environment pipeline".
 */
const { licensingApp } = require('./ecosystem.base.cjs');

module.exports = {
    apps: [licensingApp('nonprod', 'development')]
};
