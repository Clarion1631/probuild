import assert from "node:assert/strict";
import {
    assignMonthProjectLanes,
    assignProjectLanes,
    assignTaskLanes,
    clipRange,
    getEffectiveProjectRange,
    segmentProjectRange,
    toTimelineRect,
} from "../src/app/company-dashboard/schedule-board/useBarLayout";
import * as barLayout from "../src/app/company-dashboard/schedule-board/useBarLayout";
import { addDays, formatDate, parseUTCDate } from "../src/app/projects/[id]/schedule/schedule-utils";

const project = {
    id: "p1", name: "Shop", client: null, status: "In Progress",
    startDate: null, color: "#123456", contractValue: null, crew: [],
    taskCount: 2, hasQualifyingEstimate: false, unappliedChangeOrders: { count: 0, items: [] },
    tasks: [
        { id: "t1", name: "Frame", startDate: "2037-01-03T00:00:00.000Z", endDate: "2037-01-06T00:00:00.000Z", color: "#111111", parentId: null, progress: 0, status: "Not Started", type: "task", assignments: [] },
        { id: "t2", name: "Billing", startDate: "2037-01-20T00:00:00.000Z", endDate: "2037-01-20T00:00:00.000Z", color: "#222222", parentId: null, progress: 0, status: "Not Started", type: "milestone", assignments: [] },
    ],
};

assert.deepEqual(getEffectiveProjectRange(project), {
    start: new Date("2037-01-03T00:00:00.000Z"),
    end: new Date("2037-01-06T00:00:00.000Z"),
});
// Marker-only moves (In Progress) leave tasks in place: the bar must span
// BOTH the existing work and the marker day — neither may clip out of view.
const markerPrecedenceProject = { ...project, id: "p-marker", startDate: "2037-01-10T00:00:00.000Z" };
assert.deepEqual(getEffectiveProjectRange(markerPrecedenceProject), {
    start: new Date("2037-01-03T00:00:00.000Z"),
    end: new Date("2037-01-11T00:00:00.000Z"),
});
const markerOnlyProject = { ...project, id: "p-marker-only", startDate: "2037-01-10T00:00:00.000Z", taskCount: 0, tasks: [] };
assert.deepEqual(getEffectiveProjectRange(markerOnlyProject), {
    start: new Date("2037-01-10T00:00:00.000Z"),
    end: new Date("2037-01-11T00:00:00.000Z"),
});
const taskDerivedProject = { ...project, id: "p-task-derived", startDate: null };
assert.deepEqual(getEffectiveProjectRange(taskDerivedProject), {
    start: new Date("2037-01-03T00:00:00.000Z"),
    end: new Date("2037-01-06T00:00:00.000Z"),
});

assert.equal(typeof (barLayout as Record<string, unknown>).createProjectDropIntent, "function", "createProjectDropIntent must be exported");
assert.equal(typeof (barLayout as Record<string, unknown>).previewProjectMove, "function", "previewProjectMove must be exported");
const createProjectDropIntent = (barLayout as unknown as {
    createProjectDropIntent: (candidate: typeof project, targetStart: string) => {
        project: typeof project;
        originalStart: string;
        targetStart: string;
        deltaDays: number;
    } | null;
}).createProjectDropIntent;
const previewProjectMove = (barLayout as unknown as {
    previewProjectMove: (candidate: typeof project, targetStart: string) => typeof project;
}).previewProjectMove;
const moveIntent = createProjectDropIntent(project, "2037-03-15");
assert.deepEqual(moveIntent, {
    project,
    originalStart: "2037-01-03",
    targetStart: "2037-03-15",
    deltaDays: 71,
});
assert.equal(createProjectDropIntent(project, "2037-01-03")?.deltaDays, 0);
const firstSetPreview = previewProjectMove(project, "2037-03-15");
assert.equal(firstSetPreview.startDate, "2037-03-15");
assert.deepEqual(firstSetPreview.tasks, project.tasks);
const scheduledProject = { ...project, status: "Waiting to Start", startDate: "2037-01-03T00:00:00.000Z" };
const preview = previewProjectMove(scheduledProject, "2037-03-15");
assert.equal(preview.startDate, "2037-03-15");
assert.deepEqual(preview.tasks.map(task => [task.startDate, task.endDate]), [
    ["2037-03-15", "2037-03-18"],
    ["2037-04-01", "2037-04-01"],
]);
assert.equal(new Date(preview.tasks[0].endDate).getTime() - new Date(preview.tasks[0].startDate).getTime(), 3 * 86_400_000);
const unscheduledPreview = previewProjectMove({ ...project, id: "p-unscheduled", startDate: null, tasks: [] }, "2037-03-15");
assert.equal(unscheduledPreview.startDate, "2037-03-15");

