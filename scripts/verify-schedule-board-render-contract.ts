import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// Owner-feedback round (2026-07-22) rewrote the company schedule board from
// per-drag auto-save + project locking to local draft-mode + one explicit
// Save. This contract asserts the NEW architecture's real invariants —
// spec items 1-8 — rather than mirroring implementation lines 1:1.

function src(path: string): string {
    const url = new URL(path, import.meta.url);
    return existsSync(url) ? readFileSync(url, "utf8") : "";
}

const boardSource = src("../src/app/company-dashboard/schedule-board/ScheduleBoard.tsx");
const monthSource = src("../src/app/company-dashboard/schedule-board/MonthBarsView.tsx");
const timelineSource = src("../src/app/company-dashboard/schedule-board/TimelineView.tsx");
const projectBarSource = src("../src/app/company-dashboard/schedule-board/ProjectBar.tsx");
const taskBlockSource = src("../src/app/company-dashboard/schedule-board/TaskBlockSegment.tsx");
const availabilityPanelSource = src("../src/app/company-dashboard/schedule-board/AvailabilityPanel.tsx");
const availabilityHelpersSource = src("../src/app/company-dashboard/schedule-board/availability.ts");
const dispatchViewSource = src("../src/app/company-dashboard/schedule-board/DispatchView.tsx");
const dispatchReviewDialogSource = src("../src/app/company-dashboard/schedule-board/DispatchReviewDialog.tsx");
const dispatchJobCardSource = src("../src/app/company-dashboard/schedule-board/DispatchJobCard.tsx");
const dispatchCrewTaskChooserSource = src("../src/app/company-dashboard/schedule-board/DispatchCrewTaskChooser.tsx");
const dispatchTaskBankSource = src("../src/app/company-dashboard/schedule-board/DispatchTaskBank.tsx");
const dispatchStripSource = src("../src/app/company-dashboard/schedule-board/DispatchExceptions.tsx");
const dispatchExceptionsSource = src("../src/app/company-dashboard/schedule-board/dispatch-exceptions.ts");
const traySource = src("../src/app/company-dashboard/schedule-board/UnscheduledTray.tsx");
const dialogSource = src("../src/app/company-dashboard/schedule-board/ShiftConfirmDialog.tsx");
const layoutSource = src("../src/app/company-dashboard/schedule-board/useBarLayout.ts");
const dragVisualSource = src("../src/app/company-dashboard/schedule-board/dragVisualLayer.ts");
const cellActivationSource = src("../src/app/company-dashboard/schedule-board/emptyCellCreation.ts");
const popoverSource = src("../src/app/company-dashboard/schedule-board/FloatingPopover.tsx");
const actionsSource = src("../src/lib/actions.ts");
const coreSource = src("../src/lib/schedule-core.ts");
const taskCoreSource = src("../src/lib/schedule-task-core.ts");
const dispatchIntentSource = src("../src/lib/dispatch-intent.ts");
const dispatchPublicationSource = src("../src/lib/dispatch-publication.ts");
const weatherSource = src("../src/lib/weather.ts");
const companyDashboardPageSource = src("../src/app/company-dashboard/page.tsx");
const companyDashboardSource = src("../src/app/company-dashboard/CompanyDashboardClient.tsx");
// CrewPicker/TaskCrewPicker moved out of CompanyDashboardClient.tsx into their
// own module (item 1) so ProjectBar/TaskBlockSegment can reuse them from the
// new context menus without a circular import back into
// CompanyDashboardClient (which imports ScheduleBoard -> …View -> ProjectBar).
const crewPickersSource = src("../src/app/company-dashboard/schedule-board/CrewPickers.tsx");
const drawerSource = src("../src/app/company-dashboard/schedule-board/BoardTaskDrawer.tsx");
const projectDrawerSource = src("../src/app/company-dashboard/schedule-board/BoardProjectDrawer.tsx");
const drawerShellSource = src("../src/app/company-dashboard/schedule-board/BoardDrawerShell.tsx");
const projectTaskOverflowSource = src("../src/app/company-dashboard/schedule-board/ProjectTaskOverflow.tsx");
const taskCreationDialogSource = src("../src/components/TaskCreationDialog.tsx");
const detailPanelSource = src("../src/app/projects/[id]/schedule/TaskDetailPanel.tsx");
const scheduleBoardDirectory = new URL("../src/app/company-dashboard/schedule-board/", import.meta.url);
const scheduleBoardSourceTree = readdirSync(scheduleBoardDirectory, { recursive: true })
    .filter(path => typeof path === "string" && /\.(?:ts|tsx)$/.test(path))
    .map(path => readFileSync(new URL(path.replaceAll("\\", "/"), scheduleBoardDirectory), "utf8"))
    .join("\n");

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
// and it fires exactly once per Save click. (updateProjectEndDateAction
// joined this import in the owner-feedback round — item 2's edge-resize
// commit — but it is NOT part of the batch/draft system below; see its own
// assertions further down.)
assert.match(boardSource, /import \{ saveCompanyScheduleTaskDatesAction, shiftNotStartedTasksAction, updateProjectEndDateAction, updateProjectStartDateAction \} from "@\/lib\/actions"/);
const saveAllDraftsStart = boardSource.indexOf("async function saveAllDrafts()");
const saveAllDraftsEnd = boardSource.indexOf("async function publishDispatchDrafts()", saveAllDraftsStart);
const saveAllDraftsBody = boardSource.slice(saveAllDraftsStart, saveAllDraftsEnd);
assert.ok(saveAllDraftsStart >= 0, "saveAllDrafts must exist");
assert.ok(saveAllDraftsEnd > saveAllDraftsStart, "the legacy Save body must end before the atomic Dispatch gesture");
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

// PR-A3 step 1: characterize pointer and draft behavior before replacing
// React-rendered drag previews with the detached visual layer. These checks
// pin the user-visible gates and final writer calls, not transient preview
// implementation details.
assert.match(boardSource, /const TASK_MOUSE_DRAG_THRESHOLD_PX = 5;/, "task mouse drag activation stays at 5px");
assert.match(boardSource, /const TASK_TOUCH_DRAG_THRESHOLD_PX = 8;/, "task touch drag activation stays at 8px");
assert.match(boardSource, /const PROJECT_MOUSE_DRAG_THRESHOLD_PX = 5;/, "project mouse and end-resize activation stays at 5px");
assert.match(boardSource, /const PROJECT_TOUCH_DRAG_THRESHOLD_PX = 8;/, "project touch and end-resize activation stays at 8px");

