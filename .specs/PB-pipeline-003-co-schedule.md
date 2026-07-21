# PB-pipeline-003 — The Mid-Job Loop: Auto-Schedule on Signature, Change Orders → Schedule & Cash, Task-Level Crew

**Status:** TRIP-1 plan gate
**Date:** 2026-07-20
**Requester:** Owner ("sometimes we have change orders that will adjust schedule — keep in
mind the workflow of an entire remodeling company")
**Builds on:** PB-pipeline-001 (PR #214), PB-pipeline-002 (PR #215, stacked).

## The remodeling-company workflow this serves

Lead → estimate → **signed ⇒ schedule exists** → Waiting to Start → Scheduled (crew,
conflicts checked) → In Progress — and then reality: **the customer changes something**.
A change order reprices the job, and today ProBuild already bills it; what it does NOT do
is move the calendar. The crew finishes the original scope Friday and stands down Monday
because nobody's schedule shows the added week of work — and the cash forecast doesn't
show the CO money either. This spec closes that loop:

1. **Signing the estimate generates the schedule automatically** (no more "someone has to
   remember to click the button").
2. **Approving a change order adjusts the schedule and the cash forecast** — new scope
   appears as tasks, job finish moves out, CO money appears in the income overlays.
3. **Crew gets precise**: assignment at task level from the company dashboard, conflicts
   computed from actual task windows (upgrading P2's project-window approximation).

## Codebase context (delta)

- `ChangeOrder` (projectId, estimateId, code `CO-#####`, title, status
  Draft/Sent/Approved/Declined, totalAmount); `ChangeOrderItem` (flat: name, type
  ["Material" legacy label], quantity, unitCost, total, order, costCodeId/costTypeId);
  `ChangeOrderPaymentSchedule` (name, amount, **dueDate?**, order — no status, no task link).
- **CO approval already has an automation hook**: `handleChangeOrderApproved(changeOrderId)`
  (billing-core.ts:984) auto-bills a freshly-approved CO (creates ONE invoice milestone
  per CO; billed-state is detected by `CO-#####` name-prefix on invoice milestones,
  billing-core.ts:865-867; idempotent).
- **Estimate approval single funnel**: `approveEstimate(...)` (actions.ts:2280) — used by
  both the portal signature path and admin approval; sets status "Approved" and triggers
  invoice creation (~L2262 QBO push).
- P2 shipped: `generateScheduleFromEstimate` (provenance `generatedFromEstimateId`,
  full subtree eligibility, FOR UPDATE discipline), `setProjectCrew`, `getCrewConflicts`
  (Project.crew windows), overlays with shared `effectiveDueDate`, MCP v1.8.0.
- Task-level crew primitives: `TaskAssignment` (taskId+userId unique, role);
  create/delete actions at actions.ts:6893-6921 (project schedule page).

## Schema changes (`scripts/apply-co-schedule-schema.mjs` + `prisma generate`)

- `ScheduleTask.generatedFromChangeOrderId String?` FK → `ChangeOrder` (SetNull) + index
  (CO-task provenance, mirroring `generatedFromEstimateId`).
- `ChangeOrderPaymentSchedule.scheduleTaskId String?` FK → `ScheduleTask` (SetNull) +
  index (milestone↔calendar tie for CO money, mirroring the P1 pattern).

## Workstream A — Auto-generate on estimate signature

- Hook: at the end of `approveEstimate`, AFTER the approval+invoice work commits, call
  `generateScheduleFromEstimate({ estimateId, mode: "merge", requireEmptyProject: true, actor: SYSTEM/"system" })`
  **best-effort**: wrapped in try/catch; a failure is logged (console + ActivityLog where
  possible) and NEVER fails or rolls back the approval (money-path discipline).
- **Auto-path zero-task precondition** (R1 fix 1, R2 fix): `generateScheduleFromEstimate`
  gains `requireEmptyProject?: boolean` — when true, the generation transaction enforces
  **zero schedule tasks** under the Project lock (P2's merge mode alone only skips
  already-linked estimate items and would otherwise stack a generated schedule on top of
  manually-built tasks). Callers: the `approveEstimate` hook → `true`; the
  `setProjectStartDate` post-commit hook → `true`; the dashboard button → `true`
  (consistent with its zero-task visibility rule); the MCP tool and the rewired importer →
  omitted (merge semantics preserved for explicit estimateId-driven calls).
- **The "forgot to set a date" loop is closed** (R1 fix 2): `setProjectStartDate` gains a
  post-commit best-effort step — when a project goes null→dated (or is dated) and still has
  zero tasks AND a qualifying estimate exists (P2 selection rule), it calls
  `generateScheduleFromEstimate` with the triggering actor; failures are caught and surface
  in the result's `notes[]`, never fail the date move. Sign first, date later ⇒ schedule
  appears by itself.

## Workstream B — Change orders adjust the schedule + cash

New in `schedule-core.ts`: `applyChangeOrderToSchedule({ changeOrderId, mode, actor })`.

- **Preconditions:** CO status Approved; project has `startDate`. Otherwise actionable error.
- **Provenance & idempotency:** CO parent + child + milestone tasks all carry
  `generatedFromChangeOrderId`. `mode: "merge"` (default) = no-op when provenance tasks
  exist for this CO; `"regenerate"` deletes only provenance-tagged tasks whose ENTIRE
  subtree passes the P2 full eligibility predicate, then rebuilds. One transaction;
  Project row `FOR UPDATE` first (P1/P2 discipline).
- **Structure:** one parent task `CO-##### · <title>` + flat child tasks from
  `ChangeOrderItem`s in `order`. **Deduction items (negative `total`) create NO task** —
  they reduce scope; reported in `notes[]` for the PM to trim existing tasks manually.
- **One `effectiveWorkEnd` definition** (R1 fix 3, R2 fix): `max(Project.endDate,
  max(endDate of NON-milestone tasks)) ?? startDate` — payment milestone tasks never
  extend the work window (a final-payment milestone 30 days out must not push CO placement
  or conflicts), and an empty project falls back to `startDate`. Used by BOTH CO placement
  and the project-window conflict rule (replacing P2's
  `endDate ?? latest task end ?? startDate + 1 day`; the `startDate + 1 day` value now
  serves ONLY as the conflict-window duration fallback).
- **Placement (defensible default):** appended as a contiguous block starting **exactly at
  `effectiveWorkEnd`** — task bounds are end-exclusive (P2), so starting AT the current end
  leaves no empty day — the job's finish visibly moves out; the PM drags tasks to slot them
  mid-job if needed (per-project schedule page already supports that).
- **CO window duration:** labor-calibrated — `coLaborDays = round(coLabor$ / (estimateLabor$ /
  estimateWindowDays))`, using the CO's **positive** labor lines only (`costType?.name ??
  type` = "Labor", `total > 0` — negative labor lines are excluded so a mixed
  addition/deduction CO doesn't shorten the new block while the deducted work awaits
  manual trimming) (R1 fix 5) and the ORIGINAL estimate's labor burn rate (min 1 day; when
  the estimate or labor data is missing/unusable: 1 day per non-negative item, packed). Children placed inside the CO
  window with P2's proportional-boundary rule (exact coverage, 1-day minimum).
- **Milestones — incl. the zero-row fallback** (R1 fix 4): one milestone task per
  `ChangeOrderPaymentSchedule` row; canonical date = `dueDate` if set, else
  cumulative-share of the CO window by `(order, id)`; set `scheduleTaskId` on the CO
  payment row (regardless of billing state — linking is not a money mutation). **No
  production path creates `ChangeOrderPaymentSchedule` rows**, so when an Approved CO has
  ZERO payment rows, synthesize ONE milestone task `CO-##### payment` at the CO block's
  end with projected amount = **`signedAmount = CO.totalAmount + tax`, computed with the
  same `co-tax.ts` helper billing uses** (coTaxRate/coTaxLabel — `totalAmount` is the
  PRE-TAX subtotal; billing invoices totalAmount + tax, so a pre-tax projection would
  understate cash and jump after billing) (R2 fix). The same `signedAmount` is the
  zero-row overlay projection below. **Null dueDates on CO
  payment rows are NOT written** (date authority stays with the invoice clone once billed;
  the CO row's projected date lives on the task).
- **Billed-clone linking:** after task creation, find the CO's already-billed invoice
  milestone(s) by the billing-core convention (invoice on this project, milestone name
  starts with the CO code) and set their `scheduleTaskId` to the corresponding milestone
  task (match by order; when the CO has zero payment rows, link the clone to the single
  synthesized milestone task). Linking regardless of QB state; NO dueDate writes.
- **Income overlays (no double counting):** a CO contributes to the income layer and
  project strip as: **billed** → its invoice `PaymentSchedule` clone(s) flow in through the
  existing P1/P2 queries (they are PaymentSchedule rows); **Approved-but-unbilled** → each
  `ChangeOrderPaymentSchedule` row as *projected* income at
  `effectiveDueDate = dueDate ?? linkedTask.startDate` — and with ZERO payment rows, the
  CO's **`signedAmount`** (totalAmount + tax via co-tax.ts) projected at the synthesized
  milestone task's date (R1 fix 4, R2 fix).
  `getCalendarOverlays` and the strip gain a CO section with this billed/unbilled split
  (ADMIN-only as before).
- **Auto-hook:** inside `handleChangeOrderApproved`, after a FRESH approval (+ auto-bill)
  completes, call `applyChangeOrderToSchedule(changeOrderId, "merge", SYSTEM)` best-effort
  — try/catch, failures appended to `summary.issues`, never fail the money path. Skipped
  quietly when preconditions fail (not an error; e.g. no startDate).
- **Manual entries:** dashboard button on In Progress rows with Approved-but-unapplied COs
  (data via `getCompanyDashboardData`: `unappliedChangeOrders: count + codes`); server
  action `applyChangeOrderToScheduleAction` (ADMIN/MANAGER); MCP tool
  `apply_change_order_to_schedule` ({ changeOrderId, mode? }).

## Workstream C — Task-level crew + precise conflicts

- `setTaskCrew({ taskId, userIds, actor })` in schedule-core: `TaskAssignment`
  replace-diff (ACTIVATED validation like `setProjectCrew`; role stays "assigned");
  ActivityLog "set_task_crew". Server action `updateTaskCrewAction` (ADMIN/MANAGER).
- Dashboard: "Schedule & crew" card rows become **expandable** — tasks of the project
  (from `getCompanyDashboardData`: id, name, dates, status, assigned users incl.
  inactive-removable entries) each with the P2 picker UI. FINANCE read-only as before.
- **Conflict precision upgrade** (`getCrewConflicts` v2): conflicts from **TaskAssignment
  windows** — user assigned to tasks on different projects whose `[start, end)` windows
  overlap within the visible month → pairs with task names + dates. **The project-window
  fallback is per `(userId, projectId)`** (R1 fix 6): only user–project pairs with NO task
  assignments in the month use the P2 project-window rule, so having task assignments on
  project A never suppresses fallback coverage on project B. Union both, dedupe. Windows
  use the shared `effectiveWorkEnd` (R1 fix 3). MCP `get_company_schedule` returns the
  upgraded block.

## MCP changes (server → v1.9.0)

- New `apply_change_order_to_schedule` (write) per workstream B.
- `get_company_schedule`: gains `unappliedChangeOrders` per project and the v2
  `crewConflicts` block.
- Instructions extended: "change orders adjust the schedule — approve in ProBuild (auto)
  or call apply_change_order_to_schedule; deductions never auto-remove tasks."

## Verification (`scripts/verify-phase3-co-schedule.ts`, fixtures cleaned up)

- (a) approveEstimate hook fires generation (Approved + startDate + zero tasks → tasks
  appear); **zero-task precondition**: a project with MANUAL tasks gets NO generated
  schedule from the auto path; **failure injection** (R1 fix 7): force the generator to
  throw (e.g. corrupt fixture) and assert the approval + invoice state remains committed;
  **null→dated loop** (R1 fix 2): approve without startDate (nothing), then setProjectStartDate
  → generation fires automatically.
- (b) CO application: parent/children created after `effectiveWorkEnd` (a trailing payment
  milestone does NOT push placement); negative items skipped + noted; mixed
  addition/deduction CO: negative labor lines excluded from coLabor$; merge idempotent;
  regenerate respects subtree eligibility.
- (c) CO milestones: dueDate wins; derived dates otherwise; `scheduleTaskId` set on CO rows
  AND on a seeded billed clone (name-prefix match); no dueDate writes anywhere; **zero-row
  fallback** (R1 fix 4, R2): a CO with NO payment rows gets one synthesized end milestone
  carrying signedAmount (totalAmount + tax via the co-tax.ts helper), its billed clone linked;
  placement starts exactly at effectiveWorkEnd (no empty day), empty project falls back to
  startDate; auto callers pass requireEmptyProject: true, MCP/importer keep merge semantics
- (d) Overlay: Approved-unbilled CO money appears as projected income at effectiveDueDate
  (incl. the zero-row signedAmount fallback — taxable fixture asserting the SAME exact amount
  before and after billing); after seeding the billed clone, the same money appears ONCE (no double count).
- (e) setTaskCrew diff + ACTIVATED rejection; dashboard data exposes task assignments;
  conflict v2 flags a task-window overlap; **per-pair fallback** (R1 fix 6): user with task
  assignments on A but none on B still gets B project-window coverage; ignores
  same-project overlaps.
- (f) Hook integration: `handleChangeOrderApproved`-adjacent path (call with preconditions
  met vs unmet) leaves billing results untouched when scheduling throws (inject failure).
- (g) `tsc --noEmit` 0 errors; dev smoke: expand row → task pickers; CO button appears;
  overlays show CO projected income (ADMIN only).

## Money-path note

B writes ONLY `scheduleTaskId` on CO payment rows + billed clones (no amounts, no status,
no QB fields, no dueDate writes at all this phase); hooks are best-effort post-commit and
can never fail approval/billing → TRIP-2 codex review before merge;
`e2e/money-pipeline.spec.ts` must stay green.

## Explicitly out of scope (Phase 4+)

- Mid-job INSERTION with automatic right-shift of remaining tasks (PM drags for now);
  deduction items auto-trimming existing tasks (notes only).
- OfficeTask/"set a start date" reminders; notifications for CO schedule impact.
- Daily-log-driven progress rollups on the dashboard; punch list / closeout surfacing
  (both exist per-project); capacity planning.

## R1 changelog (Codex review round 1 → this revision)

1. Auto path enforces zero-project-tasks inside the locked transaction (P2 merge only skips linked items; manual tasks would otherwise get an overlapping generated schedule).
2. Closed the forgot-the-date loop: setProjectStartDate post-commit best-effort generation when a qualifying estimate exists and the project has zero tasks.
3. One effectiveWorkEnd = max(Project.endDate, non-milestone task ends) for CO placement AND project-window conflicts (payment milestones never extend the work window).
4. Zero-payment-row CO fallback: one synthesized CO-end milestone with the signed totalAmount, billed clone linked, overlay projects the same amount; non-seeded verification case added.
5. coLabor$ uses positive labor lines only.
6. Project-window conflict fallback is per (userId, projectId).
7. Verification now injects an actual generator failure and asserts approval/invoice state stays committed.

## R2 changelog (Codex review round 2 → this revision)

1. requireEmptyProject?: boolean distinguishes the automatic zero-task path (approveEstimate hook, setProjectStartDate hook, dashboard button = true) from explicit merge callers (MCP, importer).
2. CO signedAmount = totalAmount + tax via co-tax.ts (totalAmount is pre-tax; billing invoices totalAmount + tax) — used by the synthesized milestone AND the overlay projection so projected cash doesn't jump after billing.
3. effectiveWorkEnd gains the ?? startDate fallback; the CO block starts exactly AT it (end-exclusive, no empty day); startDate + 1 day remains only the conflict-window duration fallback.
