# DC Kids Brand

A complete e-commerce storefront **and** admin panel for DC Kids Brand — a children's
clothing, footwear, bedding, and accessories shop. Customers browse and order on the
storefront; the owner manages everything from the admin panel. The checkout flow is
WhatsApp-native (orders are recorded server-side, then confirmed over WhatsApp / mobile
money), which fits a manual-fulfilment SME.

Built deliberately with **vanilla HTML/CSS/JS** on the front end (no framework) and a
small **Node + Express + SQLite** backend, for lightweight load times and easy hosting.

---

## Architecture

One Express process serves **both** the static front end and the JSON API, so there's a
single thing to deploy and no CORS issues in normal use.

```
web prototype 1/
├── index.html          Storefront (catalogue, cart, checkout, tracking)
├── app.js              Storefront logic
├── styles.css          Storefront styles
├── track.html          Order tracking page
├── admin.html          Admin panel (single-page)
├── admin.js            Admin logic
├── admin.css           Admin styles
├── manifest.json       Storefront PWA manifest
├── admin.manifest.json Admin PWA manifest
├── service-worker.js   PWA service worker (offline shell + caching)
├── gradient.js         Decorative background
├── images/             Product & promo images (optimized, ≤1000px)
└── server/
    ├── server.js       Express API + static file server
    ├── db.js           SQLite schema, migrations, seed data
    ├── backup_db.js    One-off database backup script
    ├── test_flow_runner.js  Integration test (register → reset → login)
    ├── verify_assets.js     Asset sanity check
    ├── inventory.db    SQLite database (gitignored — holds real data)
    └── .env            Secrets & config (gitignored)
```

The front end talks to the backend via the relative path `/api`, so it works on any host
or domain without configuration.

---

## Features

### Storefront
- Product catalogue with categories, search, and pagination
- **Retail and wholesale** modes (wholesale applies MOQ + discount math)
- **Per-product sizes with their own prices** (admin-managed; authoritative on the server)
- **China pre-orders** as a per-product listing type (independent of category)
- Cart, checkout (records the order, then hands off to WhatsApp), order tracking
- Product reviews, guest wishlist, and verified Firebase customer accounts
- Installable **PWA** (add to home screen, offline app shell)

### Admin panel
- Product management: full CRUD, auto-generated SKUs (editable), per-size pricing,
  global size presets, image upload, bulk CSV import
- Owner-managed **categories** (add / rename / delete, reflected on the storefront)
- Inventory, orders, customers, suppliers, analytics, reports
- New-order notifications in the bell (live poll) + optional **Telegram** alerts
- Settings: store config, WhatsApp number, wholesale rules, banner, password change

---

## Getting started (local)

Requires Node.js 22.13 or newer.

```bash
cd server
npm install
node server.js
```

The server prints the port it's listening on (default **3000**). Then open:

- Storefront: <http://localhost:3000/>
- Admin: <http://localhost:3000/admin.html>
- Customer account: <http://localhost:3000/account.html>

> **First-boot admin account:** username `admin`. On a fresh database the password is
> taken from the `ADMIN_PASSWORD` env var, or a strong random one is generated and
> **printed once** in the server log. (The bundled local dev database uses `admin123` —
> change it before deploying.)

---

## Configuration

Set these in `server/.env` (see `DEPLOYMENT.md` for the full table):

| Variable | Purpose |
|---|---|
| `NODE_ENV` | Set to `production` to enable strict CORS, HSTS, and tight rate limits. |
| `JWT_SECRET` | **Required.** Strong random string for signing sessions. The server refuses to start in production on the built-in fallback. |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed by CORS in production. |
| `ADMIN_PASSWORD` | First-boot admin password (else a random one is printed once). |
| `PORT` | Listening port (default 3000; most hosts inject this). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Optional order alerts. `TELEGRAM_CHAT_ID` accepts multiple comma-separated chat/channel IDs. |
| `SHOP_NOTIFY_EMAIL`, `SMTP_*` | Optional transactional email. |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | Public Firebase web-app configuration for customer authentication. |
| `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON` | External service-account path or sealed JSON value when the host does not provide Application Default Credentials. |

---

## Scripts

```bash
node server/server.js          # start the app (API + static site)
node server/backup_db.js       # write a backup copy of inventory.db
node server/test_flow_runner.js  # run the auth/reset integration flow
node server/verify_assets.js   # sanity-check referenced assets exist
```

---

## Data & backups

- All data lives in **`server/inventory.db`** (SQLite, WAL mode). It's **gitignored** —
  it holds customer/order PII and must never be committed.
- On a host with ephemeral storage, put `inventory.db` on a **persistent volume** or a
  redeploy will wipe it.
- Schedule `backup_db.js` (e.g. daily cron) and keep copies **off the server**.

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full checklist. In short: serve over
**HTTPS**, set `NODE_ENV=production`, a fresh `JWT_SECRET`, `ALLOWED_ORIGINS`, an
`ADMIN_PASSWORD`, and persist the database.

---

## Tech notes

- **Security:** Firebase bearer ID tokens for verified customer accounts, separate admin JWT auth, bcrypt password hashing for legacy/admin records, parameterized
  SQL throughout, server-side order pricing (never trusts client-sent prices),
  manual security headers, in-memory rate limiting, MIME-validated image uploads.
- **PWA:** separate storefront/admin manifests + a service worker (network-first for
  HTML/JS/CSS, cache-first for images/fonts).
- **Images:** product/promo images are downscaled to ≤1000px and recompressed; pre-edit
  originals are kept in the gitignored `_image_originals_backup/`.


## Catalogue images and production data

SQLite (`server/inventory.db`, or `DB_PATH`) is authoritative once the app is running in production. `products.json` is the fresh-install seed and offline catalogue snapshot; editing it does not update an existing production database.

Products without genuine photography reuse clearly labelled category artwork from `images/category-fallbacks/`; startup also backfills existing placeholder rows to their matching category asset. These images remain marked **Category image** and still appear in the missing-real-photo report. Managers can use **Products ? Bulk photos** to upload JPG, PNG, or WebP files named by SKU (for example `CLO-0001.jpg`) or `product-<id>.jpg`. The admin preview reports matched, unmatched, and duplicate files before upload, processes three files concurrently, and updates successful mappings transactionally.

The product catalogue CSV export/import includes both `sku` and `img`. Use **Image health** to find missing images, missing or duplicate SKUs, invalid image paths, and unused uploaded files.
## Tailwind CSS build

Tailwind is compiled locally rather than loaded from the development CDN. From `server/`, run `npm run build:css` after changing utility classes in `index.html`, `app.js`, `admin.html`, or `admin.js`. The command regenerates `tailwind-storefront.css` and `tailwind-admin.css`; the admin bundle intentionally disables Tailwind preflight so it does not reset `admin.css`.
