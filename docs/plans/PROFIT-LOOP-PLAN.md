# Profit Loop — every bank line gets a receipt, every job gets a margin

Goal (Justin, 2026-08-19): every nightly WTB transaction lands in ProBuild,
every one of them gets its receipt, and a dashboard answers **"are we
profitable — as a company and per job?"** fast.

This plan EXTENDS the live pipeline (see hermes skill `gtr-money-map` and
/automation/guide). Nothing here rebuilds Gemini intake, QBO purchase
creation, or the QBO→ProBuild sync. QBO stays read-only for everything new.

## What already exists (verified in-repo 2026-08-19)

| Piece | Where | State |
|---|---|---|
| Nightly WTB CSV → BankLine ledger | 6pm Hermes cron → `scripts/parse-wtb-daily-csv.mjs` → ingest route | LIVE (hardened, Codex r2, `e14f580f`) |
| BankLine state machine | `prisma/schema.prisma` (POSTED → … → TAX_VALIDATED / EXCEPTION) | LIVE, states mostly unused past POSTED |
| QBO obs ↔ BankLine reconcile | `/api/integrations/bank-ledger/reconcile` (exact payee+date+amount+check#) | LIVE |
| Receipt intake → QBO purchase | Apps Script + Gemini (Drive job folders) | LIVE |
| QBO → ProBuild job costs | 4h sync | LIVE |
| Company dashboard | `/reports/company-financials` + `src/lib/project-financials.ts` | LIVE — cash margin only, **no earned revenue** |
| Bank register plan | `docs/BANK-REGISTER-PLAN.md` phases 1-5 | Phase 1 built; Phase 3 (BankImage) is designed, not built |

## The gaps this plan closes

1. **Bank lines don't know about receipts.** `BankLine.receiptUrl` exists but
   nothing fills it. The reconcile route links QBO entries, not receipts.
2. **Nobody chases missing receipts automatically.** That's Marge, manually.
3. **Check images aren't in ProBuild** (Justin: backfill 2 months, then keep
   them coming).
4. **The dashboard shows cash margin, not earned margin.** No % complete, so
   "are we profitable" can't be answered per job while a job is mid-flight.

## Phase 1 — Daily receipt-completeness reconcile (the Marge engine)

Nightly, after the 6pm CSV post (extend the same cron):

1. Run the existing reconcile route (idempotent) to link fresh BankLines to
   QBO observations.
2. NEW route `/api/integrations/bank-ledger/receipt-match` (secret-gated,
   same pattern as ingest): for each BankLine with a linked QBO expense that
   has a `receiptUrl` → advance state, copy receiptUrl to the BankLine. Pure
   matcher in `src/lib/` (peer-reviewable money math), route is glue.
3. What's left = **the daily missing-receipt list**, by card:
   …8516 = CJ, …6098 = Richard (rails already in `rawDescriptor`).
4. Cron reports the list to Justin (Telegram) — friendly, specific, per the
   money-map tone rule. Google Chat nudges to CJ/Richard come later, after
   the list proves accurate for a week (adoption rule: don't nag wrongly).

## Phase 1b — Marge's worklist dashboard (Justin, 2026-08-19: "a dashboard
she can live in")

A ProBuild page (`/automation/receipts` or a tab on /automation/bank) that
IS Marge's workday — not a report she visits, the queue she works:

- Source: the same matcher output, persisted — every BankLine grouped by
  state: needs receipt (by person: CJ / Richard / check / other), ambiguous
  evidence (human picks), awaiting sync, done.
- Row actions: open the QBO deep link, open the Drive receipt, mark
  resolved, and **"Request affidavit"** (Phase 1c) when chasing failed.
- Same permission gate as the bank register (financialReports).
- Counts at the top = her daily scoreboard; the goal is this page replacing
  her chase spreadsheet entirely.

## Phase 1c — Missing-receipt affidavit via Google Chat

The register plan's Phase 4 affidavit flow, with delivery re-pointed:

- Trigger: from Marge's worklist (manual) or auto after a line sits on the
  missing list N days (start manual; auto only once trusted).
- Flow (as already designed): prefilled PDF via the existing /api/pdf
  machinery → magic-token mobile page (sub-portal token pattern) → project
  picker + signature (existing contract signature component) → signed PDF
  to the Drive receipt repo → expense receiptUrl upserted, BankLine state
  advanced with the affidavit as evidence (flagged AFFIDAVIT, not RECEIPT —
  Vanessa must be able to tell them apart at audit time).
- **Delivery: Google Chat DM to the responsible person** (…8516 = CJ,
  …6098 = Richard), friendly tone per money-map rule. Composio's Google
  Chat connection exists but is NOT allowlisted on the MCP server yet —
  that's a setup step, not code. Fallback: email-first exactly as the
  register plan specified.
- Never SMS until the consent/expiry/one-time-token spec exists (register
  plan constraint, kept).

## Phase 2 — Receipt hunting via Composio (replace Marge's chase work)

For each unmatched BankLine, a Hermes job (NOT in-app code) hunts evidence:

- **Gmail** (Composio, GTR mailboxes incl. rlord@): search vendor + amount
  ± date window; found receipts get saved INTO the Drive job folder — the
  existing pipeline takes over from there. Never book QBO directly.
- **Amazon** — GTR business account: order-history lookup by amount/date,
  invoice PDF → Drive job folder.
- **Lowe's** — account signed as Richard: purchase lookup, receipt PDF →
  Drive job folder.
- Anything found: file to Drive, let Gemini/QBO rails do their job.
  Anything not found after the hunt: stays on the daily list → affidavit
  path later (register plan Phase 4).

Marge's remaining job = review what auto-books (unchanged). The chasing,
downloading, and filing is what this replaces.

## Phase 3 — Check images (Justin's explicit ask)

Two parts:

- **Backfill 2 months.** June + July 2026 monthly PDFs are NOT in Drive yet
  (folder stops at Nov 2025). Pull both statements from WTB (browser_exec +
  Bitwarden, same as daily cron), run `parse-wtb-statement.mjs` to backfill
  the ledger for those months (allowed: strictly before DAILY_CANONICAL_FROM
  2026-08-12), then pull each check's front image from WTB online (checks
  carry `Bank Reference` ids in the export; images are per-check downloads).
