/**
 * Change-order tasks must count toward percent complete.
 *
 * THE BUG THIS LOCKS DOWN. Approved change-order dollars ARE part of a phase's
 * budget (job-variance-db.ts pushes ChangeOrderItem rows into the budget side).
 * But applyChangeOrderToSchedule sets `estimateItemId: null` on every task it
 * creates — CO scope lives in ChangeOrderItem, a different table — and the
 * recalc used to load only tasks WITH an estimateItemId. Net effect:
 *
 *   - a CO-only phase carried real budget weight and could never advance past
 *     0%, permanently dragging the whole job's percentage down;
 *   - CO work in a phase shared with the original estimate silently inherited
 *     the estimate tasks' progress instead of reporting its own.
 *
 * The fix is ScheduleTask.costCodeId, stamped at generation for both estimate-
 * and CO-generated tasks, with the recalc resolving
 * `estimateItem?.costCodeId ?? task.costCodeId`.
 *
 * Prisma is faked with the scoped CJS require() patch used across this repo —
 * `mock.module()` is unusable here (CI pins Node 20).
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

interface Fixture {
    estimateItems: any[];
    changeOrderItems: any[];
    scheduleTasks: any[];
    dailyLogs: any[];
}
let fixture: Fixture;
let recordedTaskQuery: any;
let written: { auto: number | null } | null;

const estimateItem = (id: string, costCodeId: string | null, total: number) => ({
    id, name: id, type: "Labor", parentId: null, total,
    costCodeId,
    costCode: costCodeId ? { code: costCodeId, name: costCodeId } : null,
    costType: { name: "Labor" },
});

const coItem = (id: string, costCodeId: string | null, total: number) => ({
    id, name: id, total, type: "Labor",
    costCodeId,
    costCode: costCodeId ? { code: costCodeId, name: costCodeId } : null,
    costType: { name: "Labor" },
});

/** An estimate-generated task: phase comes from the live estimate item. */
const estimateTask = (id: string, costCodeId: string | null, status: string, parentId: string | null = null) => ({
    id, status, type: "task", parentId,
    costCodeId: costCodeId,           // stamped at generation
    estimateItem: { costCodeId },     // and resolvable live
});

/** A CO-generated task: estimateItemId is ALWAYS null, so the stamp is all there is. */
const coTask = (id: string, costCodeId: string | null, status: string, parentId: string | null = null) => ({
    id, status, type: "task", parentId,
    costCodeId,
    estimateItem: null,
});

function resetFixture() {
    fixture = { estimateItems: [], changeOrderItems: [], scheduleTasks: [], dailyLogs: [] };
    recordedTaskQuery = null;
    written = null;
}

const fakePrisma = {
    project: { findMany: async () => [{ id: "p1", name: "Berg ADU", status: "In Progress" }] },
    costCode: {
        findMany: async () => [
            { id: "cc-demo", code: "01-DEMO", name: "Demolition" },
            { id: "cc-elec", code: "04-ELEC", name: "Electrical" },
        ],
    },
    estimate: { findMany: async () => [{ id: "e1", items: fixture.estimateItems }] },
    estimateItem: { findMany: async () => [] },
    changeOrderItem: { findMany: async () => fixture.changeOrderItems },
    timeEntry: { findMany: async () => [] },
    expense: { findMany: async () => [] },
    scheduleTask: {
        findMany: async (args: any) => {
            recordedTaskQuery = args;
            return fixture.scheduleTasks;
        },
    },
    dailyLog: { findMany: async () => fixture.dailyLogs },
    $executeRawUnsafe: async () => 0,
    $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
        written = { auto: values[0] as number | null };
        return [{ percentComplete: values[0], percentCompleteSource: "AUTO" }];
    },
};

let recalcProjectPercentComplete: (p: { id: string; name: string }) => Promise<any>;

const PRISMA_SPECIFIER = "@/lib/prisma";

before(async () => {
    const originalRequire = Module.prototype.require;
    let hit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) {
            hit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { recalcProjectPercentComplete?: unknown };
    try {
        mod = await import("../src/lib/percent-complete-db");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.recalcProjectPercentComplete !== "function") {
        throw new Error(
            `percent-complete-co-tasks.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply ` +
                `(patch ${hit ? "WAS" : "was NOT"} hit).`,
        );
    }
    recalcProjectPercentComplete = mod.recalcProjectPercentComplete as any;
});

