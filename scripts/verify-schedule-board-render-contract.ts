import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Owner-feedback round (2026-07-22) rewrote the company schedule board from
// per-drag auto-save + project locking to local draft-mode + one explicit
// Save. This contract asserts the NEW architecture's real invariants —
// spec items 1-8 — rather than mirroring implementation lines 1:1.

function src(path: string): string {
    return readFileSync(new URL(path, import.meta.url), "utf8");
}

const boardSource = src("../src/app/company-dashboard/schedule-board/ScheduleBoard.tsx");
const monthSource = src("../src/app/company-dashboard/schedule-board/MonthBarsView.tsx");
const timelineSource = src("../src/app/company-dashboard/schedule-board/TimelineView.tsx");
const projectBarSource = src("../src/app/company-dashboard/schedule-board/ProjectBar.tsx");
const taskBlockSource = src("../src/app/company-dashboard/schedule-board/TaskBlockSegment.tsx");
const traySource = src("../src/app/company-dashboard/schedule-board/UnscheduledTray.tsx");
const dialogSource = src("../src/app/company-dashboard/schedule-board/ShiftConfirmDialog.tsx");
const layoutSource = src("../src/app/company-dashboard/schedule-board/useBarLayout.ts");
const popoverSource = src("../src/app/company-dashboard/schedule-board/FloatingPopover.tsx");
const actionsSource = src("../src/lib/actions.ts");
const coreSource = src("../src/lib/schedule-core.ts");
const companyDashboardSource = src("../src/app/company-dashboard/CompanyDashboardClient.tsx");

// ── Item 2: draft mode replaces per-drag auto-save ──

// Drafting never calls a server action — draftTaskChange/draftProjectMove
// are pure local-state writers.
const draftTaskChangeStart = boardSource.indexOf("function draftTaskChange(");
const draftTaskChangeEnd = boardSource.indexOf("function draftProjectMove(", draftTaskChangeStart);
const draftTaskChangeBody = boardSource.slice(draftTaskChangeStart, draftTaskChangeEnd);
assert.ok(draftTaskChangeStart >= 0, "draftTaskChange must exist");
assert.doesNotMatch(draftTaskChangeBody, /await |updateCompanyScheduleTaskDatesAction|saveCompanyScheduleTaskDatesAction/, "drafting a task change must never touch the server");
assert.match(draftTaskChangeBody, /setTaskPreview\(taskId, normalizedDates\)/);

