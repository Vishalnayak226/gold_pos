# Pipeline Build Checklist — Dev / Sandbox / Live (Phase 19)

Single running checklist for standing up the pipeline designed in
`deploy/README.md` §8. I update this file directly as items complete —
re-open it anytime for current status instead of asking. Broader go-live
items unrelated to this pipeline (SMTP, Razorpay, Play Store, pricing) stay
tracked separately in `docs/GO_LIVE_CHECKLIST.md`.

---

## Done — code-side

- [x] `GET /api/health` on `backend/` and `licensing_server/`
- [x] Per-env PM2 configs (`deploy/ecosystem.{dev,sandbox,live,licensing-nonprod,licensing-live}.config.cjs`)
- [x] `deploy/remote-deploy.sh` shared deploy script
- [x] `cd-dev.yml` / `cd-sandbox.yml` / `cd-live.yml` GitHub Actions workflows
- [x] `deploy/provision-pipeline.sh` — one-command, idempotent provisioner that
      performs all of `deploy/README.md` §8.2 (added 2026-08-07). Replaces the
      hand-typed walkthrough: the 5 checkout directory names have to match what
      `cd-*.yml` hardcodes exactly, and that table now lives in code instead of
      in a human's typing.
- [x] Signing-key overlay in `deploy/remote-deploy.sh` (added 2026-08-07) —
      fixes a latent deploy-breaker: `backend/keys/*_public.pem` are *tracked*
      files, so `git reset --hard` on every deploy reverted them to the
      laptop-generated pair, which cannot match the keypair a fresh licensing
      server generates on the VPS at first boot. Left unfixed, every license
      activation on the pipeline VPS would have failed signature verification
      and `updateEngine.js` would have rejected every release. Keys are now
      pinned in `/opt/gold-pos/keys/<checkout>/`, outside any checkout, and
      re-applied after each reset.
- [x] Docs updated: `deploy/README.md` §8, `docs/PROJECT_PLAN.md` §5.14, `docs/GO_LIVE_CHECKLIST.md` §6, `CHANGELOG.md`
- [x] Verified locally: ecosystem configs load, `node --check` passes, full `backend/test_suite.js` suite green, `/api/health` responds correctly and is exempt from the license gate

## Done — repo/git

- [x] Committed the accumulated backlog as 2 logical commits (not the ~10 originally guessed — turned out Phases 1-17 were already folded into the single `Initial commit`, so there was nothing to split there without rewriting already-pushed history, which wasn't done):
  - `969e88a` — Phase 18: security/reliability hardening (v1.0.1) + tiered auto-update platform (v1.1.0)
  - `e4999bc` — Phase 19: this pipeline
- [x] Created `develop` and `staging` branches and pushed all three (`main`, `develop`, `staging`) to `origin` (`github.com/Vishalnayak226/gold_pos`)
- [~] ~~Generated the CI→VPS deploy SSH keypair in the session scratchpad~~ —
  **superseded 2026-08-07.** That scratchpad has since been wiped, so the
  private key no longer exists and the public key above it was useless on its
  own. Replaced by a better arrangement: **you** generate the keypair on your
  own machine (`docs/GO_LIVE_CHECKLIST.md` §A4, one `ssh-keygen` command), so
  the private key is durable and under your control rather than living in an
  ephemeral agent temp directory. `provision-pipeline.sh --ssh-pubkey "..."`
  installs the public half on the VPS for you.

⚠️ **Heads up:** pushing to `develop`/`staging`/`main` just triggered `cd-dev.yml`/`cd-sandbox.yml`/`cd-live.yml` for real on GitHub Actions. The test-gate job should pass, but the deploy job in each will fail (no `VPS_HOST`/`VPS_USER`/`VPS_SSH_KEY` secrets exist yet) — expected and harmless, just don't be surprised by red X's in the Actions tab until the VPS + secrets exist.

## Blocked on you — external accounts/payment (nothing I can act on)

Full step-by-step with exact commands, costs and click paths:
**`docs/GO_LIVE_CHECKLIST.md` Track A.** Short version:

- [ ] A1/A2 — Buy a domain + a 2GB RAM VPS
- [ ] A3 — Point 5 DNS A records at the VPS (`dev.`, `sandbox.`, `app.`, `license-dev.`, `license.`)
- [ ] A4 — `ssh-keygen` the CI deploy keypair on your machine
- [ ] A5 — SSH in as root and run `deploy/provision-pipeline.sh --domain ... --email ... --ssh-pubkey "..."`
      (this now covers the whole of `deploy/README.md` §8.2 — Node/PM2/Nginx/Certbot,
      5 checkouts, 5 `.env` files, 5 PM2 apps, 5 vhosts + TLS, firewall, signing keys —
      so there is no longer a live walkthrough to schedule)
- [ ] A5 — Save the two `ADMIN_SECRET` values the script prints (not recoverable elsewhere)
- [ ] A6 — Add GitHub secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` + variable `PIPELINE_DOMAIN`
- [ ] A6 — Create GitHub Environments `development`, `sandbox`, `production`; required reviewers on `production` only

## Not yet exercised end-to-end (depends on everything above existing)

- [ ] First real run of `cd-dev.yml` against a live VPS
- [ ] Confirm the manual-approval gate actually blocks `cd-live.yml` until approved
- [ ] Confirm license isolation: a fake key activated via `license-dev.<domain>` never appears in the production licensing dashboard
