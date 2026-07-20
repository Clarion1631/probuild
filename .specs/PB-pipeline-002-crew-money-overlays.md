# PB-pipeline-002 — Crew + Money Overlays on the Company Dashboard, and Estimate→Schedule Generation

**Status:** TRIP-1 plan gate — round 2 (addresses Codex review R1)
**Date:** 2026-07-20
**Requester:** Owner ("continue" after PB-pipeline-001)
**Builds on:** PB-pipeline-001 (PR #214; schedule-core.ts, /company-dashboard,
Project.startDate/endDate, scheduleTaskId FKs on both milestone models, MCP v1.7.0).

## Codebase context (delta from PB-pipeline-001's map)

- `EstimateItem` has `parentId`/`subItems` — phases are top-level items with children —
  `scheduleTask ScheduleTask?` (back-relation of `ScheduleTask.estimateItemId @unique`),
  `budgetUnit`, legacy `type`, and `costType.name`. **It has NO `unit` field** (schema:453);
  the MCP `unit` input is not persisted (ai-estimate-transform.ts:98).
- `Expense`: `estimateId` (join project via `estimate.projectId`), `amount`, `vendor`,
  `date DateTime?`, `status` (Pending/Reviewed).
- `TimeEntry`: `userId`, `projectId`, `startTime`, `durationHours`, `laborCost`, `burdenCost`.
  Profitability convention uses **burdened labor** (laborCost + burdenCost —
  reports/profitability/page.tsx:121).
- Crew: `Project.crew User[]` m-n ("CrewAssignments") — used today only for access filtering;
  NO action exists to set a project's crew.
- `getTeamMembers()` (actions.ts:7104) returns PENDING and DISABLED users too — pickers must
  filter to ACTIVATED.
- `importEstimateToSchedule` (actions.ts:6615) — EXISTING estimate→schedule importer; must be
  routed through the new core so all paths share preconditions/idempotency.
- Signed-estimate flow pushes pending milestones to QBO at approval (actions.ts:2262) — most
  PaymentSchedule clones on signed jobs carry `qbInvoiceId`.
- Company dashboard from P1: page.tsx gates `hasPermission(financialReports)`, ADMIN-only
  financial serialization, canEdit = ADMIN|MANAGER; P1 shift rules: Project row FOR UPDATE,
  entire-`sourceScheduleId`-group skip on QB-flagged clones **for due-date WRITES**.

## Problem (owner's original sentence, completing it)

"Tie milestone payments to the project calendar **and tasks to the estimate getting
completed**, and eventually we can **assign crew** to it and **project cashflow, expense,
hours, income all on the schedule**, but this info is only good for admins to see."

P1 shipped the calendar, start-date moves, and the milestone↔task link mechanism. What
remains: (A) generate a job's schedule from its completed estimate, (B) assign + see crew
on the company calendar with conflict visibility, (C) money/hours overlays — admin-only.

## Schema changes (`scripts/apply-schedule-provenance-schema.mjs` + `prisma generate`)

- `ScheduleTask.generatedFromEstimateId String?` FK → `Estimate` (onDelete: SetNull) + index
  — generation provenance for EVERY generated task kind (phase parents, children,
  milestones) so regenerate can identify them without touching manual tasks (R1 fix 1).

## Workstream A — Estimate → schedule generation ("tasks tied to the estimate")

New in `schedule-core.ts`: `generateScheduleFromEstimate({ estimateId, mode, actor })`.
**Everything runs in ONE transaction** (withTxRetry; Project row `FOR UPDATE` first, same
lock family as P1) — lock → read → delete(regenerate) → create → link → ActivityLog (R1 fix 1).

- **Preconditions:** estimate status in (`Approved`, `Invoiced`, `Partially Paid`, `Paid`);
  owner is a **project** (lead-owned: actionable error suggesting conversion); project has
  `startDate` (actionable error otherwise).
- **Deterministic estimate selection at the project level** (R1 fix 6): the dashboard
  button and any project-scoped caller resolve to the project's **most recent qualifying
  estimate** — the same selection P1's `contractValue` uses (status in the list above,
  latest `createdAt`) — and the chosen estimate `code` is returned in the result. The MCP
  tool and the rewired importer pass an explicit `estimateId`.