beforeEach(() => {
    resetFixture();
});

const recalc = () => recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

// ── the query itself ────────────────────────────────────────────────────────

test("the task query loads the WHOLE project, so parenthood can be computed", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 1_000)];
    await recalc();

    // Filtering on estimateItemId alone is what made CO tasks invisible; any
    // filter at all would also hide a coded parent whose children are uncoded,
    // making the parent look like a leaf.
    assert.deepEqual(recordedTaskQuery.where, { projectId: "p1" });
    assert.equal(recordedTaskQuery.select.parentId, true);
});

// -- containers are structure, not work ------------------------------------

test("a completed leaf under an incomplete PHASE PARENT reports 100, not 50", async () => {
    // generateScheduleFromEstimate creates a phase parent per top-level estimate
    // line -- a row that mirrors an estimate SECTION, which is itself excluded
    // from the budget because section headers are not billable. Counting it
    // beside its own child made a finished phase read 1/2.
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.scheduleTasks = [
        estimateTask("parent", "cc-demo", "Not Started"),
        estimateTask("leaf", "cc-demo", "Complete", "parent"),
    ];

    await recalc();
    assert.equal(written?.auto, 100);
});

test("a childless top-level task is a LEAF and still counts", async () => {
    // A childless top-level line inside a phased estimate is placed as a task in
    // its own right, so "parentId is null" must not be the exclusion rule.
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.scheduleTasks = [estimateTask("solo", "cc-demo", "Not Started")];

    await recalc();
    assert.equal(written?.auto, 0);
});

test("nested containers are excluded at every level", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.scheduleTasks = [
        estimateTask("grandparent", "cc-demo", "Not Started"),
        estimateTask("parent", "cc-demo", "Not Started", "grandparent"),
        estimateTask("leafA", "cc-demo", "Complete", "parent"),
        estimateTask("leafB", "cc-demo", "Not Started", "parent"),
    ];

    await recalc();
    // Only the two leaves count: 1 of 2 done.
    assert.equal(written?.auto, 50);
});

test("the CO parent is a container too and never dilutes its phase", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", "cc-elec", 10_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Complete"),
        coTask("coParent", "cc-elec", "Not Started"),
        coTask("coChild", "cc-elec", "Complete", "coParent"),
    ];

    await recalc();
    assert.equal(written?.auto, 100);
});

// ── a CO-only phase ─────────────────────────────────────────────────────────

test("a CO-ONLY phase advances when its tasks complete", async () => {
    // Two equally-weighted phases: 01-DEMO from the estimate (untouched),
    // 04-ELEC entirely from an approved change order (done).
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", "cc-elec", 10_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Not Started"),
        coTask("t2", "cc-elec", "Complete"),
    ];

    await recalc();

    // Before the fix this read 0: the CO phase held half the budget weight and
    // had no visible task, so it could never leave 0%.
    assert.equal(written?.auto, 50);
});

test("a CO-only phase with its work still open holds the job back honestly", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", "cc-elec", 10_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Complete"),
        coTask("t2", "cc-elec", "Not Started"),
    ];

    await recalc();
    assert.equal(written?.auto, 50);
});

test("an uncoded CO item still contributes no phase — no guessing", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", null, 2_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Complete"),
        coTask("t2", null, "Not Started"),
    ];

    await recalc();
    // The uncoded $2,000 lands in uncodedBudget: still above the 50% trust
    // floor, and the one coded phase is done.
    assert.equal(written?.auto, 100);
});

// ── a SHARED phase ──────────────────────────────────────────────────────────

test("a shared phase blends estimate and CO tasks instead of inheriting progress", async () => {
    // One phase, budget from both sources. Two tasks, one done.
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", "cc-demo", 5_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Complete"),
        coTask("t2", "cc-demo", "Not Started"),
    ];

    await recalc();
    // Before the fix the CO task was invisible, so the phase read 1/1 = 100%
    // — the added CO scope silently inherited the estimate task's completion.
    assert.equal(written?.auto, 50);
});

test("a shared phase reaches 100 only when the CO work is done too", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", "cc-demo", 5_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Complete"),
        coTask("t2", "cc-demo", "Complete"),
    ];

    await recalc();
    assert.equal(written?.auto, 100);
});

// ── resolution order ────────────────────────────────────────────────────────

