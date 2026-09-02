/**
 * The CO-task cost-code repair: same SQL in both places, and safe to re-run.
 *
 * WHY IT RUNS TWICE. The pre-deploy apply script runs BEFORE the new build goes
 * live. Every change-order task the OLD build creates in the window between the
 * script finishing and the deploy landing is born with no cost code — and a
 * one-shot backfill has already been and gone, so those tasks would stay
 * unattributed forever. The nightly recalc therefore runs the same statement as
 * a repair pass. That only works if it is genuinely idempotent, and if the two
 * copies of the SQL never drift.
 *
 * Importing the apply script is safe: it is wrapped in a main-module guard, so
 * importing resolves no DATABASE_URL and opens no connection (asserted below —
 * if that guard is ever removed, this test starts hitting a real database and
 * the assertion is what tells us).
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";

import { BACKFILL_CO_TASK_COST_CODES as SCRIPT_SQL } from "../scripts/apply-percent-complete.mjs";

// ── in-memory stand-in for the UPDATE ───────────────────────────────────────

interface Task { id: string; coId: string | null; name: string; type: string; costCodeId: string | null; estimateItemId: string | null; parentId: string | null }
interface CoItem { coId: string; name: string; costCodeId: string | null; total: number }

let tasks: Task[];
let coItems: CoItem[];
let statementsRun: string[];

function resetFixture() {
    tasks = [
        // The CO PARENT row: type 'task', no estimate item, and parentId null.
        { id: "t2", coId: "co1", name: "CO-001 · Extra electrical", type: "task", costCodeId: null, estimateItemId: null, parentId: null },
        // A generated CHILD, built from the CO item of the same name.
        { id: "t1", coId: "co1", name: "Recessed lighting", type: "task", costCodeId: null, estimateItemId: null, parentId: "t2" },
    ];
    coItems = [{ coId: "co1", name: "Recessed lighting", costCodeId: "cc-elec", total: 1200 }];
    statementsRun = [];
}

/** Applies exactly the predicate the real statement encodes. */
function applyBackfill(): number {
    let n = 0;
    for (const t of tasks) {
        if (t.costCodeId !== null) continue;          // st."costCodeId" IS NULL
        if (t.estimateItemId !== null) continue;      // st."estimateItemId" IS NULL
        if (t.type !== "task") continue;              // st."type" = 'task'
        if (t.parentId === null) continue;            // st."parentId" IS NOT NULL
        if (!t.coId) continue;
        const matches = coItems.filter(
            (c) => c.coId === t.coId && c.name === t.name && c.costCodeId !== null && c.total >= 0
        );
        if (matches.length !== 1) continue;           // unambiguous task-producing CO item
        const twins = tasks.filter(
            (s) => s.coId === t.coId && s.name === t.name && s.type === "task" && s.parentId !== null
        );
        if (twins.length !== 1) continue;             // unambiguous child task
        t.costCodeId = matches[0].costCodeId;
        n++;
    }
    return n;
}

const fakePrisma = {
    $executeRawUnsafe: async (sql: string) => {
        statementsRun.push(sql);
        return applyBackfill();
    },
    // Present so an accidental query is a loud failure rather than a silent one.
    project: { findMany: async () => { throw new Error("repair must not list projects"); } },
};

let repairChangeOrderTaskCostCodes: () => Promise<number>;
let APP_SQL: string;

const PRISMA_SPECIFIER = "@/lib/prisma";

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) return { prisma: fakePrisma };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/lib/percent-complete-db");
    } finally {
        Module.prototype.require = originalRequire;
    }
    repairChangeOrderTaskCostCodes = mod.repairChangeOrderTaskCostCodes;
    APP_SQL = mod.BACKFILL_CO_TASK_COST_CODES;
});

beforeEach(() => {
    resetFixture();
});

// ── the two copies must not drift ───────────────────────────────────────────

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

test("the apply script and the nightly repair run the SAME statement", () => {
    assert.equal(normalize(SCRIPT_SQL), normalize(APP_SQL));
});

test("the checked-in migration carries that same statement", () => {
    // Three copies exist by necessity (the .mjs writes prod, the migration
    // builds CI's database, the app repairs nightly). Only a test can stop them
    // drifting.
    const migration = readFileSync(
        new URL("../prisma/migrations/20260901000000_percent_complete/migration.sql", import.meta.url),
        "utf8",
    );
    assert.ok(
        normalize(migration).includes(normalize(APP_SQL)),
        "migration.sql has drifted from BACKFILL_CO_TASK_COST_CODES",
    );
});

test("importing the apply script has no side effects (main-module guard intact)", () => {
    // If the guard is removed, importing resolves DATABASE_URL and constructs a
    // PrismaClient at module load — this test is the tripwire for that.
    assert.equal(typeof SCRIPT_SQL, "string");
    assert.ok(SCRIPT_SQL.includes("ScheduleTask"));
});