const characterizedTaskPointerStart = boardSource.indexOf("function handleTaskPointerEditStart(");
const characterizedTaskPointerEnd = boardSource.indexOf("function handleTaskKeyboardStart(", characterizedTaskPointerStart);
const characterizedTaskPointerBody = boardSource.slice(characterizedTaskPointerStart, characterizedTaskPointerEnd);
assert.ok(characterizedTaskPointerStart >= 0, "task pointer edit machine must exist");
assert.match(characterizedTaskPointerBody, /drag\.pointerType === "touch" \? TASK_TOUCH_DRAG_THRESHOLD_PX : TASK_MOUSE_DRAG_THRESHOLD_PX/, "task pointer threshold remains pointer-type specific");
assert.match(characterizedTaskPointerBody, /Math\.hypot\(event\.clientX - drag\.startX, event\.clientY - drag\.startY\) < threshold/, "task threshold uses two-dimensional pointer distance");
assert.match(characterizedTaskPointerBody, /return previewTaskPointerCandidate\(canonicalTask, mode, deltaDays\);/, "task drop candidates keep using the shared pure date helper");
assert.match(characterizedTaskPointerBody, /drag\.latestClientX = releaseEvent\.clientX;\s*\n\s*drag\.latestClientY = releaseEvent\.clientY;[\s\S]*?const candidate = drag\.active && !cancelled \? calculatePointerCandidate\(\) : null;/, "task drop recomputes its final candidate from pointer-up coordinates");
assert.match(characterizedTaskPointerBody, /if \(!drag\.active \|\| cancelled \|\| !candidate\) \{[\s\S]*?return;\s*\n\s*\}\s*\n\s*draftTaskChange\(task\.id, candidate\);/, "task cancel or outside-grid release never reaches the existing draft writer");
assert.match(characterizedTaskPointerBody, /const onPointerCancel = \(event: PointerEvent\) => \{[\s\S]*?finish\(true\);/, "task pointercancel routes through cancellation");
assert.match(characterizedTaskPointerBody, /const onWindowBlur = \(\) => finish\(true\);/, "task blur routes through cancellation");

const characterizedProjectPointerStart = boardSource.indexOf("function handleProjectPointerEditStart(");
const characterizedProjectPointerEnd = boardSource.indexOf("function commitProjectEndResize(", characterizedProjectPointerStart);
const characterizedProjectPointerBody = boardSource.slice(characterizedProjectPointerStart, characterizedProjectPointerEnd);
assert.ok(characterizedProjectPointerStart >= 0, "project pointer edit machine must exist");
assert.match(characterizedProjectPointerBody, /drag\.pointerType === "touch" \? PROJECT_TOUCH_DRAG_THRESHOLD_PX : PROJECT_MOUSE_DRAG_THRESHOLD_PX/, "project pointer threshold remains pointer-type specific");
assert.match(characterizedProjectPointerBody, /formatDate\(addDays\(parseUTCDate\(drag\.originalStart\), deltaDays\)\)/, "project drop candidates remain based on the original start plus the snapped signed delta");
assert.match(characterizedProjectPointerBody, /drag\.latestClientX = releaseEvent\.clientX;\s*\n\s*drag\.latestClientY = releaseEvent\.clientY;[\s\S]*?const candidate = drag\.active && !cancelled \? calculateProjectPointerCandidate\(\) : null;/, "project drop recomputes its final candidate from pointer-up coordinates");
assert.match(characterizedProjectPointerBody, /if \(cancelled \|\| !candidate\) \{[\s\S]*?return;\s*\n\s*\}\s*\n\s*draftProjectMove\(drag\.project, candidate\);/, "project cancel or outside-grid release never reaches the existing draft writer");
assert.match(characterizedProjectPointerBody, /const onWindowBlur = \(\) => finish\(true\);/, "project blur routes through cancellation");

const characterizedEndResizeStart = boardSource.indexOf("function handleProjectEndResizeStart(");
const characterizedEndResizeEnd = boardSource.indexOf("function handleProjectKeyboardStart(", characterizedEndResizeStart);
const characterizedEndResizeBody = boardSource.slice(characterizedEndResizeStart, characterizedEndResizeEnd);
assert.ok(characterizedEndResizeStart >= 0, "project end-resize pointer machine must exist");
assert.match(characterizedEndResizeBody, /drag\.pointerType === "touch" \? PROJECT_TOUCH_DRAG_THRESHOLD_PX : PROJECT_MOUSE_DRAG_THRESHOLD_PX/, "project end-resize shares the project pointer thresholds");
assert.match(characterizedEndResizeBody, /computeProjectEndResizeCandidate\(/, "end-resize candidates keep using the shared clamp helper");
assert.match(characterizedEndResizeBody, /!drag\.active \|\| cancelled \|\| !candidate \|\| candidate === drag\.originalEnd/, "cancelled, invalid, and origin end-resize releases stay no-ops");
assert.match(characterizedEndResizeBody, /commitProjectEndResize\(drag\.project, candidate\);/, "a changed end-resize release keeps using the immediate end writer");
assert.match(characterizedEndResizeBody, /const onWindowBlur = \(\) => finish\(true\);/, "project end-resize blur routes through cancellation");

const characterizedDiscardStart = boardSource.indexOf("function discardAllDrafts()");
const characterizedDiscardEnd = boardSource.indexOf("function waitForConfirmChoice(", characterizedDiscardStart);
const characterizedDiscardBody = boardSource.slice(characterizedDiscardStart, characterizedDiscardEnd);
assert.match(characterizedDiscardBody, /cancelActiveTaskEdit\(\);\s*\n\s*cancelActiveProjectEdit\(\);/, "Discard cancels every active edit before clearing unsaved state");
assert.match(characterizedDiscardBody, /awaitingTaskRefreshIds\.has\(taskId\)/, "Discard preserves saved-awaiting task overrides");
assert.match(saveAllDraftsBody, /if \(awaitingTaskRefreshIds\.has\(taskId\)\) return false;/, "Save never resubmits saved-awaiting task overrides");
assert.match(boardSource, /rewriteAwaitingOverridesFromShift\(unseen\.flatMap\(event => event\.taskDates\)\)/, "all unseen external shifts keep rebasing saved-awaiting overrides");

// PR-A3 steps 2-4: the new architecture must make active pointer frames an
// imperative DOM-only path. These assertions intentionally start RED after
// characterization passes and before production code changes.
assert.ok(dragVisualSource.length > 0, "the isolated dragVisualLayer module must exist");
assert.doesNotMatch(dragVisualSource, /@\/lib\/actions|schedule-core|router|toast|draftTaskChange|draftProjectMove|updateProjectEndDateAction/, "the visual layer must have no schedule persistence knowledge");
assert.match(dragVisualSource, /export function createDragVisualLayer\(/, "the visual layer exposes one focused controller factory");
assert.match(dragVisualSource, /cloneNode\(true\)/, "move ghosts clone the rendered task or project visual");
assert.match(dragVisualSource, /document\.body\.appendChild\(/, "the detached ghost mounts outside React-owned schedule geometry");
assert.match(dragVisualSource, /position = "fixed"/, "ghost positioning is viewport-fixed");
assert.match(dragVisualSource, /pointerEvents = "none"/, "the ghost never interferes with hit testing");
assert.match(dragVisualSource, /new MutationObserver\(/, "the controller re-applies source/target visuals across refresh remounts");
assert.match(dragVisualSource, /querySelectorAll<HTMLElement>\(sourceSelector\)/, "stable data hooks reacquire every remounted source fragment");
assert.match(dragVisualSource, /export function projectMarkerDragSourceSelector\(/, "marker-only project drags can target title strips without dimming task visuals");
assert.match(dragVisualSource, /document\.elementsFromPoint\(/, "target highlighting is reacquired from the live DOM at the last pointer position");
assert.match(dragVisualSource, /data-schedule-date/, "the visual layer owns schedule-date target highlighting");
assert.match(dragVisualSource, /transform = `translate3d\(/, "active pointer frames update detached ghost geometry imperatively");
assert.match(dragVisualSource, /sourceOffsetX\?: number;/, "resize ghosts can track source movement caused by timeline autoscroll");
assert.match(dragVisualSource, /observer\.disconnect\(\)/, "visual cleanup stops refresh observation");
assert.match(dragVisualSource, /ghost\.remove\(\)/, "visual cleanup removes the detached ghost");
assert.match(dragVisualSource, /ghost\.setAttribute\("aria-hidden", "true"\)/, "detached visual clones stay out of the accessibility tree");
assert.match(dragVisualSource, /dispatchEvent\(new CustomEvent\(DRAG_VISUAL_ACTIVE_EVENT/, "pointer-drag activity is published below ScheduleBoard instead of root state");

// PR-A3 step 5: the native Unscheduled tray drag must reuse the imperative
// visual layer rather than writing React state in Month/Timeline. Empty-cell
// creation shares one click/keyboard guard and reaches the existing dialog
// seam with view-specific defaults.
assert.match(dragVisualSource, /export function highlightScheduleTarget\(/, "native HTML drag targets must use the shared imperative highlighter");
assert.match(dragVisualSource, /export function clearScheduleTargetHighlight\(/, "native drag target cleanup must be explicit");
assert.match(dragVisualSource, /export function beginNativeScheduleDragActivity\(/, "native tray drags must publish the same below-root activity signal");
assert.match(traySource, /beginNativeScheduleDragActivity\(\)/, "UnscheduledTray must publish native drag activity without React state");
assert.match(traySource, /onDragEnd=\{handleDragEnd\}/, "UnscheduledTray must clean up activity/highlighting when a native drag ends");
for (const [name, source] of [["Month", monthSource], ["Timeline", timelineSource]] as const) {
    assert.match(source, /highlightScheduleTarget\(/, `${name} native drop targets must highlight imperatively`);
    assert.match(source, /clearScheduleTargetHighlight\(\)/, `${name} native drop targets must clean up imperatively`);
    assert.doesNotMatch(source, /dragOverDate|setDragOverDate/, `${name} must not render from native drag-over state`);
    assert.match(source, /isDragVisualLayerActive\(\)/, `${name} empty-cell creation must ignore every active drag`);
    assert.match(source, /isPrimaryUnmodifiedClick\(/, `${name} empty-cell creation must require an unmodified primary click`);
    assert.match(source, /isScheduleCellBackgroundTarget\(/, `${name} empty-cell creation must ignore blocks and controls`);
}
assert.match(cellActivationSource, /event\.button === 0/, "the shared empty-cell guard must require the primary button");
assert.match(cellActivationSource, /!event\.altKey && !event\.ctrlKey && !event\.metaKey && !event\.shiftKey/, "the shared empty-cell guard must reject modified clicks");
assert.match(cellActivationSource, /data-task-edit-block/, "the shared empty-cell guard must reject task blocks");
assert.match(cellActivationSource, /data-drag-visual-kind/, "the shared empty-cell guard must reject dragged schedule geometry");
assert.match(monthSource, /role=\{data\.canEdit \? "button" : undefined\}[\s\S]{0,220}tabIndex=\{data\.canEdit \? 0 : undefined\}/, "editable Month day cells need a keyboard-equivalent activation path without exposing button semantics to read-only users");
assert.match(monthSource, /onKeyDown=\{event => handleDayKeyDown\(dayKey, event\)\}/, "Month day cells must implement Enter/Space activation");
assert.equal((timelineSource.match(/onKeyDown=\{event => handleEmptyCellKeyDown\(/g) ?? []).length, 2, "both Timeline cell modes must implement Enter/Space activation");
assert.match(timelineSource, /const \[focusedCell, setFocusedCell\] = useState<TimelineCellFocus \| null>\(null\)/, "Timeline creation cells must use one roving focus owner");
assert.match(timelineSource, /event\.key === "ArrowLeft"[\s\S]{0,500}event\.key === "ArrowRight"[\s\S]{0,500}event\.key === "ArrowUp"[\s\S]{0,500}event\.key === "ArrowDown"/, "Timeline roving focus must navigate dates and rows with arrow keys");
assert.equal((timelineSource.match(/tabIndex=\{data\.canEdit \? \(isTimelineCellTabbable\(/g) ?? []).length, 2, "both Timeline modes must expose only the current roving cell in the tab order");
assert.doesNotMatch(timelineSource, /tabIndex=\{data\.canEdit \? 0 : undefined\}/, "Timeline must not create one tab stop per day per row");
assert.equal((timelineSource.match(/role=\{data\.canEdit \? "button" : undefined\}/g) ?? []).length, 2, "read-only Timeline cells must not expose button semantics");
assert.match(monthSource, /onCreateTask\(\{ defaultStartDate: dayKey \}\)/, "Month creation must default only the date and leave project selection unlocked");
assert.match(timelineSource, /defaultProjectId: project\.id,[\s\S]{0,100}lockProject: true,[\s\S]{0,100}defaultStartDate: dayKey/, "Timeline project cells must lock the row project and default the date");
assert.match(timelineSource, /defaultStartDate: dayKey, defaultCrewIds: \[row\.userId\]/, "Timeline crew cells must default the date and row crew member");
assert.equal((boardSource.match(/onCreateTask=\{openTaskCreation\}/g) ?? []).length, 3, "Dispatch, Month, and Timeline must share the one task-creation dialog seam");

assert.match(taskBlockSource, /data-drag-visual-kind="task"/, "task roots expose a stable visual kind hook");
assert.match(taskBlockSource, /data-drag-task-id=\{task\.id\}/, "task roots expose a stable task-id hook");
assert.match(projectBarSource, /data-drag-visual-kind="project"/, "project roots expose a stable visual kind hook");
assert.match(projectBarSource, /data-drag-project-id=\{project\.id\}/, "project roots expose a stable project-id hook");
assert.match(projectBarSource, /data-drag-project-title="true"/, "In-Progress marker-only ghosts have a stable title-strip hook");
assert.match(taskBlockSource, /isDragVisualLayerActive\(\)/, "task hover opening reads pointer-drag activity without a board-root render");
assert.match(taskBlockSource, /DRAG_VISUAL_ACTIVE_EVENT/, "active pointer drags close existing task hover cards below the board root");

assert.match(boardSource, /let scheduleBoardRenderCount = 0;/, "a module-level development render counter must exist");
assert.match(boardSource, /process\.env\.NODE_ENV !== "production"/, "the render counter must be development-only");
assert.match(boardSource, /window\.__boardRenderCount = scheduleBoardRenderCount/, "the browser test can read the ScheduleBoard render count");
assert.match(boardSource, /import \{\s*createDragVisualLayer[,\s\S]*?\} from "\.\/dragVisualLayer"/, "ScheduleBoard must consume the isolated visual controller");
assert.doesNotMatch(boardSource, /setPointerDragActive/, "threshold crossing and pointer-up must not write board-root drag state");
const taskRafBody = characterizedTaskPointerBody.slice(
    characterizedTaskPointerBody.indexOf("const runTaskPointerFrame ="),
    characterizedTaskPointerBody.indexOf("const onPointerMove ="),
);
const projectRafBody = characterizedProjectPointerBody.slice(
    characterizedProjectPointerBody.indexOf("const runProjectPointerFrame ="),
    characterizedProjectPointerBody.indexOf("const requestProjectPointerFrame ="),
);
const endResizeRafBody = characterizedEndResizeBody.slice(
    characterizedEndResizeBody.indexOf("const runEndResizeFrame ="),
    characterizedEndResizeBody.indexOf("const onPointerMove ="),
);
assert.doesNotMatch(taskRafBody, /setTaskPreview\(|clearTaskPreview\(|setTaskDateOverrides\(/, "task pointer RAFs must not write React preview state");
assert.doesNotMatch(projectRafBody, /setProjectPreview\(|clearProjectPreview\(|setProjectPreviewOverrides\(|setProjectIncomeOverrides\(/, "project pointer RAFs must not write React preview state");
assert.doesNotMatch(endResizeRafBody, /setProjectPreview\(|clearProjectPreview\(|setProjectPreviewOverrides\(/, "project end-resize RAFs must not write React preview state");
assert.match(characterizedTaskPointerBody, /createDragVisualLayer\(/, "task move and resize paths use the detached controller");
assert.match(characterizedEndResizeBody, /createDragVisualLayer\(/, "project end-resize uses the detached controller");
assert.match(characterizedProjectPointerBody, /createDragVisualLayer\(/, "project move uses the detached controller");
assert.match(characterizedProjectPointerBody, /sourceSelector: drag\.project\.status === "In Progress"\s*\n\s*\? projectMarkerDragSourceSelector\(project\.id\)\s*\n\s*: projectDragSourceSelector\(project\.id\)/, "In-Progress moves dim only marker/title fragments while Waiting-to-Start moves dim the full composite");
assert.match(characterizedTaskPointerBody, /visualLayer\.update\(/, "task RAF updates only the visual controller");
assert.match(characterizedEndResizeBody, /visualLayer\.update\(/, "end-resize RAF updates only the visual controller");
assert.match(characterizedProjectPointerBody, /visualLayer\.update\(/, "project-move RAF updates only the visual controller");
assert.match(characterizedTaskPointerBody, /sourceOffsetX: drag\.originX - drag\.startX/, "task resize ghosts stay anchored to their autoscrolled source");
assert.match(characterizedEndResizeBody, /sourceOffsetX: drag\.originX - drag\.startX/, "project end-resize ghosts stay anchored to their autoscrolled source");

// ── Item 1: crew ACTIVATED validation is added-only ──
const setProjectCrewStart = coreSource.indexOf("async function runSetProjectCrew");
const setProjectCrewEnd = coreSource.indexOf("export interface CrewConflictPair", setProjectCrewStart);
const setProjectCrewBody = coreSource.slice(setProjectCrewStart, setProjectCrewEnd);
assert.match(setProjectCrewBody, /toConnect\.map\(id => byId\.get\(id\)!\)\.filter\(u => u\.status !== "ACTIVATED"\)/);
assert.ok(setProjectCrewBody.indexOf("toConnect = wanted.filter") < setProjectCrewBody.indexOf("notActivated ="), "toConnect must be computed before the ACTIVATED check runs against it");
const setTaskCrewBody = coreSource.slice(coreSource.indexOf("async function runSetTaskCrew"));
assert.match(setTaskCrewBody, /toAdd\.map\(id => byId\.get\(id\)!\)\.filter\(u => u\.status !== "ACTIVATED"\)/);

// ── Item 3: floating popovers escape clipping via a portal ──
assert.match(popoverSource, /createPortal\(/);
assert.match(popoverSource, /document\.body/);
assert.match(popoverSource, /event\.key !== "Escape"/);
// anchorRef is now optional (item 1 — an anchorPoint-only context menu has
// no trigger element to refocus), hence the extra `?.` before `.current`.
assert.match(popoverSource, /anchorRef\?\.current\?\.focus\(\)/);
// Interactive popovers expose an explicit close button, while non-interactive
// hover cards do not. The button sits before/outside contentRef so it never
// participates in the content ResizeObserver's measurements.
assert.match(popoverSource, /\{!pointerEventsNone && \(\s*<button[\s\S]{0,500}type="button"[\s\S]{0,500}aria-label="Close"[\s\S]{0,500}onClick=\{onClose\}/, "interactive popovers must render an explicit Close button");
assert.match(popoverSource, /aria-label="Close"[\s\S]{0,800}<\/button>\s*\)\}\s*\{\/\* Content wrapper:[\s\S]{0,300}<div ref=\{contentRef\}/, "the Close button must live outside and above the observed content wrapper");
assert.match(popoverSource, /<div ref=\{contentRef\} className=\{pointerEventsNone \? undefined : "pr-6"\}>/, "interactive popover content must reserve minimal right-side room for the Close button");
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
assert.doesNotMatch(projectBarSource, /FloatingPopover/, "ProjectBar must not import or render the removed project popover");
assert.match(projectTaskOverflowSource, /import \{ FloatingPopover \} from "\.\/FloatingPopover"/, "the unchanged +N task overflow keeps its popover in an isolated component");
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
assert.match(projectBarSource, /<ProjectTaskOverflow projectName=\{project\.name\} tasks=\{hiddenTasks\} \/>/, "a +N overflow affordance must exist for tasks beyond the lane cap");
assert.match(projectTaskOverflowSource, /if \(tasks\.length === 0\) return null;/, "the extracted +N overflow must only render for tasks beyond the lane cap");
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
assert.match(projectBarSource, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/, "ProjectBar must open its drawer on the ContextMenu key / Shift+F10");
assert.match(taskBlockSource, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/, "TaskBlockSegment must open its menu on the ContextMenu key / Shift+F10");
// Only one schedule-board menu/drawer is open at a time, including click vs
// context activation — quick menus keep their registrations and both drawers
// inherit the same coordination through their shared shell.
for (const source of [taskBlockSource, monthSource, timelineSource, projectTaskOverflowSource]) {
    assert.match(source, /activateExclusiveMenu\(close\)/, "every schedule-board menu must register with the exclusive-menu coordinator on open");
    assert.match(source, /deactivateExclusiveMenu\(close\)/, "every schedule-board menu must deregister with the exclusive-menu coordinator on close");
}
assert.match(drawerShellSource, /activateExclusiveMenu\(close\)/, "the shared drawer shell must register with the exclusive-menu coordinator");
assert.match(drawerShellSource, /deactivateExclusiveMenu\(close\)/, "the shared drawer shell must deregister with the exclusive-menu coordinator");
// Empty day cell "Schedule here…" routes through the SAME function the tray
// drop handler calls (onTrayProjectDrop) — never a second scheduling path.
assert.match(monthSource, /onTrayProjectDrop\(project, dayContextMenu\.date\)/, "Month's Schedule-here must route through the existing tray-drop function");
assert.match(timelineSource, /onTrayProjectDrop\(project, dayContextMenu\.date\)/, "Timeline's Schedule-here must route through the existing tray-drop function");
assert.match(monthSource, /No unscheduled projects/, "Month's Schedule-here must show a disabled line when there is nothing to schedule");
assert.match(timelineSource, /No unscheduled projects/, "Timeline's Schedule-here must show a disabled line when there is nothing to schedule");
// Task block: Delete task is an immediate action (not draft-mode) through
// the existing deleteScheduleTask, with explicit non-draft copy in the confirm.
assert.match(taskBlockSource, /import \{ addTaskComment, deleteScheduleTask \} from "@\/lib\/actions"/);
assert.match(taskBlockSource, /await deleteScheduleTask\(task\.id\)/);
assert.match(taskBlockSource, /Deletes now — not part of unsaved changes/, "Delete task's confirm copy must explicitly say it is immediate, not draft-mode");
// Project drawer: Remove from schedule only for Waiting to Start, through the
// existing updateProjectStartDateAction(projectId, null, false) path.
assert.match(projectDrawerSource, /project\.status === "Waiting to Start" &&[\s\S]{0,900}Remove from schedule/, "Remove from schedule must only render for Waiting-to-Start projects");
assert.match(projectDrawerSource, /await updateProjectStartDateAction\(project\.id, null, false\)/, "Remove from schedule must use the existing updateProjectStartDateAction(projectId, null, false) path");
// Color… reuses the ORIGINAL schedule palette (PRESET_COLORS), not a
// re-invented swatch list.
assert.match(projectDrawerSource, /PRESET_COLORS[\s\S]*from "@\/app\/projects\/\[id\]\/schedule\/schedule-utils"/);
assert.match(projectDrawerSource, /PRESET_COLORS\.map\(swatch =>/, "the drawer Color section must be built from PRESET_COLORS");
// Project crew…/Task crew… reuse the SAME pickers as the Schedule & crew
// table (via the extracted CrewPickers module), never a rebuilt picker.
// Crew-picker rebuild (item 5): the schedule-board menu instances render the
// shared CrewChecklist INLINE (variant="inline") — no nested popover inside
// the bar/block's own FloatingPopover menu, which was the double-scrollbar bug.
assert.match(projectDrawerSource, /import \{ CrewPicker \} from "\.\/CrewPickers"/);
assert.match(projectDrawerSource, /<CrewPicker[\s\S]{0,240}projectId=\{project\.id\}[\s\S]{0,240}variant="inline"[\s\S]{0,240}layout="list"/, "the project drawer must use the shared serialized picker in list layout");
assert.match(taskBlockSource, /import \{ TaskCrewPicker \} from "\.\/CrewPickers"/);
assert.match(taskBlockSource, /<TaskCrewPicker task=\{task\} teamMembers=\{teamMembers\} variant="inline" \/>/);

// ── Item 6: root activation routes to the right drawer ──
assert.doesNotMatch(taskBlockSource, /aria-label=\{`Task actions for /, "TaskBlockSegment must not render the old ellipsis action button");
assert.doesNotMatch(taskBlockSource, />\s*\u22ef\s*<\/button>/, "TaskBlockSegment must not render a vertical-ellipsis button");
assert.doesNotMatch(taskBlockSource, /actionTriggerRef/, "the removed task action button must not leave a trigger ref behind");
assert.match(taskBlockSource, /function handleBlockActivate\(event: ReactMouseEvent<HTMLDivElement> \| KeyboardEvent<HTMLElement>\) \{/);
assert.match(taskBlockSource, /if \(!canEdit \|\| isPending\) return;\s*\n\s*if \(\(event\.target as HTMLElement\)\.closest\("a,button,input,summary,form,details"\)\) return;/, "task block activation must reuse the old action-button edit gates and ignore interactive descendants");
assert.match(taskBlockSource, /onClick=\{handleBlockActivate\}/, "the task block root click must route through the named activation seam");
assert.match(taskBlockSource, /handleBlockActivate[\s\S]{0,400}event\.stopPropagation\(\);/, "block activation must stop propagation so the parent bar's project drawer does not replace the task drawer");
assert.match(taskBlockSource, /mode === "move" && activeMode === null && \(event\.key === " " \|\| event\.key === "Enter"\)[\s\S]{0,250}handleBlockActivate\(event\);/, "Enter/Space on a non-editing task block must route through the activation seam");
assert.match(taskBlockSource, /<FloatingPopover open=\{menuOpen\} anchorRef=\{rootRef\} anchorPoint=\{menuAnchorPoint\}/, "keyboard-opened task menus must anchor to the block rect while pointer-opened menus may use a point");

assert.doesNotMatch(projectBarSource, /aria-label=\{`Project actions for /, "ProjectBar must not render the redundant Actions chip");
assert.doesNotMatch(projectBarSource, />\s*Actions\s*<\/button>/, "ProjectBar must not render the redundant Actions chip");
assert.doesNotMatch(projectBarSource, /actionTriggerRef/, "the removed project Actions chip must not leave a trigger ref behind");
assert.match(projectBarSource, /const rootRef = useRef<HTMLDivElement>\(null\)/);
assert.match(projectBarSource, /ref=\{rootRef\}[\s\S]{0,1200}onClick=\{handleBarClick\}/, "ProjectBar's root ref and existing click activation must stay wired");
assert.doesNotMatch(projectBarSource, /menuOpen|menuView|menuAnchorPoint|openMenu/, "all project-menu state and view switching must be gone");

// Project-bar activation always routes through the lifted drawer seam.
assert.match(projectBarSource, /function handleBarClick\(/);
assert.match(projectBarSource, /function handleBarClick\([\s\S]{0,500}onProjectActivate\(project\.id\)/, "plain project-bar clicks must open the project drawer");
assert.match(projectBarSource, /if \(!editing && \(event\.key === " " \|\| event\.key === "Enter"\)\) \{[\s\S]{0,160}onProjectActivate\(project\.id\)/, "Enter/Space must open the project drawer");
assert.match(projectBarSource, /function handleContextMenu\([\s\S]{0,500}onProjectActivate\(project\.id\)/, "right-click must open the project drawer");
assert.match(projectBarSource, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)[\s\S]{0,220}onProjectActivate\(project\.id\)/, "ContextMenu/Shift+F10 must open the project drawer");
assert.doesNotMatch(projectBarSource, /onClick=\{.*router\.push|onClick=\{.*navigate/, "the bar itself must never navigate on click");
assert.match(projectDrawerSource, /Open project/, "Open project must move into the project drawer header");

// ── Item 7: crew picker hygiene (FINANCE exclusion + name disambiguation) ──
// Owner call 2026-07-23: schedulable people = FIELD_CREW only (no admins or
// office in pickers/availability). Stricter than the earlier FINANCE-exclusion.
assert.match(coreSource, /where: \{ status: "ACTIVATED", role: "FIELD_CREW" \}/);
// Owner call 2026-07-23: names stay bare — no email decoration ever (full
// addresses wrapped across six lines in the crew checklist).
assert.doesNotMatch(coreSource, /name: `\$\{r\.name\} \(\$\{r\.email\}\)`/, "picker names must never carry email decorations");
assert.match(crewPickersSource, /c\.status !== "ACTIVATED" \? "inactive" : c\.role\.toLowerCase\(\)\.replace\("_", " "\)/, "CrewPicker labels removable non-crew entries by role (or inactive)");
assert.match(crewPickersSource, /a\.status !== "ACTIVATED" \? "inactive" : a\.userRole\.toLowerCase\(\)\.replace\("_", " "\)/, "TaskCrewPicker labels removable non-crew entries by role (or inactive)");
assert.match(companyDashboardSource, /a\.userRole === "FINANCE" \? " \(finance\)"/, "the Schedule & crew task-row display keeps its own FINANCE label");
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
for (const source of [boardSource, monthSource, timelineSource, projectBarSource, projectDrawerSource, drawerShellSource, projectTaskOverflowSource, taskBlockSource, popoverSource, availabilityPanelSource, crewPickersSource]) {
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
assert.match(projectDrawerSource, /project\.distanceMilesFromShop != null/);
assert.match(projectDrawerSource, /mi from shop/, "the project drawer header must surface the shop distance line");
// The crew-mode toggle is now owned by ScheduleBoard so the panel's
// drill-down can force it on even when Timeline is already mounted.
assert.match(timelineSource, /export const CREW_MODE_STORAGE_KEY/);
assert.match(boardSource, /import \{ TimelineView, CREW_MODE_STORAGE_KEY \} from "\.\/TimelineView"/);
assert.match(boardSource, /function drillDownToCrewTimeline\(/);
assert.match(boardSource, /onDrillDown=\{drillDownToCrewTimeline\}/);

// ── Owner-feedback round (2026-07-22), item 1: end date merged into
// "Edit dates…" — the standalone "Set end date…" item and its own menu view
// are GONE; the "dates" view now carries both fields. ──
assert.doesNotMatch(projectBarSource, /Set end date…/, "the standalone \"Set end date…\" menu item must be removed");
assert.doesNotMatch(projectBarSource, /BarMenuView|setMenuView/, "ProjectBar must carry no menu view state");
// "Edit dates…" is no longer canMoveProject-gated at the menu-item level (a
// Substantial Completion project can't move its start, but must still be
// able to set an end date) — the Start FIELD inside the view stays gated.
assert.doesNotMatch(projectBarSource, /\{canMoveProject && \(\s*<button type="button" onClick=\{\(\) => setMenuView\("dates"\)\}/, "the Edit dates… menu item itself must not be canMoveProject-gated");
assert.match(projectDrawerSource, /\{canMoveProject && \(\s*<div>\s*<label[\s\S]{0,300}Start date/, "the Start date field inside the drawer stays canMoveProject-gated");
assert.match(projectDrawerSource, />End date<\/label>/, "the drawer Dates section must contain an End date field");
assert.match(projectDrawerSource, /Joins unsaved changes — Save to commit\./, "the Start field needs a caption distinguishing it from the immediate End write");
assert.match(projectDrawerSource, /Saves immediately\./, "the End field needs a caption distinguishing it from the draft Start write");
assert.match(projectDrawerSource, /Clear end date/, "the drawer keeps a Clear end date affordance");
// Submit behavior: Start routes through the EXISTING draft path
// (onMoveCommit -> draftProjectMove); End calls updateProjectEndDateAction
// (via submitEndDate) immediately and ONLY when it actually changed.
const handleDateSubmitStart = projectDrawerSource.indexOf("function handleDateSubmit(");
const handleDateSubmitEnd = projectDrawerSource.indexOf("function submitEndDate(", handleDateSubmitStart);
const handleDateSubmitBody = projectDrawerSource.slice(handleDateSubmitStart, handleDateSubmitEnd);
assert.ok(handleDateSubmitStart >= 0, "handleDateSubmit must exist");
assert.match(handleDateSubmitBody, /onMoveCommit\(project, targetStart\)/, "a start change must route through the existing draft path");
assert.match(handleDateSubmitBody, /if \(endDateValue !== projectEndDate\) \{\s*\n\s*submitEndDate\(endDateValue \|\| null\);/, "an end change must fire submitEndDate ONLY when the value actually changed");
assert.match(projectDrawerSource, /await updateProjectEndDateAction\(project\.id, value\);/, "the drawer End field still routes through the existing updateProjectEndDateAction — no new action");
assert.match(projectDrawerSource, /toast\.error\(err\?\.message \|\| "Failed to update end date"\)/, "end-date validation errors stay toasts");

// ── Item 2: project-bar right-edge resize -> end date ──
assert.match(projectBarSource, /onProjectEndResizeStart: ProjectEditCallbacks\["onProjectEndResizeStart"\]/, "ProjectBarProps must carry the end-resize callback");
assert.match(projectBarSource, /export interface ProjectEndResizePointerStart \{/, "a dedicated pointer-start payload type must exist for the edge-resize drag");
assert.match(projectBarSource, /function handleEndResizePointerDown\(event: ReactPointerEvent<HTMLDivElement>\) \{/);
assert.match(projectBarSource, /event\.stopPropagation\(\);\s*\n\s*onProjectEndResizeStart\(project, \{/, "the edge-resize pointerdown must stop propagation so it wins over the whole-bar move drag");
// The handle only renders on the segment that actually ENDS the project
// (never a continuation), is canEdit-gated independent of canMoveProject
// (matches item 1's End-date access boundary), and follows the standard
// hover-reveal + [@media(hover:none)] always-visible pattern.
assert.match(projectBarSource, /\{canEdit && !isPending && !segment\.continuesAfter && \(/, "the edge-resize handle must only render on the segment ending the project, canEdit-gated, independent of canMoveProject");
assert.match(projectBarSource, /onPointerDown=\{handleEndResizePointerDown\}/);
assert.match(projectBarSource, /opacity-0 transition group-hover\/project:opacity-100 group-focus-within\/project:opacity-100 \[@media\(hover:none\)\]:opacity-100/, "the edge-resize handle must use the standard hover/focus/touch-always-visible pattern");
// Confined to the title strip's own 18px band — this is what keeps it from
// EVER vertically overlapping a task block's own resize-right handle, which
// lives only inside the task strip below.
// 16px grab zone with a 4px overhang past the bar edge (a 6px sliver was
// unhittable in practice) — still confined to the title strip's 18px band.
assert.match(projectBarSource, /className="absolute -right-1 top-0 z-20 h-\[18px\] w-4/, "the edge-resize handle must be a findable-width target confined to the title strip's 18px band, never the task strip");
// ScheduleBoard: a SEPARATE drag machine from the whole-bar move. Its active
// visual stays detached; drop installs one final projectPreviewOverride before
// the immediate commit (never draftProjectMove).
assert.match(layoutSource, /export function computeProjectEndResizeCandidate\(originalEnd: Date, startDate: Date, deltaDays: number\): Date \{/, "the resize-preview clamp must be an exported PURE helper (testable, reused by both views)");
assert.match(layoutSource, /candidate < minEnd \? minEnd : candidate/, "the clamp must floor the candidate at start+1, never at or before the start");
assert.match(boardSource, /function measureMonthDayWidth\(clientX: number, clientY: number\): number \| null \{/, "Month's day width must be measured from the underlying week-grid day cell, not hardcoded");
assert.match(boardSource, /function handleProjectEndResizeStart\(project: DashboardProjectRow, start: ProjectEndResizePointerStart\) \{/);
assert.match(boardSource, /const dayWidth = drag\.start\.timelineDayWidth \?\? drag\.monthDayWidth;/, "px->day math must read the CURRENT day width — Timeline's zoom-driven prop or Month's measured value — never a hardcoded constant");
// The clamp floor is the PERSISTED start marker when one exists (the effective
// range can begin at an earlier task after marker-only moves, and the server
// rejects end <= persisted startDate) — falling back to the range start.
assert.match(boardSource, /const clampStart = drag\.project\.startDate\s*\n\s*\? parseUTCDate\(drag\.project\.startDate\.slice\(0, 10\)\)\s*\n\s*: parseUTCDate\(drag\.originalStart\);/, "the resize clamp must floor at the persisted start marker");
assert.match(boardSource, /computeProjectEndResizeCandidate\(\s*\n\s*parseUTCDate\(drag\.originalEnd\),\s*\n\s*clampStart,/, "the live preview must run through the shared pure clamp helper");
assert.match(boardSource, /function commitProjectEndResize\(project: DashboardProjectRow, candidateEnd: string\) \{/);
assert.doesNotMatch(
    boardSource.slice(boardSource.indexOf("function commitProjectEndResize("), boardSource.indexOf("function handleProjectEndResizeStart(")),
    /draftProjectMove|setProjectDrafts/,
    "the edge-resize commit must NEVER join the draft/Save system — it writes immediately",
);
assert.match(boardSource, /await updateProjectEndDateAction\(project\.id, candidateEnd\);/, "the edge-resize commit must call the existing updateProjectEndDateAction — no new action");
assert.match(boardSource, /const taskDerivedRange = getEffectiveProjectRange\(\{ \.\.\.project, endDate: null \}\);/, "the 'still shows through' toast must compare against the pure task/marker-derived range (endDate ignored)");
assert.match(boardSource, /End date saved — the bar still shows through \$\{formatDate\(addDays\(taskDerivedRange\.end, -1\)\)\} because tasks run that long\./, "a released end shorter than the last task's end must still save, with an info toast explaining the bar's visible length");
assert.match(boardSource, /activeProjectEndResizeRef\.current\?\.cleanup\(\);/, "starting another project/task edit must cancel an active end-resize drag");
assert.match(boardSource, /const combinedPendingProjectIds = useMemo\(\s*\n\s*\(\) => mergeProjectPendingIds\(externallyPendingProjectIds, endResizeSavingProjectIds\),/, "an in-flight end-resize save must lock the project the SAME way the legacy externally-pending mechanism does");
assert.equal((boardSource.match(/pendingProjectIds=\{combinedPendingProjectIds\}/g) ?? []).length, 2, "both views must receive the combined (legacy + end-resize) pending-project set");
assert.match(monthSource, /onProjectEndResizeStart=\{onProjectEndResizeStart\}/);
assert.match(timelineSource, /onProjectEndResizeStart=\{onProjectEndResizeStart\}/);
assert.match(boardSource, /onProjectEndResizeStart=\{handleProjectEndResizeStart\}/, "the board must wire the end-resize handler into at least one view");

// ── Item 3: hover notes on task blocks ──
assert.match(coreSource, /latestComments: DashboardTaskComment\[\];/, "DashboardTaskRow must carry the hover-card's latestComments");
assert.match(coreSource, /comments: \{\s*\n\s*orderBy: \{ createdAt: "desc" \},\s*\n\s*take: 2,/, "the task select must cap comments at 2, newest first");
assert.match(coreSource, /authorName: c\.user\?\.name \?\? c\.user\?\.email \?\? c\.subcontractorName \?\? "Unknown",/, "author fallback chain must be user.name -> user.email -> subcontractorName -> Unknown");
const addTaskCommentStart = actionsSource.indexOf("export async function addTaskComment(");
const addTaskCommentEnd = actionsSource.indexOf("export async function getTaskComments(", addTaskCommentStart);
const addTaskCommentBody = actionsSource.slice(addTaskCommentStart, addTaskCommentEnd);
assert.ok(addTaskCommentStart >= 0, "addTaskComment must exist");
assert.match(addTaskCommentBody, /await assertScheduleTaskAccess\(taskId\);/, "addTaskComment previously had NO auth check — hardened to the same schedule-task gate every other per-task mutation uses");
assert.match(taskBlockSource, /import \{ addTaskComment, deleteScheduleTask \} from "@\/lib\/actions"/);
assert.match(taskBlockSource, /Add note…/, "the task context menu must offer Add note…");
assert.match(taskBlockSource, /await addTaskComment\(task\.id, text\);/, "Add note must go through the existing (now hardened) addTaskComment action");
const hoverCardStart = taskBlockSource.indexOf('<FloatingPopover open={hoverCardOpen}');
const hoverCardBody = taskBlockSource.slice(hoverCardStart);
assert.ok(hoverCardStart >= 0, "the task hover card must exist");
assert.equal((hoverCardBody.match(/<p className=/g) ?? []).length, 3, "the hover card must have exactly three text lines");
assert.match(hoverCardBody, /formatDate\(taskStart\)[\s\S]{0,120}formatDate\(isMilestone \? taskStart : taskEnd\)[\s\S]{0,120}\{task\.status\}[\s\S]{0,100}\{progress\}%/, "the second hover-card line must combine dates, status, and progress");
assert.match(hoverCardBody, /\{crew\}/, "the third hover-card line must show crew or Unassigned");
assert.doesNotMatch(hoverCardBody, /latestComments|comment\.|relativeDayLabel|truncateNote|estimatedHours|href=/, "comments, timestamps, hours, and links must stay out of the slim hover card");
assert.match(taskBlockSource, /isAnyDragActive: boolean;/, "TaskBlockSegmentProps must accept the cross-board drag-active flag");
assert.match(taskBlockSource, /if \(!isAnyDragActive && !menuOpen\) return;[\s\S]{0,300}setHoverCardOpen\(false\);/, "an active drag (or the click/context menu) must force-close an already-open hover card");
assert.match(taskBlockSource, /if \(isAnyDragActive \|\| menuOpen(?: \|\| hoverOpenTimeoutRef\.current != null)?\) return;/, "opening the hover card must be gated on isAnyDragActive");
assert.match(popoverSource, /pointerEventsNone\?: boolean;/, "FloatingPopover must support a non-interactive hover-card mode");
assert.match(popoverSource, /pointerEventsNone \? "pointer-events-none" : ""/);
assert.match(taskBlockSource, /pointerEventsNone/, "the hover card FloatingPopover instance must opt into pointer-events-none");
for (const source of [monthSource, timelineSource, projectBarSource]) {
    assert.match(source, /isAnyDragActive=\{isAnyDragActive\}/, "every TaskBlockSegment/ProjectBar render site must thread isAnyDragActive through");
}

// ── Item 5: crew-picker rebuild (owner-flagged double scrollbar) ──
// CrewChecklist owns NO scroll/width of its own — FloatingPopover (width=320
// for the standalone popover variant) is the ONLY scroll owner anywhere a
// picker renders, including the "inline" variant nested inside an ALREADY-
// open schedule-board menu.
assert.doesNotMatch(crewPickersSource, /max-h-64/, "CrewPickers must not bring its own max-height scroller — FloatingPopover owns scrolling");
assert.doesNotMatch(crewPickersSource, /overflow-y-auto/, "CrewPickers must not bring its own scroll region — double scrollbar was the bug");
assert.match(crewPickersSource, /function CrewChecklist\(/, "a single shared checklist presentation must exist");
assert.match(crewPickersSource, /layout\?: "compact" \| "list"/, "CrewChecklist must expose a list layout without forking the picker");
assert.match(crewPickersSource, /layout === "list" \? "grid grid-cols-1 gap-1" : "grid grid-cols-1 gap-1 sm:grid-cols-2"/, "the drawer gets one row per person while compact popovers keep two columns");
assert.match(crewPickersSource, /option\.tag/, "removable non-crew entries must expose a separate role/status tag in list layout");
assert.match(crewPickersSource, /variant\?: "inline" \| "popover";/, "CrewPicker/TaskCrewPicker must accept the inline/popover variant");
assert.match(crewPickersSource, /if \(variant === "inline"\) \{\s*\n\s*return <CrewChecklist/, "the inline variant must render the checklist directly with no nested trigger/popover of its own");
assert.match(crewPickersSource, /<FloatingPopover open=\{open\} anchorRef=\{triggerRef\} onClose=\{\(\) => setOpen\(false\)\} width=\{320\}>/, "the popover variant (Schedule & crew table) must use FloatingPopover at width 320");
assert.doesNotMatch(crewPickersSource, /w-56/, "the old fixed w-56 picker panel must be gone");
assert.match(popoverSource, /overflowX: "hidden",/, "FloatingPopover must clip horizontally so nested content can never reintroduce a second scroll axis");
assert.match(popoverSource, /maxWidth: `calc\(100vw - \$\{2 \* VIEWPORT_MARGIN_PX\}px\)`,/, "FloatingPopover must clamp its own width into the viewport");
// FINANCE/inactive labeling and FloatingPopover's existing maxHeight/overflowY
// contract stay exactly as before the rebuild.


assert.match(popoverSource, /maxHeight: position\?\.maxHeight,/);
assert.match(popoverSource, /overflowY: "auto",/);

// ── Dispatch A1: shared task drawer + creation core ──

// Plain click / Enter / Space activate the board-level drawer. The quick menu
// remains available through the existing context-menu path only.
assert.match(taskBlockSource, /onActivate: \(taskId: string\) => void;/, "TaskBlockSegment must expose the board-level drawer activation callback");
const blockActivateStart = taskBlockSource.indexOf("function handleBlockActivate(");
const blockActivateEnd = taskBlockSource.indexOf("function handleKeyboard(", blockActivateStart);
const blockActivateBody = taskBlockSource.slice(blockActivateStart, blockActivateEnd);
assert.ok(blockActivateStart >= 0, "handleBlockActivate must exist");
assert.match(blockActivateBody, /onActivate\(task\.id\)/, "plain activation must open the shared drawer");
assert.doesNotMatch(blockActivateBody, /openMenu|setMenuOpen/, "plain activation must not open or toggle the quick popover");
const blockContextStart = taskBlockSource.indexOf("function handleContextMenu(");
const blockContextEnd = taskBlockSource.indexOf("function handleDateSubmit(", blockContextStart);
assert.match(taskBlockSource.slice(blockContextStart, blockContextEnd), /openMenu\(/, "right-click must retain the quick popover");
for (const source of [monthSource, timelineSource, projectBarSource]) {
    assert.match(source, /onActivate=\{onActivate\}/, "drawer activation must be threaded through every board view");
}
assert.equal((boardSource.match(/<BoardTaskDrawer/g) ?? []).length, 1, "ScheduleBoard must own exactly one drawer instance");
assert.match(boardSource, /onActivate=\{handleBlockActivate\}/, "both board views must receive the shared activation handler");
const boardBlockActivateStart = boardSource.indexOf("const handleBlockActivate = useCallback(");
const boardBlockActivateEnd = boardSource.indexOf("const closeTaskDrawer", boardBlockActivateStart);
assert.match(boardSource.slice(boardBlockActivateStart, boardBlockActivateEnd), /setOpenTaskId\(taskId\)/, "the board activation handler must set the one lifted drawer task id");

// Draft dates are never editable in the drawer, while all other task details
// remain available. The message is part of the operator-facing safety contract.
assert.match(drawerSource, /getScheduleTaskDetail\(taskId\)/, "the drawer must load the canonical authorized task detail");
assert.match(drawerSource, /datesReadOnly=\{hasDraft\}/, "the drawer must gate date editing for an unsaved board draft");
assert.match(boardSource, /const openTaskHasDraft = Boolean\(/, "ScheduleBoard must derive one drawer date-safety flag");
assert.match(boardSource, /draftTaskIds\.has\(openTaskId\)/, "direct task drafts must lock drawer date editing");
assert.match(boardSource, /draftProjectIds\.has\(openTaskProjectId\)/, "project shifts that move the task must lock drawer date editing");
assert.match(boardSource, /hasDraft=\{openTaskHasDraft\}/, "ScheduleBoard must pass the complete draft-date safety flag to the drawer");
assert.match(boardSource, /onDeleted=\{handleDrawerTaskDeleted\}/, "drawer deletion must reconcile board-local task state");
assert.match(drawerShellSource, /activeElement\.blur\(\)/, "outside-close must flush blur-saved drawer fields before unmounting");
assert.match(drawerShellSource, /window\.setTimeout\(onClose, 0\)/, "outside-close must defer unmount until the blur handler runs");
assert.match(drawerSource, /onDeleted\(id\)/, "successful drawer deletion must notify the board owner");
assert.match(drawerSource, /This task has unsaved changes on the board — Save or Discard them first\./, "the drawer must explain the draft-date gate exactly");
assert.match(detailPanelSource, /datesReadOnly\?: boolean;/, "the shared panel must support read-only dates without becoming board-specific");
assert.match(detailPanelSource, /onStatusChange: \(taskId: string, status: string, blockedReason\?: string\) => void;/, "the shared panel status callback must carry the required blocked reason");

const getTaskDetailStart = actionsSource.indexOf("export async function getScheduleTaskDetail(");
const getTaskDetailEnd = actionsSource.indexOf("export async function", getTaskDetailStart + 1);
const getTaskDetailBody = actionsSource.slice(getTaskDetailStart, getTaskDetailEnd);
assert.ok(getTaskDetailStart >= 0, "getScheduleTaskDetail must exist");
assert.match(getTaskDetailBody, /await assertScheduleTaskAccess\(taskId\);/, "task detail reads must use the canonical schedule-task authorization gate");

// G0 project drawer: lifted project selection, shared shell, and one
// all-visible list of the former project-menu capabilities.
assert.match(boardSource, /const \[openProjectId, setOpenProjectId\] = useState<string \| null>\(null\)/, "ScheduleBoard must lift the selected project id beside the task id");
assert.match(boardSource, /const handleProjectActivate = useCallback\(\(projectId: string\) => \{[\s\S]{0,220}setOpenProjectId\(projectId\)/, "the board must own one project activation handler");
assert.equal((boardSource.match(/onProjectActivate=\{handleProjectActivate\}/g) ?? []).length, 2, "Month and Timeline must receive the one project activation handler");
for (const source of [monthSource, timelineSource]) {
    assert.match(source, /onProjectActivate=\{onProjectActivate\}/, "project drawer activation must be threaded through each ProjectBar render site");
}
assert.equal((boardSource.match(/<BoardProjectDrawer/g) ?? []).length, 1, "ScheduleBoard must own exactly one project drawer instance");
assert.match(boardSource, /project=\{openProject\}/, "the project drawer must receive the selected serialized project");
assert.match(drawerSource, /import \{ BoardDrawerShell \} from "\.\/BoardDrawerShell"/, "the task drawer must use the extracted shared shell");
assert.match(projectDrawerSource, /import \{ BoardDrawerShell \} from "\.\/BoardDrawerShell"/, "the project drawer must use the exact same shell");
assert.match(drawerShellSource, /w-\[min\(420px,calc\(100vw-1rem\)\)\]/, "both drawers must retain the task drawer's 420px responsive width");
assert.match(drawerShellSource, /event\.key === "Escape"/, "the shared shell must close on Escape");
assert.match(drawerShellSource, /document\.addEventListener\("pointerdown", onPointerDown, true\)/, "the shared shell must close from captured outside clicks");
const projectHeaderIndex = projectDrawerSource.indexOf("Open project");
const projectDatesIndex = projectDrawerSource.indexOf(">Dates<");
const projectCrewIndex = projectDrawerSource.indexOf(">Project crew<");
const projectColorIndex = projectDrawerSource.indexOf(">Color<");
assert.ok(projectHeaderIndex >= 0 && projectDatesIndex > projectHeaderIndex && projectCrewIndex > projectDatesIndex && projectColorIndex > projectCrewIndex, "project drawer sections must stay in Header -> Dates -> Project crew -> Color order");
assert.doesNotMatch(projectDrawerSource, /Back<\/button>|setMenuView|menuView/, "the project drawer must be one visible scrollable list with no sub-views or Back button");

const updateTaskStart = actionsSource.indexOf("export async function updateScheduleTask(");
const updateTaskEnd = actionsSource.indexOf("export async function", updateTaskStart + 1);
const updateTaskBody = actionsSource.slice(updateTaskStart, updateTaskEnd);
assert.match(updateTaskBody, /updateScheduleTaskInTransaction\(/, "the authenticated action must delegate to the canonical mutation core");
assert.match(taskCoreSource, /nextStatus === "Blocked"/, "the mutation core must enforce Blocked as a domain invariant");
assert.match(taskCoreSource, /Blocked tasks require a reason/, "Blocked must reject an empty reason server-side");
assert.match(taskCoreSource, /updateData\.blockedReason = null/, "moving away from Blocked must clear its reason");

// Board creation is one proper shared modal and reuses the exact crew checklist
// presentation used by the quick menus, including the lead-star affordance.
assert.match(taskCreationDialogSource, /import \{ CrewChecklist/, "TaskCreationDialog must reuse CrewChecklist");
assert.match(taskCreationDialogSource, /<CrewChecklist/, "TaskCreationDialog must render CrewChecklist instead of a separate crew UI");
assert.match(taskCreationDialogSource, /getScheduleCrewMembers\(\)/, "TaskCreationDialog must request the server-filtered schedule crew list");
assert.doesNotMatch(taskCreationDialogSource, /getTeamMembers/, "TaskCreationDialog must not expose the broader staff roster to the client");
assert.match(taskCreationDialogSource, /value="appointment"/, "TaskCreationDialog must expose appointment creation");
assert.equal((boardSource.match(/<TaskCreationDialog/g) ?? []).length, 1, "ScheduleBoard must own exactly one shared creation dialog");

const getScheduleCrewStart = actionsSource.indexOf("export async function getScheduleCrewMembers(");
const getScheduleCrewEnd = actionsSource.indexOf("export async function", getScheduleCrewStart + 1);
const getScheduleCrewBody = actionsSource.slice(getScheduleCrewStart, getScheduleCrewEnd);
assert.match(getScheduleCrewBody, /await assertActiveStaff\(\)/, "schedule crew lookup must require an active staff session");
assert.match(getScheduleCrewBody, /hasPermission\(user, "schedules"\)/, "schedule crew lookup must require schedule access");
assert.match(getScheduleCrewBody, /status: "ACTIVATED", role: "FIELD_CREW"/, "schedule crew lookup must filter before returning roster data");

// Dispatch A2: Today/Week views + compact read-only exceptions strip.
for (const [name, source] of [
    ["DispatchView", dispatchViewSource],
    ["DispatchJobCard", dispatchJobCardSource],
    ["DispatchExceptions", dispatchStripSource],
    ["dispatchExceptions", dispatchExceptionsSource],
] as const) {
    assert.ok(source.length > 0, `${name} must exist`);
    if (name !== "DispatchExceptions") {
        assert.doesNotMatch(source, /framer-motion/, `${name} must keep Motion out of schedule geometry and derivation`);
    }
    assert.doesNotMatch(source, /FloatingPopover|openMenu|contextmenu/i, `${name} must use the shared drawer seam, not a new menu system`);
    if (/opacity-0/.test(source)) assert.match(source, /\[@media\(hover:none\)\]:opacity-100/, `${name} hover-reveal controls must stay visible on no-hover devices`);
}

// Motion is confined to status surfaces, drawer/dialog entrance, and the
// Dispatch exceptions strip. Schedule geometry remains plain React/DOM.
assert.match(boardSource, /<MotionConfig reducedMotion="user">/, "the schedule board must honor the user's reduced-motion preference");
assert.match(boardSource, /data-motion-scope="status-change"/, "draft/refresh status changes must use the narrow status transition scope");
assert.match(drawerShellSource, /<motion\.aside/, "the shared drawer shell must animate both drawers' entrance");
assert.match(dialogSource, /<motion\.div[\s\S]{0,220}data-motion-scope="dialog-enter"/, "the save-time confirmation dialog must animate its entrance");
assert.match(taskCreationDialogSource, /<motion\.div[\s\S]{0,220}data-motion-scope="dialog-enter"/, "the shared creation dialog must animate its entrance");
assert.match(dispatchStripSource, /<motion\.div[\s\S]{0,220}data-motion-scope="exceptions-strip"/, "the exceptions strip must use its narrow transition scope");
assert.doesNotMatch(scheduleBoardSourceTree, /<motion\.[^>]*\s(?:layout|layoutId)=/, "Framer Motion layout and layoutId props are forbidden everywhere under schedule-board/");
assert.doesNotMatch(scheduleBoardSourceTree, /<motion\.[^>]*\sdrag(?:=|\s)/, "Motion drag props are forbidden everywhere under schedule-board/");
for (const [name, source] of [
    ["TaskBlockSegment", taskBlockSource],
    ["ProjectBar", projectBarSource],
    ["MonthBarsView", monthSource],
    ["TimelineView", timelineSource],
    ["UnscheduledTray", traySource],
] as const) {
    assert.doesNotMatch(source, /from "framer-motion"|<motion\./, `${name} dragged schedule geometry must never be a Motion component`);
}

// PR-A3 step 7: Vancouver weather is a separate, failure-safe payload. It is
// cached for one hour, fetched concurrently with core dashboard data, and
// rendered by date in all three schedule views without widening schedule-core.
assert.ok(weatherSource.length > 0, "src/lib/weather.ts must exist");
for (const [name, source] of [["weather", weatherSource], ["Month", monthSource], ["Timeline", timelineSource], ["Dispatch", dispatchViewSource]] as const) {
    assert.doesNotMatch(source, /Â|Ã|â€“|ðŸ/, `${name} weather copy and glyphs must not contain mojibake`);
}
assert.match(weatherSource, /import \{ unstable_cache \} from "next\/cache"/);
assert.match(weatherSource, /latitude=45\.6617&longitude=-122\.5484/, "the forecast must stay pinned to Vancouver, WA");
for (const dailyField of ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max"]) {
    assert.match(weatherSource, new RegExp(dailyField), `Open-Meteo daily field ${dailyField} must be requested`);
}
assert.match(weatherSource, /forecast_days=10/);
assert.match(weatherSource, /temperature_unit=fahrenheit/);
assert.match(weatherSource, /const controller = new AbortController\(\);[\s\S]{0,180}controller\.abort\(\), 3_000\)/, "weather fetches must abort after about three seconds");
const weatherFetchStart = weatherSource.indexOf("async function fetchVancouverWeather(");
const weatherFetchEnd = weatherSource.indexOf("const getCachedVancouverWeather", weatherFetchStart);
const weatherFetchBody = weatherSource.slice(weatherFetchStart, weatherFetchEnd);
assert.ok(weatherFetchStart >= 0, "the uncached weather fetcher must exist");
assert.match(weatherFetchBody, /try \{[\s\S]*await fetch\(/, "the provider fetch must be wrapped");
assert.match(weatherFetchBody, /catch \{[\s\S]{0,80}return null;/, "provider failures must return null");
assert.match(weatherFetchBody, /finally \{[\s\S]{0,100}clearTimeout\(timeoutId\)/, "the abort timer must always be cleared");
assert.match(weatherSource, /unstable_cache\([\s\S]*\["vancouver-wa-weather"\][\s\S]*revalidate: 3_600/, "weather must use a stable one-hour cache");
assert.match(weatherSource, /export async function getVancouverWeather\(\)[\s\S]*try \{[\s\S]*getCachedVancouverWeather\(\)[\s\S]*catch \{[\s\S]*return null;/, "cache-layer failures must also degrade to null");
assert.match(weatherSource, /export function weatherCodeToGlyph\(/, "WMO weather codes must map through one glyph helper");
assert.doesNotMatch(coreSource, /VancouverForecastDay|weatherForecast/, "weather must not widen the core scheduling contract");

assert.match(companyDashboardPageSource, /Promise\.all\(\[[\s\S]*getCompanyDashboardData\([\s\S]*getVancouverWeather\(\)[\s\S]*\]\)/, "dashboard data and weather must fetch concurrently");
assert.match(companyDashboardPageSource, /<CompanyDashboardClient data=\{data\} weather=\{weather \?\? \[\]\}/, "weather must be passed separately and failure must become an empty list");
assert.match(companyDashboardSource, /weather: VancouverForecastDay\[\]/, "the client boundary must carry the small separate weather array");
assert.match(companyDashboardSource, /<ScheduleBoard[\s\S]{0,180}weather=\{weather\}/, "the client must thread weather separately to ScheduleBoard");
assert.match(boardSource, /weather: VancouverForecastDay\[\]/, "ScheduleBoard must accept weather outside CompanyDashboardData");
assert.equal((boardSource.match(/weather=\{weather\}/g) ?? []).length, 3, "all three schedule views must receive the separate weather array");

assert.match(monthSource, /weatherByDate\.get\(dayKey\)/);
assert.match(monthSource, /absolute right-1\.5 top-1\.5/, "Month weather glyphs must stay quiet in the cell's top-right corner");
assert.match(timelineSource, />Vancouver<\/div>/, "Timeline forecast row must identify Vancouver explicitly");
assert.match(timelineSource, /aria-label="Vancouver 10-day forecast"/);
assert.match(dispatchViewSource, /Vancouver forecast/, "Dispatch weather must identify Vancouver");
assert.match(dispatchViewSource, /visibleWeekDays\s*\.map\(day => weatherByDate\.get\(formatDate\(day\)\)\)\s*\.find\(\(forecast\): forecast is VancouverForecastDay => Boolean\(forecast\)\)/, "Dispatch week summary must use the first visible forecast rather than an elapsed week-start day");
assert.match(dispatchViewSource, /\{forecast\.glyph\} \{forecast\.precipitationProbability\}% \{forecast\.high\}\{"\\u00B0"\}/, "Dispatch day headers must show glyph, rain probability, and high");

assert.match(boardSource, /import \{ DispatchView \} from "\.\/DispatchView"/, "ScheduleBoard must import the dispatch view");
assert.match(boardSource, /export type BoardView = "month" \| "timeline" \| "dispatch"/, "the persisted board view union must include dispatch");
assert.match(boardSource, /stored === "month" \|\| stored === "timeline" \|\| stored === "dispatch"/, "stored dispatch selection must restore");
assert.match(boardSource, /onClick=\{\(\) => selectBoardView\("dispatch"\)\}/, "the board toolbar must expose Dispatch beside Month and Timeline");
assert.match(boardSource, /boardView === "dispatch" \? \(/, "ScheduleBoard must render DispatchView from the persisted union");
assert.match(boardSource, /<DispatchView[\s\S]*?onActivate=\{handleBlockActivate\}/, "dispatch task activation must route through the one board drawer handler");
assert.equal((boardSource.match(/<BoardTaskDrawer/g) ?? []).length, 1, "dispatch must not create a second task drawer");
assert.equal((boardSource.match(/<TaskCreationDialog/g) ?? []).length, 1, "dispatch must reuse the one shared creation dialog");
assert.match(boardSource, /defaultProjectId=\{taskCreationDefaults\.defaultProjectId\}/, "dispatch project defaults must reach the shared creation dialog");
assert.match(boardSource, /defaultCrewIds=\{taskCreationDefaults\.defaultCrewIds\}/, "week-cell crew defaults must reach the shared creation dialog");
assert.match(boardSource, /lockProject=\{taskCreationDefaults\.lockProject\}/, "job-card creation must lock its project");

assert.match(dispatchViewSource, /const DISPATCH_MODE_STORAGE_KEY = "gtr-company-schedule-dispatch-mode"/, "Today/Week mode must use its own stable storage key");
assert.match(dispatchViewSource, /localStorage\.getItem\(DISPATCH_MODE_STORAGE_KEY\)/);
assert.match(dispatchViewSource, /localStorage\.setItem\(DISPATCH_MODE_STORAGE_KEY, nextMode\)/);
assert.match(dispatchViewSource, /type DispatchMode = "today" \| "week"/);
assert.match(dispatchViewSource, /overflow-x-auto/, "the week grid must scroll inside its own container");
assert.match(dispatchViewSource, /member\.role === "FIELD_CREW"/, "the dispatch roster and available bench must be FIELD_CREW-only");
assert.match(dispatchViewSource, /assignment\.userRole === "ADMIN" \|\| assignment\.userRole === "MANAGER"/, "manager support must be derived separately from task assignments");
assert.match(dispatchViewSource, /Manager support/, "manager assignments must render on a separate muted line");
assert.match(dispatchViewSource, /isConflictedDay\(crewConflicts, member\.id, dayKey, true\)/, "week conflict rings must import the canonical conflict-window helper and require two solid assignments");
assert.match(dispatchViewSource, /defaultCrewIds: \[member\.id\]/, "an empty week cell must prefill that person");
assert.match(dispatchViewSource, /defaultProjectId: project\.id[\s\S]{0,100}lockProject: true/, "a job-card + Task must prefill and lock its project");

assert.match(dispatchJobCardSource, /onActivate\(task\.id\)/, "task details in a job card must open the shared drawer");
assert.match(dispatchJobCardSource, /href=\{`\/projects\/\$\{project\.id\}`\}/, "job-card project names must link to the project");
assert.match(dispatchJobCardSource, /assignmentRole === "lead"/, "today crew chips must mark the task lead");
assert.match(dispatchJobCardSource, /doneWhen/, "today task rows must show completion criteria");
assert.match(dispatchJobCardSource, /blockedReason/, "blocked status must expose its reason");

assert.match(dispatchExceptionsSource, /import \{ isConflictedDay \} from "\.\/availability"/, "dispatch conflicts must reuse the extracted canonical helper");
for (const functionName of ["getUnstaffedToday", "getNoLeadToday", "getTodayConflicts", "getBlockedTasks", "getCrewlessJobs"]) {
    assert.match(dispatchExceptionsSource, new RegExp(`export function ${functionName}\\(`), `${functionName} must be a pure exported exception derivation`);
}
assert.match(dispatchStripSource, /getDispatchExceptions/, "the exceptions strip must derive through the shared pure module");
assert.match(dispatchStripSource, /Day clear/, "the exceptions strip needs the subtle clear-day empty state");
assert.match(dispatchStripSource, /Unstaffed today/);
assert.match(dispatchStripSource, /No lead/);
assert.match(dispatchStripSource, /Conflict/);
assert.match(dispatchStripSource, /Blocked/);
assert.match(dispatchStripSource, /Crewless job/);

assert.match(availabilityPanelSource, /import \{[\s\S]{0,180}buildAvailabilityRows,[\s\S]{0,180}isConflictedDay,[\s\S]{0,180}from "\.\/availability"/, "AvailabilityPanel must consume extracted pure derivation helpers");
assert.doesNotMatch(availabilityPanelSource, /function buildAvailabilityRows|function isConflictedDay/, "availability derivation must have one shared source");
assert.match(availabilityHelpersSource, /export function buildAvailabilityRows/);
assert.match(availabilityHelpersSource, /export function isConflictedDay/);

assert.match(coreSource, /location: string \| null;/, "dispatch cards need a serialized project location");
assert.match(coreSource, /doneWhen: string \| null;/, "dispatch cards need completion criteria");
assert.match(coreSource, /blockedReason: string \| null;/, "dispatch cards need blocked reasons");
assert.match(coreSource, /scheduledTime: string \| null;/, "dispatch appointments need their scheduled time");
assert.match(coreSource, /confirmationStatus: string \| null;/, "dispatch appointments need confirmation status");
assert.match(coreSource, /doneWhen: true, blockedReason: true, scheduledTime: true, confirmationStatus: true/, "the dashboard task query must select every dispatch field");

// PR-B1: Month/Timeline retain the intentionally-partial chunked Save path,
// while Dispatch owns one atomic review-and-queue gesture.
assert.ok(dispatchIntentSource.length > 0, "the pure dispatch intent/diff module must exist");
assert.ok(dispatchPublicationSource.length > 0, "the atomic dispatch publication core must exist");
assert.ok(dispatchReviewDialogSource.length > 0, "the Dispatch review dialog must exist");
assert.match(actionsSource, /export async function publishDispatchAction\(/, "actions.ts must expose one authenticated Dispatch publication wrapper");
assert.match(actionsSource, /return publishDispatch\(/, "the wrapper must delegate to the session-free atomic core");

const publishDispatchStart = boardSource.indexOf("async function publishDispatchDrafts()");
const publishDispatchEnd = boardSource.indexOf("function cancelProjectEditsForProjects", publishDispatchStart);
const publishDispatchBody = boardSource.slice(publishDispatchStart, publishDispatchEnd);
assert.ok(publishDispatchStart >= 0, "ScheduleBoard must own the atomic Dispatch publication gesture");
assert.match(publishDispatchBody, /publishDispatchAction\(/, "Dispatch must call the atomic action");
assert.doesNotMatch(
    publishDispatchBody,
    /saveCompanyScheduleTaskDatesAction|updateProjectStartDateAction|shiftNotStartedTasksAction/,
    "Dispatch must never compose the existing partial Save actions",
);
assert.equal(
    (publishDispatchBody.match(/publishDispatchAction\(/g) ?? []).length,
    1,
    "one Dispatch confirmation must issue exactly one atomic action call",
);
assert.match(boardSource, /interface DispatchReconciliationExpectation \{[\s\S]*publicationId: string;[\s\S]*projects: Record<[\s\S]*tasks: Record<[\s\S]*assignments: Record</, "publication-scoped reconciliation must cover projects, tasks, and assignments");
assert.match(boardSource, /setDispatchReconciliationExpectation\(/, "successful publication must pin one publication expectation");
assert.match(boardSource, /Dispatch changed while you were reviewing\. Nothing was queued\. Your drafts are still here\./, "stale UX must preserve and explain drafts");
assert.match(boardSource, /boardView !== "dispatch"[\s\S]{0,400}saveAllDrafts/, "Month/Timeline must retain the existing Save gesture");
assert.match(boardSource, /boardView === "dispatch"[\s\S]{0,500}<DispatchView/, "Dispatch must receive its own view-scoped publication control");
assert.match(boardSource, /<DispatchReviewDialog/, "ScheduleBoard must own the review dialog beside its draft maps");

assert.match(dispatchViewSource, /onReviewDispatch: \(\) => void;/, "DispatchView must accept the CTA callback without owning draft state");
assert.match(dispatchViewSource, /Review dispatch/, "Dispatch CTA copy must not use Publish");
assert.doesNotMatch(dispatchViewSource, /taskDateOverrides|projectDrafts|DispatchIntent/, "DispatchView must not own or construct drafts");
assert.match(dispatchReviewDialogSource, /Confirm & queue dispatch/, "B1 confirmation copy must describe queueing");
assert.match(dispatchReviewDialogSource, /Dispatch recorded [—-] delivery pending/, "the success state must be honest about deferred delivery");
assert.doesNotMatch(dispatchReviewDialogSource, />\s*Publish\s*</, "Dispatch UI must not use the ambiguous Publish label");

// Revisions are serialized so previews can carry complete optimistic snapshots.
assert.match(coreSource, /updatedAt: string;/, "dashboard project/task contracts must expose revisions");
assert.match(coreSource, /id: true, projectId: true, name: true, startDate: true, endDate: true,[^\n]*updatedAt: true/, "the dashboard task query must select updatedAt");
assert.match(coreSource, /updatedAt: task\.updatedAt\.toISOString\(\)/, "task revisions must serialize as ISO strings");

// PR-B2: crew assignment drafts are Dispatch-only and ride the existing
// atomic review/publication path. Month/Timeline retain immediate crew writes.
assert.match(boardSource, /interface CrewDraft \{[\s\S]*addUserIds: string\[\];[\s\S]*removeUserIds: string\[\];[\s\S]*expectedAssignments: DispatchAssignment\[\];/, "ScheduleBoard must define the complete crew-draft snapshot");
assert.match(boardSource, /const \[crewDrafts, setCrewDrafts\] = useState<Record<string, CrewDraft>>\(\{\}\)/, "ScheduleBoard must own crew drafts beside its existing draft maps");
assert.match(boardSource, /function queueCrewAddition\(taskId: string, userId: string\)/, "crew additions must route through the board-owned draft writer");
assert.match(boardSource, /function queueCrewRemoval\(taskId: string, userId: string\)/, "crew removals must route through the board-owned draft writer");
assert.match(boardSource, /setCrewDrafts\(\{\}\)/, "Discard must clear unsaved crew drafts");
assert.match(boardSource, /crewDraftTaskIds/, "crew-drafted task owners must join draft counting and project unions");
assert.match(boardSource, /kind: "TASK_CREW"/, "dispatch intent collection must emit crew intents");
assert.match(publishDispatchBody, /intent\.kind === "TASK_CREW"/, "successful publication must identify and clear published crew drafts");
assert.match(boardSource, /onDraftCrewAdd=\{queueCrewAddition\}/, "DispatchView must receive the board-owned crew add callback");
assert.match(boardSource, /onDraftCrewRemove=\{queueCrewRemoval\}/, "DispatchView must receive the board-owned crew remove callback");

assert.match(dispatchViewSource, /function handleCrewPointerDragStart\(/, "Dispatch must use the board-style pointer drag machine for crew chips");
assert.match(dispatchViewSource, /const CREW_MOUSE_DRAG_THRESHOLD_PX = 5;/);
assert.match(dispatchViewSource, /const CREW_TOUCH_DRAG_THRESHOLD_PX = 8;/);
assert.match(dispatchViewSource, /createDragVisualLayer\(/, "crew drag must use the detached visual layer");
assert.match(dispatchViewSource, /window\.addEventListener\("keydown", onWindowKeyDown\)/, "Escape must cancel crew pointer drags");
assert.match(dispatchViewSource, /data-dispatch-crew-chip/, "Dispatch crew sources need stable drag metadata");
assert.match(dispatchJobCardSource, /data-dispatch-crew-chip/, "solid and outlined job-card crew chips must be drag sources");
assert.match(dispatchJobCardSource, /data-dispatch-task-id=\{task\.id\}/, "Today task rows must be direct crew drop targets");
assert.match(dispatchViewSource, /data-dispatch-week-cell/, "Week person/day cells must expose crew drop context");
assert.match(dispatchJobCardSource, /border-dashed/, "drafted additions must preserve solid chips with a dashed ring");
assert.match(dispatchJobCardSource, /\[@media\(hover:none\)\]:opacity-100/, "crew remove affordances must remain visible on no-hover devices");
assert.ok(dispatchCrewTaskChooserSource.length > 0, "the shared crew task chooser must exist");
assert.match(dispatchCrewTaskChooserSource, /import \{ FloatingPopover \} from "\.\/FloatingPopover"/, "pointer and keyboard crew choices must reuse FloatingPopover");
assert.match(dispatchCrewTaskChooserSource, /anchorPoint=/, "drop ambiguity must anchor the chooser at the release point");
assert.match(dispatchCrewTaskChooserSource, /anchorRef=/, "Enter must anchor the same chooser to the focused chip");
for (const [name, source] of [["Month", monthSource], ["Timeline", timelineSource]] as const) {
    assert.doesNotMatch(source, /crewDrafts|onDraftCrewAdd|onDraftCrewRemove|data-dispatch-crew-chip|handleCrewPointerDragStart/, `${name} must not gain Dispatch crew drafting`);
}

const projectCrewPickerStart = crewPickersSource.indexOf("export function CrewPicker(");
const projectCrewPickerEnd = crewPickersSource.indexOf("export function TaskCrewPicker(", projectCrewPickerStart);
const projectCrewPickerBody = crewPickersSource.slice(projectCrewPickerStart, projectCrewPickerEnd);
const taskCrewPickerStart = projectCrewPickerEnd;
const taskCrewPickerBody = crewPickersSource.slice(taskCrewPickerStart);
assert.match(projectCrewPickerBody, /await updateProjectCrewAction\(projectId, ids\)/, "Month/Timeline project crew remains immediate");
assert.match(taskCrewPickerBody, /await updateTaskCrewAction\(task\.id, ids\)/, "Month/Timeline task crew remains immediate");
assert.match(projectCrewPickerBody, /router\.refresh\(\)/);
assert.match(taskCrewPickerBody, /router\.refresh\(\)/);
assert.doesNotMatch(crewPickersSource, /crewDrafts|TASK_CREW|queueCrewAddition|queueCrewRemoval/, "shared Month/Timeline pickers must not know about Dispatch drafts");

// Task Bank must import, not re-derive, the canonical contract-estimate scope.
assert.match(coreSource, /export function canonicalContractEstimateQuery\(projectId: string\)/, "schedule-core must export the canonical estimate selector");
assert.match(coreSource, /export function deriveEstimateItemHours\(/, "Task Bank and generation must share the hours rule");
assert.match(actionsSource, /canonicalContractEstimateQuery[\s\S]*from "\.\/schedule-core"/, "actions must import the canonical estimate selector");
const getTaskBankStart = actionsSource.indexOf("export async function getTaskBank(");
const getTaskBankEnd = actionsSource.indexOf("export async function", getTaskBankStart + 1);
const getTaskBankBody = actionsSource.slice(getTaskBankStart, getTaskBankEnd);
assert.ok(getTaskBankStart >= 0, "the authenticated Task Bank read action must exist");
assert.match(getTaskBankBody, /canonicalContractEstimateQuery\(projectId\)/);
assert.match(getTaskBankBody, /deriveEstimateItemHours\(/);
assert.doesNotMatch(getTaskBankBody, /CONTRACT_ESTIMATE_STATUSES|orderBy:\s*\{\s*createdAt/, "Task Bank must not re-derive canonical estimate selection");
const generateProjectScheduleStart = actionsSource.indexOf("export async function generateProjectScheduleAction(");
const generateProjectScheduleEnd = actionsSource.indexOf("export async function", generateProjectScheduleStart + 1);
const generateProjectScheduleBody = actionsSource.slice(generateProjectScheduleStart, generateProjectScheduleEnd);
assert.match(generateProjectScheduleBody, /canonicalContractEstimateQuery\(projectId\)/, "manual generation must use the same canonical selector as Task Bank");
assert.doesNotMatch(generateProjectScheduleBody, /CONTRACT_ESTIMATE_STATUSES|orderBy:\s*\{\s*createdAt/, "manual generation must not keep a second selector");
assert.ok(dispatchTaskBankSource.length > 0, "the collapsible Dispatch Task Bank rail must exist");
assert.match(dispatchTaskBankSource, /getTaskBank\(/);
assert.match(dispatchTaskBankSource, /Task bank/);
assert.match(dispatchTaskBankSource, /scheduledCount/);
assert.match(dispatchTaskBankSource, /totalCount/);
assert.match(dispatchTaskBankSource, /estimateItemId/);
assert.match(dispatchViewSource, /data\.pipeline\.inProgress\[0\]\?\.id/, "Task Bank selection must default to the first In Progress project");
assert.match(taskCreationDialogSource, /defaultName\?: string/);
assert.match(taskCreationDialogSource, /defaultEstimatedHours\?: number \| null/);
assert.match(taskCreationDialogSource, /estimateItemId\?: string/);
const createScheduleTaskStart = actionsSource.indexOf("export async function createScheduleTask(");
const createScheduleTaskEnd = actionsSource.indexOf("export async function updateScheduleTask(", createScheduleTaskStart);
const createScheduleTaskBody = actionsSource.slice(createScheduleTaskStart, createScheduleTaskEnd);
assert.match(createScheduleTaskBody, /createScheduleTaskInTransaction\(/, "the authenticated action must delegate to the canonical transaction-aware creator");
assert.match(taskCoreSource, /estimateItemId\?: string \| null/);
assert.match(taskCoreSource, /estimateItemId,/, "Task Bank creation must persist its normalized estimate-item back-link");

// A crew draft gates only immediate user-assignment controls in the drawer.
assert.match(boardSource, /const openTaskHasCrewDraft = Boolean\(openTaskId && crewDrafts\[openTaskId\]\)/);
assert.match(boardSource, /hasCrewDraft=\{openTaskHasCrewDraft\}/);
assert.match(drawerSource, /hasCrewDraft: boolean;/);
assert.match(drawerSource, /crewReadOnly=\{hasCrewDraft\}/);
assert.match(drawerSource, /crewReadOnlyNote="Crew changes are drafted for dispatch/, "the drawer must explain why immediate crew controls are disabled");
assert.match(detailPanelSource, /crewReadOnly\?: boolean;/);
assert.match(detailPanelSource, /crewReadOnlyNote\?: string;/);
assert.match(detailPanelSource, /\{crewReadOnly && crewReadOnlyNote && \(/, "the Team section must show the crew draft hint");
assert.match(detailPanelSource, /disabled=\{crewReadOnly\}/, "immediate add/lead/remove controls must be disabled by the crew draft gate");

assert.match(dispatchReviewDialogSource, /function crewChangeRows\(/, "crew audit changes must expand into person-level review rows");
assert.match(dispatchReviewDialogSource, /\(add\)/);
assert.match(dispatchReviewDialogSource, /removed from/);

console.log("schedule-board render contract verification: PASS");

// A3 reviewer-approved deltas, pinned so they stay deliberate:
// 1. Escape cancels an active POINTER drag (all three pointer machines wire a
//    window keydown handler) — additive UX approved in the A3 review round.
const escapeWirings = boardSource.match(/window\.addEventListener\("keydown", onWindowKeyDown\)/g) ?? [];
assert.ok(escapeWirings.length >= 3, "all three pointer-drag machines must wire the Escape-cancel keydown handler");
// 2. Drag sourceElement is the block/bar ROOT (not the resize handle) so the
//    ghost gets block geometry and touch-action:none covers the whole block.
assert.match(taskBlockSource, /sourceElement: rootRef\.current \?\? event\.currentTarget/, "task drags must source from the block root");
assert.match(projectBarSource, /sourceElement: rootRef\.current \?\? event\.currentTarget/, "project drags must source from the bar root");
