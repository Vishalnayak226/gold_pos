#!/usr/bin/env bash
# One-shot provisioner for the platform owner's Dev/Sandbox/Live pipeline VPS
# — i.e. deploy/README.md §8.2, done by a script instead of by hand. Run it
# once, as root, on a fresh Ubuntu 22.04+ box with the 5 DNS records already
# pointed at it.
#
# Why this exists rather than the hand-typed §8.2 steps: the checkout
# directory names, ports, branches and PM2 app names must match what
# .github/workflows/cd-*.yml SSH in and run *exactly* — one typo in
# /opt/gold-pos/<name> and CI deploys silently target a path that doesn't
# exist. That table lives here in code now, so the manual and CI paths cannot
# drift apart.
#
# Usage (as root):
#   ./provision-pipeline.sh --domain yourpos.com --email you@example.com \
#       [--repo https://github.com/OWNER/REPO.git] \
#       [--ssh-pubkey "ssh-ed25519 AAAA... gold-pos-ci-deploy"] \
#       [--skip-tls]
#
# Safe to re-run: every step is idempotent (existing checkouts are fetched
# rather than re-cloned, existing .env files are never overwritten, existing
# certs are left alone).

set -euo pipefail

REPO_URL="https://github.com/Vishalnayak226/gold_pos.git"
DOMAIN=""
EMAIL=""
SSH_PUBKEY=""
SKIP_TLS=0
DEPLOY_USER="deploy"
BASE_DIR="/opt/gold-pos"
# Public/private PEMs that must survive `git reset --hard` on every future
# deploy live here, outside any checkout. See "Signing keys" below.
KEY_OVERLAY_DIR="$BASE_DIR/keys"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)     DOMAIN="${2:?}"; shift 2 ;;
        --email)      EMAIL="${2:?}"; shift 2 ;;
        --repo)       REPO_URL="${2:?}"; shift 2 ;;
        --ssh-pubkey) SSH_PUBKEY="${2:?}"; shift 2 ;;
        --skip-tls)   SKIP_TLS=1; shift ;;
        -h|--help)    sed -n '2,25p' "$0"; exit 0 ;;
        *) echo "error: unknown argument '$1' (try --help)" >&2; exit 2 ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "error: run as root (sudo $0 ...)" >&2; exit 1; }
[[ -n "$DOMAIN" ]] || { echo "error: --domain is required, e.g. --domain yourpos.com" >&2; exit 2; }
if [[ $SKIP_TLS -eq 0 && -z "$EMAIL" ]]; then
    echo "error: --email is required for Let's Encrypt (or pass --skip-tls to do TLS later)" >&2
    exit 2
fi

# name | branch | module-dir | port | subdomain-prefix | ecosystem file
# The name column IS the /opt/gold-pos/<name> directory the cd-*.yml
# workflows hardcode — do not rename without editing those workflows too.
ENVIRONMENTS=(
    "dev-backend|develop|backend|5001|dev|deploy/ecosystem.dev.config.cjs"
    "sandbox-backend|staging|backend|5002|sandbox|deploy/ecosystem.sandbox.config.cjs"
    "live-backend|main|backend|5000|app|deploy/ecosystem.live.config.cjs"
    "nonprod-licensing|develop|licensing_server|6061|license-dev|deploy/ecosystem.licensing-nonprod.config.cjs"
    "live-licensing|main|licensing_server|6060|license|deploy/ecosystem.licensing-live.config.cjs"
)

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }
warn() { echo -e "\033[1;33mwarning: $*\033[0m" >&2; }

# ---------------------------------------------------------------------------
# 0. Fail fast on an unreachable repo, before touching the system at all.
# ---------------------------------------------------------------------------
log "Checking the repo is reachable anonymously: $REPO_URL"
if ! git ls-remote "$REPO_URL" HEAD >/dev/null 2>&1; then
    cat >&2 <<EOF
error: cannot read $REPO_URL without credentials.

If the repo is private, the VPS needs read access before this script can
clone it. Cheapest fix (read-only, repo-scoped, no account password):

  sudo -u $DEPLOY_USER ssh-keygen -t ed25519 -N '' -f /home/$DEPLOY_USER/.ssh/github_ro
  cat /home/$DEPLOY_USER/.ssh/github_ro.pub

Paste that key into GitHub → the repo → Settings → Deploy keys → Add deploy
key (leave "Allow write access" unchecked), then re-run this script with the
SSH clone URL:

  --repo git@github.com:OWNER/REPO.git

