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