type TaskEditMode = import("../src/app/company-dashboard/schedule-board/useBarLayout").TaskEditMode;
const taskEditModes: TaskEditMode[] = ["move", "resize-left", "resize-right"];
assert.deepEqual(taskEditModes, ["move", "resize-left", "resize-right"]);
assert.equal(typeof (barLayout as Record<string, unknown>).previewTaskDates, "function", "previewTaskDates must be exported");
const previewTaskDates = (barLayout as unknown as {
    previewTaskDates: (
        candidate: typeof project.tasks[number],
        mode: TaskEditMode,
        deltaDays: number,
    ) => { startDate: string; endDate: string } | null;
}).previewTaskDates;
const task = project.tasks[0];
const milestoneTask = project.tasks[1];
assert.deepEqual(previewTaskDates(task, "move", 2), { startDate: "2037-01-05", endDate: "2037-01-08" });
assert.deepEqual(previewTaskDates(task, "resize-left", 2), { startDate: "2037-01-05", endDate: "2037-01-06" });
assert.deepEqual(previewTaskDates(task, "resize-right", -2), { startDate: "2037-01-03", endDate: "2037-01-04" });
assert.equal(previewTaskDates(task, "resize-left", 3), null, "left resize must preserve a positive end-exclusive duration");
assert.equal(previewTaskDates(task, "resize-right", -3), null, "right resize must preserve a positive end-exclusive duration");
assert.deepEqual(previewTaskDates(milestoneTask, "move", 3), { startDate: "2037-01-23", endDate: "2037-01-23" });
assert.equal(previewTaskDates(milestoneTask, "resize-left", 1), null, "milestones cannot resize");
assert.equal(previewTaskDates({ ...task, endDate: task.startDate }, "move", 1), null, "invalid non-milestone durations cannot be previewed");
assert.equal(typeof (barLayout as Record<string, unknown>).taskDatesMatch, "function", "taskDatesMatch must be exported");
const taskDatesMatch = (barLayout as unknown as {
    taskDatesMatch: (
        candidate: typeof task,
        dates: { startDate: string; endDate: string },
    ) => boolean;
}).taskDatesMatch;
const savedDates = { startDate: "2037-01-05", endDate: "2037-01-08" };
assert.equal(taskDatesMatch(task, savedDates), false, "slow-refresh canonical dates must not acknowledge the saved override");
const refreshedTask = { ...task, startDate: "2037-01-05T00:00:00.000Z", endDate: "2037-01-08T00:00:00.000Z" };
assert.equal(taskDatesMatch(refreshedTask, savedDates), true, "matching refreshed props acknowledge the saved override");
assert.deepEqual(previewTaskDates(refreshedTask, "move", 1), { startDate: "2037-01-06", endDate: "2037-01-09" }, "a sequential edit derives from refreshed canonical dates");
assert.equal(typeof (barLayout as Record<string, unknown>).getEffectivePendingProjectIds, "function", "pending child tasks must block their parent project");
const getEffectivePendingProjectIds = (barLayout as unknown as {
    getEffectivePendingProjectIds: (
        pendingProjects: Iterable<string>,
        pendingTasks: Iterable<string>,
        taskProjectById: ReadonlyMap<string, string>,
    ) => Set<string>;
}).getEffectivePendingProjectIds;
const reversePending = getEffectivePendingProjectIds(
    ["project-operation"],
    ["t1", "awaiting-task"],
    new Map([["t1", "p1"], ["awaiting-task", "p-awaiting"]]),
);
assert.deepEqual([...reversePending].sort(), ["p-awaiting", "p1", "project-operation"], "task mutation and task refresh states both close the reverse project race");
assert.equal(typeof (barLayout as Record<string, unknown>).mergeProjectPendingIds, "function", "page siblings need one rendered project lock set");
const mergeProjectPendingIds = (barLayout as unknown as {
    mergeProjectPendingIds: (...sources: Iterable<string>[]) => Set<string>;
}).mergeProjectPendingIds;
const pagePending = mergeProjectPendingIds(reversePending, ["legacy-project"]);
assert.deepEqual([...pagePending].sort(), ["legacy-project", "p-awaiting", "p1", "project-operation"], "board locks disable the legacy row and legacy locks disable the board");
assert.equal(typeof (barLayout as Record<string, unknown>).projectIdSetsEqual, "function", "stable publications must compare Set contents");
const projectIdSetsEqual = (barLayout as unknown as {
    projectIdSetsEqual: (left: ReadonlySet<string>, right: ReadonlySet<string>) => boolean;
}).projectIdSetsEqual;
assert.equal(projectIdSetsEqual(new Set(["p1", "p2"]), new Set(["p2", "p1"])), true);
assert.equal(projectIdSetsEqual(new Set(["p1"]), new Set(["p1", "p2"])), false);
assert.equal(typeof (barLayout as Record<string, unknown>).getNewlyPendingProjectIds, "function", "external lock transitions need a rising-edge selector");
const getNewlyPendingProjectIds = (barLayout as unknown as {
    getNewlyPendingProjectIds: (previous: ReadonlySet<string>, current: ReadonlySet<string>) => Set<string>;
}).getNewlyPendingProjectIds;
assert.deepEqual(
    [...getNewlyPendingProjectIds(new Set(["p-existing", "p-unlocked"]), new Set(["p-existing", "p-locked"]))].sort(),
    ["p-locked"],
    "only newly locked projects cancel their active editors",
);
assert.deepEqual(
    [...getNewlyPendingProjectIds(new Set(["p-existing"]), new Set(["p-existing"]))],
    [],
    "an unchanged lock set must not wipe active drafts again",
);
assert.deepEqual(
    [...getNewlyPendingProjectIds(new Set(["p-unlocked"]), new Set())],
    [],
    "unlocking must not cancel unrelated newly opened drafts",
);

