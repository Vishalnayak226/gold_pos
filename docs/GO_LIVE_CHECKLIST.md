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
| **A** | Pipeline infra | Domain + 2GB VPS + DNS + one provisioning command + GitHub wiring | ~90 min | ~₹1,000/yr + ~₹900/mo |
| **B** | SMTP | Real mail credentials for the daily report email | ~15 min | Free |
| **C** | Razorpay | Real test keys now, live keys after KYC | ~10 min (test) | Free (2% per txn live) |
| **D** | Pricing | One number + billing cycle, typed into the licensing dashboard | ~2 min | — |
| **E** | Play Store | $25 account, branding assets, privacy-policy URL, Android Studio machine | ~1 day + review | $25 one-time |

---

# Track A — Dev/Sandbox/Live pipeline infrastructure

**What this is for:** one server *you* control where a change is proven
before it ever reaches a paying tenant. Separate from any tenant's own
server (Track F below). Architecture: `deploy/README.md` §8.

### A1 — Buy a domain

- [ ] **Where:** any registrar — Namecheap, Cloudflare Registrar (cheapest,
      at-cost), GoDaddy, BigRock.
- [ ] **What:** one domain, e.g. `yourpos.com`. It can be the same domain
      you later use for tenant subdomains, or a separate internal one.
- **Cost:** ~₹800–1,200/yr for a `.com`.
- **Hand back:** the domain name.

### A2 — Buy a 2GB VPS

- [ ] **Where** (pick one — India/Singapore regions keep latency low for
      Indian users):
  - DigitalOcean, Bangalore (BLR1) — 2GB/1vCPU, **$12/mo**
  - AWS Lightsail, Mumbai — 2GB, **$12/mo**
  - Vultr, Mumbai — 2GB, **$10/mo**
  - Hetzner CX22 (EU only, higher latency from India) — 4GB, **~€4.5/mo**,
    by far the best value if latency doesn't matter for an internal
    pipeline box
- [ ] **What:** Ubuntu 22.04 or 24.04 LTS, **2GB RAM minimum**. Five Node
      processes plus Nginx run on it — 1GB will start swapping.
- [ ] Add your SSH key during creation (every provider offers this) so you
      can log in without a password.
- **Cost:** ~$10–12/mo (~₹900–1,100).
- **Hand back:** the server's public IP.

### A3 — Point 5 DNS A records at it

- [ ] **Where:** your registrar's DNS panel (or Cloudflare if you moved
      nameservers there).
- [ ] **What:** five A records, all → the VPS IP from A2. Set TTL to 300
      (5 min) for now so mistakes are cheap to fix.

| Type | Host / Name | Value | Becomes |
|---|---|---|---|
| A | `dev` | `<VPS IP>` | Development POS |
| A | `sandbox` | `<VPS IP>` | Sandbox/UAT POS |
| A | `app` | `<VPS IP>` | Live POS (your own pilot instance) |
| A | `license-dev` | `<VPS IP>` | Non-prod licensing server |
| A | `license` | `<VPS IP>` | **Production licensing server** |

- [ ] Verify before moving on — all five must return the VPS IP:
      ```bash
      for h in dev sandbox app license-dev license; do echo -n "$h: "; dig +short $h.yourpos.com; done
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
Node/PM2/Nginx/Certbot, the 5 git checkouts, 5 `.env` files with the right
ports and licensing URLs, 5 PM2 apps, 5 Nginx vhosts, TLS certs, firewall,
and signing-key setup — in one idempotent run. It exists because the five
checkout directory names must match what `.github/workflows/cd-*.yml`
hardcodes exactly; typing them by hand is the single easiest thing to get
wrong.

- [ ] **Where:** SSH'd into the VPS as root.
- [ ] **How:**
      ```bash
      ssh root@<VPS-IP>
      apt-get update && apt-get install -y git
      git clone https://github.com/Vishalnayak226/gold_pos.git /tmp/gold-pos-bootstrap
      cd /tmp/gold-pos-bootstrap
      chmod +x deploy/provision-pipeline.sh
      ./deploy/provision-pipeline.sh \
          --domain yourpos.com \
          --email you@example.com \
          --ssh-pubkey "ssh-ed25519 AAAA...   gold-pos-ci-deploy"
      ```
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
| Variable *(Variables tab, not Secrets)* | `PIPELINE_DOMAIN` | `yourpos.com` — bare domain, no `https://`, no subdomain |

- [ ] **Where:** same Settings page → **Environments** → New environment.
      Create all three, exact lowercase names — the workflows reference them
      by name and fail if missing:

| Environment | Protection |
|---|---|
| `development` | none |
| `sandbox` | none |
| `production` | **Required reviewers → add yourself.** This is the manual Approve click that stands between `main` and your Live instance. |

### A7 — Prove it works end to end

- [ ] Push any trivial change to `develop` → the Actions tab should show
      **Deploy — Development** go fully green, and
      `https://dev.yourpos.com/api/health` should return
      `{"status":"ok","env":"dev"}`.
- [ ] PR `develop` → `staging`, merge → Sandbox deploys the same way.
- [ ] PR `staging` → `main`, merge → the run should **pause** on
      "Deploy to Live (requires manual approval)" until you click Approve.
      If it doesn't pause, the `production` environment's reviewer rule
      isn't saved.
- [ ] Sanity-check license isolation: activate a fake key against
      `license-dev.yourpos.com`'s dashboard and confirm it does **not**
      appear in `license.yourpos.com`'s dashboard.
- **Hand back:** a shout if any of these go red — paste the failing job log
  and I'll fix it.

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
      in `https://license.yourpos.com` (admin token = the live
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
2. [ ] One DNS A record: `storename.yourpos.com` → that server's IP.
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
