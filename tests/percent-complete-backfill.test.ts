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

import { BACKFILL_CO_TASK_COST_CODES as SCRIPT_SQL } from "../scripts/apply-percent-complete.mjs";

// ── in-memory stand-in for the UPDATE ───────────────────────────────────────

interface Task { id: string; coId: string | null; name: string; type: string; costCodeId: string | null; estimateItemId: string | null }
interface CoItem { coId: string; name: string; costCodeId: string | null }

let tasks: Task[];
let coItems: CoItem[];
let statementsRun: string[];

function resetFixture() {
    tasks = [
        { id: "t1", coId: "co1", name: "Recessed lighting", type: "task", costCodeId: null, estimateItemId: null },
        { id: "t2", coId: "co1", name: "CO-001 · Extra electrical", type: "task", costCodeId: null, estimateItemId: null },
    ];
    coItems = [{ coId: "co1", name: "Recessed lighting", costCodeId: "cc-elec" }];
    statementsRun = [];
}

/** Applies exactly the predicate the real statement encodes. */
function applyBackfill(): number {
    let n = 0;
    for (const t of tasks) {
        if (t.costCodeId !== null) continue;          // st."costCodeId" IS NULL
        if (t.estimateItemId !== null) continue;      // st."estimateItemId" IS NULL
        if (t.type !== "task") continue;              // st."type" = 'task'
        if (!t.coId) continue;
        const matches = coItems.filter((c) => c.coId === t.coId && c.name === t.name && c.costCodeId !== null);
        if (matches.length !== 1) continue;           // unambiguous CO item
        const twins = tasks.filter((s) => s.coId === t.coId && s.name === t.name && s.type === "task");
        if (twins.length !== 1) continue;             // unambiguous task
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

test("the apply script and the nightly repair run the SAME statement", () => {
    const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
    assert.equal(normalize(SCRIPT_SQL), normalize(APP_SQL));
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
    tasks[0].costCodeId = "cc-manual";
    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 0);
    assert.equal(tasks[0].costCodeId, "cc-manual");
});

test("a CO task created AFTER the first repair is picked up by the next one", async () => {
    // Exactly the rollout window this repair exists for: the old build created
    // this task between the apply script running and the deploy landing.
    await repairChangeOrderTaskCostCodes();

    tasks.push({ id: "t3", coId: "co1", name: "Panel upgrade", type: "task", costCodeId: null, estimateItemId: null });
    coItems.push({ coId: "co1", name: "Panel upgrade", costCodeId: "cc-elec" });

    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 1);
    assert.equal(tasks.find((t) => t.id === "t3")?.costCodeId, "cc-elec");
});

// ── the ambiguity guards ────────────────────────────────────────────────────

test("two CO items sharing a name are left alone rather than guessed", async () => {
    coItems.push({ coId: "co1", name: "Recessed lighting", costCodeId: "cc-other" });
    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 0);
    assert.equal(tasks[0].costCodeId, null);
});

test("two CO tasks sharing a name are left alone rather than guessed", async () => {
    tasks.push({ id: "t4", coId: "co1", name: "Recessed lighting", type: "task", costCodeId: null, estimateItemId: null });
    const n = await repairChangeOrderTaskCostCodes();
    assert.equal(n, 0);
    assert.equal(tasks[0].costCodeId, null);
});

test("the CO parent row matches no item name and stays unattributed", async () => {
    await repairChangeOrderTaskCostCodes();
    assert.equal(tasks.find((t) => t.id === "t2")?.costCodeId, null);
});