assert.equal(typeof (barLayout as Record<string, unknown>).projectRefreshMatches, "function", "project refresh reconciliation must be exported");
const projectRefreshMatches = (barLayout as unknown as {
    projectRefreshMatches: (
        canonical: typeof project | undefined,
        expected: { projectStartDate?: string | null; taskDates: Array<{ id: string; startDate: string; endDate: string }> },
    ) => boolean;
}).projectRefreshMatches;
assert.equal(typeof (barLayout as Record<string, unknown>).previewProjectWithPersistedTaskDates, "function", "server-returned task dates must drive the saved preview");
const previewProjectWithPersistedTaskDates = (barLayout as unknown as {
    previewProjectWithPersistedTaskDates: (
        candidate: typeof project,
        projectStartDate: string | null,
        taskDates: Array<{ id: string; startDate: string; endDate: string }>,
    ) => typeof project;
}).previewProjectWithPersistedTaskDates;

const concurrentTask = { ...task, id: "t-concurrent", name: "Concurrent", startDate: "2037-02-01T00:00:00.000Z", endDate: "2037-02-04T00:00:00.000Z" };
const projectWithConcurrentTask = { ...project, startDate: "2037-01-03T00:00:00.000Z", tasks: [...project.tasks, concurrentTask] };
const markerExpectation = { projectStartDate: "2037-01-05", taskDates: [] };
const markerCanonical = {
    ...projectWithConcurrentTask,
    startDate: "2037-01-05T00:00:00.000Z",
    tasks: projectWithConcurrentTask.tasks.map(candidate => candidate.id === concurrentTask.id
        ? { ...candidate, startDate: "2037-02-10T00:00:00.000Z", endDate: "2037-02-13T00:00:00.000Z" }
        : candidate),
};
assert.equal(projectRefreshMatches(undefined, markerExpectation), false, "an absent canonical project keeps its optimistic preview");
assert.equal(projectRefreshMatches(projectWithConcurrentTask, markerExpectation), false, "marker-only reconciliation waits for the saved project start");
assert.equal(projectRefreshMatches(markerCanonical, markerExpectation), true, "marker-only reconciliation ignores every unrelated concurrent task edit");

