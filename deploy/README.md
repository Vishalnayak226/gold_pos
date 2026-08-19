# Deployment Runbook — Per-Tenant Cloud Instance

This project deploys as **one always-on Node process per tenant**, on the
tenant's own server/cloud account, browser-accessible from anywhere (see
`docs/PROJECT_PLAN.md` §5.1 — this is a locked architectural decision: no
build step, no containers required, no auto-updater). This runbook covers
provisioning one tenant's POS instance. The central `licensing_server/` is a
separate, single, platform-owner-operated deployment — see §5 below.

## 1. Prerequisites (once per server)

- A Linux VPS (Ubuntu 22.04+ recommended) with **Node.js >= 24**. Not 20: ADR-001
  put persistence on the stdlib `node:sqlite`, which is only stable and flag-free
  from 24, and `backend/repositories/connection.js` imports it at module load.
  On an older Node every backend dies with `ERR_UNKNOWN_BUILTIN_MODULE`, and
  `npm ci` only *warns* about the unsatisfied `engines` field — so the box looks
  provisioned right up until the first health check fails.
- **RAM depends on how many processes you run** — see §8.1a. A single-tenant
  install (§1–7) or the 2-process `--profile minimal` pipeline runs comfortably
  on 512MB–1GB **with swap**; the full 5-process pipeline (§8.1) wants 2GB.
  A booted backend measures ~73MB RSS, so the driver is process count, not code.
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

### 8.1a Profiles — how many of those five you actually run

The table above is the **full** pipeline. Provisioning all five before there
are paying tenants buys very little and costs 4× the RAM, so
`provision-pipeline.sh` takes a `--profile`:

| Profile | Processes | Node RAM | Total w/ OS+Nginx | Droplet |
|---|---|---|---|---|
| `minimal` *(default)* | 2 — `live-backend`, `live-licensing` | ~130 MB | ~325 MB | 512MB–1GB |
| `full` | all 5 | ~325 MB | ~520 MB | 2GB |

The number that drives this: **a Node process costs ~65MB of V8-plus-runtime
floor regardless of how small the app is** — this backend measures ~73MB RSS
booted. So the pipeline's weight is the *number of environments*, not the code.
Nothing about the app is heavy; running five copies of it is.

