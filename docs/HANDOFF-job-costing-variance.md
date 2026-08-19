# Job Costing → Estimate-Item Variance — Handoff

_Written 2026-08-19. Source: Hermes/Telegram session. Read this before touching
job costing, cost codes, or the crew clock-in._

## The goal (Justin's words)

> Answer: **are we profitable, and are we profitable per job? If not, why not —
> at an estimate level** — so we can identify issues beforehand and know why a
> job didn't go well, other than using gut.

Judge every design choice against the four product rules:

| Rule | Meaning here |
|---|---|
| **STRUCTURE** | Constrain choices. No free-form where a list works. |
| **ADOPTION** | The crew must actually use it. Extra taps kill it. |
| **TRUST** | Data must be right. A wrong cost code is worse than a blank one. |
| **AGENCY** | People keep real control. Never present a guess as measured. |

Related: QuickBooks = books only (COGS/overhead classified THERE). **ProBuild owns
job costing + receipts** (cost codes live HERE). Do not map ProBuild cost codes to
COGS accounts. Shed job = overhead, cash off-books.

---

## What shipped 2026-08-18/19 (already live in prod)

- **Phase-only clock-in.** Crew picks a PHASE (cost code), not an estimate line
  item. Punches carry `costCodeId`. Site `c4cb1043`, mobile `88e44b5`, both pushed
  and deployed.
- **One source of truth for allowed phases**: `src/lib/project-phases.ts` (pure
  rules) + `src/lib/project-phases-db.ts` (Prisma). The picker and the clock-in
  validator read the SAME helper, so they cannot disagree.
- **Closed a real hole**: `POST /api/time-entries` used to accept any globally
  existing `costCodeId` — crew could post labor to another job's phase. Now
  validated against that project's phases (400 `PHASE_NOT_ON_PROJECT`).
- **Safety phase `32-SAFETY`** seeded company-wide (NOT 22 — `22-DESIGN` and
  `23-SITEWORK` were taken; prod runs 01..31 with no gaps, so 32 was next free).
- **Crew project list** = In Progress only, plus logistics jobs while not Closed.
- **82 expenses cost-coded** ($111,812) by `scripts/suggest-expense-cost-codes.mjs`.
  140 left NULL on purpose for human review — see below.
- Closed out `United Water Services` and `Howard/Salzer exterior` (both
  `Closed Complete`).

---

## The finding that should drive the next build

Measured on live prod data:

```
job                      items  coded  uncoded  phases  items/phase
Berg ADU                    17     15        2      11         1.4
Christensen Remodel         31     31        0      15         2.1
Hoppe Bathroom Remodel      40     26       14      17         1.5
Mesplay Kitchen             52     37       15      22         1.7
```

**There are only 1.0–2.1 estimate items per phase.**

That kills the assumption that item-level capture means scrolling 52 options.
Once the crew picks a phase, there are usually **1–2 items** under it.

### The design this implies

> Crew taps phase → if that phase has exactly ONE item, attach it automatically
> (zero extra taps). If 2+, show just those 2–3 as a second step.

`resolveCostCode` (see below) **derives the cost code FROM the line item**, so
capturing the finer grain yields the phase for free. One capture, both grains.
Nothing about the shipped phase-only picker has to be undone — it gains one
optional step that is usually skipped.