const selectiveTaskDates = [{ id: task.id, startDate: "2037-01-05", endDate: "2037-01-08" }];
const selectiveExpectation = { taskDates: selectiveTaskDates };
const selectiveCanonical = {
    ...projectWithConcurrentTask,
    tasks: projectWithConcurrentTask.tasks.map(candidate => {
        if (candidate.id === task.id) return { ...candidate, startDate: "2037-01-05T00:00:00.000Z", endDate: "2037-01-08T00:00:00.000Z" };
        if (candidate.id === concurrentTask.id) return { ...candidate, startDate: "2037-02-10T00:00:00.000Z", endDate: "2037-02-13T00:00:00.000Z" };
        return candidate;
    }),
};
assert.equal(projectRefreshMatches(projectWithConcurrentTask, selectiveExpectation), false, "selective reconciliation waits for each affected task date");
assert.equal(projectRefreshMatches(selectiveCanonical, selectiveExpectation), true, "shift-Not-Started reconciliation ignores unrelated task changes");

const fullShiftDates = project.tasks.map(candidate => ({
    id: candidate.id,
    startDate: formatDate(addDays(parseUTCDate(candidate.startDate.slice(0, 10)), 2)),
    endDate: formatDate(addDays(parseUTCDate(candidate.endDate.slice(0, 10)), 2)),
}));
const fullShiftPreview = previewProjectWithPersistedTaskDates(projectWithConcurrentTask, "2037-01-05", fullShiftDates);
const fullShiftCanonical = {
    ...fullShiftPreview,
    startDate: "2037-01-05T00:00:00.000Z",
    tasks: fullShiftPreview.tasks.map(candidate => candidate.id === concurrentTask.id
        ? { ...candidate, startDate: "2037-02-11T00:00:00.000Z", endDate: "2037-02-14T00:00:00.000Z" }
        : candidate),
};
assert.equal(projectRefreshMatches(fullShiftCanonical, { projectStartDate: "2037-01-05", taskDates: fullShiftDates }), true, "Waiting full-shift reconciliation uses only server-returned affected task IDs/dates");
assert.equal(projectRefreshMatches(markerCanonical, { projectStartDate: "2037-01-05", taskDates: [] }), true, "first-time tray scheduling with no shifted task result ignores concurrent task truth");

const overlayRefreshEdgeCases = [
    "null-dated QuickBooks row resolves to a different effective date",
    "shifted income row leaves the requested date range",
    "mixed-QuickBooks mirror group keeps a sibling fixed",
    "unrelated overlay row disappears during refresh",
];
for (const scenario of overlayRefreshEdgeCases) {
    assert.equal(
        projectRefreshMatches(markerCanonical, markerExpectation),
        true,
        `${scenario} cannot keep a canonically reconciled project in a retry loop`,
    );
}
assert.equal(typeof (barLayout as Record<string, unknown>).previewTaskPointerCandidate, "function", "previewTaskPointerCandidate must be exported");
const previewTaskPointerCandidate = (barLayout as unknown as {
    previewTaskPointerCandidate: (
        candidate: typeof task,
        mode: TaskEditMode,
        deltaDays: number | null,
    ) => { startDate: string; endDate: string } | null;
}).previewTaskPointerCandidate;
assert.equal(previewTaskPointerCandidate(task, "move", null), null, "an outside-grid release has no committable candidate");
assert.equal(previewTaskPointerCandidate(task, "resize-left", 3), null, "an invalid resize boundary has no committable candidate");
assert.deepEqual(previewTaskPointerCandidate(task, "move", 1), { startDate: "2037-01-04", endDate: "2037-01-07" });

