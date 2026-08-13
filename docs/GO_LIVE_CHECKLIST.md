# Go-Live Checklist — Everything Blocked On You

Every code-side item is done and verified (`docs/PROJECT_PLAN.md` §6). What
remains needs *you personally* — signups need your identity and payment
details, and an AI agent cannot complete KYC, hold a credit card, or own a
Google/Razorpay account on your behalf.

**How to use this doc:** work top to bottom. Each task says **what** it is,
**where** to do it, **how** (exact commands/clicks), what it costs, and what
to hand back to me. Tick the boxes as you go — I read this file to know
where things stand, so you don't have to re-explain.

Status tracking for the pipeline build itself lives in
`docs/PIPELINE_CHECKLIST.md`; this file is the external/account work.

---

## Order of play

Do **Track A first** — it unblocks everything else, including having a real
HTTPS URL that Razorpay callbacks and the Play Store privacy policy both
need. B/C/D/E are independent of each other and can happen any time.

| # | Track | What | Time | Cost |
|---|---|---|---|---|
| **A** | Pipeline infra | Domain + VPS + DNS + one provisioning command + GitHub wiring | ~90 min | ~₹1,000/yr + ~₹350–500/mo on `--profile minimal` (~₹1,100/mo on `full`) |
| **B** | SMTP | Real mail credentials for the daily report email | ~15 min | Free |
| **C** | Razorpay | Real test keys now, live keys after KYC | ~10 min (test) | Free (2% per txn live) |
| **D** | Pricing | One number + billing cycle, typed into the licensing dashboard | ~2 min | — |
| **E** | Play Store | $25 account, branding assets, privacy-policy URL, Android Studio machine | ~1 day + review | $25 one-time |

---

# Track A — Dev/Sandbox/Live pipeline infrastructure

**What this is for:** one server *you* control where a change is proven
before it ever reaches a paying tenant. Separate from any tenant's own
server (Track F below). Architecture: `deploy/README.md` §8.

