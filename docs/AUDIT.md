# Retrofit Audit — DC Kids Brand

Playbook retrofit audit (Phases 0–10), run 2026-07-11 against commit `cd61271`.
Safety pass done first: tree clean, `server/.env` + `*.db` gitignored, backup taken and
**verified restorable** (integrity ok; 27 orders, 267 products readable from the backup file).

Much of a normal retrofit was already done in previous sessions (identity block, PRD,
ship checklist, 41-check smoke suite, five security-fix rounds). This report covers what
remains, ranked by risk. **No code was changed during this audit.**

---

## 1. Security violations (every gate checked)

| Gate | Status | Evidence / gap |
|---|---|---|
| Per-record authorization (RLS equivalent) | ✅ | JWT role gates on all admin routes; tracking needs phone last-4 (403 test-proven); customer endpoints flag-gated off |
| Secrets in code / bundle / git | ✅ | Fresh scan clean; history rewritten 2026-07-10; `.env`, `*.db` ignored |
| Rate limiting | ✅ | Global 120/min/IP (prod) + login 10/15min, register 5/hr, tracking 30/15min, reviews 10/hr |
| IDOR | ✅ | Wrong-phone tracking 403, role gates, self-delete block — all in the test suite |
| Error leaking | ✅ | 83 endpoints swept to generic 500s (`cd61271`); details log server-side only |
| CORS | ✅ code / ⚠️ deploy | Allowlist enforced when `ALLOWED_ORIGINS` set — **must be set at deploy, then verified** |
| Redirects | ✅ N/A | No server-side redirects exist |
| Input + upload validation | ✅ | Checkout quantity/id/length caps; upload MIME+5MB+manager-only; OTP format checks |
| Dependency audit | ✅ | `npm audit`: 0 vulnerabilities (2026-07-11) |
| Logout invalidation | ⚠️ **S1** | See below |
| Security headers | ✅ code / ⚠️ deploy | nosniff/frame/referrer/permissions/HSTS set; live securityheaders.com scan pending a domain |

### Open security items (ranked)
- **S1 · ~~MEDIUM~~ FIXED 2026-07-11** — authenticated requests now re-check the account
  in the DB: deleted/rejected/demoted staff lose access on their next request, and role
  comes from the DB rather than the token. Test: "deleted staff token revoked instantly".
- **S2 · ~~LOW~~ FIXED 2026-07-11** — the three admin `innerHTML` error sinks (toast,
  upload preview, staff-table error row) now escape their message.
- **S3 · LOW — No Content-Security-Policy header.** Inline scripts and the Tailwind CDN
  make a strict CSP a real project; document as post-launch hardening, not a quick fix.
- **S4 · ~~INFO~~ FIXED 2026-07-11** — stale `server/test_flow_runner.js` deleted.

## 2. Missing structure (ranked)

- **M1 · ~~HIGH~~ FIXED 2026-07-11** — GitHub Actions CI on every push/PR (install →
  syntax check → lint → 43 smoke tests → `npm audit --audit-level=high`) plus ESLint
  (0 errors; legacy patterns surface as warnings without blocking).
- **M2 · ~~HIGH~~ FIXED 2026-07-11** — `privacy.html` + `terms.html` written for how the
  store actually works, linked in the footer and sitemap (stale preorder.html entry removed).
- **M3 · MEDIUM — Backups are manual.** `backup_db.js` works (verified today) but nothing
  schedules it; schedule daily on the host + do one restore drill per quarter.
- **M4 · MEDIUM — No error alerting.** Telegram alerts cover new orders only; server
  errors go to console. Minimum: persist logs on the host and check on a cadence; better:
  a free error tracker.
- **M5 · LOW — Unbounded default fetches.** `/api/products` and `/api/orders` return the
  full table unless pagination params are passed (playbook: paginate everything). Fine at
  267 products / 27 orders; flip the default before the catalogue grows ~10×.
- **M6 · LOW — No uptime monitor.** Point a free pinger at the domain post-deploy.

Already in place: PRD ✅ · ship checklist ✅ · smoke tests ✅ · robots.txt + sitemap.xml ✅
(submit to Search Console at launch) · loading/empty/error states ✅ · deploy docs ✅.

## 3. Bugs found along the way

Nothing new broke during this audit pass. For the record, bugs found and **already fixed**
in this retrofit cycle: fresh-clone DB crash (`152802e`), wholesale 10× overcharge +
stale carts + empty categories (`b2b727e`), staff-delete FK failure + OTP codes leaking
into production logs + lockout-without-email-key (`5db7674`), raw driver errors shown to
users (`cd61271`). The only open code-level items are S2 and S4 above.

---

## Recommended fix order (step 4 of the retrofit)

1. **M1** — CI + ESLint (locks everything else in place; one commit)
2. **M2** — privacy + terms pages (launch blocker; one commit)
3. **S2 + S4** — escape the three sinks, delete the stale test runner (one commit)
4. **S1** — decide: accept-and-document or add status re-check middleware (one commit)
5. **M3/M4/M6** — host-level: scheduled backup, log persistence, uptime ping (at deploy)
