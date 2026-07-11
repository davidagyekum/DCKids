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
- **S1 · MEDIUM — Sessions can't be revoked server-side.** JWTs are stateless: a deleted,
  rejected, or demoted staff member's token keeps working for up to 12 h, and logout only
  clears the browser. Acceptable for a 2-person team; before the team grows, add a
  status check on authenticated requests (one indexed SELECT) or a token denylist.
- **S2 · LOW — Three unescaped `innerHTML` sinks in admin.js** (toast at ~757, upload
  preview at ~2077, staff-table error row at ~8276) interpolate API `err.message` raw.
  Every current message is a server-controlled constant, so there is no exploit today —
  but one future endpoint echoing user input into an error would turn these into XSS.
  Cheap hardening: wrap with `escapeHtml()`.
- **S3 · LOW — No Content-Security-Policy header.** Inline scripts and the Tailwind CDN
  make a strict CSP a real project; document as post-launch hardening, not a quick fix.
- **S4 · INFO — Stale test harness** `server/test_flow_runner.js` exercises the now
  flag-gated password-reset flow with a dummy secret. Dead code; delete (git keeps it).

## 2. Missing structure (ranked)

- **M1 · HIGH — No machine referee.** No CI, no lint, no typecheck. The 41-check smoke
  suite only runs when someone remembers. Fix: GitHub Actions on push/PR —
  `npm ci → syntax check → npm test → npm audit --audit-level=high` — plus ESLint.
- **M2 · HIGH (launch blocker) — No privacy policy or terms pages.** The store collects
  names and phone numbers; both pages must exist and be linked in the footer before ads.
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