const draftProjectMoveStart = boardSource.indexOf("function draftProjectMove(");
const draftProjectMoveEnd = boardSource.indexOf("function discardAllDrafts(", draftProjectMoveStart);
const draftProjectMoveBody = boardSource.slice(draftProjectMoveStart, draftProjectMoveEnd);
assert.ok(draftProjectMoveStart >= 0, "draftProjectMove must exist");
assert.doesNotMatch(draftProjectMoveBody, /await |updateProjectStartDateAction|shiftNotStartedTasksAction/, "drafting a project move must never touch the server");
assert.match(draftProjectMoveBody, /setProjectDrafts\(current => /);

// Every pointer/keyboard "finish" path routes into the draft writers, not a
// commit-to-server function.
assert.match(boardSource, /draftTaskChange\(task\.id, candidate\)/, "task pointer-drag finish must draft, not commit to the server");
assert.match(boardSource, /if \(dates\) draftTaskChange\(task\.id, dates\)/, "task keyboard commit must draft, not commit to the server");
assert.match(boardSource, /draftProjectMove\(drag\.project, candidate\)/, "project pointer-drag finish must draft, not commit to the server");
assert.match(boardSource, /draftProjectMove\(project, current\.targetStart\)/, "project keyboard commit must draft, not commit to the server");
assert.doesNotMatch(boardSource, /updateCompanyScheduleTaskDatesAction/, "the board no longer calls the single-task write action directly");

// The batch save is the ONLY place these three server actions are called,
// and it fires exactly once per Save click.
assert.match(boardSource, /import \{ saveCompanyScheduleTaskDatesAction, shiftNotStartedTasksAction, updateProjectStartDateAction \} from "@\/lib\/actions"/);
const saveAllDraftsStart = boardSource.indexOf("async function saveAllDrafts()");
const saveAllDraftsEnd = boardSource.indexOf("function cancelProjectEditsForProjects", saveAllDraftsStart);
const saveAllDraftsBody = boardSource.slice(saveAllDraftsStart, saveAllDraftsEnd);
assert.ok(saveAllDraftsStart >= 0, "saveAllDrafts must exist");
assert.match(saveAllDraftsBody, /saveCompanyScheduleTaskDatesAction\(changes\.slice\(offset, offset \+ 200\)\)/, "Save batches task changes through the one canonical action, chunked to the server cap");
assert.match(saveAllDraftsBody, /updateProjectStartDateAction\(/);
assert.match(saveAllDraftsBody, /shiftNotStartedTasksAction\(/);
assert.equal((saveAllDraftsBody.match(/router\.refresh\(\)/g) ?? []).length, 1, "exactly one router.refresh() after the whole batch settles");

// In-Progress confirm now runs INSIDE the save loop (per drafted project),
// not at drag-commit time.
assert.match(saveAllDraftsBody, /canonicalProject\.status === "In Progress"/);
assert.match(saveAllDraftsBody, /waitForConfirmChoice\(\)/);
assert.doesNotMatch(draftProjectMoveBody, /confirmIntent|ShiftConfirmDialog/, "dragging an In Progress project must not surface the confirm dialog");
assert.match(boardSource, /function waitForConfirmChoice\(\): Promise<ProjectMoveChoice \| "cancel">/);

// Failures are isolated and reported per item; succeeded drafts clear,
// failed ones remain pending for retry.
assert.match(saveAllDraftsBody, /catch \(error\) \{\s*failedProjectNames\.push/);
assert.match(boardSource, /failedTaskNames = allResults/, "per-task failures are collected across all chunks");
assert.match(boardSource, /toast\.error\(/);
assert.match(boardSource, /toast\.success\(`Saved \$\{totalSucceeded\}/);

// No project/task locking while merely drafting — only isSaving (or an
// externally-locked project) blocks an edit.
const isProjectLockedStart = boardSource.indexOf("const isProjectLocked = useCallback");
const isProjectLockedEnd = boardSource.indexOf("const isTaskLocked = useCallback", isProjectLockedStart);
const isProjectLockedBody = boardSource.slice(isProjectLockedStart, isProjectLockedEnd);
assert.match(isProjectLockedBody, /isSaving \|\| isProjectExternallyPending\(projectId\)/);
assert.doesNotMatch(isProjectLockedBody, /projectDrafts|taskDateOverrides/, "a drafted item must never be locked purely for being drafted");

// Sticky action bar: draft count + Save + Discard.
assert.match(boardSource, /\{draftCount > 0 && \(/);
assert.match(boardSource, /\{draftCount\} unsaved change\{draftCount === 1 \? "" : "s"\}/);
assert.match(boardSource, /onClick=\{discardAllDrafts\}/);
assert.match(boardSource, /onClick=\{\(\) => void saveAllDrafts\(\)\}/);
assert.match(boardSource, /\{isSaving \? "Saving\.\.\." : "Save"\}/);

// Drafted visuals: dashed/desaturated, but never disabled via isPending.
assert.match(projectBarSource, /isDraft\?: boolean/);
assert.match(projectBarSource, /isDraft \? "border-dashed border-2 border-white\/90 saturate-\[\.55\] brightness-95"/);
assert.doesNotMatch(projectBarSource, /canMoveProject && !isPending && !isDraft/, "a drafted project bar must stay as interactive as a saved one");
assert.match(taskBlockSource, /isDraft\?: boolean/);
assert.match(taskBlockSource, /isDraft \? "border-dashed border-2 border-white\/90 saturate-\[\.55\] brightness-95"/);

// ── Item 1: crew ACTIVATED validation is added-only ──
const setProjectCrewStart = coreSource.indexOf("export async function setProjectCrew");
const setProjectCrewEnd = coreSource.indexOf("export interface CrewConflictPair", setProjectCrewStart);
const setProjectCrewBody = coreSource.slice(setProjectCrewStart, setProjectCrewEnd);
assert.match(setProjectCrewBody, /toConnect\.map\(id => byId\.get\(id\)!\)\.filter\(u => u\.status !== "ACTIVATED"\)/);
assert.ok(setProjectCrewBody.indexOf("toConnect = wanted.filter") < setProjectCrewBody.indexOf("notActivated ="), "toConnect must be computed before the ACTIVATED check runs against it");
const setTaskCrewBody = coreSource.slice(coreSource.indexOf("export async function setTaskCrew"));
assert.match(setTaskCrewBody, /toAdd\.map\(id => byId\.get\(id\)!\)\.filter\(u => u\.status !== "ACTIVATED"\)/);

// ── Item 3: floating popovers escape clipping via a portal ──
assert.match(popoverSource, /createPortal\(/);
assert.match(popoverSource, /document\.body/);
assert.match(popoverSource, /event\.key !== "Escape"/);
assert.match(popoverSource, /anchorRef\.current\?\.focus\(\)/);
// Vertical placement must handle the neither-side-fits case (open on the
// larger side, capped + scrollable) and the horizontal floor must be applied
// last so narrow viewports pin to the margin instead of going negative.
assert.match(popoverSource, /const openAbove = !fitsBelow && \(fitsAbove \|\| spaceAbove > spaceBelow\)/, "vertical placement must compare which side has more room");
assert.match(popoverSource, /maxHeight: effectiveHeight/);
assert.match(popoverSource, /overflowY: "auto"/, "capped popover must scroll internally");
assert.match(popoverSource, /Math\.max\(openAbove \? spaceAbove : spaceBelow, 0\)/, "no artificial floor larger than the side's real room");
assert.match(popoverSource, /viewportHeight - 2 \* VIEWPORT_MARGIN_PX/, "degenerate viewports detach from the anchor and use the full viewport");
assert.match(popoverSource, /Math\.max\(Math\.min\(left, viewportWidth - panelWidth - VIEWPORT_MARGIN_PX\), VIEWPORT_MARGIN_PX\)/);

// Draft/save state-machine contracts from the codex round-2 blockers:
assert.match(boardSource, /!awaitingTaskRefreshIds\.has\(taskId\)\s*&&\s*normalizedDates\.startDate === originalDates\.startDate/, "back-to-canonical shortcut must not apply to saved-awaiting tasks");
assert.match(boardSource, /Object\.entries\(current\)\.filter\(\(\[taskId\]\) => awaitingTaskRefreshIds\.has\(taskId\)\)/, "Discard must preserve saved-awaiting overrides");
assert.match(boardSource, /-previousDelta/, "cancelling a project draft must undo its task-draft rebase");
assert.match(boardSource, /failedProjectIds\.has\(projectId\)/, "task drafts of failed project shifts must be retained, not batched");
assert.match(boardSource, /changes\.slice\(offset, offset \+ 200\)/, "client saves chunk to the server's 200 cap");
assert.match(boardSource, /const markerResult = await updateProjectStartDateAction\(projectId, draft\.targetStart, false\);\s*\n\s*const shiftResult = await shiftNotStartedTasksAction\(projectId, draft\.deltaDays\)/, "In Progress shift choice moves the marker AND the not-started work");
assert.match(popoverSource, /VIEWPORT_MARGIN_PX/);
assert.match(projectBarSource, /import \{ FloatingPopover \} from "\.\/FloatingPopover"/);
assert.match(taskBlockSource, /import \{ FloatingPopover \} from "\.\/FloatingPopover"/);
assert.doesNotMatch(projectBarSource, /<details/, "the project bar's Actions menu must no longer be a clipped native <details>");
assert.doesNotMatch(taskBlockSource, /<details/, "the task block's date menu must no longer be a clipped native <details>");

// ── Item 4: no Estimating leads anywhere on the board ──
assert.doesNotMatch(traySource, /estimating/i, "the tray must not reference Estimating leads at all");
assert.doesNotMatch(boardSource, /estimating=\{data\.pipeline\.estimating\}/, "the board must not pass estimating leads into the tray");
for (const source of [monthSource, timelineSource]) {
    assert.doesNotMatch(source, /pipeline\.estimating/, "month/timeline project sourcing must never include Estimating leads");
}

// ── Item 5: overlapping task blocks stack into capped mini-lanes ──
assert.match(layoutSource, /export const MAX_TASK_LANES = 3/);
assert.match(layoutSource, /export function assignTaskLanes/);
assert.match(projectBarSource, /assignTaskLanes\(taskLaneInput\)/);
assert.match(projectBarSource, /hiddenTasks\.length > 0/, "a +N overflow affordance must exist for tasks beyond the lane cap");
assert.match(taskBlockSource, /laneTop\?: number/);
assert.match(taskBlockSource, /laneHeight\?: number/);

// ── Item 6: a bar click toggles its menu, never navigates ──
assert.match(projectBarSource, /function handleBarClick\(/);
assert.match(projectBarSource, /setMenuOpen\(value => !value\)/);
assert.doesNotMatch(projectBarSource, /onClick=\{.*router\.push|onClick=\{.*navigate/, "the bar itself must never navigate on click");
assert.match(projectBarSource, />\s*Open project\s*<\/Link>/, "Open project must be a menu item inside the Actions dropdown");

// ── Item 7: crew picker hygiene (FINANCE exclusion + name disambiguation) ──
assert.match(coreSource, /where: \{ status: "ACTIVATED", role: \{ not: "FINANCE" \} \}/);
assert.match(coreSource, /nameCounts\.get\(r\.name\)! > 1 \? \{ \.\.\.r, name: `\$\{r\.name\} \(\$\{r\.email\}\)` \} : r/);
assert.match(companyDashboardSource, /c\.role === "FINANCE" \? "finance" : "inactive"/);
assert.match(companyDashboardSource, /a\.role === "FINANCE" \? " \(finance\)"/);

// ── Item 8: crew-grouped Timeline toggle ──
// By-project rows must size from the shared lane geometry — a fixed h-16 row
// overflows when a 3-lane (60px) bar renders inside it.
assert.match(timelineSource, /const rowHeight = Math\.max\(64, 12 \+ computeTaskLaneLayout\(project\.tasks\)\.barHeight \+ 8\)/, "Timeline by-project row height must derive from computeTaskLaneLayout");
assert.doesNotMatch(timelineSource, /data-timeline-schedule-grid="true" className="relative h-16/, "Timeline schedule grid must not use a fixed h-16 row");
assert.match(projectBarSource, /export function computeTaskLaneLayout/, "bar lane geometry must be the shared exported helper");
assert.match(timelineSource, /gtr-company-schedule-board-crew-mode/);
assert.match(timelineSource, /function buildCrewTimelineRows/);
assert.match(timelineSource, /member\.status !== "ACTIVATED"/);
assert.match(timelineSource, /assignedProjectIdsByUser\.get\(member\.id\)\?\.has\(project\.id\)/, "unassigned-but-on-crew coverage must use the same project-window fallback source data");
assert.match(timelineSource, /toggleGroupByCrew/);
assert.match(timelineSource, />\s*By crew\s*</);

// ── Cross-cutting: the ShiftConfirmDialog contract is unchanged in shape ──
assert.match(dialogSource, /Move start marker only/);
assert.match(dialogSource, /Move the start marker AND shift all Not Started tasks by/);
assert.match(boardSource, /<ShiftConfirmDialog[\s\S]*?intent=\{confirmIntent\}[\s\S]*?onChoice=\{handleMoveChoice\}[\s\S]*?onCancel=\{cancelConfirmedMove\}/);

// ── Money-path invariants: unchanged by this feature round ──
for (const source of [boardSource, monthSource, timelineSource, projectBarSource, taskBlockSource, popoverSource]) {
    assert.doesNotMatch(source, /PaymentSchedule\.(update|create|delete)|EstimatePaymentSchedule\.(update|create|delete)|ChangeOrderPaymentSchedule\.(update|create|delete)/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
}
assert.match(monthSource, /const adminOverlays = data\.isAdmin \? data\.overlays : null/);
assert.match(timelineSource, /const adminOverlays = data\.isAdmin \? data\.overlays : null/);
assert.match(monthSource, /canEdit=\{data\.canEdit\}/);
assert.match(timelineSource, /canEdit=\{data\.canEdit\}/);
assert.match(projectBarSource, /canEdit=\{canEdit\}/);

// ── Board-view persistence untouched ──
assert.match(boardSource, /const BOARD_VIEW_STORAGE_KEY = "gtr-company-schedule-board-view"/);
assert.match(boardSource, /localStorage\.getItem\(BOARD_VIEW_STORAGE_KEY\)/);
assert.match(boardSource, /localStorage\.setItem\(BOARD_VIEW_STORAGE_KEY, nextView\)/);

console.log("schedule-board render contract verification: PASS");
