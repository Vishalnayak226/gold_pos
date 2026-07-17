/**
 * PM2 config for the Live (production/pilot) backend instance (branch: main).
 * Usage: pm2 start deploy/ecosystem.live.config.cjs
 * See deploy/README.md "Multi-environment pipeline".
 */
const { backendApp } = require('./ecosystem.base.cjs');

module.exports = {
    apps: [backendApp('live', 'production')]
};
