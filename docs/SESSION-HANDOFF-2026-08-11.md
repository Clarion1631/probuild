# Session Handoff — 2026-08-10 → 2026-08-11
**Receipt automation end-to-end: robot bookkeeper, command center, Gemini outage + fix**

Read this top to bottom to resume exactly where we left off. Written by Claude at the end
of the session that built the receipt-automation operating layer.

---

## What exists now (all live in prod)

### 1. The workflow (runs by itself)
- Receipt lands in Drive (`I:\My Drive\Expenses\New Receipts & Checks\<Project>\`) →
  Apps Script bot ("QBO Automation" project) reads it with Gemini every 10 min → books a
  QuickBooks Purchase with the receipt attached → Vanessa matches the bank feed → QBO →
  ProBuild expense sync every 4 h.
- **Robot bookkeeper**: Windows scheduled task `receipt-resolver-daily`, 7:23 AM, runs
  `claude -p --model claude-opus-5 --effort medium` over
  `C:\Users\jat00\.claude\receipt-resolver\RUNBOOK.md`. Works the `_Needs Review` pile,
  writes a digest to `I:\My Drive\Claude\Bookeeping\resolver-digests\YYYY-MM-DD.md`.
  Interactive-only (PC must be logged in, I: mounted). Cleared 32 of 47 stuck receipts on
  day one; flags missed runs; has a reader-outage rule (no repeat re-drops when the bot
  itself is broken).
- **The one unblock rule**: a parked file is frozen forever (state lives in the Drive
  file's *description*). To unblock: save a corrected copy as a **brand-new file** into
  the project's intake folder. Never move the old file back; never Drive-"Make a copy".

### 2. The command center — probuild.goldentouchremodeling.com/automation
Unified money register: money in/out, per-row proof dots (receipt · job cost · amount),
month dropdown + search, **Download CSV** (mirrors on-screen filters, formula-injection
safe), working **Mark reviewed** button, **How to run this ↗** link → ops runbook.
- Commits this session (branch `feat/unified-money-register`): `537993ec` ops guide,
  `c165322e` filters + link, `841329f8` Mark-reviewed wiring, `60d015b1` CSV export +
  duplicate Drive links, `54e00a2b` Codex round-1 fixes, `fea9c62d` round-2 fixes.
- **Two Codex review rounds passed** (round 1 blocker: CSV injection — fixed; round 2:
  degraded-path parity + button state sync — fixed). Open nit: share the acknowledged
  predicate with review-alert-lifecycle.ts (low value, do with next register work).

### 3. The ops guide (in-product)
/automation → "How this pipeline works" → **"Running it — the 2-minute health check"**
(anchor `#running-it`): where to look, the unblock rule, the robot's job description and
limits, emergency stops. Source: `docs/qbo-expense-sync-flow.html` → regenerate
`src/app/automation/guide/guide-html.ts` via the JSON.stringify one-liner, then deploy.

### 4. Prod database work done this session
- Applied (all additive/idempotent): `apply-automation-events.mjs`,
  `apply-qbo-purchase-classification.mjs`, `apply-review-alerts-schema.mjs`,
  `apply-review-evidence-columns.mjs`.
- July backfill ran: `backfill-automation-events` (53 marked purchases),
  `backfill-review-evidence` (95 rows linked), `backfill-qbo-purchase-classification`
  (237/253 classified). Result on /automation: documented 4→50 of 176, needs-review
  84→22, uncategorized 76→8. "Receipt not traced 105" is honest history (pre-tracking
  bookings) — will only shrink via new activity.
- NOT done: index pass `apply-review-evidence-columns.mjs --with-indexes` (needs
  DIRECT_URL/port 5432, unreachable from this machine; irrelevant at ~225 rows).

---

## The Gemini outage (2026-08-11) — diagnosis + fix, for next time
- Symptom: "Receipt bot needs help … Failed AI reads: 3" emails; clean re-drops bounce.
- Cause: the bot key's Google project lost access (2.5-pro → 429 "limit: 0";
  2.5-flash → 403 "project denied access"). Billing/project issue, not model quality.
- Fix path (Script Properties UI is READ-ONLY past 50 props — hundreds of `dup_` rows):
  script.google.com → QBO Automation → Editor → `TestAPiKey.gs` → paste key into
  `setGeminiKey()` placeholder → Run once → Run `testMyNewKey()` → expect "✅ SUCCESS"
  → restore `PASTE_NEW_KEY_HERE` placeholder. Same key → Vercel `GEMINI_API_KEY` → one
  `vercel --prod` redeploy.
- Verified healed: test receipt booked hands-free as QBO Purchase **#6513** ($27.86,
  Berg ADU, 2026-08-11).

---

## Open items (all Justin decisions, from the resolver digests)
See `I:\My Drive\Claude\Bookeeping\resolver-digests\2026-08-10.md` + `2026-08-11.md`.
1. **Amazon policy**: book at order confirmation or at fulfillment charge? (clears 4 files)
2. **PO#APPLIANCES project** — $5,821.50 Lowe's appliance order (likely Mesplay Kitchen;
   book the 3 fulfillment receipts, not the confirmation) (clears 4)
3. **Grover $22.57 + Walmart $4.66/$14.03 job codes**; consider standing rule for Grover
   walk-ins (clears 2–3)
4. **RTA Store T2005418 $19,679.62** — correct total, unbooked; Shop vs Berg ADU; two
   smaller booked RTA charges may be deposits on the same order
5. **$17,930.24 Hoppe check** (`Scanned_20260728-1207.pdf`) is INCOME — route to deposits
6. **$511.27 over-booked** (refund-after-charge ×3) + 4 pre-existing Lowe's double-books
7. **$937.95 vs $1,345.05** Lowe's shed booking at confirmation amount
8. 4 UNSIGNED missing-receipt memos need signatures (Office Depot $20.55, Ferguson $27.19)

## Known gaps / next features (agreed, not built)
- Month-close workspace ("this month is DONE" state) — biggest bookkeeper ask, own feature
- Trustworthy counts (journey list caps at 200; register "needs review" vs receipt
  "needs attention" are different things and read confusingly)
- Mobile field capture (kills the "no project on slip" ticket class)
- Backlog worklist artifact ("Receipts not yet in QuickBooks") as an /automation tab
- Merge `feat/unified-money-register` → main when the register work is called done

## Deploy/ops gotchas learned (also in Claude memory `probuild-deploy-gotchas`)
- `vercel --prod` ships the working DIRECTORY; check `git status` first. Use `--force`
  when a generated-file change doesn't show (stale build cache served old guide-html).
- Schema first, deploy second: unapplied apply-*.mjs = P2022 = "Documentation status
  couldn't be loaded" degraded page.
- Stale Prisma client breaks typecheck with phantom missing-column errors — regenerate
  via PowerShell (`node_modules\.bin\prisma generate`), never Git Bash.
- `$env:VERCEL_TOKEN` goes stale after setx rotation — re-read live:
  `(Get-ItemProperty HKCU:\Environment -Name VERCEL_TOKEN).VERCEL_TOKEN`.
- QBO API: `EntityRef` not queryable on Purchase — query `TotalAmt` full-history, then
  read each hit. Never date-window a "is this booked?" check.