test("the statement carries the guards that make it safe to repeat", () => {
    assert.match(APP_SQL, /st\."costCodeId" IS NULL/, "without this, a re-run would overwrite corrected codes");
    assert.match(APP_SQL, /st\."estimateItemId" IS NULL/, "estimate tasks resolve through their live item, not this");
    assert.match(APP_SQL, /st\."type" = 'task'/, "milestones are markers, not work");
    assert.match(APP_SQL, /st\."parentId" IS NOT NULL/, "the CO parent row is structural, never generated from an item");
    assert.match(APP_SQL, /ci\."total" >= 0/, "negative deduction lines never produce a task");
    assert.match(APP_SQL, /COUNT\(\*\) FROM "ChangeOrderItem"/, "ambiguous CO item names must not be guessed");
    assert.match(APP_SQL, /COUNT\(\*\) FROM "ScheduleTask"/, "ambiguous task names must not be guessed");
});

// ── idempotency ─────────────────────────────────────────────────────────────

test("the repair fixes what it can on the first run and nothing on the second", async () => {
    const first = await repairChangeOrderTaskCostCodes();
    assert.equal(first, 1);
    assert.equal(tasks.find((t) => t.id === "t1")?.costCodeId, "cc-elec");

    const second = await repairChangeOrderTaskCostCodes();
    assert.equal(second, 0, "a second run must be a no-op — this is what lets it run nightly");
    assert.equal(tasks.find((t) => t.id === "t1")?.costCodeId, "cc-elec");

    const third = await repairChangeOrderTaskCostCodes();
    assert.equal(third, 0);
    assert.equal(statementsRun.length, 3);
    assert.equal(new Set(statementsRun).size, 1, "the same statement every time");
});

test("a task fixed by hand is never overwritten by a later repair", async () => {
    const child = tasks.find((t) => t.id === "t1")!;
    child.costCodeId = "cc-manual";
    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 0);
    assert.equal(child.costCodeId, "cc-manual");
});

test("a CO task created AFTER the first repair is picked up by the next one", async () => {
    // Exactly the rollout window this repair exists for: the old build created
    // this task between the apply script running and the deploy landing.
    await repairChangeOrderTaskCostCodes();

    tasks.push({ id: "t3", coId: "co1", name: "Panel upgrade", type: "task", costCodeId: null, estimateItemId: null, parentId: "t2" });
    coItems.push({ coId: "co1", name: "Panel upgrade", costCodeId: "cc-elec", total: 900 });

    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 1);
    assert.equal(tasks.find((t) => t.id === "t3")?.costCodeId, "cc-elec");
});

// ── the ambiguity guards ────────────────────────────────────────────────────

test("two CO items sharing a name are left alone rather than guessed", async () => {
    coItems.push({ coId: "co1", name: "Recessed lighting", costCodeId: "cc-other", total: 800 });
    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 0);
    assert.equal(tasks.find((t) => t.id === "t1")?.costCodeId, null);
});

test("two CO tasks sharing a name are left alone rather than guessed", async () => {
    tasks.push({ id: "t4", coId: "co1", name: "Recessed lighting", type: "task", costCodeId: null, estimateItemId: null, parentId: "t2" });
    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 0);
    assert.equal(tasks.find((t) => t.id === "t1")?.costCodeId, null);
});

test("the CO parent row matches no item name and stays unattributed", async () => {
    await repairChangeOrderTaskCostCodes();
    assert.equal(tasks.find((t) => t.id === "t2")?.costCodeId, null);
});

// -- narrowing to exactly what generation produces ---------------------------

test("the structural CO PARENT is never stamped, even on an exact name collision", async () => {
    // The parent row is type 'task' with a null estimateItemId, so only the
    // parentId guard keeps it out. Stamping it would add a phantom task to the
    // phase's completion ratio -- a parent is a container, not work.
    coItems.push({ coId: "co1", name: "CO-001 · Extra electrical", costCodeId: "cc-elec", total: 500 });

    const n = await repairChangeOrderTaskCostCodes();

    assert.equal(tasks.find((t) => t.id === "t2")?.costCodeId, null, "the parent must stay unattributed");
    assert.equal(n, 1, "the real child is still fixed");
    assert.equal(tasks.find((t) => t.id === "t1")?.costCodeId, "cc-elec");
});

test("a negative DEDUCTION line never stamps anything -- it produces no task", async () => {
    // applyChangeOrderToSchedule builds children from items with total >= 0.
    // A deduction generates no task at all, so any name match against one is a
    // false positive by construction.
    tasks.push({ id: "t5", coId: "co1", name: "Remove tile allowance", type: "task", costCodeId: null, estimateItemId: null, parentId: "t2" });
    coItems.push({ coId: "co1", name: "Remove tile allowance", costCodeId: "cc-tile", total: -1500 });

    await repairChangeOrderTaskCostCodes();

    assert.equal(tasks.find((t) => t.id === "t5")?.costCodeId, null);
});

test("a deduction sharing a name with a real item does not trip the ambiguity guard", async () => {
    // Before the total >= 0 narrowing, a same-named deduction made the CO-item
    // count 2 and silently blocked a match that is not actually ambiguous:
    // only one of the two ever produced a task.
    coItems.push({ coId: "co1", name: "Recessed lighting", costCodeId: "cc-tile", total: -300 });

    const n = await repairChangeOrderTaskCostCodes();

    assert.equal(n, 1);
    assert.equal(tasks.find((t) => t.id === "t1")?.costCodeId, "cc-elec");
});
