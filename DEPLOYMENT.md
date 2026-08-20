# DC Kids Brand — Deployment Guide

The app is a single Node 22.13+ / Express process that serves both the static frontend
(project root) and the JSON API under `/api`. The frontend talks to the backend
via the relative path `/api`, so no host/URL configuration is needed — it works
on whatever domain you deploy to.

## 1. Install & run

```bash
cd server
npm install
node server.js
```

The server listens on `PORT` (default 3000) and serves the whole site.

### Keep it running (important)

The storefront has **no products to show if the Node server isn't running** — the
catalogue comes from the API, and the static `products.json` fallback is served by the
same process, so if it stops, the store goes blank. Two safeguards are in place and one
is up to your host:

- The server now has **crash guards** (`uncaughtException` / `unhandledRejection`): a
  single bad request or stray error is logged but **won't take the whole server down**.
- **Run it under a process manager so it auto-restarts** if it ever exits or the box
  reboots. Examples:
  ```bash
  # PM2
  npm install -g pm2
  pm2 start server.js --name dckids
  pm2 startup && pm2 save        # restart on reboot
  ```
  Or a `systemd` unit with `Restart=always`, or your platform's built-in restart policy
  (Render/Railway/Fly all auto-restart a crashed process). Don't run it as a bare
  `node server.js` in a terminal in production — close the terminal and the store dies.

## 2. Required environment (set on your host, in `server/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | **yes (production)** | Set to `production` to enable strict CORS, HSTS, and tight rate limiting. Unset = dev mode (open CORS, no HSTS). |
| `JWT_SECRET` | **yes** | Secret for signing admin/customer sessions. Use a long random string (32+ chars). Never commit it. |
| `ALLOWED_ORIGINS` | production | Comma-separated origins permitted by CORS, e.g. `https://dckidsbrand.com,https://www.dckidsbrand.com`. |
| `OWNER_EMAIL` | recommended | Comma-separated emails auto-activated as owner (manager) on sign-up. Everyone else lands in `pending` and must be approved. Unset = the very first sign-up becomes owner. See §3. |
| `RESEND_API_KEY` / `RESEND_FROM` | optional | Sends admin sign-in codes and notification emails via Resend. Unset in production = storefront checkout continues, while admin email-code sign-in and email notifications are disabled; Google/recovery sign-in remains available. In local development, codes are printed to the server log. |
| `APP_URL` | recommended | Public base URL used in emails (e.g. `https://dckidsbrand.com`). |
| `PORT` | no | Listening port (default 3000). Most hosts inject this automatically. |
| `RAILWAY_VOLUME_MOUNT_PATH` | Railway production | Railway injects `/data` when the Volume is mounted there. Never create or edit this variable manually. The app refuses Railway production without it. |
| `RAILWAY_VOLUME_NAME` | Railway production | Railway injects the attached Volume name. Never create or edit this variable manually. The app refuses Railway production without it. |
| `DB_PATH` | Railway production | `/data/inventory.db` (optional only because it is the default when the volume is configured). |
| `UPLOAD_DIR` | Railway production | `/data/uploads` (optional only because it is the default when the volume is configured). |
| `BACKUP_DIR` | Railway production | `/data/backups` (optional only because it is the default when the volume is configured). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | Optional instant order alerts. `TELEGRAM_CHAT_ID` accepts **one or more** comma-separated destinations — each can be a personal chat id or a shared channel/group id. To add the new owner, append their id (e.g. `111111111,222222222`); every destination receives each order. For a channel, add the bot as an admin and use the channel id. |
| `SHOP_NOTIFY_EMAIL`, `SMTP_*` | no | Optional transactional email. |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | **yes** | Public Firebase web-app configuration used by the customer account page. |
| `GOOGLE_APPLICATION_CREDENTIALS` / `FIREBASE_SERVICE_ACCOUNT_JSON` | production* | Use an external service-account file path, workload identity, or a sealed JSON environment value on Railway-style hosts. Never expose or commit the JSON. |
| `PAYSTACK_SECRET_KEY` | direct payments | Server-only Paystack test/live secret. Never expose it to browser code or Git. |
| `PAYSTACK_AKUA_WEBHOOK_URL` | shared Paystack integration | Akua POS webhook. DC Kids forwards valid `AKUA-` events with the original raw body and Paystack signature. Defaults to the verified Akua production endpoint. |
| `PAYSTACK_LEGACY_WEBHOOK_URL` | shared Paystack integration | Existing app's webhook. Valid references that are neither `DCK-` nor `AKUA-` continue to this fixed URL. |

