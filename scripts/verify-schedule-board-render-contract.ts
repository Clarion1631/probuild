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
const availabilityPanelSource = src("../src/app/company-dashboard/schedule-board/AvailabilityPanel.tsx");
const traySource = src("../src/app/company-dashboard/schedule-board/UnscheduledTray.tsx");
const dialogSource = src("../src/app/company-dashboard/schedule-board/ShiftConfirmDialog.tsx");
const layoutSource = src("../src/app/company-dashboard/schedule-board/useBarLayout.ts");
const popoverSource = src("../src/app/company-dashboard/schedule-board/FloatingPopover.tsx");
const actionsSource = src("../src/lib/actions.ts");
const coreSource = src("../src/lib/schedule-core.ts");
const companyDashboardSource = src("../src/app/company-dashboard/CompanyDashboardClient.tsx");
// CrewPicker/TaskCrewPicker moved out of CompanyDashboardClient.tsx into their
// own module (item 1) so ProjectBar/TaskBlockSegment can reuse them from the
// new context menus without a circular import back into
// CompanyDashboardClient (which imports ScheduleBoard -> …View -> ProjectBar).
const crewPickersSource = src("../src/app/company-dashboard/schedule-board/CrewPickers.tsx");

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
assert.match(saveAllDraftsBody, /const chunk = changes\.slice\(offset, offset \+ 200\);\s*\n\s*try \{\s*\n\s*const batchResult = await saveCompanyScheduleTaskDatesAction\(chunk\)/, "Save batches task changes through the one canonical action, chunked to the server cap with per-chunk isolation");
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
// anchorRef is now optional (item 1 — an anchorPoint-only context menu has
// no trigger element to refocus), hence the extra `?.` before `.current`.
assert.match(popoverSource, /anchorRef\?\.current\?\.focus\(\)/);
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
assert.match(boardSource, /function clearTaskPreview\(taskId: string\) \{\r?\n[^}]*if \(awaitingTaskRefreshIds\.has\(taskId\)\) return;/, "cancelling a speculative edit must never delete a saved-awaiting override");
assert.match(boardSource, /rewriteAwaitingOverridesFromShift\(shiftedPersistedDates\)/, "board-owned shifts must rewrite saved-awaiting overrides to the persisted dates");
assert.match(boardSource, /rewriteAwaitingOverridesFromShift\(unseen\.flatMap\(event => event\.taskDates\)\)/, "external (legacy StartDateRow) shifts must ALSO rewrite saved-awaiting overrides — ALL unseen events, not just the latest");
assert.match(boardSource, /externalShiftEvents\.filter\(event => event\.nonce > lastExternalShiftNonceRef\.current\)/, "every unseen external-shift nonce is applied exactly once");
assert.match(companyDashboardSource, /setExternalShiftEvents\(current => \[\.\.\.current, event\]\)/, "the legacy path publishes shifts via an UNCAPPED functional append — any truncation can silently drop an unseen event");
assert.doesNotMatch(companyDashboardSource, /setExternalShiftEvents\([^)]*slice\(/, "the external-shift queue must never be truncated");
assert.match(companyDashboardSource, /externalShiftEvents=\{externalShiftEvents\}/, "the board must receive the external-shift event queue");
assert.match(boardSource, /catch \(chunkError: any\) \{/, "chunk failures are isolated per chunk");
assert.match(boardSource, /chunk\.map\(change => \(\{ taskId: change\.taskId, ok: false as const, error: message \}\)\)/, "a rejected chunk synthesizes failures for its own tasks only");
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

// ── Readability pass (2026-07-22, owner addendum item 5): bigger task
// blocks + Timeline zoom — geometry constants bumped, every row-height
// consumer updated to match, never re-pinned to the old (unreadable) sizes ──
assert.match(projectBarSource, /const TASK_STRIP_SINGLE_LANE_HEIGHT = 22/, "single-lane task strip must be 22px, not the old unreadable 18px");
assert.match(projectBarSource, /const TASK_LANE_HEIGHT = 18/, "multi-lane task rows must be 18px per lane, not the old unreadable 14px");
assert.match(taskBlockSource, /text-\[11px\]/, "task block labels must render at 11px, not the old unreadable 9px");
assert.match(taskBlockSource, /const MIN_LABEL_WIDTH_PX = 28/, "a task label only renders once there is room for it; below that, icon/tooltip only");
assert.match(taskBlockSource, /allocatedWidth >= MIN_LABEL_WIDTH_PX/, "the label-visibility gate must use the named threshold, not a re-inlined magic number");
assert.match(monthSource, /grid-rows-\[repeat\(4,80px\)\]/, "Month lane rows must be tall enough for a 3-lane bar at the new geometry (18 + 3*18 = 72px)");
assert.match(monthSource, /h-\[320px\]/, "Month lane-area container must scale with the bumped row height (4 * 80px)");
assert.match(timelineSource, /const TASK_LANE_HEIGHT = 20/, "Timeline crew-row task lanes must scale with the bumped label font");
assert.match(timelineSource, /text-\[11px\] font-semibold leading-\[18px\] text-white/, "Timeline crew-row task chips must render at 11px");
assert.match(availabilityPanelSource, /text-\[11px\]/, "AvailabilityPanel chips must render at 11px like every other task chip on the board");

// ── Item 4 (same addendum): Timeline horizontal range extension + zoom ──
assert.match(timelineSource, /ZOOM_DAY_WIDTHS/, "a three-state zoom (Compact/Normal/Wide) day-width table must exist");
assert.match(timelineSource, /TIMELINE_DAYS_BEFORE_ANCHOR = 28/, "canvas must extend 28 days before the anchor month's grid start");
assert.match(timelineSource, /TIMELINE_DAYS_AFTER_ANCHOR = 112/, "canvas must extend 112 days after the anchor month's grid start (~20 weeks total)");
assert.match(timelineSource, /gtr-company-schedule-board-timeline-zoom/, "zoom must persist in its own localStorage key alongside the view keys");
assert.doesNotMatch(timelineSource, /getTimelinePointerDelta\([^)]*,\s*20\)/, "drag math must read the current zoom day width, never hardcode 20");

// ── Item 1 (2026-07-22 owner addendum): right-click context menus ──
// contextmenu handlers exist on both views (empty day cells) and on the two
// bar/block components — each canEdit-gated (read-only roles get the
// browser's default menu instead of preventDefault).
assert.match(monthSource, /onContextMenu=\{event => handleDayContextMenu\(dayKey, event\)\}/, "Month day cells must wire a contextmenu handler");
assert.match(monthSource, /function handleDayContextMenu\(dayKey: string, event: ReactMouseEvent<HTMLDivElement>\) \{\s*\n\s*if \(!data\.canEdit\) return;/, "Month's day context menu must be canEdit-gated, letting the browser default through otherwise");
assert.match(timelineSource, /onContextMenu=\{event => handleDayContextMenu\(dayKey, event\)\}/, "Timeline day columns must wire a contextmenu handler");
assert.match(timelineSource, /function handleDayContextMenu\(dayKey: string, event: ReactMouseEvent<HTMLDivElement>\) \{\s*\n\s*if \(!data\.canEdit\) return;/, "Timeline's day context menu must be canEdit-gated, letting the browser default through otherwise");
assert.match(projectBarSource, /onContextMenu=\{handleContextMenu\}/, "ProjectBar must wire a contextmenu handler");
assert.match(projectBarSource, /function handleContextMenu\(event: ReactMouseEvent<HTMLDivElement>\) \{\s*\n\s*if \(!canEdit \|\| isPending\) return;/, "ProjectBar's context menu must be canEdit-gated");
assert.match(taskBlockSource, /onContextMenu=\{handleContextMenu\}/, "TaskBlockSegment must wire a contextmenu handler");
assert.match(taskBlockSource, /function handleContextMenu\(event: ReactMouseEvent<HTMLDivElement>\) \{\s*\n\s*if \(!canEdit \|\| isPending\) return;/, "TaskBlockSegment's context menu must be canEdit-gated");
// Keyboard equivalent (ContextMenu key / Shift+F10) on both bar/block.
assert.match(projectBarSource, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/, "ProjectBar must open its menu on the ContextMenu key / Shift+F10");
assert.match(taskBlockSource, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/, "TaskBlockSegment must open its menu on the ContextMenu key / Shift+F10");
// Only one schedule-board menu open at a time, including click vs context
// menu — the shared exclusive-menu coordinator, registered by every menu.
for (const source of [projectBarSource, taskBlockSource, monthSource, timelineSource]) {
    assert.match(source, /activateExclusiveMenu\(close\)/, "every schedule-board menu must register with the exclusive-menu coordinator on open");
    assert.match(source, /deactivateExclusiveMenu\(close\)/, "every schedule-board menu must deregister with the exclusive-menu coordinator on close");
}
// Empty day cell "Schedule here…" routes through the SAME function the tray
// drop handler calls (onTrayProjectDrop) — never a second scheduling path.
assert.match(monthSource, /onTrayProjectDrop\(project, dayContextMenu\.date\)/, "Month's Schedule-here must route through the existing tray-drop function");
assert.match(timelineSource, /onTrayProjectDrop\(project, dayContextMenu\.date\)/, "Timeline's Schedule-here must route through the existing tray-drop function");
assert.match(monthSource, /No unscheduled projects/, "Month's Schedule-here must show a disabled line when there is nothing to schedule");
assert.match(timelineSource, /No unscheduled projects/, "Timeline's Schedule-here must show a disabled line when there is nothing to schedule");
// Task block: Delete task is an immediate action (not draft-mode) through
// the existing deleteScheduleTask, with explicit non-draft copy in the confirm.
assert.match(taskBlockSource, /import \{ deleteScheduleTask \} from "@\/lib\/actions"/);
assert.match(taskBlockSource, /await deleteScheduleTask\(task\.id\)/);
assert.match(taskBlockSource, /Deletes now — not part of unsaved changes/, "Delete task's confirm copy must explicitly say it is immediate, not draft-mode");
// Project bar: Remove from schedule only for Waiting to Start, through the
// existing updateProjectStartDateAction(projectId, null, false) path.
assert.match(projectBarSource, /project\.status === "Waiting to Start" &&[\s\S]{0,700}Remove from schedule/, "Remove from schedule must only render for Waiting-to-Start projects");
assert.match(projectBarSource, /await updateProjectStartDateAction\(project\.id, null, false\)/, "Remove from schedule must use the existing updateProjectStartDateAction(projectId, null, false) path");
// Color… reuses the ORIGINAL schedule palette (PRESET_COLORS), not a
// re-invented swatch list.
assert.match(projectBarSource, /import \{ addDays, formatDate, parseUTCDate, PRESET_COLORS \} from "@\/app\/projects\/\[id\]\/schedule\/schedule-utils"/);
assert.match(projectBarSource, /PRESET_COLORS\.map\(swatch =>/, "the Color… grid must be built from PRESET_COLORS");
// Project crew…/Task crew… reuse the SAME pickers as the Schedule & crew
// table (via the extracted CrewPickers module), never a rebuilt picker.
assert.match(projectBarSource, /import \{ CrewPicker \} from "\.\/CrewPickers"/);
assert.match(projectBarSource, /<CrewPicker projectId=\{project\.id\} crew=\{project\.crew\} teamMembers=\{teamMembers\} \/>/);
assert.match(taskBlockSource, /import \{ TaskCrewPicker \} from "\.\/CrewPickers"/);
assert.match(taskBlockSource, /<TaskCrewPicker task=\{task\} teamMembers=\{teamMembers\} \/>/);

// ── Item 6: a bar click toggles its menu, never navigates ──
assert.match(projectBarSource, /function handleBarClick\(/);
// Item 1 (2026-07-22) replaced the bare `setMenuOpen(value => !value)` toggle
// with explicit open/close (via `openMenu`, which also resets the menu's
// view/anchor state) — still a toggle in effect, just no longer a one-liner.
assert.match(projectBarSource, /if \(menuOpen\) \{\s*setMenuOpen\(false\);\s*\} else \{\s*openMenu\(null\);\s*\}/, "a bar click must still toggle the menu open/closed");
assert.doesNotMatch(projectBarSource, /onClick=\{.*router\.push|onClick=\{.*navigate/, "the bar itself must never navigate on click");
assert.match(projectBarSource, />\s*Open project\s*<\/Link>/, "Open project must be a menu item inside the Actions dropdown");

// ── Item 7: crew picker hygiene (FINANCE exclusion + name disambiguation) ──
assert.match(coreSource, /where: \{ status: "ACTIVATED", role: \{ not: "FINANCE" \} \}/);
assert.match(coreSource, /nameCounts\.get\(r\.name\)! > 1 \? \{ \.\.\.r, name: `\$\{r\.name\} \(\$\{r\.email\}\)` \} : r/);
assert.match(crewPickersSource, /c\.role === "FINANCE" \? "finance" : "inactive"/, "CrewPicker (now in CrewPickers.tsx) must still label removable FINANCE crew entries");
assert.match(crewPickersSource, /a\.role === "FINANCE" \? "finance" : "inactive"/, "TaskCrewPicker (now in CrewPickers.tsx) must still label removable FINANCE task-crew entries");
assert.match(companyDashboardSource, /a\.role === "FINANCE" \? " \(finance\)"/, "the Schedule & crew task-row display keeps its own FINANCE label");
assert.match(companyDashboardSource, /import \{ CrewPicker, TaskCrewPicker \} from "\.\/schedule-board\/CrewPickers"/, "the Schedule & crew table must reuse the extracted pickers, not redefine them");

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
for (const source of [boardSource, monthSource, timelineSource, projectBarSource, taskBlockSource, popoverSource, availabilityPanelSource, crewPickersSource]) {
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

// ── Crew-availability panel: canEdit gate, canSeeFinancials money gate,
// serialized-data-only sourcing, and the ProjectBar distance line ──
assert.match(boardSource, /import \{ AvailabilityPanel \} from "\.\/AvailabilityPanel"/, "the board must import the availability panel");
assert.match(boardSource, /\{data\.canEdit && <AvailabilityPanel/, "the availability panel must be gated on canEdit (ADMIN\\/MANAGER only)");
const plannedRowGuardIndex = availabilityPanelSource.indexOf("{canSeeFinancials && (");
const plannedLabelIndex = availabilityPanelSource.indexOf("Planned $/day");
assert.ok(plannedRowGuardIndex >= 0 && plannedLabelIndex > plannedRowGuardIndex, "the planned-$/day footer row must be gated behind canSeeFinancials");
assert.doesNotMatch(availabilityPanelSource, /\bprisma\b|getCashflowOutlook|getChangeOrderOverlayRows|getCalendarOverlays|getCompanyDashboardData/, "the availability panel must derive from serialized CompanyDashboardData only, never a direct query or money-fetch function");
assert.match(availabilityPanelSource, /distanceMilesFromShop/, "far-job awareness must read the serialized distanceMilesFromShop field");
assert.match(projectBarSource, /project\.distanceMilesFromShop != null/);
assert.match(projectBarSource, /mi from shop/, "the Actions popover must surface the shop distance line");
// The crew-mode toggle is now owned by ScheduleBoard so the panel's
// drill-down can force it on even when Timeline is already mounted.
assert.match(timelineSource, /export const CREW_MODE_STORAGE_KEY/);
assert.match(boardSource, /import \{ TimelineView, CREW_MODE_STORAGE_KEY \} from "\.\/TimelineView"/);
assert.match(boardSource, /function drillDownToCrewTimeline\(/);
assert.match(boardSource, /onDrillDown=\{drillDownToCrewTimeline\}/);

console.log("schedule-board render contract verification: PASS");