(The deploy user is created in step 2, so run this script once to get that
far, or create the user by hand first.)
EOF
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. Base packages (deploy/README.md §1, once per server)
# ---------------------------------------------------------------------------
log "Installing base packages (git, nginx, certbot, ufw, curl)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl nginx ufw certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then
    log "Installing Node.js 20 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
else
    log "Node $(node -v) already present — leaving it alone"
fi

command -v pm2 >/dev/null 2>&1 || { log "Installing PM2"; npm install -g pm2 --silent; }

# ---------------------------------------------------------------------------
# 2. The low-privilege deploy user CI SSHes in as (README §8.2 step 3)
# ---------------------------------------------------------------------------
if id "$DEPLOY_USER" >/dev/null 2>&1; then
    log "User '$DEPLOY_USER' already exists"
else
    log "Creating low-privilege '$DEPLOY_USER' user (no sudo, no password login)"
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi

install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
if [[ -n "$SSH_PUBKEY" ]]; then
    AUTH="/home/$DEPLOY_USER/.ssh/authorized_keys"
    touch "$AUTH"
    if grep -qF "$SSH_PUBKEY" "$AUTH"; then
        log "CI deploy key already installed for '$DEPLOY_USER'"
    else
        log "Installing CI deploy public key for '$DEPLOY_USER'"
        echo "$SSH_PUBKEY" >> "$AUTH"
    fi
    chmod 600 "$AUTH"; chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"
else
    warn "No --ssh-pubkey given: GitHub Actions will not be able to SSH in until you append the CI public key to /home/$DEPLOY_USER/.ssh/authorized_keys yourself."
fi

install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$BASE_DIR"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$KEY_OVERLAY_DIR"

# ---------------------------------------------------------------------------
# 3. Firewall — only SSH and the Nginx ports. The 5 Node processes bind
#    127.0.0.1 (server.js: app.listen(PORT, '127.0.0.1')), so their ports must
#    never be publicly reachable regardless.
# ---------------------------------------------------------------------------
log "Configuring ufw (OpenSSH + Nginx Full only)"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/    /'

# ---------------------------------------------------------------------------
# 4. The 5 checkouts + per-environment .env files
# ---------------------------------------------------------------------------
gen_secret() { openssl rand -hex 24; }

for row in "${ENVIRONMENTS[@]}"; do
    IFS='|' read -r NAME BRANCH MODULE PORT SUB _ECO <<< "$row"
    TARGET="$BASE_DIR/$NAME"

    if [[ -d "$TARGET/.git" ]]; then
        log "$NAME: checkout exists — fetching $BRANCH"
        sudo -u "$DEPLOY_USER" git -C "$TARGET" fetch origin "$BRANCH" --quiet
        sudo -u "$DEPLOY_USER" git -C "$TARGET" reset --hard "origin/$BRANCH" --quiet
    else
        log "$NAME: cloning $BRANCH into $TARGET"
        sudo -u "$DEPLOY_USER" git clone --quiet -b "$BRANCH" "$REPO_URL" "$TARGET"
    fi

    ENV_FILE="$TARGET/$MODULE/.env"
    if [[ -f "$ENV_FILE" ]]; then
        log "$NAME: $MODULE/.env already exists — not overwriting"
    elif [[ "$MODULE" == "backend" ]]; then
        # Dev and Sandbox share the non-production licensing server so pipeline
        # testing never writes to real tenant license records; only Live talks
        # to the production one.
        if [[ "$NAME" == "live-backend" ]]; then
            LICENSING_URL="https://license.$DOMAIN"; NODE_ENV_VAL="production"
        else
            LICENSING_URL="https://license-dev.$DOMAIN"; NODE_ENV_VAL="development"
        fi
        log "$NAME: writing backend/.env (PORT=$PORT → $LICENSING_URL)"
        sudo -u "$DEPLOY_USER" tee "$ENV_FILE" >/dev/null <<EOF
# Generated by deploy/provision-pipeline.sh. Untracked (.gitignore), so it
# survives the git reset --hard that deploy/remote-deploy.sh runs.
PORT=$PORT
LICENSING_SERVER_URL=$LICENSING_URL
NODE_ENV=$NODE_ENV_VAL
EOF
    else
        SECRET="$(gen_secret)"
        [[ "$NAME" == "live-licensing" ]] && NODE_ENV_VAL="production" || NODE_ENV_VAL="development"
        log "$NAME: writing licensing_server/.env (PORT=$PORT, fresh ADMIN_SECRET)"
        sudo -u "$DEPLOY_USER" tee "$ENV_FILE" >/dev/null <<EOF