test("the LIVE estimate item wins over a stale stamped cost code", async () => {
    // The estimate line was re-coded from 01-DEMO to 04-ELEC after the schedule
    // was generated. The task's stamp is stale; the live link must win, or
    // re-coding an estimate would silently stop moving its phase.
    fixture.estimateItems = [estimateItem("i1", "cc-elec", 10_000)];
    fixture.scheduleTasks = [
        { id: "t1", status: "Complete", type: "task", costCodeId: "cc-demo", estimateItem: { costCodeId: "cc-elec" } },
    ];

    await recalc();
    // Counted under 04-ELEC (the only phase with budget) → 100.
    assert.equal(written?.auto, 100);
});

test("a task whose estimate item was deleted falls back to its stamped code", async () => {
    // estimateItemId is onDelete: SetNull, so deleting the line used to strip
    // the task's phase entirely. The stamp preserves it.
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.scheduleTasks = [
        { id: "t1", status: "Complete", type: "task", costCodeId: "cc-demo", estimateItem: null },
    ];

    await recalc();
    assert.equal(written?.auto, 100);
});

test("an estimate line RE-CODED TO NULL is uncoded, not silently kept in its old phase", async () => {
    // The line was generated under 01-DEMO (so the task carries that stamp) and
    // has since been deliberately cleared to "no cost code". `?? task.costCodeId`
    // fell through to the stale stamp and went on counting it under 01-DEMO --
    // an item that EXISTS and says null means uncoded, and only a MISSING
    // relation may fall back to the stamp.
    fixture.estimateItems = [
        estimateItem("i1", null, 4_000),           // re-coded to null -> uncoded budget
        estimateItem("i2", "cc-elec", 10_000),     // the one real phase
    ];
    fixture.scheduleTasks = [
        { id: "t1", status: "Complete", type: "task", costCodeId: "cc-demo", estimateItem: { costCodeId: null } },
        { id: "t2", status: "Not Started", type: "task", costCodeId: "cc-elec", estimateItem: { costCodeId: "cc-elec" } },
    ];

    await recalc();

    // Only 04-ELEC has budget, and its single task is untouched -> 0.
    // With the stale-stamp fallback the completed t1 was counted under a
    // phantom 01-DEMO phase instead.
    assert.equal(written?.auto, 0);
});

test("a task-less phase with a daily log naming it counts as half started", async () => {
    // The whole point of the fallback, exercised through the real DB path: a
    // phase with budget, NO schedule tasks, and the crew writing about it.
    fixture.estimateItems = [
        estimateItem("i1", "cc-demo", 10_000),
        estimateItem("i2", "cc-elec", 10_000),
    ];
    fixture.scheduleTasks = [estimateTask("t1", "cc-demo", "Not Started")];
    fixture.dailyLogs = [{ workPerformed: "Rough-in continued; cc-elec panel work started today." }];

    await recalc();
    // 01-DEMO 0% (task not started) + 04-ELEC 50% (log evidence, no tasks).
    assert.equal(written?.auto, 25);
});

test("a task-less phase with NO log mention stays at zero", async () => {
    fixture.estimateItems = [
        estimateItem("i1", "cc-demo", 10_000),
        estimateItem("i2", "cc-elec", 10_000),
    ];
    fixture.scheduleTasks = [estimateTask("t1", "cc-demo", "Not Started")];
    fixture.dailyLogs = [{ workPerformed: "Cleaned up the site and staged materials." }];

    await recalc();
    assert.equal(written?.auto, 0);
});

test("a log mention never overrides a phase that HAS tasks", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.scheduleTasks = [estimateTask("t1", "cc-demo", "Not Started")];
    fixture.dailyLogs = [{ workPerformed: "cc-demo demolition all day" }];

    await recalc();
    assert.equal(written?.auto, 0);
});

test("CO milestones are markers, not work — they never dilute a phase", async () => {
    fixture.estimateItems = [estimateItem("i1", "cc-demo", 10_000)];
    fixture.changeOrderItems = [coItem("co1", "cc-elec", 10_000)];
    fixture.scheduleTasks = [
        estimateTask("t1", "cc-demo", "Complete"),
        coTask("t2", "cc-elec", "Complete"),
        { id: "m1", status: "Not Started", type: "milestone", costCodeId: "cc-elec", estimateItem: null },
    ];

    await recalc();
    assert.equal(written?.auto, 100);
});
