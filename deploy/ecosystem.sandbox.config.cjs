/**
 * PM2 config for the Sandbox/Test backend instance (branch: staging).
 * Usage: pm2 start deploy/ecosystem.sandbox.config.cjs
 * See deploy/README.md "Multi-environment pipeline".
 */
const { backendApp } = require('./ecosystem.base.cjs');

module.exports = {
    apps: [backendApp('sandbox', 'development')]
};
