/**
 * PM2 config for the Development backend instance (branch: develop).
 * Usage: pm2 start deploy/ecosystem.dev.config.cjs
 * See deploy/README.md "Multi-environment pipeline".
 */
const { backendApp } = require('./ecosystem.base.cjs');

module.exports = {
    apps: [backendApp('dev', 'development')]
};