> ### ⚠️ A0 — Get the code onto `main` before A5
>
> As of 2026-08-14, `origin/main`, `origin/develop` and `origin/staging` are
> **all** still at `e4999bc` (Phase 19). Everything from Phase 20 onward —
> the SQLite repository seam, `backend/productionGuard.js`, payment
> verification, multi-line invoices, and `deploy/provision-pipeline.sh`
> itself — exists only on `origin/phase-21-payment-verification-and-production-guard`.
>
> Two consequences, both fatal to A5:
> 1. `deploy/provision-pipeline.sh` **does not exist on `main`**, so the A5
>    bootstrap clone fails with "No such file or directory".
> 2. Even if it did, the five checkouts it creates clone `main` — so the
>    server would run Phase 19 code: no production guard, no SQLite seam, no
>    verified payments.
>
> - [ ] Merge the Phase 20–27 work into `main` (and fast-forward `develop`
>       and `staging` to match, so the pipeline branches aren't inverted).
> - [ ] Confirm with: `git cat-file -e origin/main:deploy/provision-pipeline.sh`
>
> **A1–A4 and A6 do not depend on this** — buy the droplet, set DNS and
> generate the SSH key in parallel while it's sorted out. Only A5 is blocked.

### A1 — Buy a domain

- [ ] **Where:** any registrar — Namecheap, Cloudflare Registrar (cheapest,
      at-cost), GoDaddy, BigRock.
- [ ] **What:** one domain, e.g. `luminapos.in`. It can be the same domain
      you later use for tenant subdomains, or a separate internal one.
- **Cost:** ~₹800–1,200/yr for a `.com`.
- **Hand back:** the domain name.

### A2 — Buy the VPS

- [ ] **Where** (pick one — India/Singapore regions keep latency low for
      Indian users):
  - DigitalOcean, Bangalore (BLR1) — 2GB/1vCPU, **$12/mo**
  - AWS Lightsail, Mumbai — 2GB, **$12/mo**
  - Vultr, Mumbai — 2GB, **$10/mo**
  - Hetzner CX22 (EU only, higher latency from India) — 4GB, **~€4.5/mo**,
    by far the best value if latency doesn't matter for an internal
    pipeline box
- [ ] **What:** Ubuntu 22.04 or 24.04 LTS. **Size depends on the profile you
      provision** (`deploy/README.md` §8.1a):

| Profile | Processes | Droplet | Cost |
|---|---|---|---|
| **`minimal`** *(default — start here)* | 2: Live POS + licensing | 512MB–1GB | **$4–6/mo** |
| `full` | all 5 (adds Dev, Sandbox, non-prod licensing) | 2GB | $12/mo |

  Start `minimal`. A Node process costs ~65MB of runtime floor no matter how
  small the app is (this backend measures ~73MB), so the pipeline's weight is
  **how many environments you run**, not the code. Dev belongs on your own
  laptop at `localhost:5000`, and Sandbox exists to protect a *paying tenant*
  from a bad deploy — worth its RAM the day you have one, not before. Moving up
  later is one idempotent re-run with `--profile full` plus a resize.
- [ ] Add your SSH key during creation (every provider offers this) so you
      can log in without a password.
- **Hand back:** the server's public IP.

**Done 2026-08-14.** DigitalOcean droplet, BLR1, Ubuntu, in its own `Gold POS`
project (the `Custom ERP` droplet is deliberately left alone).

| | |
|---|---|
| Public IP | **`139.59.37.153`** ← this is what DNS and `VPS_HOST` use |
| Private IP | `10.122.0.2` (VPC-internal only; not used by anything yet) |
| Admin SSH key | `~/.ssh/luminapos_admin` — deliberately *not* the pre-existing `id_ed25519`, whose comment is `erp-deploy@…` and which has no passphrase; one leaked file must not hand over both systems |
| CI deploy key | `~/.ssh/gold_pos_ci` — public half goes to A5's `--ssh-pubkey`, private half to A6's `VPS_SSH_KEY` |

```powershell
ssh -i "$env:USERPROFILE\.ssh\luminapos_admin" root@139.59.37.153
```

**Use a separate droplet from any other app you run.** A DigitalOcean
*Project* is only a folder — it groups resources in the UI and allocates
nothing, so two droplets in the same project share no RAM, disk or data and
cannot slow each other down. What *does* cause contention is putting two apps
on **one** droplet; that is the thing to avoid.

**Resizing later** (e.g. `minimal` → `full`): Droplet → **Resize** → power off
→ pick the larger plan. Choose **"CPU and RAM only"**, which is reversible;
"Disk, CPU and RAM" permanently enlarges the disk and **cannot be scaled back
down**. You keep the IP, so DNS from A3 stays valid. 10GB of disk is ample —
SQLite tenant databases are megabytes, not gigabytes.

**Swap is handled for you.** On any box under 2GB the provisioner creates a 2G
swapfile with `vm.swappiness=10`. The real memory risk on a small droplet is
`npm ci` spiking during install, not the running app — without swap the OOM
killer takes the install and provisioning dies halfway through.

### A3 — Point the DNS A records at it

- [ ] **Where:** `luminapos.in` is registered at **Hostinger** — its
      nameservers are `solar.dns-parking.com` / `lunar.dns-parking.com` and the
      bare domain currently resolves to `2.57.91.91` (a Hostinger parking page).
      So use **hPanel → Domains → luminapos.in → DNS / Nameservers → DNS
      Records**, and *keep* Hostinger's nameservers. Moving them to
      DigitalOcean is optional, buys nothing here, and costs propagation time.
      Leave the existing parking `@` / `www` records alone — they don't
      conflict with these subdomains.
- [ ] **What:** A records → the VPS IP from A2. Set TTL to 300 (5 min) for now
      so mistakes are cheap to fix. **On `--profile minimal` you only need the
      first two** — the other three are for `full`, add them when you move up.

| Type | Host / Name | Value | Becomes | Profile |
|---|---|---|---|---|
| A | `app` | `<VPS IP>` | Live POS (your own pilot instance) | both |
| A | `license` | `<VPS IP>` | **Production licensing server** | both |
| A | `dev` | `<VPS IP>` | Development POS | `full` only |
| A | `sandbox` | `<VPS IP>` | Sandbox/UAT POS | `full` only |
| A | `license-dev` | `<VPS IP>` | Non-prod licensing server | `full` only |

- [ ] Verify before moving on — each must return the VPS IP:
      ```bash
      # minimal:
      for h in app license; do echo -n "$h: "; dig +short $h.luminapos.in; done
      # full: for h in dev sandbox app license-dev license; do ... done
      ```
      DNS can take 5–30 minutes. Certbot in A5 fails on any record that
      hasn't propagated, so don't rush this step.

### A4 — Generate the CI deploy SSH key (on your own machine)

This keypair is what GitHub Actions uses to SSH into the VPS. Generate it
yourself so the private key lives with you permanently — an earlier session
generated one in a temp directory and it has since been wiped, which is
exactly why it now belongs on your machine, not mine.

- [ ] **Where:** your Windows machine, PowerShell.
- [ ] **How:**
      ```powershell
      ssh-keygen -t ed25519 -C "gold-pos-ci-deploy" -f "$env:USERPROFILE\.ssh\gold_pos_ci" -N '""'
      Get-Content "$env:USERPROFILE\.ssh\gold_pos_ci.pub"     # public  → goes on the VPS (A5)
      Get-Content "$env:USERPROFILE\.ssh\gold_pos_ci"         # private → becomes VPS_SSH_KEY (A6)
      ```
- The `.pub` line is safe to share anywhere. The other one is **not** —
  never paste it into a file in this repo, only into the GitHub secret box.

### A5 — Provision the server (one command)

`deploy/provision-pipeline.sh` does the whole of `deploy/README.md` §8.2 —
Node 24/PM2/Nginx/Certbot, swap, the git checkouts, their `.env` files with the
right ports and licensing URLs, the PM2 apps, the Nginx vhosts, TLS certs,
firewall, and signing-key setup — in one idempotent run (2 of each on
`--profile minimal`, 5 on `full`). It exists because the checkout directory
names must match what `.github/workflows/cd-*.yml` hardcodes exactly; typing
them by hand is the single easiest thing to get wrong.

> **Prerequisite that is easy to miss:** this clones the repo's **default
> branch** from GitHub. The script — and the whole Phase 20–27 codebase — must
> actually be on that branch first. See the note at the top of Track A.

- [ ] **Where:** SSH'd into the VPS as root.
- [ ] **How:**
      ```bash
      ssh root@<VPS-IP>
      apt-get update && apt-get install -y git
      git clone https://github.com/Vishalnayak226/gold_pos.git /tmp/gold-pos-bootstrap
      cd /tmp/gold-pos-bootstrap
      chmod +x deploy/provision-pipeline.sh
      ./deploy/provision-pipeline.sh \
          --profile minimal \
          --domain luminapos.in \
          --email your-real-email@example.com \
          --ssh-pubkey "ssh-ed25519 AAAA...   gold-pos-ci-deploy"
      ```
      (`--profile minimal` is the default; pass `--profile full` for all 5
      processes. Re-running with `full` later adds the missing three without
      disturbing the running two.)
      (`--email` is for Let's Encrypt expiry notices. Add `--skip-tls` if
      DNS isn't ready yet and run certbot later.)
- [ ] **If the repo is private**, the clone fails and the script tells you
      exactly what to do: generate a read-only key on the VPS, add it under
      GitHub → repo → Settings → **Deploy keys**, then re-run with
      `--repo git@github.com:Vishalnayak226/gold_pos.git`.
- **What "done" looks like:** the script prints a health-check table with
  five green `ok` lines, then a summary block.
- [ ] **Copy the two `ADMIN_SECRET` values** it prints into your password
      manager. They are the admin tokens for the non-prod and production
      licensing dashboards, generated fresh per server, and stored nowhere
      else. Losing the live one means editing `.env` on the server to reset it.
- Re-running the script later is safe — it never overwrites an existing
  `.env` or an existing certificate.

### A6 — Wire up GitHub

- [ ] **Where:** github.com/Vishalnayak226/gold_pos → **Settings** →
      *Secrets and variables* → **Actions**.

| Kind | Name | Value |
|---|---|---|
| Secret | `VPS_HOST` | the VPS IP from A2 |
| Secret | `VPS_USER` | `deploy` |
| Secret | `VPS_SSH_KEY` | **entire** contents of the private key file from A4, including the `-----BEGIN/END OPENSSH PRIVATE KEY-----` lines |
| Variable *(Variables tab, not Secrets)* | `PIPELINE_DOMAIN` | `luminapos.in` — bare domain, no `https://`, no subdomain |

- [ ] **Where:** same Settings page → **Environments** → New environment.
      Exact lowercase names — the workflows reference them by name and fail if
      missing. **On `minimal` you only need `production`:**

| Environment | Profile | Protection |
|---|---|---|
| `production` | both | **Required reviewers → add yourself.** This is the manual Approve click that stands between `main` and your Live instance. |
| `development` | `full` only | none |
| `sandbox` | `full` only | none |

- [ ] **On `minimal`, expect `cd-dev.yml` and `cd-sandbox.yml` to fail** — the
      `dev-backend` / `sandbox-backend` checkouts they SSH to simply don't
      exist yet. Harmless. Either ignore the red X's or disable both workflows
      in the Actions tab until you move up to `--profile full`.

### A7 — Prove it works end to end

**On `--profile minimal`:**

- [ ] Push any trivial change to `main` → the run should **pause** on
      "Deploy to Live (requires manual approval)" until you click Approve.
      If it doesn't pause, the `production` environment's reviewer rule
      isn't saved.
- [ ] After approving, `https://license.luminapos.in/api/health` returns
      `{"status":"ok",...}`. The POS at `https://app.luminapos.in` is the one
      that will still refuse to boot — that's A8 below, and it's expected.

**Additionally, on `--profile full`:**

- [ ] Push any trivial change to `develop` → the Actions tab should show
      **Deploy — Development** go fully green, and
      `https://dev.luminapos.in/api/health` should return
      `{"status":"ok","env":"dev"}`.
- [ ] PR `develop` → `staging`, merge → Sandbox deploys the same way.
- [ ] Sanity-check license isolation: activate a fake key against
      `license-dev.luminapos.in`'s dashboard and confirm it does **not**
      appear in `license.luminapos.in`'s dashboard.
- **Hand back:** a shout if any of these go red — paste the failing job log
  and I'll fix it.

### A8 — Expect Live to refuse its first boot (this is correct)

Dev and Sandbox come up clean. **Live will not**, and that is the safety
feature working, not a bug. `backend/productionGuard.js` refuses to bind the
port until real Razorpay credentials, a webhook secret, an https public URL,
a changed admin PIN, and a real gold-rate provider are all configured — so a
production install can never quietly take money it cannot honour.

The trap: those live in Settings, edited through the admin UI, which needs a
running server. So bring Live up once in demo mode, configure it, then hand
control back.

- [ ] Full procedure: **`deploy/README.md` §9** — blocker→fix table and the
      exact four commands. Do not shortcut it by setting
      `NODE_ENV=development` in the Live `.env`; that disarms the guard
      permanently and silently.
- [ ] Done when `https://app.<domain>/api/health` returns
      `{"status":"ok","env":"live"}` **from the real
      `ecosystem.live.config.cjs` process**. A clean boot there means the
      guard found nothing — that is the actual go-live gate.
- Needs Track C's Razorpay keys first (test keys are enough to get past the
  guard and are instant, no KYC).

---

# Track B — Real SMTP credentials

**What for:** the Phase 13 daily report email. Goes in Settings → Backup &
Email (`settings.smtp.{host,port,user,pass}`).

**Option A — Gmail (fastest):**
1. [ ] Use a dedicated Gmail account, not your personal inbox.
2. [ ] Turn on 2-Step Verification: myaccount.google.com/security
3. [ ] Create an **App Password**: myaccount.google.com/apppasswords → app
       type "Mail". Copy the 16-character password.
4. [ ] In Settings: host `smtp.gmail.com`, port `587`, Secure **unchecked**
       (STARTTLS), username = the Gmail address, password = the app password
       (not your normal Gmail password — that will not work).

**Option B — transactional service (better at real volume):**
1. [ ] Sign up for SendGrid / Postmark / Resend (all have free tiers;
       SendGrid gives 100 emails/day free).
2. [ ] Verify a sending domain or single sender (a DNS TXT/CNAME record —
       you already have a registrar open from A1).
3. [ ] Generate an SMTP API key.
4. [ ] In Settings: e.g. `smtp.sendgrid.net:587`, username literally
       `apikey`, password = the key.

- [ ] Test with **Send Daily Report Now** in that same settings panel.
- **Hand back:** nothing needed — the UI is built. Paste the creds to me
  only if you'd rather I verify the send path.

---

# Track C — Razorpay credentials

**What for:** Settings → Payment Gateway, replacing the demo placeholder
pair.

1. [ ] Sign up at dashboard.razorpay.com (needs your identity — I can't
       create this).
2. [ ] **Test keys are instant, no KYC:** Dashboard → Settings → API Keys →
       Generate Test Key → gives `rzp_test_...` + secret.
3. [ ] **Live keys need KYC:** PAN, bank account, business proof (or
       individual proof for a sole proprietor). Razorpay reviews in a few
       business days. Only needed to accept real money.
4. [ ] Paste key ID + secret into Settings → Payment Gateway.

Important: any pair *other than* the exact demo placeholder
(`rzp_test_xxxxxx` / `rzp_test_xxxxxx_secret`) is sent to the **real**
Razorpay API. So a genuine test key already exercises the real integration,
not the mock — no code change needed between test and live.

- **Hand back:** nothing required. Paste a key pair only if you want me to
  verify order creation against it.

---

# Track D — Pricing

**Good news:** no schema work is pending. `licensing_server/server.js`
already stores `amount` + `billingCycle` (`monthly`/`yearly`) per license
key, signs them into the activation token, and shows them in the admin
dashboard. So "the pricing number" is a **data-entry decision at the moment
you issue the first real key**, not a code change.

- [ ] Decide two things: the number (e.g. ₹2,000) and the cycle
      (monthly or yearly).
- [ ] Enter them in the Amount / Billing Cycle fields when creating the key
      in `https://license.luminapos.in` (admin token = the live
      `ADMIN_SECRET` from A5).

**Hand back:** tell me the number only if you want it as a *default*
pre-filled in the dashboard's new-key form instead of typed each time —
that's a genuine one-line change I'll make on the spot.

---

# Track E — Play Store (Android app)

**What for:** publishing the Capacitor wrapper around `customer.html`
(`mobile/`). This is the one track that needs a different machine as well as
your accounts.

1. [ ] **Account:** play.google.com/console — **$25 one-time** registration,
       needs a Google account + ID verification.
2. [ ] **Branding assets** to prepare or commission:
   - App icon, 512×512 PNG
   - Feature graphic, 1024×500 PNG
   - At least 2 phone screenshots
   - **A privacy policy at a URL you control** — mandatory; the listing is
     rejected without one. This app handles phone-number login and payments.
     Easiest host: a `privacy.html` page on the domain from A1.
3. [ ] **Build machine:** Android Studio + JDK 17 (not available in this
       sandbox). Then follow `mobile/README.md`: `npm install`, set the real
       domain in `capacitor.config.json`, `npx cap add android`,
       `npx cap sync android`, `npx cap open android`, then
       Build → Generate Signed Bundle/AAB.
4. [ ] Create the listing in Play Console, upload the AAB, fill in the
       assets, submit. First review is typically 1–3 days.

**Hand back:** nothing I can act on remotely. I can write the privacy-policy
page for you, and I'll fix any `customer.html` issue the review flags.

---

# Track F — First paying tenant's own server (later)

Not blocking anything above — do this when you actually have a customer. A
tenant gets their **own** small server, updated on their own schedule; they
never share the Track A pipeline box.

1. [ ] Cheapest Ubuntu 22.04+ VPS, 1GB RAM is plenty for one tenant
       (~$5–6/mo).
2. [ ] One DNS A record: `storename.luminapos.in` → that server's IP.
3. [ ] Follow `deploy/README.md` §1–7 top to bottom — Node, PM2, Nginx,
       Certbot, then first-boot license activation using a key you issue
       from the production licensing dashboard.

**Hand back:** nothing — but I'm happy to walk the commands interactively,
pasting output back and forth, when you get there.

---

## Summary — what I need back from you

| From | Value | Needed for |
|---|---|---|
| A1 | Domain name | Everything |
| A2 | VPS public IP | `VPS_HOST`, DNS records |
| A5 | Confirmation the 5 health checks went green | Proceeding to A6 |
| A7 | Any red CI job's log | Me fixing it |
| D | Price + billing cycle *(only if you want it as a dashboard default)* | One-line change |
| — | Nothing at all for B, C, E | Those are self-serve UIs |