Scores well on all four rules: STRUCTURE (1–2 choices), ADOPTION (usually zero
extra taps), TRUST (measured, not allocated), AGENCY (they pick, we don't guess).

---

## Current linkage state (the actual blocker)

| Link | Count | Note |
|---|---|---|
| `timeEntry.estimateItemId` | 50 / 60 | **legacy** — phase-only now writes `costCodeId` |
| `timeEntry.costCodeId` | 20 / 60 | grows from here |
| `expense.costCodeId` | 89 / 562 | 82 from today's backfill |
| **`expense.itemId`** | **0 / 562** | **materials are the missing half** |

Mesplay Kitchen: **$479,750 estimated**, but only **$1,148 labor** and **$0
material** actually linked to a line item. Per-item variance is impossible today.

`Expense.itemId` EXISTS in the schema (`prisma/schema.prisma` ~line 580) and is
completely unused, because QuickBooks imports arrive with vendor + job, no line
item. **Materials are where variance hides.**

Also: **34 of 163 eligible items have no cost code** (Hoppe 14, Mesplay 15).
Those cannot derive a phase and would fail the gate — needs an estimate cleanup pass.

---

## PR #117 — salvage, don't merge

`gh pr view 117` — "Job costing: cost-code gate + WA compliance + notifications",
85 files, +5810/-223, from May, state **CONFLICTING**.

Analysis: **49 of 85 files already exist on `main`** in some form; 36 are absent.
It touches 20 `src/` files that have since diverged — including
`api/time-entries/route.ts` and `lib/time-expense-actions.ts`, which today's
phase-only work rewrote. **A straight merge is off the table.**

### Worth extracting: `src/lib/cost-coding.ts` (75 lines, standalone, no conflicts)

`resolveCostCode({ costCodeId?, lineItemId? })` — precedence:
1. explicit `costCodeId` (validated exists + `isActive`)
2. else derive from the estimate item's `costCodeId` (+ `costTypeId`)
3. else **reject**, so uncoded labor/spend can never reach the job ledger

That rejection IS the TRUST rule in code. Its "derive from line item" behaviour is
exactly what makes the 1–2 items/phase design cheap.

Also absent and possibly wanted later: `lib/labor-cost.ts` (WA L&I meal breaks),
`lib/notify.ts`, `lib/google-chat.ts`, `api/cron/crew-data-review`.

⚠️ #117's migration `p1_notifications_and_wa_meal_breaks.sql` says **already
applied to prod** — confirm before any merge so DDL isn't re-run.

Recommendation: extract `resolveCostCode`, then **close #117** so it stops sitting
in "Waiting on Justin".

---

## Suggested sequence

1. **Extract `resolveCostCode`** from #117 into `src/lib/cost-coding.ts`.
2. **Estimate cleanup** — assign cost codes to the 34 uncoded eligible items.
3. **Optional item step in the crew app** — only when a phase has >1 item.
4. **Expense → `itemId`** coding for materials. *Coordinate with Justin's separate
   QuickBooks/expenses conversation — that side owns the receipt pipeline.*
5. **Variance report** — estimated vs actual per estimate item. Easy once the data
   has the right grain; everything above is data capture.

Optional later: `ScheduleTask.costCodeId` (currently no phase field) closes
schedule → labor → materials → daily log, and lets ProBuild PROPOSE Richard's
weekly % complete instead of asking him to invent it. Useful, but the ITEM link is
what produces the variance number Justin asked for.

---

## Hard rules (from AGENTS.md / CLAUDE.md — do not relearn the hard way)

- **`main` auto-deploys to prod.** Every push = a paid Vercel build. Batch work
  into ONE push. (A past month hit $250 from many pushes.)
- **No `prisma db push` / `migrate dev`** — they dial `DIRECT_URL` (AAAA-only, no
  IPv6 route here) and fail `P1001`. Use the PowerShell SQL script route, then
  `prisma generate` from PowerShell.
- **`DATABASE_URL` must carry `?pgbouncer=true`.**
- **Never pass `--token` to the vercel CLI** (it echoes it; leaked 3×).
- Money-path changes need **codex review + green `e2e/money-pipeline.spec.ts`**.
- Scripts must load `.env.local` themselves — `next` injects it for the app, never
  for a bare `node scripts/*.mjs`.

---

## Loose ends

- **`~/cost-code-review.csv`** — 140 uncoded expenses ($94,937.88) needing human
  review, with vendor/amount/job/receipt text. Marking up even the top 20 by dollar
  value would let the rules re-run and catch the rest.
- **Google Chat / shed daily logs — UNRESOLVED.** Justin's "GTR office responder"
  routine (Claude Desktop, currently Paused, last ran Aug 11) reads Main Office
  fine. Its Composio auth lives in Anthropic's cloud and cannot be borrowed.
  Composio has TWO surfaces: the consumer one (has google_chat + sheets/docs/qbo)
  and developer project `pr_zH9_vtOM3LoD` (gmail/drive/calendar only — what the API
  key sees). The MCP server `claude-google-full` was patched to expose 8 read-only
  Chat tools (102→110), and `workspaces/golden-touch/active/google-chat/chat_read.py`
  is ready — it needs a google_chat connection inside `pr_zH9_vtOM3LoD`.
- **Howard/Salzer vs Shop Shed** — Justin said "Howard Salzer is the shed job", but
  ProBuild data reads them as separate: Howard/Salzer's 4 expenses ($8,742.87) are
  exterior siding vendors (Lowe's Pro, QXO); Shop Shed's 21 ($8,984.75) are shed
  lumber/framing. Both closed correctly either way. The shed daily logs would settle
  it. Left as-is deliberately — moving 4 expenses later is a 2-minute fix.
- `COMPOSIO_API_KEY` env var (`ck_…`) is **dead/401**. The live key is the `ak_` one
  in `~/.claude.json`. Worth deleting the stale env var.
- `CONNECTIONS.md` app list is **stale** — claims Sheets/Chat/GitHub on the main hub;
  actual connected set is much larger and differs by surface.