## 3. First admin account (passwordless)

There is **no seeded admin and no default password**. Admin sign-in is
passwordless: entering an email sends a **6-digit code** (via Resend; unset key =
code printed to the server log). The first owner is claimed like this:

- Set **`OWNER_EMAIL`** to the address(es) that should be owners
  (comma-separated) — e.g. your email plus the store owner's. Anyone signing up
  with a listed email is **auto-activated as owner (manager)** and shown one-time
  **recovery codes**; **everyone else lands in `pending`** and must be approved
  from **Manage Staff → Access Requests**.
- If `OWNER_EMAIL` is unset, the **very first sign-up becomes owner** — fine for
  local dev, but set `OWNER_EMAIL` before exposing the admin publicly so a
  stranger can't claim it first.
- Only **managers** can approve requests (staff cannot), and the approver picks
  each person's role — so approval power only spreads if you grant it.
- **Recovery codes** are the backup sign-in if email is ever unavailable; each
  works once.

## 4. Firebase customer authentication

Customer accounts use Firebase Authentication; the existing admin Google/OTP/recovery-code system remains separate.

1. Create a Firebase project and register a **Web app** for DC Kids.
2. In **Authentication > Sign-in method**, enable **Email/Password** and **Google**.
3. In **Authentication > Settings > Authorized domains**, add `localhost` plus every production hostname that serves the store.
4. Configure the verification-email and password-reset templates with the store name and production continue URL.
5. Set the Firebase password policy to require at least **8 characters**. The app also enforces this minimum before registration.
6. Copy the web app's `apiKey`, `authDomain`, `projectId`, and `appId` into the matching environment variables above.
7. Give the Node server Firebase Admin credentials through Application Default Credentials. If using a service-account JSON file, store it outside the repository and set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path. On Railway-style hosts, store the complete JSON only in the sealed `FIREBASE_SERVICE_ACCOUNT_JSON` variable.

Restart the server after changing configuration. `GET /api/customer/auth/config` intentionally exposes only the four public web fields. Customer profile, orders, addresses, wishlist, and reviews require a verified Firebase email and a valid bearer ID token.

## 5. Paystack direct checkout

1. Configure `PAYSTACK_SECRET_KEY` with a test secret, verify `PAYSTACK_AKUA_WEBHOOK_URL`, and preserve `PAYSTACK_LEGACY_WEBHOOK_URL` for the existing app.
2. Deploy DC Kids over HTTPS, then set the Paystack test webhook to `https://dckidsbrand.com/api/payments/paystack/webhook`.
3. Complete one `DCK-` test transaction, one `AKUA-` transaction, and one transaction from the existing app. Confirm DC Kids processes only `DCK-`, Akua receives only `AKUA-`, and the existing app continues receiving its events unchanged.
4. Configure `SHOP_NOTIFY_EMAIL`, `RESEND_API_KEY`, and a verified `RESEND_FROM` so paid-order details reach the owner.
5. Only after all three test paths pass, switch to the live secret and live webhook. Paystack charges products only; delivery is confirmed separately.

The callback page is not payment authority. Signed Paystack webhooks and server-side verification update orders. Direct checkout remains hidden while the secret is absent.

## 6. Data & backups

- SQLite is authoritative and runs as a **single application instance**. Do not
  scale this service horizontally or attach its `/data` volume to another writer.
