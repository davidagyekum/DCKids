# Ship Checklist — DC Kids Brand (run before EVERY launch/major deploy)

Status as of 2026-07-11 (pre-deploy). ✅ verified · ⚠️ partial/needs action at deploy · ❌ not done.

## Security
- [x] Per-record authorization (RLS equivalent — SQLite has no RLS: JWT role gates on every admin route; tracking gated by phone last-4; customer endpoints flag-gated off) — test-proven
- [x] No keys in frontend (no build step; storefront/admin JS carry no secrets; `.env`, `*.db` gitignored and history-scanned)
- [x] Rate limiting: global 120/min/IP (prod) + per-endpoint limiters — login 10/15min, register 5/hr, tracking 30/15min, reviews 10/hr ⚠️ re-verify live 429s once deployed (localhost is exempt, so it can't be tested locally)
- [x] IDOR: order tracking rejects wrong phone (403, test-proven); admin routes require role; staff can't self-elevate
- [x] Errors: users get generic messages; raw driver errors go to server logs only (83 endpoints swept 2026-07-11)
- [ ] CORS: code enforces `ALLOWED_ORIGINS` allowlist in production — ⚠️ set the env var at deploy, then verify a cross-origin request fails
- [x] Upload validation: manager-only, png/jpg/webp whitelist, 5MB cap, server-generated filenames
- [x] `npm audit`: 0 vulnerabilities (2026-07-11)
- [ ] Logout: clears client storage; ⚠️ JWTs are stateless — a stolen token stays valid up to 12h. Acceptable for a 2-person team; revisit (token denylist) if staff grows
- [ ] Staging behind auth — no staging environment yet
- [ ] securityheaders.com grade — headers are set in code (nosniff, frame, referrer, permissions, HSTS in prod); ⚠️ scan the live domain after deploy
- [ ] External scan (checkvibe.dev / vibelegit.io) — run against the live domain after deploy

## Completeness
- [x] Privacy policy + Terms: `privacy.html` + `terms.html`, linked in the storefront footer and sitemap (2026-07-11)
- [x] Loading / empty / error states: storefront fallback catalogue, empty-cart/wishlist/search states, admin toasts + empty tables
- [x] Mobile verified on real devices (owner + external reviewer, July 2026)
- [ ] SEO: titles/meta/theme-color present — ⚠️ add sitemap.xml + robots.txt and submit to Search Console at launch
- [x] Payments: N/A — WhatsApp checkout, totals computed server-side (wholesale per-piece math test-proven)

## Deploy safety
- [x] Env vars fail loudly: server refuses to start in production without JWT_SECRET or RESEND_API_KEY (Google-only fallback warns)
- [ ] DB backup: `node server/backup_db.js` works on demand — ⚠️ schedule it (host cron) + verify a restore once
- [ ] Rollback: git history is the rollback path — ⚠️ pin the previous deploy on the host once hosting is chosen
- [x] Migrations: additive-only (`CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE ADD COLUMN`); existing DBs upgrade in place — fresh-clone boot test-proven

## Operations
- [ ] Error tracking/alerts: Telegram alerts cover new orders only — ❌ no error alerting; at minimum pipe server logs somewhere readable and check them
- [ ] Dependency-update reminder — ❌ set a monthly reminder to run `npm audit` + `npm update`
- [x] Smoke tests: `npm test` — 41 end-to-end checks on a throwaway DB, all green (2026-07-11)

## Unhappy paths (playbook: test deliberately)
- [x] Empty forms rejected (client + server validation)
- [x] Wrong password ×50 → N/A (passwordless); wrong OTP ×5 → code invalidated, limiter caps requests
- [x] Other users' URLs: tracking with wrong phone → 403 (test); staff route without manager role → 403
- [x] Malformed payloads → 400, server stays up (test)
- [ ] Network drop mid-checkout / double-submit — ⚠️ retest manually on the live deploy