`minimal` drops Dev (belongs on the developer's own machine — `localhost:5000`)
and Sandbox (exists to stop a bad deploy reaching a *paying tenant*, so it earns
its RAM the day one exists, not before), and collapses the two licensing servers
to one. Moving up is `--profile full` on the same box — idempotent, it adds the
missing three alongside the running two without disturbing them. Pair it with a
resize; on DigitalOcean choose **"CPU and RAM only"**, which is reversible,
rather than "Disk, CPU and RAM", which permanently enlarges the disk.

**On `minimal`, `cd-dev.yml` and `cd-sandbox.yml` will fail** — the checkouts
they target do not exist. Expected. Ignore them, or disable both in the Actions
tab until you move up.

**Swap, on any box under 2GB:** what exhausts a small droplet is `npm ci`
spiking during install, not the running app. `provision-pipeline.sh` creates a
2G swapfile with `vm.swappiness=10` when it finds <2GB RAM and no existing swap.
Without it the OOM killer takes the install and provisioning fails halfway
through, which looks like a script bug and is not one.

### 8.2 One-time provisioning

**Use the script.** `deploy/provision-pipeline.sh` performs every step below
in one idempotent run, on a fresh Ubuntu 22.04+ VPS, as root:

```bash
# --profile minimal is the default (2 processes); pass --profile full for all 5.
./deploy/provision-pipeline.sh --domain yourpos.com --email you@example.com \
    --ssh-pubkey "ssh-ed25519 AAAA... gold-pos-ci-deploy"
```

It ends with a health check of all 5 processes and prints the generated
licensing `ADMIN_SECRET`s and the exact GitHub secret/variable values to
set. Re-running it is safe: existing checkouts are fetched rather than
re-cloned, and existing `.env` files and certificates are left untouched.
`docs/GO_LIVE_CHECKLIST.md` Track A is the operator-facing version with
costs and click paths.

What it does, i.e. what to do by hand if you'd rather:

1. §1 once (Node 24 — the floor since ADR-001, `node:sqlite` needs it — PM2,
   Nginx, Certbot) + `ufw` allowing only OpenSSH and
   Nginx — all 5 Node processes bind `127.0.0.1`, so their ports must never
   be publicly reachable.
2. DNS: 5 A records (table above) → the VPS IP.
3. Create a low-privilege `deploy` Linux user for CI to SSH in as (not
   root), owning `/opt/gold-pos/`, with the CI public key in its
   `~/.ssh/authorized_keys`. The matching private key becomes the
   `VPS_SSH_KEY` GitHub Actions secret (§8.4).
4. For each of the 5 rows, as the `deploy` user. **The directory name is
   not free-form** — `.github/workflows/cd-*.yml` hardcodes these exact
   paths, and they are deliberately *not* the same strings as the PM2 app
   names in the §8.1 table:

   | Directory | Branch | Module | PORT | LICENSING_SERVER_URL |
   |---|---|---|---|---|
   | `/opt/gold-pos/dev-backend` | `develop` | `backend` | 5001 | `https://license-dev.<domain>` |
   | `/opt/gold-pos/sandbox-backend` | `staging` | `backend` | 5002 | `https://license-dev.<domain>` |
   | `/opt/gold-pos/live-backend` | `main` | `backend` | 5000 | `https://license.<domain>` |
   | `/opt/gold-pos/nonprod-licensing` | `develop` | `licensing_server` | 6061 | — (set `ADMIN_SECRET`) |
   | `/opt/gold-pos/live-licensing` | `main` | `licensing_server` | 6060 | — (set `ADMIN_SECRET`) |

   ```bash
   git clone -b <branch> <this repo> /opt/gold-pos/<directory>
   cd /opt/gold-pos/<directory>/<module>
   npm ci --omit=dev
   cp .env.example .env   # then set PORT + the column above
   ```
   `.env` is gitignored, so it survives the `git reset --hard` that every
   deploy runs. `ENV_NAME` and `NODE_ENV` come from the PM2 config, not
   `.env` — `dotenv` does not override variables PM2 already exported.
5. `pm2 startOrRestart deploy/ecosystem.<name>.config.cjs` from each
   checkout root (the 5 `deploy/ecosystem.*.config.cjs` files each set a
   unique PM2 app name so all 5 coexist on one PM2 daemon without
   colliding). Then `pm2 save`, and `pm2 startup systemd -u deploy` once.
6. **Signing keys — easy to miss, breaks everything if skipped.** Start the
   two licensing servers *first*: each generates its own license- and
   release-signing keypairs on first boot, because `keys/*private*.pem` is
   gitignored and therefore absent from a fresh clone. The backends verify
   activations and release manifests against the *committed*
   `backend/keys/*_public.pem`, which were generated on a dev laptop and
   match nothing on this server. So copy each licensing server's real
   `license_public.pem` and `release_public.pem` into the backends that
   point at it (non-prod → dev + sandbox, live → live), **and** stage a copy
   in `/opt/gold-pos/keys/<directory>/` — `remote-deploy.sh` re-applies that
   overlay after every `git reset --hard`, since those public PEMs are
   tracked files and would otherwise be reverted on the next deploy.
7. 5 Nginx vhosts from `deploy/nginx.conf.template` (§4), one per row,
   `certbot --nginx -d <subdomain>` for each.

### 8.3 Deploying a build

`deploy/remote-deploy.sh <checkout-path> <branch> <module-dir> <ecosystem-file>`
does the actual work (`git fetch && git reset --hard`, `npm ci`,
`pm2 startOrRestart`, `pm2 save`) — run it by hand on the server, or let
CI run it over SSH (§8.4). Example, deploying Dev by hand:

```bash
deploy/remote-deploy.sh /opt/gold-pos/dev-backend develop backend deploy/ecosystem.dev.config.cjs
```

**Rollback (automatic, added 2026-08-19 Phase 36):** every normal deploy
writes `.rollback-sha` at the checkout path — the commit it was about to
move off of — before it fetches and resets. `cd-dev.yml`/`cd-sandbox.yml`/
`cd-live.yml` all react to a failed post-deploy smoke test by calling
`remote-deploy.sh` again with a trailing `--rollback`, which resets to
that recorded commit instead of the branch tip (the branch tip is the
build that just failed), reinstalls, and restarts — then the job still
ends red, because a rollback restores service, it does not turn a bad
build into a good one. Manually:

```bash
deploy/remote-deploy.sh /opt/gold-pos/dev-backend develop backend deploy/ecosystem.dev.config.cjs --rollback
```

To roll back further than one deploy (`.rollback-sha` only ever holds the
*immediately* previous commit), `git checkout <sha>` at the checkout path by
hand instead, then re-run `remote-deploy.sh` without `--rollback` — a normal
deploy always records wherever it finds HEAD, so the next deploy's rollback
marker will be correct again afterward.

**Not yet exercised against a real VPS** (§7 — none is provisioned as of
2026-08-19): the git-reset/rollback-marker mechanics were verified locally
against a throwaway repo, and all four workflow YAML files parse cleanly, but
the SSH/GitHub-Environment wiring itself has never run on an Actions runner.
Same caveat as the CI security-scanning jobs in `daily-checks.yml` — it needs
a real pull request, and this needs a real VPS, to prove out.

### 8.4 CI/CD (GitHub Actions)

Three workflows, one per stage, each gated on `node backend/test_suite.js`
+ `npm audit --audit-level=high` (same test gate `.github/workflows/daily-checks.yml`
already runs) passing before deploying:

- `cd-dev.yml` — push to `develop` → deploy to `dev-backend` (+
  `nonprod-licensing` if `licensing_server/` changed) → smoke-test
  `GET https://dev.<domain>/api/ready`, polled for up to 60s, then
  `/api/health`.

> **Two probes, two questions** (added 2026-08-16). `GET /api/health` is
> **liveness**: is the process alive and on the expected commit? It touches no
> dependency on purpose, so a restart supervisor never kills a process for a
> fault restarting cannot fix. `GET /api/ready` is **readiness**: can it serve a
> request end to end right now? It answers 503, naming the failing check, until
> the ledger opens and every migration the build ships is applied — and while
> the process is draining. Point the load balancer and the deploy gate at
> `/api/ready`; point the process supervisor at `/api/health`.
>
> **Restarts drain.** SIGTERM/SIGINT flips readiness to 503 first, closes the
> listener second, and closes the ledger last, so a sale already posting still
> finishes. `SHUTDOWN_GRACE_MS` (default 10000) caps the wait. **`kill_timeout:
> 15000` in the PM2 configs must stay above it** — PM2's default is 1600ms and
> would SIGKILL mid-drain.
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

## 9. First production boot — the one ordering that is not obvious

Applies to **any** install running `NODE_ENV=production`: the §8.1 Live
instance and every per-tenant server from §1–7. Dev and Sandbox run
`NODE_ENV=development` and are unaffected.

`backend/productionGuard.js` runs inside `bootstrapServer()` *before* the
listener binds, and refuses to start if any of these hold:

| Blocker | Fix |
|---|---|
| Razorpay key/secret missing, or still the shipped `rzp_test_xxxxxx` demo pair | Settings → Payment Gateway |
| No `razorpayWebhookSecret` | Razorpay dashboard → Webhooks → save its secret |
| No `publicUrl` / `PUBLIC_URL`, or one that is not `https://` | `.env` (the provisioner now writes it) or Settings |
| Admin PIN still the default `1234` (checked against the scrypt hash, not by string equality) | Settings → change the master PIN |
| `goldApiProvider` is `mock` | Settings → a real rate provider |

This is deliberate and must not be relaxed — it is what stops an install
taking money it cannot honour. But it creates a **bootstrap ordering trap**:
those values live in `settings.json`, which is edited through the admin UI,
which needs a running server. Deploy `main` to a fresh box and `cd-live.yml`
smoke-tests a process that exited 1, with no in-app way to fix it.

**Bring a new production install up in this order:**

**Every `pm2` command below runs as the `deploy` user**, not root. The
provisioner starts all processes as `deploy`, and PM2 keeps one daemon *per
user* — a root-run `pm2` silently talks to a different, empty daemon, so
`pm2 list` shows nothing and `pm2 start` launches a second copy competing for
the same port. This is the single easiest thing to get wrong here.

1. Deploy normally. Expect the Live process to fail its first health check:
   ```bash
   sudo -u deploy pm2 list                                  # gold-pos-live: errored
   sudo -u deploy pm2 logs gold-pos-live --lines 40 --nostream
   ```
   That prints the numbered `REFUSING TO START` list. On stock settings it is
   exactly three items — demo Razorpay credentials, no webhook secret, and the
   default admin PIN. (`publicUrl` is already satisfied by the `PUBLIC_URL` the
   provisioner writes, and `goldApiProvider` defaults to `public`, not `mock`.)
2. Start it once in demo mode so the UI is reachable. Port 5000 is free
   because the real process is not running, so Nginx proxies to this one:
   ```bash
   cd /opt/gold-pos/live-backend
   sudo -u deploy env NODE_ENV=development ENV_NAME=live \
       pm2 start backend/server.js --name gold-pos-bootstrap
   ```
   `NODE_ENV=development` wins over the `.env` because dotenv never overrides
   a variable already in the environment — which is exactly what disarms the
   guard for this one temporary process.
3. Open `https://app.<domain>`. It shows the license activation overlay first:
   issue a key at `https://license.<domain>` (bearer token = the
   `ADMIN_SECRET` in `/opt/gold-pos/live-licensing/licensing_server/.env`),
   activate it, then set every row of the table above through Settings.
   **Track C first** — you need real Razorpay keys to clear two of the three
   blockers, and test keys are instant and need no KYC.
4. Tear the temporary process down and hand control back to the real config:
   ```bash
   sudo -u deploy pm2 delete gold-pos-bootstrap
   cd /opt/gold-pos/live-backend
   sudo -u deploy pm2 startOrRestart deploy/ecosystem.live.config.cjs --update-env
   sudo -u deploy pm2 save
   ```
5. `curl https://app.<domain>/api/health` → `{"status":"ok","env":"live"}`.
   A clean boot here means the guard found nothing; that is the real
   go-live gate.
6. `curl https://app.<domain>/api/ready` → `{"status":"ready",…,"checks":
   {"database":"ok","migrations":"current"}}`. Liveness only proves the process
   started; this proves it can actually serve. A 503 here names which check
   failed — a pending migration is the usual one on a first boot.

Re-deploys after this point are ordinary — the settings persist in
`backend/data/`, which no deploy touches.

**Do not "temporarily" set `NODE_ENV=development` in the Live `.env` to get
past this.** It disarms the guard permanently and silently, and `.env`
survives every `git reset --hard`, so nothing will ever remind you.
