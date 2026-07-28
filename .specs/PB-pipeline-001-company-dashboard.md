# PB-pipeline-001 — Company Pipeline Dashboard + ChatGPT Start-Calendar Tools

**Status:** TRIP-1 plan gate — round 2 (addresses Codex review R1)
**Date:** 2026-07-19
**Requester:** Owner (via Kimi Work session)

## Codebase context (stands in for docs/ARCHI.md — this repo has none)

Repo: `probuild` (goldentouch-pro), Next.js 16 App Router + Prisma/Postgres + next-auth.
Key files for this feature:

- `prisma/schema.prisma` — `Project` (no start/end dates today, status default "In Progress"),
  `Lead.expectedStartDate`, `ScheduleTask` (job tasks; `type: task|milestone`; `estimateItemId`
  hook), `EstimatePaymentSchedule` / `PaymentSchedule` (milestone dueDate; PaymentSchedule has
  `sourceScheduleId` back-link to its EstimatePaymentSchedule + QB fields `qbInvoiceId`, …),
  `ActivityLog` (projectId?, actorType, actorName, action, entityType?, entityId?, metadata?).
- `src/lib/project-status.ts` — canonical `PROJECT_STATUSES`, `OPEN_PROJECT_STATUSES`,
  `LEGACY_PROJECT_STATUS_MAP`.
- `src/lib/actions.ts` (~10k lines, "use server") — `convertLeadToProject` (~L1036, hardcodes
  "In Progress", drops expectedStartDate), `createProject` (~L1125), invoice creation from
  estimate (~L3197-3217, clones EstimatePaymentSchedule → PaymentSchedule keeping
  `sourceScheduleId`), `getAllScheduleTasks` (L6946), `updateProjectStatus` (L6985).
- `src/app/api/manager/jobs/route.ts` (L117-125) — mobile project creation; relies on the
  schema status default ("In Progress").
- `src/lib/quickbooks-payments.ts` (L142-150) — copies local `PaymentSchedule.dueDate` into
  the customer-facing QBO invoice when (re)pushing a milestone.
- `src/app/api/mcp/[transport]/route.ts` — ChatGPT MCP server (v1.6.0), shared-secret auth,
  session-free cores in `src/lib/*-core.ts` (billing-core.ts precedent).
- `src/app/manager/schedule/` — existing Master Schedule = job TASKS (getAllScheduleTasks).
- `src/app/projects/[id]/schedule/schedule-utils.ts` — UTC-safe date helpers (getMonthGrid,
  parseUTCDate, todayUTC, formatCurrency) reused by the new calendar.
- `src/components/nav/navItems.tsx` — NAV_ITEMS; `usePermissions().can(key)`; ADMIN/MANAGER
  pass every key (permissions.ts ADMIN_ROLES).
- `scripts/apply-*-schema.mjs` — additive-migration pattern ($executeRawUnsafe, then
  `prisma generate`; never `prisma db push`). `scripts/verify-*.ts` — DB round-trip checks.

## Problem

The owner wants one company-wide place to see the whole book of work:

> "An overall calendar that would hold all of our project starts… separate from the
> job calendars… a company dashboard." Pipeline: **Estimating → Waiting to Start →
> Scheduled → In Progress**. ChatGPT (via the existing MCP connector) can read and
> move company-level project start dates; the dashboard itself stays in ProBuild.
> Later: crew on the schedule, cashflow/expense/hours/income overlays — admin-only.

Today:

- `Lead.expectedStartDate` exists but is **dropped at conversion** (`convertLeadToProject`
  hardcodes `status: "In Progress"`, never copies the date).
- `Project` has **no start/end dates** and no pre-work status.
- The Master Schedule (`/manager/schedule`) shows job **tasks**, not project starts.
- The MCP server has no schedule/start-date tools.

## Decisions (owner-approved or recommended-and-accepted)

1. **One new canonical status: `"Waiting to Start"`** — inserted before `"In Progress"` in
   `src/lib/project-status.ts`. Projects are *born* here (conversion, direct create, and the
   mobile jobs route all set it explicitly — see change list).
2. **"Scheduled" is derived, not a status**: a Waiting-to-Start project *with* a `startDate`
   is shown as Scheduled on the dashboard. Avoids status↔date drift (a date is what makes it scheduled).
