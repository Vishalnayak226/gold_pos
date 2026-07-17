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
- [x] Docs updated: `deploy/README.md` §8, `docs/PROJECT_PLAN.md` §5.14, `docs/GO_LIVE_CHECKLIST.md` §6, `CHANGELOG.md`
- [x] Verified locally: ecosystem configs load, `node --check` passes, full `backend/test_suite.js` suite green, `/api/health` responds correctly and is exempt from the license gate

## Done — repo-side, no external accounts needed

- [x] Confirmed local `main` is in sync with `origin/main` (0 ahead / 0 behind — one commit on both)
- [x] Created `develop` and `staging` branches locally (point at `main` for now; not yet pushed)
- [x] Generated the CI→VPS deploy SSH keypair (ed25519), kept **outside the repo** in the session scratchpad — private key never touches git. Public key, safe to install anywhere:
  ```
  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPcNHDaetwGS6IeQq2/BSa8qsM/nfvBI7DGZTtQQcAZd gold-pos-ci-deploy
  ```
  Once the VPS exists: `mkdir -p ~/.ssh && echo "<line above>" >> ~/.ssh/authorized_keys` as the `deploy` user. The private key is what goes into the `VPS_SSH_KEY` GitHub secret — I still have it in this session; say the word when you're ready to wire it in (or I can regenerate a fresh one at that point instead).
- [ ] **Open decision:** the repo currently has only one commit (`1d7ad4f Initial commit`) with a large backlog of uncommitted work sitting on top of it (Phases 9-19). Nothing here pushes anywhere without your go-ahead first — flagging as its own item below.

## Needs your decision (no external account required, just your call)

- [ ] Commit the current uncommitted backlog (Phases 9-19 worth of work)? If yes, as one commit or broken up?
- [ ] Push to `origin` (`github.com/Vishalnayak226/gold_pos`) — and if so, is that repo private? (It'll hold real architecture detail once pushed.)

## Blocked on you — external accounts/payment (nothing I can act on)

- [ ] Buy a domain + a 2GB RAM VPS (`docs/GO_LIVE_CHECKLIST.md` §6)
- [ ] Point 5 DNS A records at the VPS (`dev.`, `sandbox.`, `app.`, `license-dev.`, `license.`)
- [ ] SSH in and run the `deploy/README.md` §8.2 provisioning steps (Node/PM2/Nginx/Certbot, 5 checkouts, 5 PM2 apps, 5 vhosts + TLS) — I'll walk through this live with you once you're SSH'd in
- [ ] Install the deploy public key in the `deploy` user's `~/.ssh/authorized_keys` on the VPS
- [ ] Add GitHub repo secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`
- [ ] Add GitHub repo variable: `PIPELINE_DOMAIN`
- [ ] Create GitHub Environments `development`, `sandbox`, `production` (Settings → Environments); add required reviewers on `production` only

## Not yet exercised end-to-end (depends on everything above existing)

- [ ] First real run of `cd-dev.yml` against a live VPS
- [ ] Confirm the manual-approval gate actually blocks `cd-live.yml` until approved
- [ ] Confirm license isolation: a fake key activated via `license-dev.<domain>` never appears in the production licensing dashboard
