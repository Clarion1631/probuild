# Spec: Rescue plan for PR #117 — re-derive job-costing gate + WA compliance + notifications against current main

**ID:** 20260717-job-costing-117-rescue
**Date:** 2026-07-17
**Status:** draft

## Context

PR #117 (`feat/job-costing-gates`, "Job costing: cost-code gate + WA compliance + notifications (P0–P2)") is an **85-file, +5810/−223** branch opened **2026-05-29** and never merged. It bundled real, valuable work with a large amount of unrelated scratch/recovery/QA noise, and it has since gone badly stale: none of its feature files exist on main, yet a lot of the surface it targeted **has** landed independently in the ~7 weeks since. Rebasing an 85-file May branch onto today's main would be a merge nightmare and would drag in obsolete and junk files.

This spec is a **re-derivation plan**, not a rebase. It keeps only the parts of #117 that are still missing and still valuable, re-split into dependency-ordered, PR-sized slices built fresh against current `main`, each with its own acceptance criteria. The branch itself should be treated as a **reference/source of prose**, not something to merge.

**Role served:** the **field crew** (labor must actually cost money and respect WA L&I meal-break law), the **bookkeeper/PM** (no uncoded labor or spend leaking into job costing; IDOR-safe expense review), and the **manager/owner** (notifications when data needs attention). The original P0 proof was that a coded clock-in/out that previously logged **\$0** now yields **\$400 labour + \$120 burden**.

### What has since landed on main (so is OBSOLETE in #117 — do NOT re-derive)

Verified against `origin/main`:
- **Cost-code management + models** — `CostCode` / `CostType` models (schema:580/597), `EstimateItem.costCodeId/costTypeId`, `TimeEntry.costCodeId/costTypeId/laborCost/burdenCost/estimateItemId`, cost-code CRUD APIs (`src/app/api/cost-codes/route.ts`, `src/app/api/projects/[id]/cost-codes/route.ts`), and management pages (`src/app/company/cost-codes/`, `src/app/settings/cost-codes/`). #117's cost-code *plumbing* is redundant.
- **Job-costing dashboard** — `src/app/projects/[id]/costing/` (`JobCostingClient.tsx` + page). #117's costing UI is superseded.
- **Gusto integration** — full `src/app/api/gusto/*` (auth, callback, employee-mappings, export) + `src/app/settings/integrations/gusto/`. #117's labor-export-adjacent bits are superseded; the `sync-gusto` skill is the current path.
- **Money-path locks** — `src/lib/tx-retry.ts` (`lockMoneyParents` / `withTxRetry`) landed via PR #191. Any transaction #117 introduces must be re-derived on top of these helpers, not #117's May-era patterns.
- **The `EstimateItem.approvalStatus` per-item flag** — unrelated, already on main.

### What is still MISSING on main (so is the real payload to re-derive)

Verified absent on `origin/main`: `src/lib/cost-coding.ts`, `src/lib/notify.ts`, `src/lib/labor-cost.ts`, `src/lib/google-chat.ts`, `src/lib/rate-limit.ts`, `src/app/api/cron/crew-data-review/route.ts`, `src/app/api/manager/notifications/route.ts`, and there is **no `resolveCostCode` gate** on any current write path (time-entries/expenses can still be written uncoded). No `Notification` model on main.

### Pure noise in #117 (DROP entirely — never bring across)

`qa-screenshots/*.png`, `portal-schedule-*.png`, `.antigravitycli/*`, `.claude/scheduled_tasks.lock`, `ast_extract.py`, `performance_audit.md`, `AGENTS.md`, `scratch-db-recovery-diff.mjs`, `scripts/mesplay-*`, `scripts/restore-mesplay.mjs`, `scripts/search-backups.mjs`, `scripts/extract-*`, `scripts/insert-mesplay-children.mjs`, `scripts/seed-lump-sum-contract.mjs`, `scripts/list-*`, `scripts/test-prisma.ts`, `scripts/import-log-*.json`, `scripts/copy-signature.mjs`, `scripts/download-hdri.ts`, `src/components/VoiceCommandMic.tsx` + `src/app/api/ai/voice-command/route.ts` (separate voice feature), `src/app/api/gmail/sync/route.ts`, all `src/app/api/help-chat/*` refactors. These are unrelated to job costing and must not ride along.

## Goals

1. **A clean re-derivation plan** that maps every still-valuable behavior in #117 to exactly one of 4 dependency-ordered slices, explicitly lists what is obsolete/dropped, and lets a doer implement slice-by-slice against current main without ever checking out `feat/job-costing-gates`.
2. **Slice A — Cost-code gate (P0):** no labor or spend can be written uncoded, IDOR holes on expense review closed. Independently shippable; foundation for B and C.
3. **Slice B — WA L&I labor compliance (P1):** meal-break deduction + payable-hours + burden math applied to time entries, on top of the Slice-A gate.
4. **Slice C — Notification layer (P1):** durable notifications (in-app + email + Google Chat) fired by the gate/compliance/expense paths, with the manager notifications API + UI.
5. **Slice D — Crew data review cron + hardening (P1/P2):** daily stale-clock-out / offsite / weekly-OT sweep and PIN-login rate limiting.
6. **Per-slice acceptance criteria** (below) that a checker can verify against a throwaway test job, with `npm run build` green and codex review on any money/labor math.