3. **Moving a start date moves the job plan with it** (owner: "whatever you recommend"):
   - Project still **Waiting to Start** (no work logged): shift ALL its `ScheduleTask`s by the
     same delta (default, `shiftJobTasks: true`), so FS dependencies stay consistent.
   - Project already **In Progress**: never auto-shift tasks — only the start marker moves.
   - Payment milestones **linked** to schedule tasks shift with their task — **except groups
     already pushed to QuickBooks: if ANY `PaymentSchedule` clone in a `sourceScheduleId`
     group has `qbInvoiceId` set, the ENTIRE group is skipped** (the source
     `EstimatePaymentSchedule` AND all sibling clones stay unchanged — never a partial shift),
     because the customer-facing QBO invoice carries the old date. Skipped groups are
     reported in `skippedQbMilestones`/`notes[]` for manual/QB-side handling. (R1 fix 4, R2 hardening)
   - Every move writes an `ActivityLog` row — `actorType: "TEAM"` for authenticated UI users,
     `"SYSTEM"` for MCP/connector operations (actorName identifies who, e.g. the user's name
     or "ChatGPT connector"). (R2 fix)
4. **Milestone payments tie to the calendar via explicit link**: nullable
   `scheduleTaskId` FK on `EstimatePaymentSchedule` and `PaymentSchedule` → `ScheduleTask`
   (onDelete: SetNull). The invoice-copy path **propagates the link** (R1 fix 5), and shift
   logic updates **both mirrors**: the linked `EstimatePaymentSchedule` row and every unpaid
   `PaymentSchedule` cloned from it (found via `sourceScheduleId`) or directly linked.
5. **Admin-only money overlays, enforced at the data layer** (R1 fix 2): the page admits
   ADMIN, MANAGER, and FINANCE (the `financialReports` roles), but calendar/cashflow
   financial data is only **queried and serialized** when `user.role === "ADMIN"` —
   managers and finance never receive milestone amounts in the payload (owner requirement).

## Schema changes (`scripts/apply-company-schedule-schema.mjs` + `prisma generate`)

- `Project.startDate DateTime?`, `Project.endDate DateTime?`, `@@index([startDate])` (additive).
- `EstimatePaymentSchedule.scheduleTaskId String?` FK → `ScheduleTask` (onDelete: SetNull) + index.
- `PaymentSchedule.scheduleTaskId String?` FK → `ScheduleTask` (onDelete: SetNull) + index.
- Update `Project.status` comment to include "Waiting to Start" (schema default unchanged;
  creation paths set the status explicitly — smaller blast radius than ALTER DEFAULT).
- **Data backfill in the same script** (R1 fix 7): `UPDATE "Project" SET status='Waiting to Start'
  WHERE status IN ('Paid Ready to Start','Paid, Ready to Start')` so stored legacy rows join
  the canonical pipeline.

## Code changes

### Lifecycle
- `src/lib/project-status.ts`: add `"Waiting to Start"` def (blue) at rank 0;
  `OPEN_PROJECT_STATUSES` gains it; legacy `"Paid Ready to Start"`/`"Paid, Ready to Start"`
  now map to `"Waiting to Start"` (input-side map; stored rows backfilled above).
- `actions.ts convertLeadToProject`: `status: "Waiting to Start"`,
  `startDate: lead.expectedStartDate ?? null`.
- `actions.ts createProject`: post-conversion status override applies whenever a canonical
  status was passed (comment update; behavior unchanged otherwise).
- **`src/app/api/manager/jobs/route.ts`: set `status: "Waiting to Start"` explicitly** on
  mobile project creation (R1 fix 6) — every project birth lands in the pipeline.
- **`src/app/projects/NewProjectModal.tsx`: default its status selector to
  `"Waiting to Start"`** (currently submits "In Progress", L134) (R2 fix) — direct web
  creation enters the pipeline too.
- Kanban (`/projects`) picks the new column up automatically from `PROJECT_STATUSES`
  (default list; a saved custom `CompanySettings.projectStatuses` overrides — noted in rollout).

### New session-free core — `src/lib/schedule-core.ts` (billing-core.ts pattern; NO "use server")
- `getCompanyPipeline()` — open leads (stage, expectedStartDate, latest estimate status/total,
  targetRevenue) + projects bucketed: `waitingToStart` (status WtS, no startDate),
  `scheduled` (WtS + startDate), `inProgress`, `substantialCompletion`.
  Per-project **contractValue** (R1 fix 10, R2 fix) = `totalAmount` of that project's most
  recent estimate with status in (`Approved`, `Invoiced`, `Partially Paid`, `Paid`); null when
  none. One per project, no double counting (change orders excluded in this pass).
- `getStartCalendar(from, to, { includeFinancials })` — projects with startDate in range;
  leads with expectedStartDate in range; **milestone data only when `includeFinancials`
  (page passes it for ADMIN only)** (R1 fix 2): unpaid milestones with dueDate in range,
  incl. `scheduleTaskId` anchor flag and `qbInvoiceId != null` flag.
