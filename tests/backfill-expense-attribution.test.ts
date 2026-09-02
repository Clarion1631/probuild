/**
 * The backfill writes to the books, so the two properties that matter are
 * "a dry run writes NOTHING" and "an apply cannot overwrite a human".
 *
 * Everything is driven through an injected prisma-shaped stub — no module
 * mocking (CI is Node 20), no database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
    MIN_CONFIDENCE,
    measureCoverage,
    planBackfill,
    projectedRows,
    remainderCsv,
    runBackfill,
} from "../scripts/backfill-expense-attribution.mjs";

const OVERHEAD_ID = "overhead-project";

type StubExpense = {
    id: string;
    estimateId: string;
    projectId: string | null;
    costCodeId: string | null;
    costCodeSource: string | null;
    itemId: string | null;
    amount: number;
    vendor: string | null;
    description: string | null;
    date: Date | null;
    estimate: { projectId: string | null };
};

/** What the loader hands `planBackfill`: the item plus WHERE it lives. */
type StubItem = { costCodeId: string | null; estimateId: string; projectId: string | null };

function expense(overrides: Partial<StubExpense> = {}): StubExpense {
    return {
        id: "e1",
        estimateId: "est-job-1",
        projectId: null,
        costCodeId: null,
        costCodeSource: null,
        itemId: null,
        amount: 100,
        vendor: null,
        description: null,
        date: new Date("2026-08-01T00:00:00.000Z"),
        estimate: { projectId: "job-1" },
        ...overrides,
    };
}

const NO_ITEMS = new Map<string, StubItem>();

const COST_CODE_IDS = new Map([
    ["03-PLUMB", "cc-plumb"],
    ["02-FRAME", "cc-frame"],
]);

function createStub(
    expenses: StubExpense[],
    items: { id: string; costCodeId: string | null; estimateId: string; estimate: { projectId: string | null } }[] = [],
) {
    const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    return {
        writes,
        db: {
            project: {
                async findMany() {
                    return [
                        { id: "job-1", name: "Mueller Bath", status: "In Progress" },
                        { id: "job-closed", name: "Old Job", status: "Closed Complete" },
                        { id: OVERHEAD_ID, name: "Shop", status: "In Progress" },
                    ];
                },
            },
            costCode: {
                async findMany() {
                    return [...COST_CODE_IDS].map(([code, id]) => ({ id, code }));
                },
            },
            estimateItem: {
                async findMany() { return items; },
            },
            timeEntry: {
                async findMany() { return []; },
            },
            expense: {
                async findMany() { return expenses; },
                async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
                    writes.push(args);
                    return { count: 1 };
                },
            },
        },
    };
}

// ── planning ────────────────────────────────────────────────────────────────