## Non-Goals

- Rebasing, cherry-picking, or merging `feat/job-costing-gates` — it is reference only.
- Re-building anything in the "obsolete" list (cost-code CRUD/models, costing dashboard, Gusto export) — reuse what's on main.
- Bringing across any file in the "noise" list.
- Re-litigating the money-path lock design — reuse `src/lib/tx-retry.ts` as-is.
- OT **premium application** (rate multiplier) — #117 itself deferred this ("premium application deferred pending policy"); stays deferred pending Justin's policy call (Open Question 4).
- The voice-command mic, gmail sync, and help-chat refactors from #117 — out of scope entirely (separate features if wanted).

## Approach

Treat #117 as a spec source: read its diff for the *intent* of each helper, then re-implement against current schema, current lock helpers, and current cost-code models. Extract each helper's May version to a scratch file for reference (`MSYS_NO_PATHCONV=1 git show origin/feat/job-costing-gates:src/lib/cost-coding.ts`, etc.) but write new code. Each slice is its own branch + PR off current main, landed in order A→B→C→D (B and C both depend on A; C is consumed by B and by the expense paths; D depends on A+C).

### Slice A — Cost-code gate (P0) — *foundation, no dependencies*

Re-derive `src/lib/cost-coding.ts#resolveCostCode`: given a write (time entry or expense) it must resolve an **active** cost code, either explicit or derived from the chosen estimate line item (line items scoped to the project — reject cross-project ids). Wire the gate into every current write path: `POST /api/time-entries` and `[id]` PUT, `POST /api/expenses`, the web `createTimeEntry`(s) in `src/app/projects/[id]/timeclock/actions.ts` + `src/lib/time-expense-actions.ts`, and `createExpense`. Close the expense IDOR: `PUT`/`DELETE`/`approve` on `src/app/api/expenses/[id]/` gated to reviewer roles (check `src/lib/permissions.ts` for current role names — ADMIN/MANAGER/FIELD_CREW/FINANCE), and approve must block uncoded/inactive-coded expenses. Re-verify against the **current** endpoints (they have changed since May — do not assume #117's line numbers).

### Slice B — WA L&I labor compliance (P1) — *depends on A*

Re-derive `src/lib/labor-cost.ts`: 30-minute unpaid meal deduction on shifts > 5h; a skipped meal becomes paid **and flagged**; `durationHours` becomes **payable** hours; half-cent rounding fixed. Apply on time-entry create/update so `laborCost`/`burdenCost` (already columns on `TimeEntry`) are computed correctly. This is labor money math → **codex-review required**.

### Slice C — Notification layer (P1) — *depends on A; consumed by B and expense paths*

Add a durable `Notification` model (new table) + `src/lib/notify.ts` fan-out to in-app + email (Resend) + Google Chat (`src/lib/google-chat.ts`, internal/customer webhooks), timeout-bounded so it never breaks the request path, idempotent via `dedupeKey`. Fire on time-entry edit, missing-receipt, AI-uncoded expense, meal-skipped (the Slice-B flag). Add `GET`/`PATCH` `src/app/api/manager/notifications/route.ts` + the manager UI surface (re-derive the `ProjectHeader.tsx` / `LeadDetailsSidebar.tsx` touch-points against current files). **Toasts must use `sonner`** per project rules; follow `DESIGN_SYSTEM.md`.

### Slice D — Crew data review cron + hardening (P1/P2) — *depends on A + C*

Re-derive `src/app/api/cron/crew-data-review/route.ts` (daily): stale clock-outs, offsite entries (`TimeEntry.isOffsite/offsiteMs` already exist), weekly OT **detection** (>40 payable hrs flagged — detection only, no premium). Add `src/lib/rate-limit.ts` for PIN-login on `src/app/api/mobile/login/route.ts`. Register the cron in `vercel.json`.

## Files Touched

Re-created fresh (names from #117, code new):
- `src/lib/cost-coding.ts`, `src/lib/labor-cost.ts`, `src/lib/notify.ts`, `src/lib/google-chat.ts`, `src/lib/rate-limit.ts`
- `src/app/api/cron/crew-data-review/route.ts`, `src/app/api/manager/notifications/route.ts`

Modified against **current** main (re-verify current shape, ignore #117 line numbers):
- `src/app/api/time-entries/route.ts`, `src/app/api/time-entries/[id]/route.ts`
- `src/app/api/expenses/route.ts`, `src/app/api/expenses/[id]/route.ts`, `src/app/api/expenses/[id]/approve/route.ts`, `src/app/api/expenses/parse/route.ts`, `src/app/api/receipts/parse/route.ts`
- `src/app/projects/[id]/timeclock/actions.ts`, `src/lib/time-expense-actions.ts`, `src/lib/actions.ts` (createExpense/createTimeEntry only)
- `src/app/api/mobile/login/route.ts`, `src/app/api/manager/jobs/route.ts`
- `src/app/projects/[id]/ProjectHeader.tsx`, `src/app/leads/[id]/LeadDetailsSidebar.tsx`
- `prisma/schema.prisma` (Notification model + any nullable compliance flags), `vercel.json` (cron)

Verification (re-derived, not the May version):
- `scripts/verify-job-costing.ts` — fresh isolated-test-job verifier (see #117's `verify-job-costing-p0.ts` for the assertion set, but write against current code).

## Data Model Changes

- **New:** `Notification` table (id, recipient/role scope, type, title/body, `dedupeKey` unique-ish, read-at, createdAt, related-entity refs). Exact shape re-derived from #117's `migrations/p1_notifications_and_wa_meal_breaks.sql` — **document the intended schema here at implementation time**; do not copy the May migration blindly (schema has drifted).
- **Additive nullable** compliance flags on `TimeEntry` if not already present (e.g. a "meal skipped / flagged" boolean) — check current `TimeEntry` first (`laborCost`, `burdenCost`, `durationHours`, `isOffsite`, `offsiteMs` already exist; do not re-add).
- Apply via `apply_schema.ps1`, then `prisma generate` via PowerShell. Additive/nullable only. **Warning:** #117's body claims its migration was "already applied to prod" in May — verify current prod schema state before applying anything, to avoid a double-apply or a column that already exists.

## Test Plan

- **Slice A:** on an isolated auto-cleaned test job — a coded clock-in/out that previously cost \$0 now yields non-zero `laborCost` + `burdenCost`; an **uncoded** time-entry/expense write is **rejected**; a non-reviewer role cannot `PUT`/`DELETE`/`approve` an expense (IDOR closed); approve blocks an uncoded/inactive-coded expense.
- **Slice B (codex-review):** shift > 5h deducts a 30-min unpaid meal; skipped meal → paid **and** flagged; `durationHours` reflects payable hours; rounding exact to the cent on a spread of shift lengths.
- **Slice C:** notification fires exactly once per event (dedupeKey), never blocks or errors the request path on a webhook/email timeout; `GET`/`PATCH` manager notifications work; UI renders via `sonner`/design-system components.
- **Slice D:** cron flags stale clock-outs / offsite / >40-payable-hr weeks on seeded data; PIN-login rate limit trips after N attempts.
- Each slice: `npm run build` zero errors; a fresh `scripts/verify-job-costing.ts` run passes on a throwaway job; **never run against prod / Supabase DB** (per `docs/TESTING.md` — the e2e guard refuses Supabase URLs).

## Rollback Plan

- Each slice is an independent PR; revert that slice's PR to undo it without touching the others.
- Slice A gate is a code-level guard on write paths — reverting restores prior (ungated) behavior; no data migration to undo.
- `Notification` table (Slice C) and any additive nullable `TimeEntry` flags (Slice B) are additive — safe to leave in place on revert.
- Slice D cron: remove the `vercel.json` entry; the route is inert without a scheduler.
- No slice mutates existing money records; labor recompute (Slice B) only affects entries written after it ships (do **not** back-fill historical entries without a separate, reviewed migration).

## Open Questions

1. **Notification channels config.** #117 wired Google Chat internal + customer webhooks. Are those webhook URLs still valid / wanted, or should Slice C ship in-app + email first and add Chat behind a flag? Where do the webhook secrets live (Vercel env)?
2. **Reviewer roles.** Confirm which of ADMIN/MANAGER/FIELD_CREW/FINANCE may approve/edit/delete expenses and edit time entries, so the Slice-A gate matches `src/lib/permissions.ts` intent (not #117's May assumptions).
3. **Prod schema drift.** #117 claims its `p1_notifications_and_wa_meal_breaks.sql` was already applied to prod in May. Was it? If a partial/old version of the `Notification` table or meal-break columns already exists in prod, the re-derived migration must reconcile rather than re-create. Needs a prod-schema check before Slice B/C apply.
4. **OT premium policy.** #117 deferred overtime *premium* (rate multiplier) pending policy. Slice D does detection only. Do you want premium application in this effort, or keep it deferred to a later spec?
5. **WA meal-break parameters.** Confirm the exact WA L&I rule to encode: 30-min unpaid meal on shifts > 5h — are there rest-break or second-meal (>10h) rules to include in v1, or just the single-meal rule #117 implemented?
6. **Cost-derivation source of truth.** With the costing dashboard + Gusto sync already on main, should `resolveCostCode`'s "derive from estimate line item" path defer to any logic those already use, to avoid two cost-derivation code paths diverging?
7. **Slice count vs. sequencing.** Is 4 PRs (A→B→C→D) the right granularity, or would you rather fold D's hardening into A/C to reduce PR overhead? A and C are the two that stand alone cleanly; B and D are smaller.