- **`importEstimateToSchedule` rewiring** (R1 fix 6): its internals delegate to
  `generateScheduleFromEstimate` (mode "merge"), preserving its current signature/response
  shape for existing UI call sites (adapt the wrapper, or update call sites if the shape
  cannot be preserved — implementer reports which).
- **Structure:** top-level items (phases) → parent `ScheduleTask`s (with
  `generatedFromEstimateId`); `subItems` → child tasks linked via `estimateItemId` (+
  provenance); phase-less estimates → flat tasks (with provenance).
- **Labor classification & hours** (R1 fix 5 — no `unit` exists): a line counts as Labor
  when `costType?.name ?? type` equals "Labor" (case-insensitive). Child-task
  `estimatedHours` = `quantity` when `budgetUnit` is hour-like (`hr|hrs|hour|hours`,
  case-insensitive); else null.
- **Phase windows** (R2 fix): window = startDate → endDate if set, else startDate + 42 days;
  if the phase count exceeds the window's days, the window extends to `phaseCount` days.
  Allocation: **reserve 1 day per phase first, then distribute the remaining
  `windowDays − phaseCount` days proportionally by labor-dollar share** (each phase's
  ideal share of the remainder is floored; leftover days go to the phases with the
  **largest fractional remainder**, ties broken by phase order — Hamilton/largest-remainder
  apportionment — so slices sum exactly to the window) (R3 fix: one algorithm, stated once). Calendar days (existing scheduler spans
  weekends). Bounds: `[start, end)` end-exclusive as in P1; a 1-day task ends the next
  UTC day.
- **Phase-less placement** (R1 fix 7): flat tasks placed sequentially in estimate `order`,
  equal share of the window (`windowDays / taskCount`, min 1 day each); when taskCount >
  windowDays, multiple tasks share a start day (order preserved via `order`).
- **Milestones — ONE canonical date rule** (R1 fix 3, R2 fixes): order EPS rows by
  **`(EPS.order, EPS.id)`** (business sequence, not percentage value) and accumulate each
  row's percentage → the cumulative-percentage point of the window (fixed-amount/unordered
  rows at window end). The milestone task date = `EPS.dueDate` if set, else that derived
  point. Then **initialize `dueDate` from that date ONLY on rows that are `Pending` AND
  `dueDate IS NULL` AND not QB-pushed** (R2 fix — paid/settled rows are NEVER rewritten;
  their historical task date is derived without any write; QB-pushed clones keep their
  QB-visible date and are reported in notes). Existing dueDates always win.
  **Income-overlay fallback** (R2 fix, R3 fix): define ONE `effectiveDueDate =
  dueDate ?? linked milestone task's startDate` (via `scheduleTaskId`) and use it in BOTH
  the calendar income layer AND the project strip's "Income due" — so AI-imported
  milestones whose local dueDate is null but are already QBO-pushed still appear as
  *projected* income on the generated task date. Overlays and tasks agree by construction.
- **Milestone linking** (R1 fix 2): set `scheduleTaskId` on the EPS row AND every unpaid
  clone in its `sourceScheduleId` group — **regardless of `qbInvoiceId`** (linking is not a
  QBO mutation; the QB whole-group skip applies ONLY to due-date WRITES, per P1). Done under
  the same FOR UPDATE row locks as P1.
