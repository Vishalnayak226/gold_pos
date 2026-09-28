# Native Android Customer App (v1 — Capacitor Wrapper)

Per `docs/PROJECT_PLAN.md` §5.1 / §5.11, the v1 Android app is a
**Capacitor-wrapped shell around the existing `customer.html` portal** — it
reuses the tested UI, ships fastest, and gets a real Play Store presence. A
full React Native rewrite is a later option if ever needed, not this phase.

This scaffold is code-complete but **cannot be built in this sandbox** — an
Android build requires Android Studio, the Android SDK, and a JDK, none of
which are available here. Everything below is what a developer runs on a
machine that has them.

## What's here

- `capacitor.config.json` — points the WebView's `server.url` directly at a
  tenant's live, deployed `customer.html` (HTTPS required — Capacitor
  disallows cleartext by default). This is a thin native wrapper, not a
  bundled offline copy: the app always shows the live portal.
  Set to `https://app.luminapos.in/customer.html` on 2026-08-14 — the platform
  owner's own pilot instance. `server.url` is free to change at any time; the
  next field is not.

> ### ⚠️ `appId` is a one-way door — already decided, do not change it
>
> **`in.luminapos.customer`**, settled 2026-08-14 (was the scaffold default
> `com.goldpos.customerportal`, which predated the brand).
>
> A Play Store listing's package name **can never be changed after the first
> release is published** — not renamed, not migrated. Changing it after
> publication means a brand-new listing that loses every install, rating and
> review, and the old package name can never be reused by anyone, ever.
>
> It was free to set today. From the first upload onward it is permanent, so
> treat this line as frozen unless nothing has ever been published.
- `package.json` — Capacitor Core/CLI/Android dependencies.
- `www/index.html` — a required-but-unused placeholder (Capacitor needs a
  non-empty `webDir` even when `server.url` is set).

## One-time setup (per developer machine)

1. Install [Android Studio](https://developer.android.com/studio) (includes
   the Android SDK) and a JDK 17.
2. `cd mobile && npm ci` — installs the exact versions pinned in
   `package-lock.json` (added 2026-09-19; before that, `mobile/` had no
   lockfile at all and `npm audit` refused to run here — see below). Use
   `npm ci`, not `npm install`, so every machine building this app gets the
   identical dependency tree.
3. Edit `capacitor.config.json` — replace
   `REPLACE-WITH-TENANT-DOMAIN.example.com` with the real deployed domain
   for the tenant this build targets (see `deploy/README.md` for how a
   tenant gets deployed and gets a domain in the first place — Phase 14).
4. `npx cap add android` — generates the native `android/` project (not
   checked in; it's a build artifact of this config).
5. `npx cap sync android`
6. `npx cap open android` — opens the project in Android Studio. From there:
   run on an emulator/device to test, or Build > Generate Signed Bundle/APK
   to produce a release artifact.

## Play Store submission — blocked on platform-owner inputs

Per `docs/PROJECT_PLAN.md` §5.13, publishing needs, from the platform owner:

- A Google Play Developer account.
- App icon, feature graphic, and screenshots (branding assets).
- A privacy policy URL (mandatory for Play Store listings, and this app
  talks to a live backend handling phone-number logins and payments).

None of those exist yet, so this phase stops at "a developer can build and
side-load a working APK" — the actual store listing is a separate,
non-code task once those assets are provided.

## Dependency reproducibility and security (2026-09-19)

- `package-lock.json` is now committed. Previously `mobile/` had none, which
  also meant `npm audit` could not run here at all (it refuses without a
  lockfile) — this was the audit gap tracked as part of
  `docs/WHOLE_APP_QUALITY_AUDIT_2026-09-18.md`.
- Generating that lockfile surfaced a real finding: the scaffold's original
  `@capacitor/{core,android,cli}@^6.0.0` pin resolved to a `tar` version with
  several critical/high archive-extraction advisories (path traversal via
  hardlinks/symlinks, DoS). No non-breaking fix existed within the 6.x line —
  the patched `tar` only ships behind a Capacitor major bump. Bumped all three
  packages to `^7.0.0` (the very next major, not the latest 8.x — a smaller,
  lower-risk migration was preferred since nothing native has ever been built
  against this scaffold yet, so there is no existing customization to
  re-migrate). `npm audit` now reports 0 vulnerabilities.
- **What was verified in this sandbox** (no Android SDK/Studio/JDK
  available here — see the warning at the top of this file): `npm ci`
  installs cleanly, `npx cap --version` reports `7.6.9`, `npx cap sync`
  runs without error against the existing `capacitor.config.json` (no
  platform directory exists yet, so this only proves the CLI and config
  schema are still compatible, not that a native build succeeds).
- **What remains unverified, and must be done on a real machine before
  relying on this**: `npx cap add android`, a real Gradle build, and running
  the app on a device/emulator. If anything in Capacitor 7's own migration
  notes affects Gradle/AGP/`minSdkVersion` requirements, resolve it there —
  this scaffold has no native customization to lose either way.
- `npm run audit:security` / `npm run sbom:dependencies` added, matching the
  convention already used in `backend/` and `licensing_server/`.

## Notes / gotchas for whoever builds this next

- Every tenant needs its **own** build (different `appId` suffix or a
  build-time variable substitution for `server.url`) if multiple tenants
  each want their own branded app — this scaffold as-is is single-tenant.
  A multi-tenant story (one app, server-selects tenant) is out of scope for
  v1 per the locked architecture decision (per-tenant hosting, not
  multi-tenant SaaS at the network layer).
- The customer portal already handles phone-based login, Razorpay checkout,
  and the real `upi://pay` QR fallback (Phase 9) — nothing in the web app
  needs to change for the wrapper to work, by design.
- If `customer.html` ever needs native-only capabilities (push
  notifications, biometric login), add the relevant Capacitor plugin here
  rather than forking the web UI.