- `setProjectStartDate({ projectId, startDate, shiftJobTasks = true, actor })` — tx:
  validates project (rejects Closed Complete/Closed Lost), stores marker, derives delta,
  optionally shifts tasks + linked unpaid, **non-QB-pushed** milestone dueDates on BOTH
  mirrors (EstimatePaymentSchedule + cloned PaymentSchedules via sourceScheduleId) (R1 fix 5),
  writes ActivityLog, returns `{ previousStartDate, startDate, shiftedTasks,
  shiftedMilestones, skippedQbMilestones, notes[] }`. `startDate: null` clears the marker
  (back to Waiting; tasks untouched).
- `getCashflowOutlook()` — ADMIN-only (R1 fix 8): milestones with `status = "Pending"`
  only (Paid and Canceled excluded), bucketed by dueDate (UTC calendar day, non-overlapping):
  **overdue** (< today), **0–30**, **31–60**, **61–90** days; Pending milestones with **no
  dueDate** reported as a separate count (excluded from buckets). Buckets are not cumulative.

### Dashboard page — top-level `/company-dashboard` (NOT inside `/company` settings layout)
- `src/app/company-dashboard/page.tsx` (server): `force-dynamic`; authorizes via
  **`hasPermission(user, "financialReports")`** (permissions.ts:40 — always true for
  ADMIN/MANAGER, default-true for FINANCE, and honors explicit per-user overrides), NOT a
  hard-coded role list, so nav and page can never disagree (R3 fix 1); Access Denied otherwise.
  The cashflow strip and per-day milestone amounts remain **`user.role === "ADMIN"` only**
  (owner requirement), and editing is gated separately below (R3 fix 2).
  Reads `?month=YYYY-MM` searchParam (default: current month), computes the 42-day
  `getMonthGrid(anchor)` and passes its **first and last dates as `from`/`to`** to
  `getStartCalendar` so adjacent-month spillover cells are populated (R2 fix); fetches
  pipeline + calendar(+financials iff ADMIN) + cashflow(iff ADMIN) in parallel.
  **Month navigation is URL-driven (server re-fetch), not client-state-only** (R1 fix 3).
- `CompanyDashboardClient.tsx`:
  - 4 funnel cards (Estimating / Waiting to Start / Scheduled / In Progress) with counts;
    Estimating card sums `lead.targetRevenue`; Scheduled/Waiting cards sum `contractValue`.
  - Month-grid start calendar (reusing `schedule-utils.ts` UTC helpers): solid chips =
    project starts → link to project; dashed chips = lead expected starts → link to lead;
    prev/next month navigate via `router.push("?month=…")`.
  - "Waiting to start" table with inline date input, **rendered only when
    `canEdit = user.role === "ADMIN" || user.role === "MANAGER"`** (passed from the server;
    FINANCE gets a strictly read-only dashboard) (R3 fix 2) → thin server action
    `updateProjectStartDateAction` in actions.ts which **rejects any caller that is not
    ADMIN/MANAGER** (same inline role check used by other actions), calls the core, then
    `revalidatePath("/company-dashboard")`; client calls `router.refresh()` after (R1 fix 3).
  - ADMIN-only strip (server-rendered only for ADMIN): cash expected overdue / 0–30 / 31–60 /
    61–90 + per-day milestone $ markers on the calendar.
- Nav: add `{ key: "dashboard", href: "/company-dashboard", label: "Dashboard",
  show: can("financialReports") }` to `NAV_ITEMS` (R1 fix 9 / R2 fix 9 — `financialReports`
  is held by default exactly by ADMIN, MANAGER, and FINANCE (permissions.ts:95), the same
  roles the page admits; `schedules` can be granted to FIELD_CREW). Page still role-guards
  and the money strip stays ADMIN-only.

### MCP tools — `src/app/api/mcp/[transport]/route.ts` (version → 1.7.0, instructions extended)
- `get_company_schedule` (readOnly): pipeline summary + upcoming starts (next N days,
  default 90) + waiting-to-start list. Answers "what jobs are waiting to start?",
  "show project starts for August". Includes NO milestone amounts (MCP secret holder is
  trusted, but the read surface stays lean per connector convention).
- `set_project_start_date` (write): `{ projectId, startDate ISO | null, shiftJobTasks = true }`.
  Refuses closed projects; never shifts tasks on In-Progress projects (marker only); never
  shifts QB-pushed milestones (reported in `skippedQbMilestones`). Returns exactly what moved.
  No preview-token flow (internal, reversible, no customer email).

### Verification
- `scripts/verify-company-schedule.ts` (verify-*.ts pattern): temp client→lead→project,
  2 tasks + linked unpaid milestone (EstimatePaymentSchedule mirror + TWO PaymentSchedule
  clones via the invoice-copy path, one with `qbInvoiceId` set) + one unlinked milestone;
  set start → move +7d → assert: tasks shifted; when no clone is QB-flagged, linked EPS
  **and** PS mirrors all shift (R1 fix 5); **with one clone QB-flagged, the ENTIRE group
  (EPS + both clones) stays unchanged** and is reported in skippedQbMilestones (R2 fix);
  unlinked untouched; In-Progress project shifts nothing; ActivityLog actorType is TEAM for
  UI calls and SYSTEM for MCP calls; cleanup.
