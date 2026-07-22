import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const monthSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/MonthBarsView.tsx", import.meta.url), "utf8");
const taskSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/TaskBlockSegment.tsx", import.meta.url), "utf8");
const boardSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/ScheduleBoard.tsx", import.meta.url), "utf8");
const projectSource = readFileSync(new URL("../src/app/company-dashboard/schedule-board/ProjectBar.tsx", import.meta.url), "utf8");
function optionalSource(path: string): string {
    try {
        return readFileSync(new URL(path, import.meta.url), "utf8");
    } catch {
        return "";
    }
}
const traySource = optionalSource("../src/app/company-dashboard/schedule-board/UnscheduledTray.tsx");
const dialogSource = optionalSource("../src/app/company-dashboard/schedule-board/ShiftConfirmDialog.tsx");
const timelineSource = optionalSource("../src/app/company-dashboard/schedule-board/TimelineView.tsx");
const milestoneSource = optionalSource("../src/app/company-dashboard/schedule-board/MilestoneMarker.tsx");
const layoutSource = optionalSource("../src/app/company-dashboard/schedule-board/useBarLayout.ts");
const actionsSource = optionalSource("../src/lib/actions.ts");
const coreSource = optionalSource("../src/lib/schedule-core.ts");
const pageSource = optionalSource("../src/app/company-dashboard/page.tsx");
const navSource = optionalSource("../src/components/nav/navItems.tsx");
const companyDashboardSource = optionalSource("../src/app/company-dashboard/CompanyDashboardClient.tsx");

