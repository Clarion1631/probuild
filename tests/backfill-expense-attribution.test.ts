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

/**
 * The jobs' own phases. Required for a suggestion to be written at all — the
 * check fails CLOSED, so a test that omits this is asserting the refusal path.
 */
const ALL_PHASES = new Map([
    ["job-1", new Set(["cc-plumb", "cc-frame"])],
    ["job-2", new Set(["cc-plumb", "cc-frame"])],
    ["job-closed", new Set(["cc-plumb", "cc-frame"])],
    ["overhead-project", new Set(["cc-plumb", "cc-frame"])],
]);

const COST_CODE_IDS = new Map([
    ["03-PLUMB", "cc-plumb"],
    ["02-FRAME", "cc-frame"],
]);

/**
 * STATEFUL by design. An earlier version returned `{ count: 1 }` without
 * touching the fixture, which made every write look like it succeeded — and
 * that is exactly what hid the bug where pass (a) filled `projectId` and pass
 * (c)'s predicate then matched nothing. A stub that cannot fail a predicate
 * cannot test a predicate.
 */
function createStub(
    expenses: StubExpense[],
    items: { id: string; costCodeId: string | null; estimateId: string; estimate: { projectId: string | null } }[] = [],
) {
    const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    const rows = expenses;

    const matches = (row: StubExpense, where: Record<string, unknown>): boolean => {
        if (typeof where.id === "string" && row.id !== where.id) return false;
        if (where.id && typeof where.id === "object") {
            const ids = (where.id as { in?: string[] }).in ?? [];
            if (!ids.includes(row.id)) return false;
        }
        if ("projectId" in where && (row.projectId ?? null) !== where.projectId) return false;
        if ("costCodeId" in where && (row.costCodeId ?? null) !== where.costCodeId) return false;
        if (Array.isArray(where.OR)) {
            const ok = (where.OR as Record<string, unknown>[]).some(branch => {
                if (!("costCodeSource" in branch)) return false;
                const expected = branch.costCodeSource;
                if (expected === null) return (row.costCodeSource ?? null) === null;
                const notIn = (expected as { notIn?: string[] }).notIn ?? [];
                // SQL semantics: NULL NOT IN (...) is NULL, i.e. NOT a match.
                return row.costCodeSource !== null && !notIn.includes(row.costCodeSource);
            });
            if (!ok) return false;
        }
        return true;
    };

    return {
        writes,
        rows,
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
                async findMany() { return rows; },
                async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
                    writes.push(args);
                    let count = 0;
                    for (const row of rows) {
                        if (!matches(row, args.where)) continue;
                        Object.assign(row, args.data);
                        count += 1;
                    }
                    return { count };
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
        allowedCodesByProject: ALL_PHASES,
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
        allowedCodesByProject: ALL_PHASES,
    });
    assert.equal(plan.codeFills.length, 1);
    assert.equal(plan.codeFills[0].costCodeId, "cc-frame");
    assert.match(plan.codeFills[0].why, /same project/);
});