- `npm run typecheck` must pass 0 errors (standing rule).
- Dev-server smoke (R1 fix 11 / R2 fix 9 / R3 — final matrix): `/company-dashboard` as
  **ADMIN → renders with financial strip + editor**; as **MANAGER → renders, no financial
  strip, editor visible**; as **FINANCE → renders read-only (no strip, no editor)**; as
  **FIELD_CREW → Access Denied**; plus an explicit-override case: FINANCE with
  `financialReports: false` → Access Denied.

## Money-path note

This feature WRITES `PaymentSchedule.dueDate` / `EstimatePaymentSchedule.dueDate` (dates only —
never amounts, status, or QB fields) and deliberately SKIPS QB-pushed milestones → TRIP-2 codex
review required before merge; `e2e/money-pipeline.spec.ts` should remain unaffected (it asserts
amounts/status, not due dates) — flag if it touches dueDate.

## Explicitly out of scope (Phase 2, documented for later)

- Crew assignment visualization on the company calendar (primitives exist: `Project.crew`,
  `TaskAssignment`); conflict detection ("Mike is on 2 jobs Mar 3–7").
- Expense/hours per-day overlays beyond the cashflow strip; full cashflow forecast.
- Estimate → schedule-task auto-generation (`ScheduleTask.estimateItemId` hook already exists).
- Auto-draft invoice when a schedule milestone task hits 100% (VISION.md:185).
- UI for linking existing milestones to tasks (schema link ships now; wiring later).
- QBO-side due-date updates for already-pushed milestones (needs its own money-path design).

## Rollout / risk

- Schema is additive + nullable: old deploy keeps working; run apply script (includes the
  legacy-status backfill), then `prisma generate`, then deploy.
- Behavior change: **new projects are born "Waiting to Start"** (conversion, direct create,
  mobile route) — they appear in the new pipeline column and remain under
  OPEN_PROJECT_STATUSES everywhere (variance, SMS routing, AI summaries keep working).
- If `CompanySettings.projectStatuses` was customized, re-add "Waiting to Start" via the
  kanban customize modal (default list already includes it).

## R1 changelog (Codex review round 1 → this revision)

1. Added Codebase-context section (no docs/ARCHI.md exists in this repo — not a defect).
2. Financial data now fetched/serialized for ADMIN only (not merely hidden at render).
3. Month nav via `?month=` searchParam + server re-fetch; mutations revalidatePath + router.refresh().
4. QB-pushed milestones (`qbInvoiceId`) are never date-shifted; reported in skippedQbMilestones.
5. Invoice-copy path propagates `scheduleTaskId`; shift updates both milestone mirrors; test covers both.
6. Mobile jobs route (`api/manager/jobs/route.ts`) sets "Waiting to Start" explicitly.
7. Migration script backfills stored "Paid Ready to Start"/"Paid, Ready to Start" rows.
8. Cashflow semantics pinned: status="Pending" only; overdue/0–30/31–60/61–90 non-overlapping UTC buckets; no-dueDate counted separately.
9. Nav gate moved from `schedules` to `financialReports` (matches page's admin-grade audience).
10. "Contract sums" defined: latest estimate per project, statuses Approved/Invoiced/Partially Paid.
11. Smoke-test matrix corrected: ADMIN ok, MANAGER ok (no financials), FIELD_CREW denied.

## R2 changelog (Codex review round 2 → this revision)

1. Finding 9 resolved by admitting FINANCE to the page (nav `financialReports` and page roles
   now match exactly); money strip stays ADMIN-only per owner.
2. `NewProjectModal.tsx` added to the change list (status selector defaults to "Waiting to Start").
3. QB skip now operates on the complete `sourceScheduleId` mirror group (EPS + all sibling
   clones) — never a partial shift; verification asserts every mirror unchanged.
4. `contractValue` qualifying estimate statuses now include `Paid`.
5. ActivityLog: actorType TEAM (UI) vs SYSTEM (MCP).
6. `getStartCalendar(from, to)` bounds explicitly derived from the 42-day `getMonthGrid()`
   first/last dates.

## R3 changelog (Codex review round 3 → this revision)

1. Page authorization switched from hard-coded roles to hasPermission(user, "financialReports") so explicit per-user overrides cannot desync nav and page.
2. FINANCE is explicitly read-only: date editor renders only for ADMIN/MANAGER (canEdit flag), and updateProjectStartDateAction rejects non-ADMIN/MANAGER callers server-side. Smoke matrix extended with an explicit-override denial case.