- **Store per register plan Phase 3**: `BankImage` table (source +
  sourceExternalId idempotency, driveFileId, normalizedCheckNumber,
  amountCents) + match to BankLine on check# + date + amount, manual
  confirm for anything fuzzy. Schema change goes through the PowerShell
  SQL script route (NOT prisma migrate — CLAUDE.md).
- **Recurring**: the 6pm cron gains a step — any new CHECK PAID line →
  fetch its image while logged in, file to Drive, register BankImage.

## Phase 4 — Earned-margin dashboard (the answer to "are we profitable")

- Add `percentComplete` (+ asOf, source) per active project — updated by
  Richard's weekly 2-minute prompt (money-map gap #3; Google Chat main
  office channel, friendly).
- Extend `project-financials.ts`: earnedRevenue = approved contract value ×
  % complete; earnedMargin = earnedRevenue − costToDate (expenses + labor
  burden). Keep existing cash-margin fields untouched (two screens share
  this lib — do not change their meaning, add fields).
- New tiles on `/reports/company-financials` + per-job table:
  earned margin, cash margin, receipt-completeness (% of that job's bank
  lines with receipt evidence), Shed excluded from books-based numbers,
  Shop = overhead per existing env var.

## Order + cost control

Phase 1 → 3-backfill → 2 → 3-recurring → 4. Each phase: build, test
(`test:bank-ledger` pattern), Codex peer review for money math, ONE push per
phase (Vercel cost rule). Hermes-side cron/skills changes cost nothing.

## Standing rules (inherited, non-negotiable)

- QBO read-only. Receipts flow through Drive so the keyed-by-file-id
  pipeline stays the single writer.
- Never type bank credentials; Bitwarden autofills, 2FA = ask Justin.
- Shed = off-books. Shop = overhead. Logistics labor spreads by hours.
- Humans keep sign-off: Marge reviews bookings, Vanessa owns audit defense.
- **VISUAL flywheel (Justin, 2026-08-19): where a HUMAN interfaces with an
  AI system, give them a visual — that's the flywheel that makes the other
  four rules spin.** Not every screen needs a chart; every AI↔human
  touchpoint needs a way to SEE what the machine did and whether it's
  right. A human can't TRUST what they can't check at a glance → they
  won't ADOPT it → the AI never gets the data to improve → the loop dies.
  Visuals (status colors, completeness rings, queue columns) are also how
  STRUCTURE constrains the next action and how AGENCY stays real — a
  dashboard you understand is control; one you don't is surveillance.
  AI-generated visuals are fine; ship them with the feature, not after.
  In this plan the AI↔human touchpoints are: Marge's worklist (she
  verifies the matcher), the nightly Telegram list (Justin verifies the
  pipeline), and the earned-margin dashboard (Justin/Richard verify
  profitability claims).
- **Visual self-evaluation (same rule, pointed at the AI): the builder
  verifies its own work visually before deploy.** Screenshot the rendered
  page (browser_exec/Playwright), LOOK at it, catch layout breaks, empty
  states, and wrong numbers before any human does. A feature isn't done
  when tests pass — it's done when its visual has been seen and judged.
  This is the enforcement mechanism for the flywheel: the same visual the
  human will trust is the one the AI checks itself against first.