const incomeRows = [
    { id: "eligible-explicit", name: "Deposit", amount: 100, dueDate: "2037-01-05T00:00:00.000Z", effectiveDueDate: "2037-01-05T00:00:00.000Z", invoiceId: "i1", invoiceCode: "INV-1", projectId: "p1", projectName: "Shop", scheduleTaskId: "t1", anchoredToTask: true, inQuickBooks: false },
    { id: "eligible-fallback", name: "Progress", amount: 200, dueDate: null, effectiveDueDate: "2037-01-06T00:00:00.000Z", invoiceId: "i2", invoiceCode: "INV-2", projectId: "p1", projectName: "Shop", scheduleTaskId: "t2", anchoredToTask: true, inQuickBooks: false },
    { id: "projectless", name: "General", amount: 300, dueDate: "2037-01-07T00:00:00.000Z", effectiveDueDate: "2037-01-07T00:00:00.000Z", invoiceId: "i3", invoiceCode: "INV-3", projectId: null, projectName: null, scheduleTaskId: "t3", anchoredToTask: true, inQuickBooks: false },
    { id: "unanchored", name: "Fixed", amount: 400, dueDate: "2037-01-08T00:00:00.000Z", effectiveDueDate: "2037-01-08T00:00:00.000Z", invoiceId: "i4", invoiceCode: "INV-4", projectId: "p1", projectName: "Shop", scheduleTaskId: null, anchoredToTask: false, inQuickBooks: false },
    { id: "quickbooks", name: "QB", amount: 500, dueDate: "2037-01-09T00:00:00.000Z", effectiveDueDate: "2037-01-09T00:00:00.000Z", invoiceId: "i5", invoiceCode: "INV-5", projectId: "p1", projectName: "Shop", scheduleTaskId: "t1", anchoredToTask: true, inQuickBooks: true },
    { id: "other-project", name: "Other", amount: 600, dueDate: "2037-01-10T00:00:00.000Z", effectiveDueDate: "2037-01-10T00:00:00.000Z", invoiceId: "i6", invoiceCode: "INV-6", projectId: "p2", projectName: "Other", scheduleTaskId: "t1", anchoredToTask: true, inQuickBooks: false },
];
assert.equal(typeof (barLayout as Record<string, unknown>).previewProjectIncomeOverlays, "function", "previewProjectIncomeOverlays must be exported");
const previewProjectIncomeOverlays = (barLayout as unknown as {
    previewProjectIncomeOverlays: (rows: typeof incomeRows, projectId: string, deltaDays: number) => typeof incomeRows;
}).previewProjectIncomeOverlays;
const incomePreview = previewProjectIncomeOverlays(incomeRows, "p1", 3);
assert.deepEqual([incomePreview[0].dueDate, incomePreview[0].effectiveDueDate], ["2037-01-08", "2037-01-08"]);
assert.deepEqual([incomePreview[1].dueDate, incomePreview[1].effectiveDueDate], [null, "2037-01-09"]);
assert.deepEqual(incomePreview.map(row => row.amount), incomeRows.map(row => row.amount));
for (const index of [2, 3, 4, 5]) assert.strictEqual(incomePreview[index], incomeRows[index]);
assert.equal(typeof (barLayout as Record<string, unknown>).previewShiftedTaskIncomeOverlays, "function", "shift-task overlay reconciliation must be exported");
const previewShiftedTaskIncomeOverlays = (barLayout as unknown as {
    previewShiftedTaskIncomeOverlays: (rows: typeof incomeRows, projectId: string, deltaDays: number, eligibleTaskIds: ReadonlySet<string>) => typeof incomeRows;
}).previewShiftedTaskIncomeOverlays;
const selectiveIncomePreview = previewShiftedTaskIncomeOverlays(incomeRows, "p1", 3, new Set(["t1", "t2"]));
assert.strictEqual(selectiveIncomePreview[0], incomeRows[0], "explicit due dates remain fixed when only tasks shift");
assert.deepEqual([selectiveIncomePreview[1].dueDate, selectiveIncomePreview[1].effectiveDueDate], [null, "2037-01-09"]);
for (const index of [2, 3, 4, 5]) assert.strictEqual(selectiveIncomePreview[index], incomeRows[index]);
assert.equal(typeof (barLayout as Record<string, unknown>).previewProjectOverlays, "function", "previewProjectOverlays must be exported");
const overlayFixture = {
    income: incomeRows,
    changeOrders: [{ probe: "change-order" }],
    expenses: [{ probe: "expense" }],
    hours: [{ probe: "hours" }],
};
const previewProjectOverlays = (barLayout as unknown as {
    previewProjectOverlays: (overlays: typeof overlayFixture, projectId: string, deltaDays: number) => typeof overlayFixture;
}).previewProjectOverlays;
const overlayPreview = previewProjectOverlays(overlayFixture, "p1", 3);
assert.strictEqual(overlayPreview.changeOrders, overlayFixture.changeOrders);
assert.strictEqual(overlayPreview.expenses, overlayFixture.expenses);
assert.strictEqual(overlayPreview.hours, overlayFixture.hours);
assert.deepEqual(overlayPreview.income.map(row => row.amount), overlayFixture.income.map(row => row.amount));
const segments = segmentProjectRange("p1", getEffectiveProjectRange(project)!, new Date("2036-12-29T00:00:00.000Z"), new Date("2037-02-09T00:00:00.000Z"));
assert.equal(segments.length, 2);
assert.deepEqual(segments.map(s => [s.weekIndex, s.startColumn, s.spanDays, s.continuesBefore, s.continuesAfter]), [
    [0, 5, 2, false, true],
    [1, 0, 1, true, false],
]);
assert.deepEqual(toTimelineRect({ start: new Date("2037-01-03Z"), end: new Date("2037-01-06Z") }, new Date("2037-01-01Z"), 20), { left: 40, width: 60 });
const timelineOriginX = 240;
const timelineClientX = 271;
const timelineDayWidth = 20;
const timelineDeltaDays = Math.round((timelineClientX - timelineOriginX) / timelineDayWidth);
assert.equal(timelineDeltaDays, 2);
assert.equal(formatDate(addDays(parseUTCDate(moveIntent!.originalStart), timelineDeltaDays)), "2037-01-05");
assert.equal(typeof (barLayout as Record<string, unknown>).getTimelinePointerDelta, "function", "getTimelinePointerDelta must be exported");
const getTimelinePointerDelta = (barLayout as unknown as {
    getTimelinePointerDelta: (_clientX: number, _originX: number, _dayWidth: number) => number;
}).getTimelinePointerDelta;
assert.equal(getTimelinePointerDelta(timelineClientX, timelineOriginX, timelineDayWidth), 2);
assert.equal(formatDate(addDays(parseUTCDate(moveIntent!.originalStart), getTimelinePointerDelta(timelineClientX, timelineOriginX, timelineDayWidth))), "2037-01-05");
assert.equal(typeof (barLayout as Record<string, unknown>).getTimelineAutoscrollStep, "function", "getTimelineAutoscrollStep must be exported");
const getTimelineAutoscrollStep = (barLayout as unknown as {
    getTimelineAutoscrollStep: (_input: {
        clientX: number;
        containerLeft: number;
        containerRight: number;
        timelineLeftInset: number;
        scrollLeft: number;
        scrollWidth: number;
        clientWidth: number;
        threshold: number;
        maxStep: number;
    }) => number;
}).getTimelineAutoscrollStep;
const autoscrollFixture = {
    containerLeft: 100,
    containerRight: 900,
    timelineLeftInset: 240,
    scrollLeft: 100,
    scrollWidth: 1600,
    clientWidth: 800,
    threshold: 48,
    maxStep: 16,
};
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 291 }), 0);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 292 }), 0);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 293 }), -1);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 340 }), -16);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 387 }), -1);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 388 }), 0);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 851 }), 0);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 853 }), 1);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 900 }), 16);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 947 }), 1);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 948 }), 0);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 340, scrollLeft: 0 }), 0);
assert.equal(getTimelineAutoscrollStep({ ...autoscrollFixture, clientX: 900, scrollLeft: 800 }), 0);
assert.equal(clipRange({ start: new Date("2036-12-01Z"), end: new Date("2036-12-02Z") }, { start: new Date("2037-01-01Z"), end: new Date("2037-02-01Z") }), null);