- For Railway production, create one Railway Volume mounted at **`/data`**.
  Railway must inject both `RAILWAY_VOLUME_MOUNT_PATH=/data` and
  `RAILWAY_VOLUME_NAME`; never create or edit either injected variable manually.
  The resolved paths are
  `DB_PATH=/data/inventory.db`, `UPLOAD_DIR=/data/uploads`, and
  `BACKUP_DIR=/data/backups`; do not point any of them outside `/data`, and never
  put `DB_PATH` or `BACKUP_DIR` at or beneath the publicly served `UPLOAD_DIR`.
- The database and its `-wal`/`-shm` sidecars hold customer/order data and are
  **gitignored**. Never commit them. Railway health checks call `GET /api/health`,
  which checks SQLite without returning paths, credentials, or record data.
- Railway sends `SIGTERM` during a deploy. Allow the process its **15-second
  drain**: it stops accepting requests, checkpoints WAL, then closes SQLite.
- Run `node server/backup_db.js` daily. It uses SQLite's online backup API,
  verifies `PRAGMA integrity_check`, and retains the 30 newest snapshots in
  `/data/backups`. Also enable Railway Volume backups on a weekly schedule and
  keep at least one tested off-platform copy.

### Safe Railway cutover and restore

**Do not attach a Volume or configure its mount before capture is complete.**
Attaching/configuring a Railway Volume can trigger a deployment; an early deploy
could start the service against an empty database.

1. Keep the old process and its authoritative database running, pause public
   ingress, block new admin writes, and let every in-flight write drain. Do not
   stop or redeploy the old service yet.
2. While the old database remains accessible, run `node server/backup_db.js`
   against it. Require the command's successful `PRAGMA integrity_check`, then
   download the verified snapshot and a complete copy of the existing uploaded
   product images to off-platform storage.
3. Query the old database and record independently checkable evidence: known
   table counts plus several recent order numbers and Paystack references. Keep
   the backup timestamp, integrity result, counts, and references in the cutover
   record. Do not proceed if any capture or verification is incomplete.
4. Only after those artifacts are safely captured, stop the sole service and
   wait for its 15-second drain to finish. Keep public ingress closed.
5. With the service stopped, provision/attach the one Volume at `/data`. Confirm
   Railway injected both `RAILWAY_VOLUME_MOUNT_PATH=/data` and
   `RAILWAY_VOLUME_NAME`; never create either variable manually.
6. Still while stopped, restore the verified snapshot to `/data/inventory.db`
   and restore uploaded images beneath `/data/uploads`. Configure
   `DB_PATH=/data/inventory.db`, `UPLOAD_DIR=/data/uploads`, and
   `BACKUP_DIR=/data/backups`.
7. Start exactly one replica with `node server/server.js`. Require HTTP 200 from
   `/api/health` with
   `{"status":"ok","database":"ready","persistentStorage":true}`, then verify
   the recorded historical counts, order numbers, payment references, and known
   uploaded images against the restored service.
8. Perform one controlled restart, repeat health and historical-record checks,
   record the result, and only then reopen public ingress.

For a later restore into an existing `/data`, first close ingress and stop the
sole service after draining. Preserve the current database plus `-wal`/`-shm` as
an incident copy, restore the verified snapshot and uploads while stopped, and
remove only stale sidecars belonging to that stopped database before step 7.

### Paystack reconciliation after the 2026-08-19 incident

The recovery window begins **2026-08-19 00:00 Africa/Lagos**. Obtain a verified
Paystack transaction export for that window directly from Paystack; do not use
browser callback data, screenshots, forwarded JSON, or an unverified third-party
copy. Before any apply run, create a fresh `node server/backup_db.js` snapshot,
confirm its integrity check passed, and retain an off-platform copy.

The reconciliation command uses the configured `DB_PATH`, accepts either a JSON
array or `{ "data": [...] }`, and always writes a PII-masked JSON report. The
report's parent directory must already exist, and the report file itself must be
new: the command refuses existing files, links, storage/input aliases, and never
overwrites a prior report. Run it against the verified export first without
`--apply`:

```powershell
npm --prefix server run reconcile:paystack -- --input C:\secure\paystack-export.json --report C:\secure\paystack-dry-run-report.json
```

Review every `wouldRestore`, `alreadyPresent`, and `rejected` entry. Only then
run apply with both required attestations:

```powershell
npm --prefix server run reconcile:paystack -- --input C:\secure\paystack-export.json --report C:\secure\paystack-apply-report.json --apply --verified-export --backup-confirmed
```

Apply restores only successful GHS `DCK-` records compatible with DC Kids. Each
new recovery order remains in `payment_review`; product and delivery details
must be confirmed manually. The tool creates no order items, changes no stock,
recognizes no revenue, sends no notification, and makes no Paystack request.
Re-running the same export is safe: existing provider references are reported as
`alreadyPresent` instead of being inserted again. Keep both reports with the
incident record; although they mask email and omit raw metadata, they still
contain payment references and transaction IDs and should be access-controlled.

## 7. Production checklist

- [ ] `NODE_ENV=production` set on the host
- [ ] `JWT_SECRET` is a fresh long random value
- [ ] `ALLOWED_ORIGINS` lists your real domain(s)
- [ ] `OWNER_EMAIL` set to your owner address(es) — so a stranger can't claim owner
- [ ] `RESEND_API_KEY` + `RESEND_FROM` set (and a domain verified in Resend) so sign-in codes actually email
- [ ] `APP_URL` set to your public URL (used in emails)
- [ ] Exactly one Railway replica has a Volume mounted at `/data`
- [ ] Railway injected `RAILWAY_VOLUME_MOUNT_PATH=/data` and `RAILWAY_VOLUME_NAME`; neither was created manually
- [ ] The resolved `DB_PATH`, `UPLOAD_DIR`, and `BACKUP_DIR` stay under `/data`, and private database/backup paths are not beneath uploads
- [ ] Railway and Docker start directly with `node server/server.js`, with `drainingSeconds` set to the string `"15"`
- [ ] Railway health check is `/api/health` and returns HTTP 200 after a controlled restart
- [ ] Daily validated SQLite snapshot and weekly Railway Volume backup configured
- [ ] Served over HTTPS (required for the PWA service worker and HSTS)
- [ ] Production runtime is Node 22.13 or newer
- [ ] Firebase Email/Password and Google providers enabled
- [ ] Firebase authorized domains include localhost and every production hostname
- [ ] Firebase verification/reset templates and 8-character password policy configured
- [ ] All four `FIREBASE_*` public values set
- [ ] Firebase Admin uses ADC/workload identity or an external service-account file
- [ ] Paystack test checkout and `DCK-` webhook processing verified
- [ ] Non-`DCK-` webhook forwarding verified against the existing app
- [ ] Live Paystack secret and webhook configured only after test-mode sign-off
- [ ] `SHOP_NOTIFY_EMAIL` receives an itemised paid-order message

## 8. Admin Google Sign-In setup (optional but recommended)

"Continue with Google" is the fastest everyday login. It replaces the OTP *step*
but keeps the same approve/reject gate — Google proves identity, your `users`
table still decides access. Email-OTP and recovery codes remain as fallbacks.

To turn it on:

1. Go to <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → OAuth consent screen**: set User type **External**, add an
   app name + your support email, and add yourself as a **Test user** (or Publish
   the app once you're ready for all staff).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - **Authorized JavaScript origins**: add every origin the admin page loads from
     — e.g. `http://localhost:3001` for local, and `https://dckidsbrand.com` for
     production. (No redirect URI is needed — this uses the ID-token flow.)
4. Copy the generated **Client ID** and set it in `server/.env`:
   `GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com`
5. Restart the server. The button appears automatically; if the id is ever unset
   or wrong, the page silently falls back to email-OTP.

First Google sign-in from a new email creates a `pending` access request (unless
the email is in `OWNER_EMAIL`), which an owner approves under **Manage Staff →
Access Requests** — same as the email flow.