# Generated by deploy/provision-pipeline.sh. Untracked (.gitignore), so it
# survives the git reset --hard that deploy/remote-deploy.sh runs.
PORT=$PORT
ADMIN_SECRET=$SECRET
NODE_ENV=$NODE_ENV_VAL
EOF
    fi
    chmod 600 "$ENV_FILE"

    log "$NAME: npm ci --omit=dev in $MODULE"
    sudo -u "$DEPLOY_USER" bash -c "cd '$TARGET/$MODULE' && npm ci --omit=dev --no-audit --no-fund --silent"
done

# ---------------------------------------------------------------------------
# 5. Start the two licensing servers first — each generates its own
#    license/release signing keypairs on first boot — then start the backends.
# ---------------------------------------------------------------------------
start_app() {
    local NAME="$1" ECO="$2"
    log "$NAME: pm2 startOrRestart $ECO"
    sudo -u "$DEPLOY_USER" bash -c "cd '$BASE_DIR/$NAME' && pm2 startOrRestart '$ECO' --update-env"
}

for row in "${ENVIRONMENTS[@]}"; do
    IFS='|' read -r NAME _B MODULE _P _S ECO <<< "$row"
    [[ "$MODULE" == "licensing_server" ]] && start_app "$NAME" "$ECO"
done

sleep 3

# --- Signing keys ----------------------------------------------------------
# The trap this avoids: licensing_server/keys/*_private.pem is gitignored, so
# each licensing instance generates a BRAND NEW keypair on the VPS at first
# boot — and overwrites its own tracked *_public.pem doing so. The backends
# verify activations and release manifests against the *committed* public
# keys (backend/keys/), which were generated on a dev laptop and match
# nothing on this server. Left alone, every license activation here fails
# signature verification, and updateEngine.js refuses every release.
#
# Fix: copy each licensing server's real public keys into the backends that
# talk to it, and stage them in $KEY_OVERLAY_DIR — deploy/remote-deploy.sh
# re-applies that overlay after every `git reset --hard`, so CI deploys can't
# revert them back to the laptop-generated ones.
overlay_keys() {
    local SRC_LICENSING="$1"; shift
    local SRC="$BASE_DIR/$SRC_LICENSING/licensing_server/keys"

    # Pin the licensing server's own public PEMs too. Nothing in
    # licensing_server/server.js reads them back, so this is not a liveness
    # issue — but it is the file an operator cats to hand a public key to a
    # new tenant, and a deploy would otherwise quietly revert it to the
    # laptop-generated one, producing a tenant that fails activation for
    # reasons nobody can see.
    local LIC_DEST="$KEY_OVERLAY_DIR/$SRC_LICENSING"
    install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$LIC_DEST"
    for PEM in license_public.pem release_public.pem; do
        [[ -f "$SRC/$PEM" ]] && install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SRC/$PEM" "$LIC_DEST/$PEM"
    done

    for BACKEND in "$@"; do
        local DEST="$KEY_OVERLAY_DIR/$BACKEND"
        install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEST"
        for PEM in license_public.pem release_public.pem; do
            [[ -f "$SRC/$PEM" ]] || { warn "$SRC/$PEM missing — did $SRC_LICENSING boot cleanly? (pm2 logs $SRC_LICENSING)"; continue; }
            install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SRC/$PEM" "$DEST/$PEM"
            install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$SRC/$PEM" "$BASE_DIR/$BACKEND/backend/keys/$PEM"
        done
        log "$BACKEND: public signing keys synced from $SRC_LICENSING (+ pinned in $DEST)"
    done
}

overlay_keys "nonprod-licensing" "dev-backend" "sandbox-backend"
overlay_keys "live-licensing" "live-backend"

for row in "${ENVIRONMENTS[@]}"; do
    IFS='|' read -r NAME _B MODULE _P _S ECO <<< "$row"
    [[ "$MODULE" == "backend" ]] && start_app "$NAME" "$ECO"
done

log "Persisting PM2 process list + boot-time startup"
sudo -u "$DEPLOY_USER" pm2 save
pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" >/dev/null
sudo -u "$DEPLOY_USER" pm2 list

# ---------------------------------------------------------------------------
# 6. Nginx vhosts + TLS
# ---------------------------------------------------------------------------
SERVER_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
TLS_SKIPPED=()

