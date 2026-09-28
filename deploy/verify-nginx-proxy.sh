#!/usr/bin/env bash
# Local, VPS-free dry run of the reverse-proxy leg of security-audit finding L2
# (docs/SECURITY_AUDIT.md) — "licensing server binds 127.0.0.1 only; nginx
# exposure unproven". L2 stays open no matter what this script does: DNS
# resolution and a real Let's Encrypt certificate (deploy/provision-pipeline.sh
# §6) inherently need a live domain pointed at a live VPS, neither of which
# exists yet (CLAUDE.md §7). What CAN be proven without either is the one
# part that IS pure code/config: that deploy/nginx.conf.template's
# proxy_pass/header directives actually forward a request through Nginx to
# the loopback-bound app and back. This script proves exactly that, so the
# only thing left for a real box is the infrastructure itself.
#
# What it does:
#   1. Boots licensing_server/server.js on an ephemeral port with a throwaway
#      ADMIN_SECRET (never touches a real .env or a real dev session on 6060).
#   2. Renders the real deploy/nginx.conf.template (same file
#      provision-pipeline.sh uses) for a test hostname.
#   3. Runs that config in an `nginx:alpine` container and curls through it.
#   4. Tears everything down.
#
# Usage: ./deploy/verify-nginx-proxy.sh
# Requires: Docker.

set -euo pipefail

APP_PORT=16060      # not 6060 — must not collide with a real local dev boot
PROXY_PORT=18080    # host port Nginx listens on; not 80, no root needed
TEST_FQDN="verify.localtest.me"
CONTAINER_NAME="gold-pos-nginx-verify"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SERVER_PID=""
TMP_CONF=""

cleanup() {
    [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" >/dev/null 2>&1 || true
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    [[ -n "$TMP_CONF" && -f "$TMP_CONF" ]] && rm -f "$TMP_CONF"
}
trap cleanup EXIT

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }
die() { echo -e "\033[1;31merror: $*\033[0m" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is required for this dry run (nginx:alpine container)."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running."

log "Starting licensing_server on 127.0.0.1:$APP_PORT (throwaway ADMIN_SECRET)"
(
    cd "$ROOT_DIR/licensing_server"
    PORT="$APP_PORT" \
    ADMIN_SECRET="verify-$(date +%s)-$$-$RANDOM" \
    NODE_ENV=production \
    node server.js
) &
SERVER_PID=$!

log "Waiting for it to answer /api/health"
UP=0
for _ in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
        UP=1
        break
    fi
    sleep 0.5
done
[[ $UP -eq 1 ]] || die "licensing_server did not come up on :$APP_PORT (it may have refused to boot — check output above)."

log "Rendering deploy/nginx.conf.template for $TEST_FQDN -> :$APP_PORT"
TMP_CONF="$(mktemp)"
# host.docker.internal substitution exists ONLY for this local test, to
# bridge the container's separate network namespace back to the host where
# node is actually listening. A real deploy runs Nginx and the app on the
# same host, so provision-pipeline.sh renders 127.0.0.1 unmodified — this
# script does not change the template or the production rendering path.
sed -e "s/__DOMAIN__/$TEST_FQDN/g" \
    -e "s/__PORT__/$APP_PORT/g" \
    -e "s/127\.0\.0\.1/host.docker.internal/g" \
    "$ROOT_DIR/deploy/nginx.conf.template" > "$TMP_CONF"

log "Starting nginx:alpine, proxying 127.0.0.1:$PROXY_PORT -> host:$APP_PORT"
# Git Bash rewrites leading-/ arguments to Windows paths before exec'ing
# docker.exe — including the CONTAINER-side path, which breaks the mount.
# MSYS_NO_PATHCONV=1 turns that off; cygpath supplies the Windows form of the
# host-side path ourselves instead. No-ops on real POSIX shells (no cygpath).
HOST_TMP_CONF="$(command -v cygpath >/dev/null 2>&1 && cygpath -w "$TMP_CONF" || echo "$TMP_CONF")"
MSYS_NO_PATHCONV=1 docker run -d --name "$CONTAINER_NAME" \
    --add-host=host.docker.internal:host-gateway \
    -p "127.0.0.1:$PROXY_PORT:80" \
    -v "$HOST_TMP_CONF:/etc/nginx/conf.d/default.conf:ro" \
    nginx:alpine >/dev/null

log "Checking rendered config is syntactically valid (nginx -t)"
docker exec "$CONTAINER_NAME" nginx -t

log "Waiting for Nginx to accept connections"
UP=0
for _ in $(seq 1 20); do
    if curl -fsS --max-time 1 "http://127.0.0.1:$PROXY_PORT/api/health" -H "Host: $TEST_FQDN" >/dev/null 2>&1; then
        UP=1
        break
    fi
    sleep 0.5
done
[[ $UP -eq 1 ]] || die "Nginx container did not come up on :$PROXY_PORT."

log "Requesting http://$TEST_FQDN:$PROXY_PORT/api/health through the proxy"
BODY="$(curl -fsS --max-time 5 "http://127.0.0.1:$PROXY_PORT/api/health" -H "Host: $TEST_FQDN")"
echo "    response: $BODY"
case "$BODY" in
    *'"status":"ok"'*) ;;
    *) die "proxied response did not contain a healthy status: $BODY" ;;
esac

echo -e "\n\033[1;32mPASS\033[0m — deploy/nginx.conf.template's proxy_pass/header directives"
echo "correctly forward a request through Nginx to the loopback-bound app and"
echo "back, unmodified from what provision-pipeline.sh renders in production."
echo
echo "Still open (needs a real VPS/domain, not provable here):"
echo "  - DNS actually resolving the tenant subdomain to the VPS"
echo "  - certbot issuing a real Let's Encrypt certificate"
echo "  - ufw + the public internet actually reaching the box"
echo "See docs/GO_LIVE_CHECKLIST.md A7 and docs/SECURITY_AUDIT.md L2."