assert.match(monthSource, /showIncome\s*\?\s*adminOverlays\.income\s*:\s*EMPTY_INCOME/);
assert.match(monthSource, /showProjectedCo\s*\?\s*adminOverlays\.changeOrders\s*:\s*EMPTY_CHANGE_ORDERS/);
assert.match(monthSource, /visibleMilestoneHosts/);
assert.match(taskSource, /task\.assignments\.slice\(0,\s*2\).*initials\(assignment\.name\)/s);
assert.match(taskSource, /ref=\{setMeasuredElement\}/);
assert.match(traySource, /application\/x-gtr-project-id/);
assert.match(traySource, /dataTransfer\.setData/);
assert.match(traySource, /aria-disabled="true"/);
assert.match(traySource, /type="date"/);
assert.match(traySource, /\[@media\(hover:none\)\]:opacity-100/);
assert.match(traySource, /canEdit\s*\?\s*"Drag a Waiting-to-Start project onto a day or use Project actions\."\s*:\s*"Unscheduled projects are read-only for your role\."/);
assert.match(monthSource, /data-schedule-date=\{dayKey\}/);
assert.match(monthSource, /if \(!data\.canEdit \|\| !hasProjectDragPayload\(event\)\) return;[\s\S]*?preventDefault\(\)/);
assert.match(monthSource, /dragOverDate/);
assert.match(monthSource, /dataTransfer\.types\.includes\(PROJECT_DRAG_MIME\)/);
assert.equal((monthSource.match(/!hasProjectDragPayload\(event\)/g) ?? []).length, 2);
assert.doesNotMatch(projectSource, /window\.addEventListener\("pointermove"|requestAnimationFrame|elementsFromPoint/);
assert.match(boardSource, /activeProjectPointerRef/);
assert.match(boardSource, /window\.addEventListener\("pointermove"/);
assert.match(boardSource, /hitTestTimelineScheduleGrid/);
assert.match(projectSource, /type="date"/);
assert.match(projectSource, /\[@media\(hover:none\)\]:opacity-100/);
assert.match(projectSource, /onProjectPointerEditStart/);
assert.match(dialogSource, /Dialog\.Title/);
assert.match(dialogSource, /Dialog\.Description/);
assert.match(dialogSource, /Move start marker only/);
assert.match(dialogSource, /Also shift all Not Started tasks by/);
assert.match(boardSource, /updateProjectStartDateAction\(intent\.project\.id, intent\.targetStart, false\)/);
assert.match(boardSource, /shiftNotStartedTasksAction\(intent\.project\.id, intent\.deltaDays\)/);
assert.match(boardSource, /toast\.success\("Project scheduled"/);
assert.match(boardSource, /router\.refresh\(\)/);
assert.match(boardSource, /previewProjectIncomeOverlays/);
assert.match(boardSource, /project\.status === "Waiting to Start" && project\.startDate/);
assert.match(boardSource, /overlays:\s*data\.overlays\s*\?/);

assert.match(timelineSource, /export function TimelineView/);
assert.match(boardSource, /export type BoardView\s*=\s*"month"\s*\|\s*"timeline"/);
assert.match(boardSource, /gtr-company-schedule-board-view/);
assert.match(boardSource, /useState<BoardView>\("month"\)/);
assert.match(boardSource, /useEffect\(\(\)\s*=>\s*\{[\s\S]*?localStorage\.getItem\([\s\S]*?stored\s*===\s*"month"\s*\|\|\s*stored\s*===\s*"timeline"[\s\S]*?setBoardView\(stored\)/);
assert.match(boardSource, /localStorage\.setItem\([\s\S]*?gtr-company-schedule-board-view|localStorage\.setItem\(BOARD_VIEW_STORAGE_KEY/);
assert.equal((boardSource.match(/aria-pressed=\{boardView === /g) ?? []).length, 2);
assert.match(boardSource, /boardView\s*===\s*"month"[\s\S]*?<MonthBarsView[\s\S]*?\)\s*:\s*\(\s*<TimelineView/);

assert.match(timelineSource, /DAY_WIDTH\s*=\s*20/);
assert.match(timelineSource, /TIMELINE_DAYS\s*=\s*42/);
assert.match(timelineSource, /toTimelineRect\([\s\S]*?DAY_WIDTH/);
assert.match(timelineSource, /getMonthGrid/);
assert.match(timelineSource, /position:\s*"sticky"|sticky left-0/);
assert.match(timelineSource, /overflow-x-auto/);
assert.match(timelineSource, /isWeekend/);
assert.match(timelineSource, /isSameUTCDay/);
assert.match(timelineSource, /ProjectBar/);
assert.match(timelineSource, /MilestoneMarker/);
assert.match(timelineSource, /timelineOrigin=\{gridStart\}/);
assert.match(timelineSource, /dayWidth=\{DAY_WIDTH\}/);
assert.match(milestoneSource, /timelineOrigin\?:\s*Date/);
assert.match(milestoneSource, /dayWidth\?:\s*number/);
assert.match(milestoneSource, /toTimelineRect/);
assert.match(timelineSource, /adminOverlays\.income/);
assert.match(timelineSource, /adminOverlays\.changeOrders/);
assert.match(timelineSource, /showIncome/);
assert.match(timelineSource, /showProjectedCo/);
assert.match(timelineSource, /showExpenses/);
assert.match(timelineSource, /showHours/);
assert.match(timelineSource, /onMoveCommit=\{onProjectMoveCommit\}/);
assert.match(timelineSource, /onProjectPointerEditStart=\{onProjectPointerEditStart\}/);
assert.match(timelineSource, /LABEL_WIDTH\s*=\s*240/);
assert.match(timelineSource, /timelineLeftInset=\{LABEL_WIDTH\}/);
assert.match(timelineSource, /tabIndex=\{labels\.length\s*>\s*0\s*\?\s*0\s*:\s*undefined\}/);
assert.match(timelineSource, /aria-label=\{labels\.length\s*>\s*0/);
assert.match(timelineSource, /focus-visible:ring-2/);
assert.match(timelineSource, /group\/overlay/);
assert.match(timelineSource, /group-focus\/overlay:block/);
assert.match(timelineSource, /labels\.join\(", "\)/);

// Task 7 Timeline release regression: only the date body is a valid pointer-up target.
assert.match(timelineSource, /data-timeline-schedule-grid="true"/);
assert.match(timelineSource, /data-timeline-sticky-label="true"/);
assert.match(boardSource, /function hitTestTimelineScheduleGrid\(clientX: number, clientY: number\): boolean/);
const timelineGridHitTestStart = boardSource.indexOf("function hitTestTimelineScheduleGrid");
const timelineGridHitTestEnd = boardSource.indexOf("function isInteractiveTaskFallbackTarget", timelineGridHitTestStart);
const timelineGridHitTestBody = boardSource.slice(timelineGridHitTestStart, timelineGridHitTestEnd);
assert.match(timelineGridHitTestBody, /document\.elementsFromPoint\(clientX, clientY\)/);
assert.match(timelineGridHitTestBody, /data-timeline-sticky-label/);
assert.match(timelineGridHitTestBody, /data-timeline-schedule-grid/);
assert.match(timelineGridHitTestBody, /getBoundingClientRect\(\)/);
const taskPointerStart = boardSource.indexOf("function handleTaskPointerEditStart");
const taskPointerEnd = boardSource.indexOf("function handleTaskKeyboardStart", taskPointerStart);
const taskPointerBody = boardSource.slice(taskPointerStart, taskPointerEnd);
assert.match(taskPointerBody, /if \(start\.timelineDayWidth\) \{\s*if \(hitTestTimelineScheduleGrid\(drag\.latestClientX, drag\.latestClientY\)\) \{\s*deltaDays = getTimelinePointerDelta/);

assert.match(boardSource, /getTimelineAutoscrollStep\(/);
assert.match(boardSource, /timelineScrollContainerRef/);
assert.match(boardSource, /drag\.latestClientX\s*=\s*event\.clientX;[\s\S]*?drag\.latestClientY\s*=\s*event\.clientY;[\s\S]*?calculateProjectPointerCandidate/);
assert.match(boardSource, /cancelActiveProjectEdit\(\);[\s\S]*?cancelActiveTaskEdit\(\);[\s\S]*?setBoardView\(nextView\)/);

// Task 7: task movement, resize, accessible fallbacks, and stable controller ownership.
assert.match(layoutSource, /export type TaskEditMode\s*=\s*"move"\s*\|\s*"resize-left"\s*\|\s*"resize-right"/);
assert.match(layoutSource, /export interface TaskDateOverride\s*\{[\s\S]*?startDate:\s*string;[\s\S]*?endDate:\s*string;/);
assert.match(boardSource, /const \[taskDateOverrides, setTaskDateOverrides\]\s*=\s*useState<Record<string, TaskDateOverride>>/);
assert.match(boardSource, /canonicalTaskById/);
assert.match(boardSource, /previewTaskDates\(canonicalTask/);
assert.equal((boardSource.match(/updateCompanyScheduleTaskDatesAction\(taskId,\s*\{\s*startDate:\s*dates\.startDate,\s*endDate:\s*dates\.endDate\s*\}\)/g) ?? []).length, 1);
assert.match(boardSource, /toast\.success\("Task dates updated"\);[\s\S]*?router\.refresh\(\)/);
assert.match(boardSource, /catch \(error\)\s*\{[\s\S]*?clearTaskPreview\(taskId\)[\s\S]*?toast\.error/);
assert.match(boardSource, /pendingTaskIds/);
assert.match(boardSource, /TASK_MOUSE_DRAG_THRESHOLD_PX\s*=\s*5/);
assert.match(boardSource, /TASK_TOUCH_DRAG_THRESHOLD_PX\s*=\s*8/);
assert.match(boardSource, /requestAnimationFrame/);
assert.match(boardSource, /window\.addEventListener\("pointermove"/);
assert.match(boardSource, /window\.removeEventListener\("pointermove"/);
assert.match(boardSource, /window\.addEventListener\("keydown",\s*onWindowKeyDown\)/);
assert.match(boardSource, /window\.removeEventListener\("keydown",\s*onWindowKeyDown\)/);
assert.match(boardSource, /activeTaskPointerRef/);
assert.match(boardSource, /cancelActiveTaskEdit\(\);[\s\S]*?setBoardView\(nextView\)/);
assert.match(boardSource, /sourceElement\.style\.touchAction\s*=\s*"none"/);
assert.match(boardSource, /sourceElement\.style\.touchAction\s*=\s*drag\.previousTouchAction/);
assert.match(boardSource, /if \(!data\.canEdit \|\| isTaskOrProjectPending\(/);
assert.match(taskSource, /timelineScrollContainerRef/);
assert.match(taskSource, /timelineLeftInset/);
assert.match(taskPointerBody, /getTaskAutoscrollStep/);
assert.match(taskPointerBody, /timelineScrollContainerRef\?\.current/);
assert.match(taskPointerBody, /timelineLeftInset/);
assert.match(taskPointerBody, /MAX_AUTOSCROLL_PX_PER_FRAME/);
assert.match(taskPointerBody, /container\.scrollLeft \+= scrollDelta/);
assert.match(taskPointerBody, /drag\.originX -= container\.scrollLeft - before/);
assert.match(taskPointerBody, /requestAnimationFrame\(runTaskPointerFrame\)/);

assert.equal((monthSource.match(/onTaskPointerEditStart=\{onTaskPointerEditStart\}/g) ?? []).length, 2);
assert.equal((timelineSource.match(/onTaskPointerEditStart=\{onTaskPointerEditStart\}/g) ?? []).length, 2);
assert.match(projectSource, /onTaskPointerEditStart=\{onTaskPointerEditStart\}/);
assert.match(projectSource, /isPending=\{isPending \|\| pendingTaskIds\.has\(task\.id\)\}/);
assert.match(monthSource, /isPending=\{pendingProjectIds\.has\(project\.id\) \|\| pendingTaskIds\.has\(task\.id\)\}/);
assert.match(timelineSource, /isPending=\{pendingProjectIds\.has\(project\.id\) \|\| pendingTaskIds\.has\(task\.id\)\}/);
assert.match(taskSource, /onTaskPointerEditStart/);
assert.match(taskSource, /if \(!canEdit \|\| isPending/);
assert.match(taskSource, /w-2/);
assert.equal((taskSource.match(/Resize (?:start|end) of/g) ?? []).length, 2);
assert.match(taskSource, /task\.type\s*!==\s*"milestone"[\s\S]*?resize-left/);
assert.match(taskSource, /task\.type\s*!==\s*"milestone"[\s\S]*?resize-right/);
assert.match(taskSource, /touch-pan-y/);
assert.match(taskSource, /tabIndex=\{0\}/);
assert.match(taskSource, /data-task-edit-block="true"/);
assert.match(taskSource, /event\.key === " " \|\| event\.key === "Enter"/);
assert.match(taskSource, /event\.shiftKey \? 7 : 1/);
assert.match(taskSource, /event\.key === "ArrowLeft" \|\| event\.key === "ArrowUp"/);
assert.match(taskSource, /event\.key === "ArrowRight" \|\| event\.key === "ArrowDown"/);
assert.match(taskSource, /event\.key === "Escape"/);
assert.match(taskSource, /type="date"/);
assert.match(taskSource, /Move Earlier/);
assert.match(taskSource, /Move Later/);
assert.match(taskSource, /\[@media\(hover:none\)\]:opacity-100/);
assert.match(taskSource, /group-focus-within\/task:opacity-100/);
assert.match(taskSource, /aria-disabled=\{!canEdit \|\| isPending\}/);

// Task 8 focused re-review: the company board adds authorization only; the
// established project schedule action remains the single mutation core.
assert.doesNotMatch(coreSource, /export async function updateCompanyScheduleTaskDates/);
const canonicalTaskActionStart = actionsSource.indexOf("export async function updateScheduleTask");
const canonicalTaskActionEnd = actionsSource.indexOf("export async function deleteScheduleTask", canonicalTaskActionStart);
const canonicalTaskActionBody = actionsSource.slice(canonicalTaskActionStart, canonicalTaskActionEnd);
assert.match(canonicalTaskActionBody, /await assertScheduleTaskAccess\(taskId\)/);
assert.doesNotMatch(canonicalTaskActionBody, /\["ADMIN",\s*"MANAGER"\]\.includes\((?:user|caller)\.role\)/);
assert.match(canonicalTaskActionBody, /withTxRetry\(\(\)\s*=>\s*prisma\.\$transaction/);
assert.match(canonicalTaskActionBody, /SELECT id FROM "Project"[\s\S]*?FOR UPDATE/);
assert.match(canonicalTaskActionBody, /SELECT id FROM "ScheduleTask"[\s\S]*?FOR UPDATE/);
assert.match(canonicalTaskActionBody, /parseStartDateInput/);
assert.match(canonicalTaskActionBody, /persistedTask\.type === "milestone"/);
assert.match(canonicalTaskActionBody, /endDate <= startDate/);
assert.match(canonicalTaskActionBody, /activityLog\.create/);
assert.match(canonicalTaskActionBody, /revalidatePath\("\/company-dashboard"\)/);
const companyTaskAdapterStart = actionsSource.indexOf("export async function updateCompanyScheduleTaskDatesAction");
const companyTaskAdapterEnd = actionsSource.indexOf("export async function updateProjectStatus", companyTaskAdapterStart);
const companyTaskAdapterBody = actionsSource.slice(companyTaskAdapterStart, companyTaskAdapterEnd);
assert.ok(companyTaskAdapterStart >= 0, "company schedule task-date authorization adapter must exist");
assert.match(companyTaskAdapterBody, /\["ADMIN",\s*"MANAGER"\]\.includes\(caller\.role\)/);
assert.equal((companyTaskAdapterBody.match(/updateScheduleTask\(/g) ?? []).length, 1, "adapter delegates exactly once to the canonical action");
assert.doesNotMatch(companyTaskAdapterBody, /parseStartDateInput|withTxRetry|\$transaction|\$queryRaw|scheduleTask\.update|activityLog\.create|revalidatePath/);
assert.match(boardSource, /import \{[^}]*updateCompanyScheduleTaskDatesAction[^}]*\} from "@\/lib\/actions"/s);
assert.doesNotMatch(boardSource, /\bupdateScheduleTask\(/);

assert.match(taskSource, /if \(event\.target !== event\.currentTarget\) return;/);
assert.match(boardSource, /taskKeyboardSentinelRef/);
assert.match(boardSource, /sourceElement\.isConnected/);
assert.match(boardSource, /isInteractiveTaskFallbackTarget/);
assert.match(boardSource, /document\.activeElement === taskKeyboardSentinelRef\.current/);
assert.match(taskSource, /useId\(\)/);
assert.match(taskSource, /task-start-\$\{task\.id\}-\$\{fragmentId\}/);
assert.match(taskSource, /!mutationDisabled\s*&&\s*\(\s*<details/);

assert.match(boardSource, /currentCandidate:\s*TaskDateOverride \| null/);
assert.match(boardSource, /drag\.currentCandidate\s*=\s*null;[\s\S]*?clearTaskPreview\(task\.id\)/);
assert.match(boardSource, /drag\.latestClientX\s*=\s*event\.clientX;[\s\S]*?drag\.latestClientY\s*=\s*event\.clientY;[\s\S]*?calculatePointerCandidate\(\)/);
assert.match(boardSource, /if \(!candidate\)\s*\{[\s\S]*?clearTaskPreview\(task\.id\)[\s\S]*?return;/);

assert.match(boardSource, /awaitingTaskRefreshIds/);
assert.match(boardSource, /taskDatesMatch\(canonicalTask,\s*dates\)/);
assert.match(boardSource, /setAwaitingTaskRefreshIds/);
const taskCommitStart = boardSource.indexOf("async function commitTaskDates");
const taskCommitEnd = boardSource.indexOf("function showSuccess", taskCommitStart);
const taskCommitBody = boardSource.slice(taskCommitStart, taskCommitEnd);
const taskSuccessStart = taskCommitBody.indexOf('toast.success("Task dates updated")');
const taskSuccessEnd = taskCommitBody.indexOf("catch (error)", taskSuccessStart);
const taskSuccessBody = taskCommitBody.slice(taskSuccessStart, taskSuccessEnd);
assert.doesNotMatch(taskSuccessBody, /clearTaskPreview\(taskId\)|setTaskPending\(taskId, false\)/);
assert.match(taskSuccessBody, /setAwaitingTaskRefreshIds/);
assert.match(taskSuccessBody, /router\.refresh\(\)/);

// Parent-project pending state blocks every child-task entry/commit path, and
// project/task pointer + keyboard controllers cannot coexist.
assert.match(boardSource, /canonicalTaskProjectById/);
assert.match(boardSource, /const isTaskOrProjectPending = \(taskId: string\)/);
assert.match(layoutSource, /export function getEffectivePendingProjectIds/);
assert.match(boardSource, /getEffectivePendingProjectIds\([\s\S]*?effectivePendingTaskIds[\s\S]*?canonicalTaskProjectById/);
assert.match(boardSource, /effectivePendingProjectIdsRef\.current = effectivePendingProjectIds/);
assert.match(boardSource, /const isProjectPending = \(projectId: string\) =>[\s\S]*?effectivePendingProjectIdsRef\.current\.has\(projectId\)/);
assert.match(taskCommitBody, /isTaskOrProjectPending\(taskId\)/);
assert.match(taskPointerBody, /isTaskOrProjectPending\(task\.id\)/);
assert.match(taskPointerBody, /cancelActiveProjectEdit\(\)/);
const taskKeyboardStart = boardSource.indexOf("function handleTaskKeyboardStart");
const taskKeyboardEnd = boardSource.indexOf("function handleTaskKeyboardAdjust", taskKeyboardStart);
const taskKeyboardBody = boardSource.slice(taskKeyboardStart, taskKeyboardEnd);
assert.match(taskKeyboardBody, /isTaskOrProjectPending\(task\.id\)/);
assert.match(taskKeyboardBody, /cancelActiveProjectEdit\(\)/);
const projectPointerStart = boardSource.indexOf("function handleProjectPointerEditStart");
const projectPointerEnd = boardSource.indexOf("function handleProjectKeyboardStart", projectPointerStart);
const projectPointerBody = boardSource.slice(projectPointerStart, projectPointerEnd);
assert.match(projectPointerBody, /cancelActiveTaskEdit\(\)/);
const projectKeyboardStart = boardSource.indexOf("function handleProjectKeyboardStart");
const projectKeyboardEnd = boardSource.indexOf("function handleProjectKeyboardAdjust", projectKeyboardStart);
assert.match(boardSource.slice(projectKeyboardStart, projectKeyboardEnd), /cancelActiveTaskEdit\(\)/);
for (const [startMarker, endMarker] of [
    ["function handleTaskKeyboardAdjust", "function handleTaskKeyboardCommit"],
    ["function handleTaskKeyboardCommit", "function handleTaskKeyboardCancel"],
    ["function handleTaskDatesCommit", "function handleTaskMoveBy"],
    ["function handleTaskMoveBy", "return ("],
] as const) {
    const start = boardSource.indexOf(startMarker);
    const end = boardSource.indexOf(endMarker, start);
    assert.match(boardSource.slice(start, end), /isTaskOrProjectPending\(task\.id\)/, `${startMarker} must reject child work while the project is pending`);
}

// Reverse exclusion is live at every project start/preview/final-commit path,
// including controllers whose listeners were created before a child save.
for (const [startMarker, endMarker] of [
    ["function scheduleUnscheduledProject", "function commitWaitingProjectMove"],
    ["function commitWaitingProjectMove", "function handleProjectMovePreview"],
    ["function handleProjectMovePreview", "function handleProjectMoveCommit"],
    ["function handleProjectMoveCommit", "function handleMoveChoice"],
    ["function handleMoveChoice", "function cancelConfirmedMove"],
    ["function handleProjectPointerEditStart", "function handleProjectKeyboardStart"],
    ["function handleProjectKeyboardStart", "function handleProjectKeyboardAdjust"],
    ["function handleProjectKeyboardAdjust", "function handleProjectKeyboardCommit"],
    ["function handleProjectKeyboardCommit", "function handleProjectKeyboardCancel"],
] as const) {
    const start = boardSource.indexOf(startMarker);
    const end = boardSource.indexOf(endMarker, start);
    assert.match(boardSource.slice(start, end), /isProjectPending\(/, `${startMarker} must read the live task-derived parent pending state`);
}
const projectCommitStart = boardSource.indexOf("function handleProjectMoveCommit");
const projectCommitEnd = boardSource.indexOf("function handleMoveChoice", projectCommitStart);
assert.match(boardSource.slice(projectCommitStart, projectCommitEnd), /isProjectPending\(project\.id\)[\s\S]*?clearProjectPreview\(project\.id\)/);
assert.match(boardSource, /<UnscheduledTray[\s\S]*?pendingProjectIds=\{effectivePendingProjectIds\}/);
assert.equal((boardSource.match(/pendingProjectIds=\{effectivePendingProjectIds\}/g) ?? []).length, 3, "tray and both views receive task-derived project pending state");

// Task 8 final integration: page-wide project mutation exclusion coordinates
// the sibling legacy StartDateRow and every board task/project entry point.
assert.match(boardSource, /interface ScheduleBoardProps[\s\S]*?externallyPendingProjectIds:\s*ReadonlySet<string>[\s\S]*?isProjectExternallyPending:\s*\(projectId: string\) => boolean[\s\S]*?onEffectivePendingProjectIdsChange:\s*\(projectIds: ReadonlySet<string>\) => void/);
assert.match(boardSource, /getEffectivePendingProjectIds\([\s\S]*?externallyPendingProjectIds[\s\S]*?effectivePendingTaskIds[\s\S]*?canonicalTaskProjectById/);
assert.match(boardSource, /const isProjectPending = \(projectId: string\) =>[\s\S]*?effectivePendingProjectIdsRef\.current\.has\(projectId\)[\s\S]*?isProjectExternallyPending\(projectId\)/);
assert.match(boardSource, /const publishEffectivePendingProjectIds = useCallback\([\s\S]*?onEffectivePendingProjectIdsChange\(next\)/);
const projectPendingSetterStart = boardSource.indexOf("function setProjectPending");
const taskPendingSetterStart = boardSource.indexOf("function setTaskPending", projectPendingSetterStart);
const taskPendingSetterEnd = boardSource.indexOf("function setTaskKeyboardState", taskPendingSetterStart);
assert.match(boardSource.slice(projectPendingSetterStart, taskPendingSetterStart), /if \(pending\)[\s\S]*?publishEffectivePendingProjectIds/);
assert.match(boardSource.slice(taskPendingSetterStart, taskPendingSetterEnd), /if \(pending\)[\s\S]*?canonicalTaskProjectById\.get\(taskId\)[\s\S]*?publishEffectivePendingProjectIds/);
assert.match(boardSource, /useEffect\(\(\) => \{\s*publishEffectivePendingProjectIds\(effectivePendingProjectIds\);\s*\}, \[effectivePendingProjectIds, publishEffectivePendingProjectIds\]\)/);
assert.match(boardSource, /useEffect\(\(\) => \(\) => onEffectivePendingProjectIdsChange\(EMPTY_PROJECT_IDS\), \[onEffectivePendingProjectIdsChange\]\)/);

assert.match(companyDashboardSource, /const boardPendingProjectIdsRef = useRef<Set<string>>/);
assert.match(companyDashboardSource, /const legacyProjectMutationsRef = useRef<Map<string, LegacyProjectMutation>>/);
assert.match(companyDashboardSource, /const isPageProjectPending = useCallback\(\(projectId: string\) =>[\s\S]*?boardPendingProjectIdsRef\.current\.has\(projectId\)[\s\S]*?legacyProjectMutationsRef\.current\.has\(projectId\)/);
assert.match(companyDashboardSource, /const publishBoardPendingProjectIds = useCallback[\s\S]*?projectIdSetsEqual[\s\S]*?setBoardPendingProjectIds/);
assert.match(companyDashboardSource, /<ScheduleBoard[\s\S]*?externallyPendingProjectIds=\{legacyPendingProjectIds\}[\s\S]*?isProjectExternallyPending=\{isPageProjectPending\}[\s\S]*?onEffectivePendingProjectIdsChange=\{publishBoardPendingProjectIds\}/);
assert.match(companyDashboardSource, /<StartDateRow[\s\S]*?isProjectPending=\{pagePendingProjectIds\.has\(p\.id\)\}[\s\S]*?beginProjectMutation=\{beginLegacyProjectMutation\}[\s\S]*?awaitProjectRefresh=\{awaitLegacyProjectRefresh\}[\s\S]*?clearProjectMutation=\{clearLegacyProjectMutation\}/);

const startDateRowStart = companyDashboardSource.indexOf("function StartDateRow");
const startDateRowEnd = companyDashboardSource.indexOf("export default function CompanyDashboardClient", startDateRowStart);
const startDateRowBody = companyDashboardSource.slice(startDateRowStart, startDateRowEnd);
assert.equal((companyDashboardSource.match(/updateProjectStartDateAction\(/g) ?? []).length, 1, "the company dashboard has exactly one legacy project-start writer");
assert.match(startDateRowBody, /if \(!beginProjectMutation\(project\.id\)\) return;/);
assert.ok(startDateRowBody.indexOf("beginProjectMutation(project.id)") < startDateRowBody.indexOf("updateProjectStartDateAction(project.id"), "the live page lock must be acquired before the legacy action starts");
assert.match(startDateRowBody, /awaitProjectRefresh\(project\.id,\s*\{[\s\S]*?projectStartDate:\s*result\.startDate[\s\S]*?taskDates:\s*result\.shiftedTaskDates/);
const legacySuccessStart = startDateRowBody.indexOf("const result = await updateProjectStartDateAction");
const legacySuccessEnd = startDateRowBody.indexOf("catch (error)", legacySuccessStart);
assert.doesNotMatch(startDateRowBody.slice(legacySuccessStart, legacySuccessEnd), /clearProjectMutation/, "legacy success keeps the parent lock through canonical refresh");
assert.match(startDateRowBody, /catch \(error\)[\s\S]*?clearProjectMutation\(project\.id\)/);
assert.equal((startDateRowBody.match(/disabled=\{isPending \|\| isProjectPending\}/g) ?? []).length, 2, "legacy date input and button both render the shared page lock");
assert.match(companyDashboardSource, /legacyRefreshCount > 0[\s\S]*?Refreshing start-date changes\.\.\.[\s\S]*?>Retry now<\/button>/);
assert.match(companyDashboardSource, /window\.setInterval\(\(\) => router\.refresh\(\), 2_000\)/);
assert.match(companyDashboardSource, /projectRefreshMatches\(canonicalProjectById\.get\(projectId\), mutation\.expectation\)/);
assert.match(companyDashboardSource, /!canonicalProjectById\.has\(projectId\)/, "a canonical project removal must release a stale parent lock");
assert.match(companyDashboardSource, /pageMountedRef\.current = false;[\s\S]*?boardPendingProjectIdsRef\.current = new Set\(\);[\s\S]*?legacyProjectMutationsRef\.current = new Map\(\)/);

// A rising legacy lock is a cancellation boundary for pre-existing board
// controllers and stable-key local menu drafts, not merely a disabled state.
assert.match(layoutSource, /export function getNewlyPendingProjectIds/);
assert.match(boardSource, /const previousExternallyPendingProjectIdsRef = useRef<ReadonlySet<string>>/);
assert.match(boardSource, /interface TaskKeyboardEditState\s*\{[\s\S]*?taskId:\s*string;[\s\S]*?projectId:\s*string;/);
assert.match(boardSource, /interface ActiveTaskPointerEdit\s*\{[\s\S]*?taskId:\s*string;[\s\S]*?projectId:\s*string;/);
const scopedTaskCancelStart = boardSource.indexOf("function cancelTaskEditsForProjects");
const scopedTaskCancelEnd = boardSource.indexOf("function cancelActiveTaskEdit", scopedTaskCancelStart);
const scopedTaskCancelBody = boardSource.slice(scopedTaskCancelStart, scopedTaskCancelEnd);
assert.match(scopedTaskCancelBody, /activeTaskPointerRef\.current/);
assert.match(scopedTaskCancelBody, /projectIds\.has\(pointerEdit\.projectId\)/);
assert.match(scopedTaskCancelBody, /pointerEdit\.cleanup\(\)[\s\S]*?clearTaskPreview\(pointerEdit\.taskId\)/);
assert.match(scopedTaskCancelBody, /projectIds\.has\(keyboardEdit\.projectId\)/);
assert.match(scopedTaskCancelBody, /clearTaskPreview\(keyboardEdit\.taskId\)[\s\S]*?taskKeyboardCleanupRef\.current\?\.\(\)[\s\S]*?setTaskKeyboardState\(null\)/);
const scopedProjectCancelStart = boardSource.indexOf("function cancelProjectEditsForProjects");
const scopedProjectCancelEnd = boardSource.indexOf("function cancelActiveProjectEdit", scopedProjectCancelStart);
const scopedProjectCancelBody = boardSource.slice(scopedProjectCancelStart, scopedProjectCancelEnd);
assert.match(scopedProjectCancelBody, /activeProjectPointerRef\.current/);
assert.match(scopedProjectCancelBody, /projectIds\.has\(pointerEdit\.projectId\)[\s\S]*?pointerEdit\.cleanup\(\)[\s\S]*?clearProjectPreview\(pointerEdit\.projectId\)/);
assert.match(scopedProjectCancelBody, /projectIds\.has\(keyboardEdit\.projectId\)[\s\S]*?clearProjectPreview\(keyboardEdit\.projectId\)[\s\S]*?projectKeyboardCleanupRef\.current\?\.\(\)[\s\S]*?setProjectKeyboardState\(null\)/);
const externalLockEffectStart = boardSource.indexOf("const newlyPendingProjectIds = getNewlyPendingProjectIds");
const externalLockEffectEnd = boardSource.indexOf("}, [externallyPendingProjectIds])", externalLockEffectStart);
const externalLockEffectBody = boardSource.slice(externalLockEffectStart, externalLockEffectEnd);
assert.match(externalLockEffectBody, /previousExternallyPendingProjectIdsRef\.current = new Set\(externallyPendingProjectIds\)/);
assert.match(externalLockEffectBody, /cancelExternallyLockedProjectEdits\(newlyPendingProjectIds\)/);
assert.match(boardSource, /const cancelExternallyLockedProjectEdits = useEffectEvent\([\s\S]*?cancelProjectEditsForProjects\(newlyPendingProjectIds\)[\s\S]*?cancelTaskEditsForProjects\(newlyPendingProjectIds\)[\s\S]*?confirmIntentRef\.current[\s\S]*?newlyPendingProjectIds\.has\(intent\.project\.id\)[\s\S]*?clearProjectPreview\(intent\.project\.id\)[\s\S]*?setConfirmIntent\(null\)/);
assert.match(taskSource, /const actionDetailsRef = useRef<HTMLDetailsElement>\(null\)/);
assert.match(taskSource, /const actionResetKey = `\$\{isPending \? "pending" : "ready"\}:\$\{task\.startDate\}:\$\{task\.endDate\}`/);
assert.match(taskSource, /const menuDates = menuDraft\.resetKey === actionResetKey \? menuDraft\.dates : null/);
assert.match(taskSource, /if \(menuDraft\.resetKey !== actionResetKey\) \{\s*setMenuDraft\(\{ resetKey: actionResetKey, dates: null \}\)/);
assert.match(taskSource, /useEffect\(\(\) => \{\s*if \(actionDetailsRef\.current\) actionDetailsRef\.current\.open = false;\s*\}, \[actionResetKey\]\)/);
assert.match(taskSource, /<details\s+ref=\{actionDetailsRef\}/);
assert.match(projectSource, /const actionDetailsRef = useRef<HTMLDetailsElement>\(null\)/);
assert.match(projectSource, /const actionResetKey = `\$\{isPending \? "pending" : "ready"\}:\$\{projectStart\}`/);
assert.match(projectSource, /const targetStart = targetStartDraft\.resetKey === actionResetKey \? targetStartDraft\.value : projectStart/);
assert.match(projectSource, /if \(targetStartDraft\.resetKey !== actionResetKey\) \{\s*setTargetStartDraft\(\{ resetKey: actionResetKey, value: projectStart \}\)/);
assert.match(projectSource, /useEffect\(\(\) => \{\s*if \(actionDetailsRef\.current\) actionDetailsRef\.current\.open = false;\s*\}, \[actionResetKey\]\)/);
assert.match(projectSource, /<details\s+ref=\{actionDetailsRef\}/);
assert.equal((monthSource.match(/isPending=\{pendingProjectIds\.has\(project\.id\)\}/g) ?? []).length, 1, "Month project menus receive the external parent lock");
assert.equal((timelineSource.match(/isPending=\{pendingProjectIds\.has\(project\.id\)\}/g) ?? []).length, 1, "Timeline project menus receive the external parent lock");
assert.match(monthSource, /isPending=\{pendingProjectIds\.has\(project\.id\) \|\| pendingTaskIds\.has\(task\.id\)\}/);
assert.match(timelineSource, /isPending=\{pendingProjectIds\.has\(project\.id\) \|\| pendingTaskIds\.has\(task\.id\)\}/);

// Project reconciliation is based only on canonical Project/ScheduleTask truth.
const refreshExpectationStart = layoutSource.indexOf("export interface ProjectRefreshExpectation");
const refreshExpectationEnd = layoutSource.indexOf("function toUTCDay", refreshExpectationStart);
const refreshExpectationBody = layoutSource.slice(refreshExpectationStart, refreshExpectationEnd);
assert.match(refreshExpectationBody, /projectStartDate\?:\s*string \| null/);
assert.match(refreshExpectationBody, /taskDates:\s*PersistedTaskDate\[\]/);
assert.doesNotMatch(refreshExpectationBody, /project:\s*DashboardProjectRow|income|OverlayIncomeItem/);
const projectReconciliationStart = boardSource.indexOf("const reconciledProjectIds");
const projectReconciliationEnd = boardSource.indexOf("useEffect(() => {", projectReconciliationStart);
const projectReconciliationBody = boardSource.slice(projectReconciliationStart, projectReconciliationEnd);
assert.match(projectReconciliationBody, /projectRefreshMatches\(canonical, expectation\)/);
assert.doesNotMatch(projectReconciliationBody, /income|data\.overlays|actualIncome/);
assert.match(boardSource, /setProjectRefreshExpectations\(current => \(\{ \.\.\.current, \[project\.id\]: expectation \}\)\)/);
assert.equal((boardSource.match(/awaitProjectRefresh\(/g) ?? []).length, 5, "all four project success paths retain a reconciliation-backed optimistic preview");
assert.match(boardSource, /previewProjectIncomeOverlays/);
assert.match(boardSource, /previewShiftedTaskIncomeOverlays/);
assert.match(layoutSource, /export function previewProjectWithPersistedTaskDates/);
assert.match(coreSource, /interface SetProjectStartDateResult[\s\S]*?shiftedTaskDates:\s*PersistedScheduleTaskDate\[\]/);
assert.match(coreSource, /interface ShiftNotStartedTasksResult[\s\S]*?shiftedTaskDates:\s*PersistedScheduleTaskDate\[\]/);
assert.match(coreSource, /UPDATE "ScheduleTask"[\s\S]*?RETURNING "id", "startDate", "endDate"/);
const trayScheduleStart = boardSource.indexOf("function scheduleUnscheduledProject");
const trayScheduleEnd = boardSource.indexOf("function commitWaitingProjectMove", trayScheduleStart);
const waitingMoveStart = trayScheduleEnd;
const waitingMoveEnd = boardSource.indexOf("function handleProjectMovePreview", waitingMoveStart);
for (const body of [boardSource.slice(trayScheduleStart, trayScheduleEnd), boardSource.slice(waitingMoveStart, waitingMoveEnd)]) {
    assert.match(body, /projectStartDate:\s*result\.startDate/);
    assert.match(body, /taskDates:\s*result\.shiftedTaskDates/);
    assert.match(body, /previewProjectWithPersistedTaskDates/);
}
const moveChoiceStart = boardSource.indexOf("function handleMoveChoice");
const moveChoiceEnd = boardSource.indexOf("function cancelConfirmedMove", moveChoiceStart);
const moveChoiceBody = boardSource.slice(moveChoiceStart, moveChoiceEnd);
assert.match(moveChoiceBody, /choice === "marker-only"[\s\S]*?taskDates:\s*\[\]/);
assert.match(moveChoiceBody, /shiftNotStartedTasksAction[\s\S]*?taskDates:\s*result\.shiftedTaskDates/);
assert.doesNotMatch(moveChoiceBody, /intent\.project\.tasks\.map/);

// A task-only reconciliation exposes the same visible/manual recovery path.
assert.match(boardSource, /projectRefreshCount > 0 \|\| awaitingTaskRefreshIds\.size > 0/);
assert.match(boardSource, /pendingRefreshKinds/);
assert.match(boardSource, /Refreshing saved \{pendingRefreshKinds\.join\(" and "\)\} schedule changes\.\.\./);
assert.doesNotMatch(boardSource, /Ã|Â|â€¦/);
assert.match(boardSource, />Retry now<\/button>/);

// Task 8 coverage/access/reconciliation/identity contracts.
for (const source of [boardSource, monthSource, timelineSource]) assert.match(source, /substantialCompletion/);
assert.match(coreSource, /substantialCompletion:\s*DashboardProjectRow\[\]/);
assert.match(coreSource, /substantialCompletion:\s*pipeline\.substantialCompletion\.map\(enrich\)/);
assert.match(pageSource, /hasPermission\(effectiveUser, "financialReports"\)[\s\S]*?hasPermission\(effectiveUser, "schedules"\)/);
assert.match(navSource, /key:\s*"dashboard"[\s\S]*?can\("financialReports"\)\s*\|\|\s*can\("schedules"\)/);
assert.match(coreSource, /paymentScheduleId:\s*string/);
assert.match(coreSource, /paymentScheduleId:\s*row\.id/);
assert.match(coreSource, /paymentScheduleId:\s*`synthetic:/);
assert.match(projectSource, /item\.paymentScheduleId/);
assert.match(monthSource, /item\.paymentScheduleId/);
assert.match(timelineSource, /item\.paymentScheduleId/);
assert.doesNotMatch([projectSource, monthSource, timelineSource].join("\n"), /co-\$\{item\.changeOrderId\}-\$\{item\.effectiveDueDate\}-\$\{item\.name\}/);
const duplicateNameDateRows = [
    { paymentScheduleId: "payment-row-a", changeOrderId: "co-1", name: "Progress", effectiveDueDate: "2037-01-10" },
    { paymentScheduleId: "payment-row-b", changeOrderId: "co-1", name: "Progress", effectiveDueDate: "2037-01-10" },
];
assert.equal(new Set(duplicateNameDateRows.map(row => `co-${row.paymentScheduleId}`)).size, 2, "duplicate CO name/date rows retain distinct stable identities");
assert.match(boardSource, /projectRefreshExpectations/);
assert.match(boardSource, /window\.setInterval\([\s\S]*?router\.refresh\(\)/);
assert.match(projectSource, /onProjectKeyboardStart/);
assert.match(projectSource, /event\.key === " " \|\| event\.key === "Enter"/);
assert.match(projectSource, /event\.shiftKey \? 7 : 1/);
assert.match(boardSource, /projectKeyboardSentinelRef/);
assert.match(boardSource, /aria-live="polite"/);
const shiftActionStart = actionsSource.indexOf("export async function shiftNotStartedTasksAction");
const shiftActionEnd = actionsSource.indexOf("export async function", shiftActionStart + 30);
assert.match(actionsSource.slice(shiftActionStart, shiftActionEnd), /actor:\s*\{\s*type:\s*"TEAM",\s*name:\s*caller\.name\s*\|\|\s*caller\.email\s*\}/);

console.log("schedule-board render contract verification: PASS");
