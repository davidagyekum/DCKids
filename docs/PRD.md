# PRD — DC Kids Brand E-Commerce

## Goal
Give DC Kids Brand (Ghanaian kids' fashion, ages 0–12) a storefront where parents browse the catalogue and place orders that complete over WhatsApp, plus an admin dashboard where the owner and staff run the whole operation: products, orders, customers, suppliers, and analytics.

## Users
- **Shopper (guest)** — browses, searches, filters by category, adds to cart, checks out with name + phone (no account needed), tracks orders by reference + phone.
- **Wholesale buyer** — same storefront in Wholesale mode: bulk pieces at a discount with a minimum order quantity (MOQ) per item.
- **Owner (manager role)** — full admin: catalogue, orders, staff approval, settings, analytics.
- **Staff** — day-to-day admin without user management.

## Screens
| Screen | File | Notes |
|---|---|---|
| Storefront | `index.html` | Hero, category pills, paginated grid (12/page), search, cart drawer, wishlist, reviews, wholesale toggle, PWA |
| Order tracking | `track.html` | Order number + phone last-4 gate |
| Admin sign-in | `admin.html` | Passwordless: email OTP, recovery codes, optional Google |
| Admin dashboard | `admin.html` | Overview KPIs, products (camera capture, bulk import), orders (status flow), customers, suppliers, analytics, staff management, settings |

## Data model (SQLite, WAL)
`products` (sizes JSON overrides base price) · `orders` → `order_items` (name/price snapshotted) · `payments` · `customers` · `users` (role: manager/staff; status: active/pending/rejected) · `auth_codes` / `recovery_codes` (hashed, FK → users) · `suppliers` · `product_images` · `product_reviews` · `wishlist_items` · `customer_accounts`/`customer_addresses` (flag-gated, off) · `store_settings` (WhatsApp number, MOQ, discount, banner) · `transactions` (audit).

Totals are always computed **server-side**. Wholesale = per-piece price × (1 − discount%) with an MOQ floor per item. Stock deducts when an order turns `paid`.

## Order lifecycle
`pending` (retail) / `pending_deposit` (pre-order) → `processing` → `paid` (stock deducts) → `shipped`/`dispatched` → `delivered` → `completed`, or `cancelled`. Status values are whitelisted server-side.

## Edge cases (handled — keep it that way)
- Fresh clone must boot: schema + full catalogue seed from `products.json`, serialized DDL, `whenReady` gate before listen.
- Stale carts after a catalogue swap: prune items whose product no longer exists.
- Wholesale quantity is PIECES, never packages — a 10-piece order must bill 10 pieces.
- Sub-MOQ wholesale items rejected (400); quantities validated (integer, 1–100 retail / 1–1000 wholesale, ≤50 items).
- Sold-out and low-stock (≤5) states on cards; pre-orders never show stock urgency.
- Guest phone gates tracking (last-4 match); wrong phone → 403.
- Duplicate order numbers impossible (derived from row id).
- Empty categories hidden from nav; category search resets filters.
- Offline/flaky network: service worker (network-first), `products.json` fallback.
- OTP: 10-min expiry, 5 attempts, one active code; recovery codes one-time; pending/rejected staff cannot sign in.

## Out of scope (deliberate)
- Online card payments (checkout completes over WhatsApp; no PCI surface).
- Customer accounts UI (endpoints exist behind `CUSTOMER_ACCOUNTS_ENABLED=false`).
- Multi-warehouse stock, multi-currency, i18n.
- Native mobile apps (PWA covers install-to-home-screen).

## Done means
Deployed on a Node host behind HTTPS with `NODE_ENV=production`, `JWT_SECRET`, `RESEND_API_KEY`, `OWNER_EMAIL`, `ALLOWED_ORIGINS` set; `npm test` green (43 checks); `docs/SHIP-CHECKLIST.md` fully checked.