test("an item link does not excuse a code that is NOT a live phase of the job", () => {
    // The link proves the JOB; it does not prove the CODE. An item on a draft
    // or archived estimate can carry a code the job never committed to, and
    // the item fallback used to bypass the phase gate entirely.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", projectId: "job-1", itemId: "item-draft" })],
        items: new Map([["item-draft", { costCodeId: "cc-frame", estimateId: "est-draft", projectId: "job-1" }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
        allowedCodesByProject: new Map([["job-1", new Set(["cc-plumb"])]]),
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder[0].reason, "phase-not-on-project");
});

test("the PROJECT decides, and a matching estimateId is no longer a shortcut", () => {
    // Codex round 2, blocker 1. The old code accepted
    // `item.estimateId === expense.estimateId` as an alternative to the project
    // check. The one case that shortcut uniquely covered is the unsound one:
    // the two rows agree on an estimate whose own projectId is NULL or has
    // moved, so the expense resolves to one job and the item to none — and the
    // shortcut fired precisely BECAUSE the project check had already failed.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", estimateId: "shared-est", projectId: "job-1", itemId: "item-x" })],
        items: new Map([["item-x", { costCodeId: "cc-frame", estimateId: "shared-est", projectId: null }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder[0].reason, "item-outside-estimate");
});

test("an expense with no resolvable job cannot borrow a phase from an item", () => {
    // Nothing to compare the item against, so there is no evidence the link is
    // on the right job. A guess here is a wrong cost code with "backfill"
    // provenance on it.
    const plan = planBackfill({
        expenses: [expense({
            id: "e1", estimateId: "est-job-1", projectId: null,
            estimate: { projectId: null }, itemId: "item-1",
        })],
        items: new Map([["item-1", { costCodeId: "cc-frame", estimateId: "est-job-1", projectId: "job-1" }]]),
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder[0].reason, "item-outside-estimate");
});

test("a dangling itemId falls through to the rules rather than being skipped", () => {
    // The item is gone (or carries no code). That is no evidence either way,
    // so it must not consume the row — the suggester still gets its turn.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", projectId: "job-1", itemId: "item-deleted", vendor: "Summit Plumbing" })],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
        allowedCodesByProject: ALL_PHASES,
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
        allowedCodesByProject: ALL_PHASES,
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
        allowedCodesByProject: ALL_PHASES,
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
    assert.equal(
        row,
        '"e9","Mueller Bath","2026-08-01","Lowe""s",12.50,"item-outside-estimate","misc supplies"',
    );
});

test("the remainder CSV neutralizes formulas — vendor names here are OCR output", () => {
    // This file used to have its own escaper that merely quoted, so a receipt
    // read as `=cmd|...` was executable the moment the CSV was opened.
    const csv = remainderCsv(
        [{
            ...expense({ id: "e1", vendor: "=cmd|'/c calc'!A1", description: "@SUM(A1)", amount: -5 }),
            reason: "no-rule-match",
        }],
        new Map([["job-1", "+Mueller"]]),
    );
    const row = csv.split("\n")[1];
    assert.match(row, /"'=cmd\|'\/c calc'!A1"/);
    assert.match(row, /"'@SUM\(A1\)"/);
    assert.match(row, /"'\+Mueller"/);
    // ...while a negative amount stays a NUMBER, or every SUM in the sheet breaks.
    assert.match(row, /,-5\.00,/);
});

// ── the run ─────────────────────────────────────────────────────────────────

test("a dry run makes ZERO write calls", async () => {
    const stub = createStub(
        [
            expense({ id: "e1", vendor: "Summit Plumbing" }),
            expense({ id: "e2", projectId: null, estimate: { projectId: "job-1" } }),
        ],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    const result = await runBackfill({ db: stub.db, apply: false, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(stub.writes.length, 0, "dry run is the default and it must be inert");
    assert.equal(result.written.projectIds, 0);
    assert.equal(result.written.costCodes, 0);
    assert.ok(result.plan.codeFills.length > 0, "...while still PLANNING the work it would do");
});

test("apply writes both passes, each behind its own predicate", async () => {
    const stub = createStub(
        [expense({ id: "e1", vendor: "Summit Plumbing", projectId: null, estimate: { projectId: "job-1" } })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
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
    // The POST-FILL project. Asserting `null` here is what let the ordering
    // bug through: pass (a) had already set it, so the write matched nothing.
    assert.equal(codeWrite.where.projectId, "job-1");
    assert.deepEqual(codeWrite.data, {
        costCodeId: "cc-plumb",
        costCodeSource: "ai",
        costCodeConfidence: 0.9,
    });
});

test("ONE --apply actually codes the row, and a second dry run plans nothing", async () => {
    // The end-to-end proof, against a stub that honours predicates. The bug
    // this catches produced a run that reported success and wrote no cost code
    // at all, because pass (c)'s predicate still said `projectId: null` after
    // pass (a) had filled it.
    const stub = createStub(
        [expense({ id: "e1", vendor: "Summit Plumbing", projectId: null, estimate: { projectId: "job-1" } })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );

    const applied = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(applied.written.projectIds, 1);
    assert.equal(applied.written.costCodes, 1, "the cost code must actually land");
    assert.equal(stub.rows[0].projectId, "job-1");
    assert.equal(stub.rows[0].costCodeId, "cc-plumb");
    assert.equal(stub.rows[0].costCodeSource, "ai");

    const rerun = await runBackfill({ db: stub.db, apply: false, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(rerun.plan.projectFills, [], "re-run must plan zero project fills");
    assert.deepEqual(rerun.plan.codeFills, [], "re-run must plan zero cost codes");
});

test("a row re-attributed between the plan and the write is skipped, not miscoded", async () => {
    const stub = createStub(
        [expense({ id: "e1", vendor: "Summit Plumbing", projectId: "job-1" })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    // Someone moves the row after findMany has handed it to the planner.
    const passThrough = stub.db.expense.updateMany;
    let moved = false;
    stub.db.expense.updateMany = async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!moved) {
            moved = true;
            stub.rows[0].projectId = "job-elsewhere";
        }
        return passThrough(args);
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 0);
    assert.equal(stub.rows[0].costCodeId, null, "no phase from the job it left");
});

test("a cost-code write requires the project the plan resolved", async () => {
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing" })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    const codeWrite = stub.writes.find(w => "costCodeId" in w.data)!;
    assert.equal(codeWrite.where.projectId, "job-1");
});

test("a suggested phase the JOB does not have is refused", () => {
    // "The cost code exists" is not a permission (cost-coding.ts SCOPE note),
    // and a regex that fired on a vendor name knows nothing about which phases
    // this job has. The allowed set comes from the project's coded estimate
    // items — here it holds only framing, so the plumbing suggestion is out.
    const plan = planBackfill({
        expenses: [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing" })],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
        allowedCodesByProject: new Map([["job-1", new Set(["cc-frame"])]]),
    });
    assert.deepEqual(plan.codeFills, []);
    assert.equal(plan.remainder[0].reason, "phase-not-on-project");
});

test("a project with NO mapped phases fails CLOSED", () => {
    // The map has no entry for a job with no coded estimate items — i.e. the
    // job whose phases we know the LEAST about, and the one where a globally
    // matched code is most likely to be wrong. An earlier version treated the
    // missing entry as "no opinion" and wrote the code anyway.
    for (const allowedCodesByProject of [
        new Map<string, Set<string>>(),
        new Map([["job-1", new Set<string>()]]),
        undefined,
    ]) {
        const plan = planBackfill({
            expenses: [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing" })],
            items: NO_ITEMS,
            costCodeIdByCode: COST_CODE_IDS,
            scopedProjectIds: ["job-1"],
            ...(allowedCodesByProject ? { allowedCodesByProject } : {}),
        });
        assert.deepEqual(plan.codeFills, [], "nothing may be written without a positive answer");
        assert.equal(plan.remainder[0].reason, "no-phases");
    }
});

test("a suggested phase the job DOES have is accepted", () => {
    const plan = planBackfill({
        expenses: [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing" })],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
        allowedCodesByProject: new Map([["job-1", new Set(["cc-plumb"])]]),
    });
    assert.equal(plan.codeFills.length, 1);
    assert.equal(plan.codeFills[0].costCodeId, "cc-plumb");
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
        assert.ok(
            "projectId" in write.where,
            `write without an attribution predicate: ${JSON.stringify(write.where)}`,
        );
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

test("coverage counts an item-resolvable row as ALREADY attributed", () => {
    // Codex round 6, item 7. Counting only `costCodeId` overstated the
    // improvement twice: the row read as unattributed BEFORE, then copying the
    // very same code from its item read as new coverage AFTER. The headline was
    // measuring the backfill's activity, not the report's coverage.
    const items = new Map<string, string | null>([["item-1", "cc-frame"]]);
    const rows = [{ costCodeId: null, itemId: "item-1", amount: 400 }];

    assert.equal(measureCoverage(rows, items).attributed, 400, "the item already resolves it");
    assert.equal(measureCoverage(rows, items).unattributed, 0);
    // ...and without the item universe it looks like a gap, which is the bug.
    assert.equal(measureCoverage(rows).attributed, 0);
});

test("coverage still counts a genuinely uncoded row as a gap", () => {
    const rows = [{ costCodeId: null, itemId: null, amount: 100 }];
    assert.equal(measureCoverage(rows, new Map()).unattributed, 100);
    assert.equal(measureCoverage(rows, new Map()).codedCount, 0);
});