test("plans a projectId fill only for rows whose column is still NULL", () => {
    const plan = planBackfill({
        expenses: [
            expense({ id: "needs-fill", projectId: null, estimate: { projectId: "job-1" } }),
            expense({ id: "already-set", projectId: "job-1", estimate: { projectId: "job-1" } }),
            expense({ id: "no-answer", projectId: null, estimate: { projectId: null } }),
        ],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.projectFills, [{ id: "needs-fill", projectId: "job-1" }]);
});

test("the item fallback wins over the rules, and is sourced 'backfill'", () => {
    const plan = planBackfill({
        expenses: [expense({ id: "e1", itemId: "item-1", vendor: "Summit Plumbing" })],
        items: new Map([["item-1", { costCodeId: "cc-frame", estimateId: "est-job-1", projectId: "job-1" }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.equal(plan.codeFills.length, 1);
    assert.equal(plan.codeFills[0].costCodeId, "cc-frame", "a real link beats a regex guess");
    assert.equal(plan.codeFills[0].costCodeSource, "backfill");
    assert.equal(plan.codeFills[0].costCodeConfidence, null);
});

// ── the item link has to be checked before it is trusted (blocker 3) ────────

test("an itemId pointing at ANOTHER job's line item is skipped, not copied", () => {
    // Expense.itemId is ON DELETE SET NULL and was never scoped to the
    // expense's own estimate on the historical write paths, so a stored link
    // can legitimately point somewhere else. Copying that code would move a
    // phase across jobs and label the result "backfill".
    const plan = planBackfill({
        expenses: [expense({ id: "e1", estimateId: "est-job-1", itemId: "item-other" })],
        items: new Map([["item-other", { costCodeId: "cc-frame", estimateId: "est-job-2", projectId: "job-2" }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1", "job-2"],
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder.length, 1);
    assert.equal(plan.remainder[0].reason, "item-outside-estimate");
});

test("a cross-job item is skipped even when the rules WOULD have had an answer", () => {
    // The skip must be terminal for that row, not a fall-through to the
    // suggester — otherwise a bad link quietly becomes a regex guess and the
    // data problem is never surfaced to a human.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", itemId: "item-other", vendor: "Summit Plumbing" })],
        items: new Map([["item-other", { costCodeId: "cc-frame", estimateId: "est-job-2", projectId: "job-2" }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder[0].reason, "item-outside-estimate");
});

test("an item on ANOTHER estimate of the SAME job is accepted", () => {
    // Change-order and revised-estimate work lands on a different estimate of
    // the same project, and createExpenseCore already requires a CO and its
    // estimate to share the project. That link does not cross jobs.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", estimateId: "est-job-1", projectId: "job-1", itemId: "item-co" })],
        items: new Map([["item-co", { costCodeId: "cc-frame", estimateId: "est-job-1-co", projectId: "job-1" }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.equal(plan.codeFills.length, 1);
    assert.equal(plan.codeFills[0].costCodeId, "cc-frame");
    assert.match(plan.codeFills[0].why, /same project/);
});

test("a dangling itemId falls through to the rules rather than being skipped", () => {
    // The item is gone (or carries no code). That is no evidence either way,
    // so it must not consume the row — the suggester still gets its turn.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", projectId: "job-1", itemId: "item-deleted", vendor: "Summit Plumbing" })],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.equal(plan.codeFills.length, 1);
    assert.equal(plan.codeFills[0].costCodeSource, "ai");
});

test("a human's cost code is never planned over — capture and manual both", () => {
    for (const costCodeSource of ["capture", "manual"]) {
        const plan = planBackfill({
            expenses: [expense({ costCodeSource, vendor: "Summit Plumbing" })],
            items: NO_ITEMS,
            costCodeIdByCode: COST_CODE_IDS,
            scopedProjectIds: ["job-1"],
        });
        assert.deepEqual(plan.codeFills, [], `${costCodeSource} must be untouchable`);
        assert.deepEqual(plan.remainder, [], "and it is not 'needs a human' either — it HAS an answer");
    }
});

test("an already-coded row is left alone even with a NULL source", () => {
    const plan = planBackfill({
        expenses: [expense({ costCodeId: "cc-existing", vendor: "Summit Plumbing" })],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.codeFills, []);
});

test("the overhead bucket and closed jobs are out of the suggester's scope", () => {
    const plan = planBackfill({
        expenses: [
            expense({ id: "overhead", projectId: OVERHEAD_ID, estimate: { projectId: OVERHEAD_ID }, vendor: "Summit Plumbing" }),
            expense({ id: "closed", projectId: "job-closed", estimate: { projectId: "job-closed" }, vendor: "Summit Plumbing" }),
            expense({ id: "active", projectId: "job-1", estimate: { projectId: "job-1" }, vendor: "Summit Plumbing" }),
        ],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.codeFills.map(f => f.id), ["active"]);
    assert.deepEqual(plan.remainder.map(e => e.id).sort(), ["closed", "overhead"]);
    assert.deepEqual(plan.remainder.map(e => e.reason), ["out-of-scope", "out-of-scope"]);
});

test("a rule hit below the confidence floor is left for a human", () => {
    // Both current tiers clear 0.7, so this is asserted through the constant
    // rather than through a rule — the floor's job is to make ADDING a weaker
    // tier a deliberate act instead of a silent one.
    assert.equal(MIN_CONFIDENCE, 0.7);
    const plan = planBackfill({
        expenses: [expense({ vendor: "Summit Plumbing" })],
        items: NO_ITEMS,
        // The rules name 03-PLUMB; this company does not have that code.
        costCodeIdByCode: new Map(),
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder.length, 1, "an unknown code is a human's problem, not a skip");
});

// ── coverage reporting ──────────────────────────────────────────────────────

test("coverage is measured on ABSOLUTE dollars so refunds cannot fake 100%", () => {
    const rows = [
        { costCodeId: "cc-plumb", amount: 1000 },
        { costCodeId: null, amount: -1000 },
    ];
    const coverage = measureCoverage(rows);
    assert.equal(coverage.total, 2000, "netting would make this 0 and the share meaningless");
    assert.equal(coverage.attributed, 1000);
    assert.equal(coverage.unattributed, 1000);
});

test("the projected 'after' applies the plan without touching the database", () => {
    const rows = [expense({ id: "e1", vendor: "Summit Plumbing", amount: 400 })];
    const plan = planBackfill({
        expenses: rows,
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.equal(measureCoverage(rows).attributed, 0);
    assert.equal(measureCoverage(projectedRows(rows, plan.codeFills)).attributed, 400);
    assert.equal(rows[0].costCodeId, null, "the source rows are not mutated");
});

test("the remainder CSV carries what Marge needs to decide, including WHY", () => {
    const csv = remainderCsv(
        [{
            ...expense({ id: "e9", vendor: 'Lowe"s', description: "misc\nsupplies", amount: 12.5 }),
            reason: "item-outside-estimate",
        }],
        new Map([["job-1", "Mueller Bath"]]),
    );
    const [header, row] = csv.split("\n");
    assert.equal(header, "expense_id,project,date,vendor,amount,reason,description");
    assert.match(
        row,
        /^e9,"Mueller Bath",2026-08-01,"Lowe""s",12\.50,"item-outside-estimate","misc supplies"$/,
    );
});

// ── the run ─────────────────────────────────────────────────────────────────

test("a dry run makes ZERO write calls", async () => {
    const stub = createStub([
        expense({ id: "e1", vendor: "Summit Plumbing" }),
        expense({ id: "e2", projectId: null, estimate: { projectId: "job-1" } }),
    ]);
    const result = await runBackfill({ db: stub.db, apply: false, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(stub.writes.length, 0, "dry run is the default and it must be inert");
    assert.equal(result.written.projectIds, 0);
    assert.equal(result.written.costCodes, 0);
    assert.ok(result.plan.codeFills.length > 0, "...while still PLANNING the work it would do");
});

test("apply writes both passes, each behind its own predicate", async () => {
    const stub = createStub([
        expense({ id: "e1", vendor: "Summit Plumbing", projectId: null, estimate: { projectId: "job-1" } }),
    ]);
    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });

    const projectWrite = stub.writes.find(w => "projectId" in w.data)!;
    assert.deepEqual(projectWrite.where, { id: { in: ["e1"] }, projectId: null });

    const codeWrite = stub.writes.find(w => "costCodeId" in w.data)!;
    assert.equal(codeWrite.where.id, "e1");
    assert.equal(codeWrite.where.costCodeId, null);
    assert.deepEqual(codeWrite.where.OR, [
        { costCodeSource: null },
        { costCodeSource: { notIn: ["capture", "manual"] } },
    ]);
    assert.deepEqual(codeWrite.data, {
        costCodeId: "cc-plumb",
        costCodeSource: "ai",
        costCodeConfidence: 0.9,
    });
});

test("the write predicate re-checks NULL, not just the plan", async () => {
    // Between the read and the write, a re-sync or a bookkeeper can set either
    // field. A plan is a snapshot; the predicate is the guarantee.
    const stub = createStub([expense({ id: "e1", vendor: "Summit Plumbing" })]);
    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    for (const write of stub.writes) {
        const guardsNull =
            write.where.projectId === null || write.where.costCodeId === null;
        assert.ok(guardsNull, `unguarded write: ${JSON.stringify(write.where)}`);
    }
});

test("a re-run over already-attributed data plans nothing", async () => {
    // The proof rule: after --apply, a dry run must report zero.
    const stub = createStub([
        expense({ id: "e1", projectId: "job-1", costCodeId: "cc-plumb", costCodeSource: "ai", vendor: "Summit Plumbing" }),
    ]);
    const result = await runBackfill({ db: stub.db, apply: false, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(result.plan.projectFills, []);
    assert.deepEqual(result.plan.codeFills, []);
});

test("the CSV is written on a dry run — reviewing it is the point", async () => {
    const stub = createStub([expense({ id: "e1", vendor: "Unknown Hardware" })]);
    const files: { path: string; body: string }[] = [];
    await runBackfill({
        db: stub.db,
        apply: false,
        csvPath: "out.csv",
        writeFile: (path: string, body: string) => { files.push({ path, body }); },
        log: () => {},
        overheadProjectId: OVERHEAD_ID,
    });
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "out.csv");
    assert.match(files[0].body, /^expense_id,project,date,vendor,amount,reason,description/);
    assert.match(files[0].body, /e1/);
});