const crowded = new Map(Array.from({ length: 6 }, (_, index) => [`p${index}`, [{ ...segments[0], projectId: `p${index}` }]]));
const lanes = assignProjectLanes(crowded);
assert.equal(lanes.visible.filter(s => s.weekIndex === 0).length, 4);
assert.equal(lanes.hiddenByWeek.get(0), 2);

const laneGridStart = new Date("2037-01-01T00:00:00.000Z");
const laneGridEnd = new Date("2037-02-12T00:00:00.000Z");
const occupiedWork = new Map([
    ["occupier", segmentProjectRange("occupier", { start: new Date("2037-01-03Z"), end: new Date("2037-01-04Z") }, laneGridStart, laneGridEnd)],
    ["milestoned", segmentProjectRange("milestoned", { start: new Date("2037-01-10Z"), end: new Date("2037-01-12Z") }, laneGridStart, laneGridEnd)],
]);
const milestoneDays = new Map([
    ["milestoned", [new Date("2037-01-03Z"), new Date("2037-01-11Z"), new Date("2037-01-20Z")]],
]);
const monthLanes = assignMonthProjectLanes(occupiedWork, milestoneDays, laneGridStart, laneGridEnd);
assert.deepEqual(monthLanes.visibleWork.map(segment => [segment.projectId, segment.lane]), [
    ["occupier", 0],
    ["milestoned", 1],
]);
assert.deepEqual(monthLanes.visibleMilestoneHosts.map(host => [host.projectId, host.dateKey, host.lane]), [
    ["milestoned", "2037-01-03", 1],
    ["milestoned", "2037-01-20", 1],
]);
assert.equal(monthLanes.visibleMilestoneHosts.some(host => host.dateKey === "2037-01-11"), false);

