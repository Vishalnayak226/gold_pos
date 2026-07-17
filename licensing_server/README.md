# SaaS Central Licensing Server

A portable, serverless-ready microservice designed for issuing, suspending, and verifying POS application licenses.

## Key Features
1. **RSA-2048 Cryptographic Handshakes:** Signs verification responses with an RSA Private Key. POS client instances verify this signature using the matching Public Key, preventing DNS overrides or spoofed server hacks.
2. **Database Agnostic Adapter:** Easily swaps out local JSON file storage for Cloudflare KV, MongoDB, Postgres, or Redis.
3. **PDF-Ledger Style Admin Control:** Password-protected dashboard to manage keys, set custom expirations, and revoke clients in real-time.
4. **Signed Release Registry (added 2026-07-17):** Publish new POS platform releases here; every tenant's `backend/updateEngine.js` polls and cryptographically verifies them before ever applying anything. See "Release Registry & Tiered Updates" below.
5. **Liveness Probe:** `GET /api/health` (public) returns `{status, version, env}` — used by CI post-deploy smoke tests and uptime monitoring (see `deploy/README.md` §8).

---

## Release Registry & Tiered Updates

This server is also the authority POS clients trust for platform updates —
full mechanism in `docs/ai_handover.md` §7, summarized here for anyone
working directly in this codebase.

**How it works:** on first boot this server generates a dedicated
**release-signing RSA-4096 keypair** (`keys/release_private.pem` /
`release_public.pem`) — deliberately separate from the license-signing key
above, so compromising one can never unlock the other. `keys/release_public.pem`
must be copied to every POS client at `backend/keys/release_public.pem`
before that client can verify (and therefore ever apply) a release.

**Publishing a release** (admin dashboard "Publish Release" form, or
directly):
```bash
curl -X POST http://localhost:6060/api/admin/releases \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -d '{
    "version": "1.1.1",
    "channel": "security",
    "changelog": "Fixes X",
    "downloadUrl": "https://your-host/release-1.1.1.zip",
    "sha256": "<sha256 of that zip>"
  }'
```
`channel` must be `security`, `feature`, or `patch` — see `CHANGELOG.md`
"Release channels" for what each one means to a tenant. The server signs
`{version, channel, changelog, downloadUrl, sha256, publishedAt}` and stores
it in `data/config.json`'s `releases` array (an append-only registry — there
is no edit/delete endpoint by design, so a tenant can never be shown a
retroactively-altered release history).

**Reading the registry:**
- `GET /api/releases/latest?channel=security` — public, returns the newest
  release on that channel (or all channels if `channel` is omitted) as
  `{payload, signature}`. This is exactly what `backend/updateEngine.js`
  polls daily. Returns `404` if nothing has been published on that channel.
- `GET /api/releases` — admin-only, lists every published release for the
  dashboard.
- `GET /api/version` — legacy/simple endpoint, returns just
  `{latestVersion}` (derived automatically from the highest version in the
  registry) for anything that only needs a version number, not the full
  signed payload.

---

## Local Development & Testing

1. Navigate to the licensing server directory:
   ```bash
   cd licensing_server
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Boot the server:
   ```bash
   npm start
   ```
   * The server runs at `http://localhost:6060` by default (not :6000 — that port is on the WHATWG Fetch spec's forbidden-port list and breaks the POS client's fetch()-based license handshake).
   * On startup, it automatically generates a public/private RSA key pair inside `keys/` if not present.
   * Master admin secret token defaults to: `MASTER-ADMIN-SECRET-12345` (set `ADMIN_SECRET` environment variable to override).

---

## Deploying to Cloudflare Workers (Zero Cost, Zero Maintenance)

Cloudflare Workers run globally and are entirely free for up to 100k requests/day.

1. **Initialize wrangler configuration:**
   Install Wrangler CLI globally:
   ```bash
   npm install -g wrangler
   ```
2. **Create a Worker project:**
   Initialize wrangler in the licensing directory. Create a KV namespace named `LICENSES_KV`:
   ```bash
   wrangler kv:namespace create LICENSES_KV
   ```
3. **Adapt DB Adapter code:**
   Replace the `DatabaseAdapter` methods inside `server.js` with direct Cloudflare bindings:
   ```javascript
   class DatabaseAdapter {
       static async getLicenses() {
           const val = await env.LICENSES_KV.get("keys_list");
           return val ? JSON.parse(val) : [];
       }
       static async saveLicenses(licenses) {
           await env.LICENSES_KV.put("keys_list", JSON.stringify(licenses));
       }
   }
   ```
4. **Deploy:**
   Run `wrangler deploy` to push the worker live.

---

## Migrating Database Adapters

If you wish to migrate to MongoDB or PostgreSQL in the future:
1. Change the static methods inside `DatabaseAdapter` in [server.js](file:///c:/Users/ABCD/Documents/Antigravity%20Projects/Web%20POS/licensing_server/server.js):
   * Swap out local file reads (`fs.readFileSync`) for SQL queries (`SELECT * FROM licenses`) or Document queries (`db.collection('licenses').find()`).
2. The core routing and RSA validation flows remain 100% untouched.
