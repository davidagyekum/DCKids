# DC Kids Brand — Project Instructions

## Commands

### Server (Backend)
- Start server: `node server/server.js` (or `npm start` from `server/`)
- Run smoke tests: `npm test` from `server/`
- Backup database: `node server/backup_db.js`

### Frontend (Static Files)
- Served by the Express server itself from the project root — no separate static server needed. Open `http://localhost:3001`.

## Architecture

- Root directory: frontend static files — storefront (`index.html`, `app.js`, `styles.css`), admin dashboard (`admin.html`, `admin.js`, `admin.css`), order tracking (`track.html`), PWA (`service-worker.js`, `manifest.json`, `admin.manifest.json`).
- `server/`: Express API (`server.js`), SQLite schema/seeds/migrations (`db.js`), backup utility (`backup_db.js`), smoke tests (`test_smoke.js`).
- `server/inventory.db` is gitignored; `db.js` creates and seeds the full schema on first boot (serialized statements + `db.whenReady()` gate before `app.listen`).

## Key Decisions

- **DC Kids Brand**: Ghanaian kids' fashion e-commerce — retail, wholesale (MOQ + discount), and China pre-orders.
- Checkout is WhatsApp-based (no online card payments); orders are stored via `POST /api/orders` and totals are computed server-side.
- Vanilla HTML/CSS/JS frontend (no frameworks); Tailwind via CDN on the storefront.
- Auth: bcrypt + JWT. Staff/manager tokens (12h) are separate from customer tokens (`kind: 'customer'`). Staff sign-ups go through an access-request flow the owner approves.
- Customer-account public endpoints are gated behind `CUSTOMER_ACCOUNTS_ENABLED` (off by default — no storefront login UI exists).
- Cache busting: bump `VERSION` in `service-worker.js` AND the `?v=` query on `app.js`/`styles.css` in `index.html` whenever those files change.

## Domain Knowledge

- **Order statuses**: pending, pending_deposit (pre-orders), processing, paid, shipped, dispatched, delivered, completed, cancelled. Stock is deducted when an order transitions to paid.
- **Wholesale**: unit price × (1 − discount%) × MOQ per package.
- **Managed sizes**: `products.sizes` JSON (`[{label, price}]`) overrides the legacy base-price + size-modifier scheme.
- Telegram order alerts are optional (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in `server/.env`).

## Warnings

- NEVER run git commands from the home folder (`C:\Users\agben`) — only inside this project folder.
- `server/.env`, `*.db`, `*-wal`, `*-shm` must stay gitignored.
- claude.ai/design bundles OVERWRITE files on import — back up `app.js`/`index.html` customizations first.