for row in "${ENVIRONMENTS[@]}"; do
    IFS='|' read -r NAME _B _M PORT SUB _E <<< "$row"
    FQDN="$SUB.$DOMAIN"
    VHOST="/etc/nginx/sites-available/$NAME"

    log "$FQDN → 127.0.0.1:$PORT"
    sed -e "s/__DOMAIN__/$FQDN/g" -e "s/__PORT__/$PORT/g" \
        "$BASE_DIR/live-backend/deploy/nginx.conf.template" > "$VHOST"
    ln -sf "$VHOST" "/etc/nginx/sites-enabled/$NAME"
done

[[ -e /etc/nginx/sites-enabled/default ]] && rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

if [[ $SKIP_TLS -eq 0 ]]; then
    for row in "${ENVIRONMENTS[@]}"; do
        IFS='|' read -r _N _B _M _P SUB _E <<< "$row"
        FQDN="$SUB.$DOMAIN"
        RESOLVED="$(getent hosts "$FQDN" | awk '{print $1}' | head -1 || true)"
        if [[ -z "$RESOLVED" ]]; then
            warn "$FQDN does not resolve yet — skipping its cert (DNS not propagated?)"
            TLS_SKIPPED+=("$FQDN"); continue
        fi
        if [[ -n "$SERVER_IP" && "$RESOLVED" != "$SERVER_IP" ]]; then
            warn "$FQDN resolves to $RESOLVED, not this server ($SERVER_IP) — skipping its cert"
            TLS_SKIPPED+=("$FQDN"); continue
        fi
        log "Requesting TLS certificate for $FQDN"
        certbot --nginx -d "$FQDN" --non-interactive --agree-tos -m "$EMAIL" --redirect || {
            warn "certbot failed for $FQDN — re-run: certbot --nginx -d $FQDN"
            TLS_SKIPPED+=("$FQDN")
        }
    done
else
    log "--skip-tls given: no certificates requested. Run 'certbot --nginx -d <fqdn>' per subdomain later."
fi

# ---------------------------------------------------------------------------
# 7. Verify + summary
# ---------------------------------------------------------------------------
log "Local health checks (bypassing Nginx/DNS)"
HEALTH_FAIL=0
for row in "${ENVIRONMENTS[@]}"; do
    IFS='|' read -r NAME _B _M PORT _S _E <<< "$row"
    if OUT="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>&1)"; then
        printf '    \033[1;32mok\033[0m   %-18s %s\n' "$NAME" "$OUT"
    else
        printf '    \033[1;31mFAIL\033[0m %-18s (pm2 logs %s)\n' "$NAME" "$NAME"
        HEALTH_FAIL=1
    fi
done

cat <<EOF

=========================================================================
 Provisioning complete$([[ $HEALTH_FAIL -eq 1 ]] && echo " — WITH FAILURES, see above")
=========================================================================

Environments (deploy/README.md §8.1):
  https://dev.$DOMAIN          gold-pos-dev        :5001  branch develop
  https://sandbox.$DOMAIN      gold-pos-sandbox    :5002  branch staging
  https://app.$DOMAIN          gold-pos-live       :5000  branch main
  https://license-dev.$DOMAIN  licensing-nonprod   :6061  branch develop
  https://license.$DOMAIN      licensing-live      :6060  branch main

Licensing admin tokens (ADMIN_SECRET) — record these in your password
manager now, they are not stored anywhere else:
  non-prod: $(grep -h '^ADMIN_SECRET=' "$BASE_DIR/nonprod-licensing/licensing_server/.env" | cut -d= -f2-)
  live:     $(grep -h '^ADMIN_SECRET=' "$BASE_DIR/live-licensing/licensing_server/.env" | cut -d= -f2-)
$(if [[ ${#TLS_SKIPPED[@]} -gt 0 ]]; then printf '\nTLS still missing for: %s\n(fix DNS, then: certbot --nginx -d <fqdn>)\n' "${TLS_SKIPPED[*]}"; fi)
Next, in GitHub (Settings → Secrets and variables → Actions):
  secret   VPS_HOST        = ${SERVER_IP:-<this server's IP>}
  secret   VPS_USER        = $DEPLOY_USER
  secret   VPS_SSH_KEY     = the CI private key matching the installed pubkey
  variable PIPELINE_DOMAIN = $DOMAIN
And Settings → Environments: create development, sandbox, production —
add required reviewers on production only.

Then push anything to develop and watch cd-dev.yml go green.
=========================================================================
EOF

exit $HEALTH_FAIL
