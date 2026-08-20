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
| `RAILWAY_VOLUME_MOUNT_PATH` | Railway production | Mount a persistent Railway Volume at `/data` and set this exact value to `/data`. The app refuses Railway production without it. |
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
- For Railway production, create one Railway Volume mounted at **`/data`** and
  set `RAILWAY_VOLUME_MOUNT_PATH=/data`. The resolved paths are
  `DB_PATH=/data/inventory.db`, `UPLOAD_DIR=/data/uploads`, and
  `BACKUP_DIR=/data/backups`; do not point any of them outside `/data`.
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

1. Before cutover, create and mount the `/data` volume, set the four variables
   above, and run the service as exactly one replica.
2. Run a fresh `node server/backup_db.js`, copy that verified snapshot off the
   service, then deploy. Wait for `/api/health` to return HTTP 200 with
   `{"status":"ok","database":"ready","persistentStorage":true}` before
   sending production traffic.
3. For a restore, first stop the sole service and wait for its 15-second drain.
   Preserve the current `/data/inventory.db`, `-wal`, and `-shm` files as an
   incident copy; replace `inventory.db` with the verified snapshot, and remove
   only the stale `inventory.db-wal` and `inventory.db-shm` sidecars from that
   stopped database directory.
4. Restart one replica, confirm `/api/health` is healthy, then verify a known
   product and recent order in the admin UI before reopening traffic. Record
   the controlled restart and backup timestamp in the incident log.

## 7. Production checklist

- [ ] `NODE_ENV=production` set on the host
- [ ] `JWT_SECRET` is a fresh long random value
- [ ] `ALLOWED_ORIGINS` lists your real domain(s)
- [ ] `OWNER_EMAIL` set to your owner address(es) — so a stranger can't claim owner
- [ ] `RESEND_API_KEY` + `RESEND_FROM` set (and a domain verified in Resend) so sign-in codes actually email
- [ ] `APP_URL` set to your public URL (used in emails)
- [ ] Exactly one Railway replica has a Volume mounted at `/data`
- [ ] `RAILWAY_VOLUME_MOUNT_PATH=/data` and the resolved `DB_PATH`, `UPLOAD_DIR`, and `BACKUP_DIR` stay under `/data`
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