const milestoneOnlyDays = new Map(Array.from({ length: 5 }, (_, index) => [`m${index}`, [new Date("2037-01-25Z")]]));
const milestoneOnlyLanes = assignMonthProjectLanes(new Map(), milestoneOnlyDays, laneGridStart, laneGridEnd);
assert.equal(milestoneOnlyLanes.visibleMilestoneHosts.length, 4);
assert.deepEqual(milestoneOnlyLanes.hiddenProjectIdsByWeek.get(3), ["m4"]);
// Item 5: overlapping mini-lanes inside one project bar (concrete + deck run
// concurrently) — capped at MAX_TASK_LANES, greedy interval-partition.
const laneDay = (n: number) => new Date(Date.UTC(2038, 0, n));
const nonOverlapping = assignTaskLanes([
    { id: "a", start: laneDay(1), end: laneDay(3) },
    { id: "b", start: laneDay(3), end: laneDay(5) },
]);
assert.deepEqual([...nonOverlapping.laneByTaskId.entries()].sort(), [["a", 0], ["b", 0]], "back-to-back tasks share lane 0");
assert.equal(nonOverlapping.laneCount, 1);
assert.deepEqual(nonOverlapping.hiddenTaskIds, []);

const twoOverlapping = assignTaskLanes([
    { id: "concrete", start: laneDay(1), end: laneDay(5) },
    { id: "deck", start: laneDay(2), end: laneDay(6) },
]);
assert.deepEqual([...twoOverlapping.laneByTaskId.entries()].sort(), [["concrete", 0], ["deck", 1]]);
assert.equal(twoOverlapping.laneCount, 2);

const fourOverlapping = assignTaskLanes([
    { id: "t1", start: laneDay(1), end: laneDay(10) },
    { id: "t2", start: laneDay(1), end: laneDay(10) },
    { id: "t3", start: laneDay(1), end: laneDay(10) },
    { id: "t4", start: laneDay(1), end: laneDay(10) },
]);
assert.equal(fourOverlapping.laneCount, 3, "lane assignment caps at MAX_TASK_LANES");
assert.equal(fourOverlapping.hiddenTaskIds.length, 1, "the 4th concurrent task is reported hidden for the +N chip");
assert.deepEqual([...fourOverlapping.laneByTaskId.values()].sort(), [0, 1, 2]);

console.log("schedule-board layout verification: PASS");
