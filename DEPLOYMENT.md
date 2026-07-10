# DC Kids Brand — Deployment Guide

The app is a single Node/Express process that serves both the static frontend
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
| `RESEND_API_KEY` / `RESEND_FROM` | recommended | Sends the 6-digit sign-in codes via Resend. Unset = codes are only printed to the server log (fine for local dev, not production). |
| `APP_URL` | recommended | Public base URL used in emails (e.g. `https://dckidsbrand.com`). |
| `PORT` | no | Listening port (default 3000). Most hosts inject this automatically. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | no | Optional instant order alerts. `TELEGRAM_CHAT_ID` accepts **one or more** comma-separated destinations — each can be a personal chat id or a shared channel/group id. To add the new owner, append their id (e.g. `111111111,222222222`); every destination receives each order. For a channel, add the bot as an admin and use the channel id. |
| `SHOP_NOTIFY_EMAIL`, `SMTP_*` | no | Optional transactional email. |

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

## 4. Data & backups

- SQLite database lives at `server/inventory.db` (plus `-wal`/`-shm` sidecars).
- It is **gitignored** — it holds customer/order data and must not be committed.
- Persist this file across deploys (mount a volume / persistent disk). If it is
  wiped, the catalogue re-seeds and a new admin account is created.
- `node server/backup_db.js` writes a backup copy.

## 5. Production checklist

- [ ] `NODE_ENV=production` set on the host
- [ ] `JWT_SECRET` is a fresh long random value
- [ ] `ALLOWED_ORIGINS` lists your real domain(s)
- [ ] `OWNER_EMAIL` set to your owner address(es) — so a stranger can't claim owner
- [ ] `RESEND_API_KEY` + `RESEND_FROM` set (and a domain verified in Resend) so sign-in codes actually email
- [ ] `APP_URL` set to your public URL (used in emails)
- [ ] `server/inventory.db` on persistent storage
- [ ] Served over HTTPS (required for the PWA service worker and HSTS)

## 6. Google Sign-In setup (optional but recommended)

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
