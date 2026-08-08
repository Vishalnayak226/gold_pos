#!/usr/bin/env bash
# Deploys one environment's checkout on the pipeline VPS: pulls the target
# branch, installs dependencies, and (re)starts the matching PM2 app.
# Run by hand on the server, or over SSH from the cd-*.yml GitHub Actions
# workflows — same script either way, so "what deploy does" lives in git,
# not duplicated inline in CI YAML. See deploy/README.md "Multi-environment
# pipeline" for the full path/branch/app-name table.
#
# Usage: remote-deploy.sh <checkout-path> <branch> <module-dir> <ecosystem-file>
#   checkout-path   e.g. /opt/gold-pos/dev-backend
#   branch          e.g. develop
#   module-dir      backend | licensing_server (which package.json to install)
#   ecosystem-file  path relative to checkout-path, e.g. deploy/ecosystem.dev.config.cjs
#
# Example:
#   deploy/remote-deploy.sh /opt/gold-pos/dev-backend develop backend deploy/ecosystem.dev.config.cjs

set -euo pipefail

CHECKOUT_PATH="${1:?checkout-path required}"
BRANCH="${2:?branch required}"
MODULE_DIR="${3:?module-dir required (backend|licensing_server)}"
ECOSYSTEM_FILE="${4:?ecosystem-file required, relative to checkout-path}"

if [[ "$MODULE_DIR" != "backend" && "$MODULE_DIR" != "licensing_server" ]]; then
    echo "error: module-dir must be 'backend' or 'licensing_server', got '$MODULE_DIR'" >&2
    exit 1
fi

echo "==> Deploying $CHECKOUT_PATH ($MODULE_DIR) to branch $BRANCH"
cd "$CHECKOUT_PATH"

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

# Re-apply this environment's real signing keys. backend/keys/*_public.pem are
# tracked files, so the reset above just reverted them to the ones generated on
# a dev laptop — which do not match the keypair this VPS's licensing server
# generated on its own first boot. Without this, every license activation fails
# signature verification and updateEngine.js rejects every release. The overlay
# is written once by deploy/provision-pipeline.sh and lives outside any
# checkout so no deploy can clobber it.
KEY_OVERLAY_DIR="${KEY_OVERLAY_DIR:-/opt/gold-pos/keys}/$(basename "$CHECKOUT_PATH")"
if [[ -d "$KEY_OVERLAY_DIR" ]]; then
    echo "==> Restoring pinned signing keys from $KEY_OVERLAY_DIR"
    cp -f "$KEY_OVERLAY_DIR"/*.pem "$MODULE_DIR/keys/"
fi

echo "==> Installing $MODULE_DIR dependencies"
(cd "$MODULE_DIR" && npm ci --omit=dev --no-audit --no-fund)

echo "==> Starting/restarting via $ECOSYSTEM_FILE"
pm2 startOrRestart "$ECOSYSTEM_FILE"
pm2 save

echo "==> Deploy complete: $(git rev-parse --short HEAD)"
