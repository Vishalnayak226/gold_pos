# Go-Live Checklist — External Setup Only

Everything code-side is done and verified (see `docs/PROJECT_PLAN.md` §6). What's
left is entirely external: accounts, credentials, and decisions that require
you personally (signups need your identity/payment details; an AI agent
cannot complete KYC, hold a credit card, or own a Google/Razorpay account on
your behalf). This doc is the concrete, step-by-step version of the "Blocked
on Inputs" list — work through it at your own pace, then hand the resulting
values back and they get wired in immediately.

---

## 1. VPS / Cloud Hosting

**Goal:** one small Linux server to run the first tenant's `backend/` on.

1. Pick a provider — any is fine, this app has no exotic requirements:
   DigitalOcean, Hetzner, AWS Lightsail, Linode are all common ~$5-6/mo
   choices for a single-tenant Node app.
2. Create the cheapest Ubuntu 22.04+ droplet/instance (1 vCPU / 1GB RAM is
   plenty to start).
3. Point a DNS A record for the tenant's subdomain (e.g.
   `storename.yourpos.com`) at the server's IP — do this in whatever
   registrar manages your domain.
4. SSH in and follow `deploy/README.md` top to bottom — it's already written
   and covers Node install, PM2, Nginx, and Certbot TLS in full. That
   runbook is the rest of this step; nothing further needed from me until
   you're SSH'd in and hit something the doc doesn't cover.

**Hand back to me (optional):** nothing required — but if you want me to
walk through the actual `deploy/README.md` commands with you interactively
(pasting output back and forth), that works fine.

---

## 2. Real SMTP Credentials (for Phase 13's report emails)

**Goal:** `settings.smtp.{host,port,user,pass}` in Settings → Backup & Email.

Two realistic options, pick one:

**A. Gmail (fastest for testing/small scale)**
1. Use any Gmail account (a dedicated one is cleaner than a personal inbox).
2. Turn on 2-Step Verification: myaccount.google.com/security
3. Create an **App Password**: myaccount.google.com/apppasswords — choose
   "Mail" as the app. Copy the 16-character password.
4. Settings: Host `smtp.gmail.com`, Port `587`, Secure unchecked (STARTTLS),
   Username = the Gmail address, Password = the app password (not your
   regular Gmail password).

**B. A transactional email service (better for real production volume)**
1. Sign up for SendGrid, Postmark, or Resend (all have free tiers, e.g.
   SendGrid: 100 emails/day free).
2. Verify a sending domain or single sender email (their dashboard walks
   you through this — usually a DNS TXT/CNAME record).
3. Generate an SMTP API key from their dashboard.
4. Settings: Host/port from their docs (SendGrid: `smtp.sendgrid.net:587`),
   Username is usually literally `apikey`, Password = the API key they gave
   you.

**Hand back to me:** the host/port/user/pass once you have them, or just go
to Settings → Backup & Email yourself and paste them in — the UI is already
built and will "Send Daily Report Now" to test it live.

---

## 3. Razorpay Credentials (real test or live mode)

**Goal:** `settings.razorpayKeyId` / `razorpayKeySecret` in Settings →
Payment Gateway (replacing the demo mock pair).

1. Sign up at dashboard.razorpay.com — this requires your own identity;
   I cannot create this account.
2. **Test mode is instant** — no KYC needed. Dashboard → Settings → API Keys
   → Generate Test Key. You get a `rzp_test_...` key ID + secret immediately
   — good enough to fully verify the real (non-mocked) Razorpay order→verify
   flow end-to-end.
3. **Live mode requires KYC** — PAN, bank account, business proof (or
   individual proof if you're a sole proprietor). Razorpay reviews this,
   typically within a few business days. Only needed when you want to
   accept real money.
4. Paste the key ID + secret into Settings → Payment Gateway. Important:
   any pair *other than* the exact demo placeholder
   (`rzp_test_xxxxxx` / `rzp_test_xxxxxx_secret`) is sent to the real
   Razorpay API — so a genuine test key already exercises the real
   integration path, not the mock.

**Hand back to me:** nothing required — this is a self-serve UI field. If
you want me to verify a specific key pair works, paste it in and I can test
the order-creation call.

---

## 4. Play Store (Android app — Phase 17)

**Goal:** publish the Capacitor-wrapped customer portal (`mobile/`).

1. Google Play Console account: play.google.com/console — **one-time $25
   registration fee**, needs your Google account + ID verification.
2. Branding assets you'll need to prepare or commission:
   - App icon (512×512 PNG)
   - Feature graphic (1024×500 PNG)
   - At least 2 phone screenshots
   - A privacy policy, hosted at a URL you control (mandatory — this app
     handles phone-number login and payments, Play Store will reject a
     listing without one)
3. A machine with Android Studio + JDK 17 installed (this sandbox doesn't
   have one) — follow `mobile/README.md` to build a signed APK/AAB.
4. Create the store listing in Play Console, upload the AAB, fill in the
   assets above, submit for review (Google's review is typically 1-3 days
   for a first submission, can take longer).

**Hand back to me:** nothing I can act on remotely here — this is the one
item that's a different-machine-plus-your-accounts task through and
through. Happy to keep helping with `customer.html` changes if the app
review comes back asking for anything specific.

---

## 5. Pricing

Being seeded directly into the licensing schema once you give me the number
— see the live conversation. This file will be updated once that's locked
in, since it's a one-line change, not a multi-step external process.

---

## 6. Dev/Sandbox/Live Pipeline VPS + Domain (Phase 19)

**Goal:** one server the platform owner controls for trying changes safely
before they ever reach a real tenant — separate from any individual
tenant's own server in §1.

1. A domain (can be the same one used for tenant subdomains, or a separate
   one — e.g. `yourpos-internal.com`) and a **2GB RAM** VPS (5 Node
   processes run on it at once — Dev, Sandbox, Live, plus a shared
   non-production and a production `licensing_server`).
2. Point 5 DNS A records at it: `dev.`, `sandbox.`, `app.`, `license-dev.`,
   `license.` — see `deploy/README.md` §8.1 for exactly what each hosts.
3. Follow `deploy/README.md` §8.2 top to bottom (Node/PM2/Nginx/Certbot
   setup, 5 git checkouts, 5 PM2 apps, 5 Nginx vhosts + TLS) — already
   written, same shape as the §1-7 single-tenant runbook, just repeated
   5 times.
4. In the GitHub repo: add secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`
   and variable `PIPELINE_DOMAIN`, then create a `production` Environment
   with required reviewers (Settings → Environments) so Live deploys need a
   manual approval click.

**Hand back to me:** nothing required to build this out further — the
workflows (`cd-dev.yml`, `cd-sandbox.yml`, `cd-live.yml`) and deploy script
are already written and waiting on this server to exist. Once you're SSH'd
into a fresh VPS, I can walk the `deploy/README.md` §8.2 steps with you the
same way as §1.
