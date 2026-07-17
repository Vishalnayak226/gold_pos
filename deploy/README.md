# Deployment Runbook — Per-Tenant Cloud Instance

This project deploys as **one always-on Node process per tenant**, on the
tenant's own server/cloud account, browser-accessible from anywhere (see
`docs/PROJECT_PLAN.md` §5.1 — this is a locked architectural decision: no
build step, no containers required, no auto-updater). This runbook covers
provisioning one tenant's POS instance. The central `licensing_server/` is a
separate, single, platform-owner-operated deployment — see §5 below.

## 1. Prerequisites (once per server)

- A Linux VPS (Ubuntu 22.04+ recommended) or any host with Node.js >= 18.
- [PM2](https://pm2.keymetrics.io/) process manager: `npm install -g pm2`
- Nginx (reverse proxy + TLS termination): `apt-get install nginx`
- [Certbot](https://certbot.eff.org/) for free TLS certs: `apt-get install certbot python3-certbot-nginx`
- A DNS A record for the tenant's subdomain (e.g. `storename.yourpos.com`)
  pointed at the server's IP.

## 2. Deploy the code

```bash
# On the server, per tenant:
git clone <this repo> /opt/gold-pos/<tenant-slug>
cd /opt/gold-pos/<tenant-slug>/backend
npm install --production
cp .env.example .env
# edit .env: set PORT (unique per tenant if multiple share one server),
# LICENSING_SERVER_URL (the platform owner's central licensing endpoint)
```

Each tenant's `backend/data/`, `backend/logs/`, and `backend/backups/`
directories are that tenant's entire database — back them up externally
(e.g. an off-server rsync/S3 sync cron) in addition to the built-in 7-day
rolling local backups.

## 3. Process management (PM2)

```bash
cd /opt/gold-pos/<tenant-slug>
pm2 start deploy/ecosystem.config.cjs
pm2 save          # persist across reboots
pm2 startup       # follow the printed instructions once per server
```

`deploy/ecosystem.config.cjs` runs `backend/server.js`, auto-restarts on
crash, and writes PM2's own logs separately from the app's `backend/logs/`.
To update a tenant to a new release: `git pull && npm install --production
&& pm2 restart gold-pos-<tenant-slug>` (or reload for zero-downtime if
`instances > 1`, not the default here since this is a single-instance
JSON-file-backed app — do not run multiple instances against the same
`backend/data/` directory, the atomic-write layer isn't a multi-writer
lock).

## 4. Reverse proxy + TLS (Nginx)

```bash
cp deploy/nginx.conf.template /etc/nginx/sites-available/<tenant-slug>
# edit the file: replace __DOMAIN__ with the tenant's subdomain and
# __PORT__ with the PORT from that tenant's .env (matches server.js's
# app.listen(PORT, '127.0.0.1', ...) — the app only binds localhost;
# Nginx is the only public-facing listener)
ln -s /etc/nginx/sites-available/<tenant-slug> /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d <tenant-subdomain>   # issues + auto-configures TLS
```

## 5. The central licensing server (deploy once, not per-tenant)

`licensing_server/` is the platform owner's single control-plane instance —
every tenant's `backend/` points at it via `LICENSING_SERVER_URL`. Deploy it
the same way (PM2 + Nginx + TLS) on its own subdomain (e.g.
`license.yourpos.com`), using `licensing_server/.env.example` as the
template. Guard `ADMIN_SECRET` carefully — it's the bearer token for the
admin dashboard that issues/revokes every tenant's license.

## 6. First-boot license activation

No separate "setup wizard" is needed — it already exists. A freshly deployed
tenant instance starts with `backend/data/license.json` at its default
(`activated: false, status: "inactive"`, see `backend/db.js`). The first time
anyone opens the POS in a browser, `frontend/js/app.js`'s
`checkLicenseStatus()` calls `GET /api/license/status`, sees it's invalid,
and shows the full-screen activation overlay (`showLicenseLockOverlay`) —
the platform owner (or the tenant, if given their key) enters the license
key issued in the central licensing server's admin dashboard, which calls
`POST /api/license/activate` → `syncLicenseStatus()` in
`backend/licenseChecker.js`, which contacts `LICENSING_SERVER_URL` and
persists the signed, verified state. From then on the 7-day offline grace
period (`isLicenseValid()`) covers normal network drops.

## 7. What's still manual (by design — Phase 14 scope)

Per `docs/PROJECT_PLAN.md` §5.1, releases are **manual and version-flagged**:
no auto-updater ships in this phase. Phase 15 adds a non-blocking
"update available" banner the platform owner can use to know when a tenant
should be manually upgraded; it never pushes code by itself.

## 8. Multi-environment pipeline (Dev / Sandbox / Live) — Phase 19

Sections 1-7 above are the **per-tenant** runbook — one server per paying
customer, updated manually on their own schedule. This section is a
**separate, additional** thing: the platform owner's own internal
Development → Sandbox/Test → Live pipeline, used to vet a change before it
is ever rolled out to a real tenant using the runbook above. "Live" here
means the platform owner's own pilot/production instance and the
proven `main` branch state — not a new mechanism that auto-pushes to every
tenant.

All three environments (plus a shared non-production licensing server) run
on **one VPS**, as separate PM2 processes on separate ports, so pipeline
testing never touches a paying tenant's server or the real licensing data.

### 8.1 Layout

| Env | Branch | PM2 app name | Port | Licensing server it uses | Subdomain |
|---|---|---|---|---|---|
| Development | `develop` | `gold-pos-dev` | 5001 | non-prod (6061) | `dev.<domain>` |
| Sandbox/Test | `staging` | `gold-pos-sandbox` | 5002 | non-prod (6061) | `sandbox.<domain>` |
| Live | `main` | `gold-pos-live` | 5000 | production (6060) | `app.<domain>` |
| Licensing (non-prod) | `develop` | `licensing-nonprod` | 6061 | — | `license-dev.<domain>` |
| Licensing (production) | `main` | `licensing-live` | 6060 | — | `license.<domain>` |

Recommend a **2GB RAM** droplet/instance (not the 1GB box §1 suggests for a
single tenant) — 5 Node processes plus Nginx is more headroom than a 1GB box
comfortably gives.

### 8.2 One-time provisioning

1. Do §1 once (Node, PM2, Nginx, Certbot) on the pipeline VPS.
2. DNS: 5 A records (table above) → the VPS IP.
3. Create a low-privilege `deploy` Linux user for CI to SSH in as (not
   root), scoped to `/opt/gold-pos/`. Generate an SSH keypair for it — the
   private key becomes the `VPS_SSH_KEY` GitHub Actions secret (§8.4).
4. For each of the 5 rows in the table, as the `deploy` user:
   ```bash
   git clone -b <branch> <this repo> /opt/gold-pos/<name>
   cd /opt/gold-pos/<name>/<backend-or-licensing_server>
   npm ci --omit=dev
   cp .env.example .env
   # edit .env: set PORT and (for backend rows) LICENSING_SERVER_URL per
   # the table above, plus ENV_NAME=<dev|sandbox|live|nonprod> so GET
   # /api/health reports which instance you hit
   ```
5. `pm2 start deploy/ecosystem.<name>.config.cjs` for each (see the 5
   `deploy/ecosystem.*.config.cjs` files — each just sets a unique PM2 app
   name so all 5 processes coexist on one PM2 daemon without colliding).
   `pm2 save`, `pm2 startup` once.
6. 5 Nginx vhosts from `deploy/nginx.conf.template` (§4), one per row,
   `certbot --nginx -d <subdomain>` for each.

### 8.3 Deploying a build

`deploy/remote-deploy.sh <checkout-path> <branch> <module-dir> <ecosystem-file>`
does the actual work (`git fetch && git reset --hard`, `npm ci`,
`pm2 startOrRestart`, `pm2 save`) — run it by hand on the server, or let
CI run it over SSH (§8.4). Example, deploying Dev by hand:

```bash
deploy/remote-deploy.sh /opt/gold-pos/dev-backend develop backend deploy/ecosystem.dev.config.cjs
```

**Rollback:** re-run the same command against a specific commit —
`git checkout <previous-sha>` at the checkout path, then re-run
`remote-deploy.sh` (or just `pm2 restart <app-name>` after the checkout, no
need to redo `npm ci` if dependencies didn't change).

### 8.4 CI/CD (GitHub Actions)

Three workflows, one per stage, each gated on `node backend/test_suite.js`
+ `npm audit --audit-level=high` (same test gate `.github/workflows/daily-checks.yml`
already runs) passing before deploying:

- `cd-dev.yml` — push to `develop` → deploy to `dev-backend` (+
  `nonprod-licensing` if `licensing_server/` changed) → smoke-test
  `GET https://dev.<domain>/api/health`.
- `cd-sandbox.yml` — push to `staging` → same, targeting `sandbox-backend`.
  This is where the platform owner does manual UAT before promoting further.
- `cd-live.yml` — push to `main` → deploy job declares
  `environment: production`, which GitHub blocks on a **manual approval**
  (Settings → Environments → `production` → required reviewers) → deploys
  to `live-backend` + `live-licensing` → smoke test.

Repo secrets needed: `VPS_HOST`, `VPS_USER` (the `deploy` user from §8.2),
`VPS_SSH_KEY`.

**Day-to-day promotion:** `feature branch → PR into develop` (auto-deploys
Dev) → `PR develop → staging` (auto-deploys Sandbox, do UAT here) →
`PR staging → main` (blocks on manual Approve, then deploys Live).