- **Idempotency & regenerate** (R1 fix 1, R2 fix): `mode: "merge"` (default) skips items
  already task-linked. `mode: "regenerate"` deletes generated tasks then rebuilds, where
  **deletable** means the FULL eligibility predicate: `generatedFromEstimateId = estimateId
  AND progress = 0 AND status = "Not Started" AND no timeEntries AND no comments AND no
  punchItems AND no assignments AND no subAssignments AND no dependency rows** — evaluated
  at delete time (no dirty-flag hooks needed). Because `ScheduleTask.parent` is
  `onDelete: Cascade`, eligibility is decided **per phase subtree**: a subtree is deleted
  only when EVERY descendant task is deletable; if any descendant is protected, the whole
  subtree is kept and reported in notes (never a cascade through protected work).
  Milestone re-link is upsert-style (skip where already set).
- **Result:** `{ estimateCode, created, skipped, milestonesLinked, notes[] }`; ActivityLog
  "generated_schedule" (TEAM/SYSTEM as in P1).
- **Entry points:** server action `generateProjectScheduleAction` (ADMIN/MANAGER inline
  role check; revalidates dashboard + project schedule); dashboard button on
  Waiting/Scheduled rows when the project has a qualifying estimate AND zero schedule
  tasks; MCP tool `generate_project_schedule` (explicit estimateId).

## Workstream B — Crew on the company calendar

- `setProjectCrew({ projectId, userIds, actor })` in schedule-core: replaces `Project.crew`
  via connect/disconnect diff; **validates all ids are ACTIVATED users** (picker lists are
  pre-filtered to ACTIVATED in the dashboard page — `getTeamMembers()` itself is unchanged
  for other callers) (R1 fix 9); ActivityLog "set_project_crew". Server action
  `updateProjectCrewAction` (ADMIN/MANAGER; revalidates dashboard).
- Dashboard UI: Waiting/Scheduled/In-Progress rows gain a compact crew picker (checkbox
  popover); calendar project chips show up to 3 crew initials + overflow count. FINANCE:
  read-only (P1 canEdit rule).
- **Crew conflict panel** (ADMIN/MANAGER, read-only): conflicts computed from **the same
  relation the picker writes — `Project.crew`** (R1 fix 4): a project's window =
  startDate → (endDate ?? latest task endDate ?? startDate + 1 day) (R2 fix — the
  zero-length fallback is one day so two crews booked on the same day DO conflict);
  overlap uses half-open `[start, end)` bounds; a conflict = one user in the crew of two
  different projects whose windows overlap within the visible month.
  `getCrewConflicts(from, to)`: bounded queries (projects with crew + latest task end per
  project), overlap computed in memory; returns `{ userId, name, pairs: [{projectA,
  projectB, overlapStart, overlapEnd}] }`. TaskAssignment-level precision is Phase 3.

## Workstream C — Money/hours overlays (ADMIN-only, data-layer enforced as in P1)

All read-only; **only queried and serialized when `user.role === "ADMIN"`**.
- Page data assembly extracted into **`getCompanyDashboardData(userLike, month)`** in
  schedule-core (page stays thin; directly testable per R1 fix 10): overlays included only
  when `userLike.role === "ADMIN"`.
- `getCalendarOverlays(from, to)` (ADMIN path only): **income** = P1 milestone data;
  **expenses** = `Expense.date` in range → sum per UTC day (join project via estimate);
  **hours** = `TimeEntry.startTime` date in range → sum `durationHours` per UTC day.
- Calendar UI: toggleable layer chips (Income green / Expenses red / Hours blue), small
  per-day totals; default: income on, others off.
- **Per-project month strip** (ADMIN) with exact semantics (R1 fix 8, R3 fix):
  **Income due** = Pending milestone sums by **`effectiveDueDate`** (the shared
  `dueDate ?? linkedTask.startDate` rule — same dates as the calendar income layer); **Received** = Paid milestone sums
  by `COALESCE(paymentDate, paidAt)`; **Expenses** = sum by `Expense.date`; **Labor (actual,
  burdened)** = `laborCost + burdenCost` sums; **Hours** = actual TimeEntry hours vs
  `estimatedHours` of tasks overlapping the month; **Net** = Received − Expenses − burdened
  Labor (profitability convention). Columns labeled exactly this way.

## MCP changes (server → v1.8.0)

- `get_company_schedule`: gains per-project `crew` (ids+names) and a `crewConflicts` block
  (project-window rule). NO expense/hours data (lean read surface per connector convention).
- `generate_project_schedule` (write): `{ estimateId, mode? }` → workstream A core.
- `assign_project_crew` (write, idempotent replace): `{ projectId, userIds }` →
  `setProjectCrew`, actor SYSTEM/"ChatGPT connector".
- Instructions extended (estimate must be Approved+, project needs startDate first; crew
  conflicts come from project windows).

## Verification

- `scripts/verify-crew-overlays.ts` (verify-*.ts pattern), fixtures cleaned up:
  (a) generation builds phase/child/milestone tasks with correct dates, provenance, and
  estimateItemId links; merge idempotent; regenerate replaces ONLY provenance-tagged
  untouched tasks (a manually-created lookalike task survives);
  (b) milestone canonical-date rule: existing dueDate wins; null dueDates initialized ONLY
  on Pending non-QB mirrors (a Paid EPS row is never rewritten); `scheduleTaskId` set on
  EPS + ALL unpaid clones incl. QB-flagged; QB-pushed null-date clone appears in the income
  overlay as projected income on its linked task date;
  (b2) regenerate eligibility: a manually-edited generated task (status changed / comment /
  assignment / dependency added) survives; a phase subtree with one protected descendant is
  kept whole;
  (c) phase-less placement + rounding edge cases (taskCount > windowDays) and a mixed-weight phase allocation case (labor-heavy vs zero-labor phases) asserting exact window coverage under largest-remainder apportionment;
  (d) setProjectCrew diff + non-ACTIVATED rejection; picker list is ACTIVATED-filtered;
  (e) conflict detection flags a seeded two-project crew overlap, ignores same-project;
  (f) overlays: seeded Expense/TimeEntry sums on the right UTC days; Received bucketed by
  paymentDate not dueDate; Net uses burdened labor; **`effectiveDueDate` appears
  identically in the calendar income layer AND the project strip Income due** (R3);
  (g) **`getCompanyDashboardData` role matrix** (R1 fix 10): MANAGER and FINANCE users get
  NO overlay fields and NO per-project strip; ADMIN gets them;
  (h) rewired `importEstimateToSchedule` delegates to the core (merge) — one round trip.
- `tsc --noEmit` 0 errors (standing rule).
- Dev smoke: ADMIN sees picker + conflict panel + toggles; FINANCE read-only; FIELD_CREW
  denied (P1 matrix unchanged).

## Money-path note

C reads money tables; A writes `scheduleTaskId` on mirrors (any QB state) and `dueDate`
ONLY where the row is **Pending** AND null-dated AND not QB-pushed — never
amounts/status/QB fields — under P1 locking →
TRIP-2 codex review before merge; `e2e/money-pipeline.spec.ts` must stay green.

## Explicitly out of scope (Phase 3+)

- Auto-generating the schedule when an estimate is signed (approval-flow hook).
- TaskAssignment-level crew assignment/conflicts from the dashboard (exists per-project).
- Conflict notifications; weekly capacity planning; sub view; drill-down modals.

## R1 changelog (Codex review round 1 → this revision)

1. Generation provenance: new `ScheduleTask.generatedFromEstimateId` (schema migration);
   regenerate deletes only provenance-tagged untouched tasks; generation is one transaction.
2. Milestone linking no longer QB-skips (linking ≠ QBO mutation); QB whole-group skip stays
   for due-date WRITES only.
3. One canonical milestone date: existing dueDate > percentage-derived; null non-QB
   dueDates initialized from it; overlays and tasks agree by construction.
4. Crew conflicts computed from `Project.crew` project windows (same relation the picker
   writes); TaskAssignment precision deferred to Phase 3.
5. No `unit` field exists — Labor via `costType?.name ?? type`; hours via `budgetUnit`.
6. Deterministic estimate selection (P1 contractValue rule) + `importEstimateToSchedule`
   rewired through the new core.
7. Phase-less placement + integer rounding/bounds/min-day rules specified.
8. Received by payment date (COALESCE(paymentDate, paidAt)); Net uses burdened labor per
   the profitability convention; columns relabeled.
9. Crew picker filtered to ACTIVATED (getTeamMembers unchanged for other callers).
10. Page data assembly extracted to `getCompanyDashboardData` — role-matrix assertions in
    the verify script prove MANAGER/FINANCE never receive overlays.

## R2 changelog (Codex review round 2 → this revision)

1. Phase allocation: reserve 1 day per phase, then distribute the remainder proportionally (floor + largest-remainder); phaseCount > windowDays extends the window to phaseCount days.
2. Regenerate: full eligibility predicate (status/comments/punchItems/assignments/dependencies/timeEntries), evaluated per phase SUBTREE — any protected descendant keeps the whole subtree (parent delete is onDelete: Cascade).
3. Due-date initialization restricted to Pending rows — settled milestones are never rewritten; income overlay falls back to the linked milestone task date for QBO-pushed null-date rows (projected income).
4. Conflict-window zero-length fallback is startDate + 1 day; half-open [start, end) overlap stated.
5. Milestone cumulative ordering pinned to (EPS.order, EPS.id).

## R3 changelog (Codex review round 3 → this revision)

1. One effectiveDueDate (dueDate ?? linkedTask.startDate) used by BOTH the calendar income layer and the project strip Income Due.
2. Phase-remainder algorithm unified on Hamilton/largest-remainder (floor, leftover days to largest fractional remainders, ties by phase order); mixed-weight verification case added to (c).
3. Money-path summary now states the Pending restriction on due-date initialization.
