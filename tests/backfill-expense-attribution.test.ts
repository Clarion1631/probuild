/**
 * The backfill writes to the books, so the two properties that matter are
 * "a dry run writes NOTHING" and "an apply cannot overwrite a human".
 *
 * Everything is driven through an injected prisma-shaped stub — no module
 * mocking (CI is Node 20), no database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    MIN_CONFIDENCE,
    measureCoverage,
    planBackfill,
    projectedRows,
    remainderCsv,
    runBackfill,
    scopedItemCostCodes,
} from "../scripts/backfill-expense-attribution";

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
    updatedAt?: Date | null;
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
        updatedAt: new Date("2026-09-01T00:00:00.000Z"),
        estimate: { projectId: "job-1" },
        ...overrides,
    };
}

/**
 * The write phase re-asserts `CostCode.isActive` under its own lock (round 20,
 * item 5), so every raw-SQL stub has to answer that read. Active unless a test
 * says otherwise.
 */
let costCodeActive = true;

/**
 * THE ITEM UNIVERSE THE PHASE PROOF READS (round 34, item 3).
 *
 * The write phase no longer decides phase membership from a list it fetched for
 * itself with `estimateItem.findMany`. That read took no lock, so a row
 * inserted and committed after this script's lock scans could answer it and
 * then be deleted before the UPDATE landed. It calls `provePhaseMembershipTx`
 * instead, whose SQL both answers the question and share-locks the
 * estimate/line-item pair the answer came from.
 *
 * That moves the question into raw SQL, so the stub has to answer it there —
 * and from whatever `stub.items` says NOW. A hard-coded "yes" would make
 * every phase test pass by construction. Aliased, not copied, because the
 * tests that matter mutate `stub.items` mid-run.
 */
let phaseProofItems: { costCodeId: string | null; estimate: { projectId: string | null } }[] = [];

function activeCode(query: string, ...args: unknown[]) {
    if (/FROM "CostCode"/.test(query) && /"isActive"/.test(query)) {
        // `code` is deliberately NOT the Safety phase: `assertPhaseOfProjectTx`
        // short-circuits on that one, and the backfill calls the proof query
        // directly precisely so that it does not.
        return [{ id: args[0], code: "stub-code", isActive: costCodeActive }];
    }
    if (/FROM "Project" WHERE id/.test(query)) {
        return [{ id: args[0], status: "In Progress" }];
    }
    // provePhaseMembershipTx: "does an eligible estimate of this project carry
    // this cost code on a line item?" — answered from the live item universe.
    if (/SELECT 1 AS ok/.test(query) && /FROM "EstimateItem" ei/.test(query)) {
        const [projectId, costCodeId] = args as [string, string];
        const proven = phaseProofItems.some(
            item => item.costCodeId === costCodeId && (item.estimate?.projectId ?? null) === projectId,
        );
        return proven ? [{ ok: 1 }] : [];
    }
    return [{}];
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
    // The SAME array, not a copy: tests mutate it to model a phase removed or
    // an item re-coded mid-run, and the proof stub has to see that.
    phaseProofItems = items;

    const matches = (row: StubExpense, where: Record<string, unknown>): boolean => {
        if (typeof where.id === "string" && row.id !== where.id) return false;
        if (where.id && typeof where.id === "object") {
            const ids = (where.id as { in?: string[] }).in ?? [];
            if (!ids.includes(row.id)) return false;
        }
        if ("projectId" in where && (row.projectId ?? null) !== where.projectId) return false;
        if ("costCodeId" in where && (row.costCodeId ?? null) !== where.costCodeId) return false;
        if ("estimateId" in where && row.estimateId !== where.estimateId) return false;
        // The write-time JOIN. `estimateId` proves the row is on the same
        // estimate; this proves the estimate still points at the project the
        // plan read off it.
        if (where.estimate) {
            const want = (where.estimate as any).is?.projectId ?? null;
            if (((row as any).estimate?.projectId ?? null) !== want) return false;
        }
        // The row-version CAS. Dates compare by value, not identity.
        if ("updatedAt" in where) {
            const want = where.updatedAt as Date | null;
            const have = (row as any).updatedAt as Date | null | undefined;
            if ((have?.getTime() ?? null) !== (want?.getTime() ?? null)) return false;
        }
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
        // Exposed so a test can change the item universe AFTER the plan has
        // read it — the whole point of re-reading under the lock.
        items,
        db: {
            // Present even on the no-transaction stub: the write phase asks
            // whether the cost code is still active, and a stub that cannot
            // answer would make the guard pass by accident.
            async $queryRawUnsafe(query: string, ...args: unknown[]) { return activeCode(query, ...args); },
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
                // The write phase re-reads the phase list for ONE project,
                // inside the lock, so the stub has to honour that filter — and
                // serve whatever `items` says NOW, not a snapshot.
                async findMany(args?: { where?: Record<string, any> }) {
                    // OWNERSHIP IS LOADED FOR EVERY LINKED ITEM (round 44,
                    // item 3), so the real query now selects `costCode.isActive`
                    // and normalises a retired code to null itself. The stub
                    // defaults it to ACTIVE, and the retired-code tests below
                    // set `costCode: { isActive: false }` explicitly — which is
                    // what the production query would return for them.
                    const withCode = (item: any) => ({
                        costCode: { isActive: true },
                        ...item,
                    });
                    // The stub HONOURS a code filter when one is asked for.
                    // It did not, which meant a `where` narrowing the ownership
                    // map back to coded/active items was invisible here — the
                    // exact regression round 44 item 3 fixed would have passed
                    // every test in this file.
                    const where = args?.where ?? {};
                    const wantProject = where.estimate?.projectId ?? null;
                    return items
                        .filter(item => !wantProject || (item.estimate?.projectId ?? null) === wantProject)
                        .map(withCode)
                        .filter((item: any) => {
                            if (where.costCodeId?.not === null && item.costCodeId === null) return false;
                            if (where.costCode?.isActive === true && !item.costCode?.isActive) return false;
                            return true;
                        });
                },
                async findUnique(args: { where: { id: string } }) {
                    const item = items.find(candidate => candidate.id === args.where.id);
                    return item ? { costCode: { isActive: true }, ...item } : null;
                },
            },
            timeEntry: {
                async findMany() { return []; },
            },
            expense: {
                // A SNAPSHOT, like a real read. Handing back the live objects
                // meant a test could not model "the row changed after the
                // planner saw it" — the planner would see the change too.
                async findMany() { return rows.map(row => ({ ...row })); },
                // The cost-code pass re-reads each row UNDER THE LOCK before
                // deciding, so the stub has to serve the CURRENT row rather
                // than the snapshot the planner saw.
                async findUnique(args: { where: { id: string } }) {
                    const row = rows.find(candidate => candidate.id === args.where.id);
                    return row ? { ...row } : null;
                },
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
    // The estimate the project was DERIVED from rides along, so the write can
    // require the derivation is still valid.
    assert.deepEqual(plan.projectFills, [
        { id: "needs-fill", projectId: "job-1", expectedEstimateId: "est-job-1" },
    ]);
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
    assert.deepEqual(projectWrite.where, {
        // One expense per statement now: the group cannot share a per-expense
        // lock, so it is written a row at a time under one.
        id: "e1",
        projectId: null,
        // Both halves of the derivation, plus the join that proves the second
        // half is still true at write time.
        estimateId: "est-job-1",
        estimate: { is: { projectId: "job-1" } },
    });

    const codeWrite = stub.writes.find(w => "costCodeId" in w.data)!;
    assert.equal(codeWrite.where.id, "e1");
    assert.equal(codeWrite.where.costCodeId, null);
    assert.deepEqual(codeWrite.where.OR, [
        { costCodeSource: null },
        // "manual-none" joined the human list in round 36, item 3: clearing a
        // phase is a decision, and NULL provenance is what every automated pass
        // reads as "a machine may write here".
        { costCodeSource: { notIn: ["capture", "manual", "manual-none"] } },
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
    // Keyed by `projectId:itemId` — the map says "item I resolves to code C
    // ON JOB J", never as a global fact (round 21, item 4).
    const items = new Map<string, string | null>([["job-1:item-1", "cc-frame"]]);
    const rows = [{ projectId: "job-1", costCodeId: null, itemId: "item-1", amount: 400 }];

    assert.equal(measureCoverage(rows, items).attributed, 400, "the item already resolves it");
    assert.equal(measureCoverage(rows, items).unattributed, 0);
    // ...and without the item universe it looks like a gap, which is the bug.
    assert.equal(measureCoverage(rows).attributed, 0);
});

test("coverage credit does NOT leak to a corrupt row on another job", () => {
    // Codex round 21, item 4. `scopedItemCostCodes` checked the cross-job gate
    // when it ADMITTED an entry and then stored it under the bare item id, so
    // any other row pointing at that item read the same entry back — including
    // the cross-job row the gate exists to exclude. The scope has to be part of
    // the LOOKUP, not part of a check made once.
    const legitimate = expense({ id: "ok", projectId: "job-1", itemId: "item-1", amount: 100 });
    const corrupt = expense({ id: "bad", projectId: "job-2", itemId: "item-1", amount: 900 });
    const items = new Map([
        ["item-1", { costCodeId: "cc-frame", estimateId: "est-1", projectId: "job-1" }],
    ]);
    const scoped = scopedItemCostCodes([legitimate, corrupt], items, ALL_PHASES);

    assert.deepEqual([...scoped.keys()], ["job-1:item-1"], "one entry, and it names its job");

    const coverage = measureCoverage([legitimate, corrupt], scoped);
    assert.equal(coverage.attributed, 100, "only the row whose own job owns the item");
    assert.equal(coverage.unattributed, 900, "the cross-job dollars stay a gap");
    assert.equal(coverage.codedCount, 1);
});

test("coverage still counts a genuinely uncoded row as a gap", () => {
    const rows = [{ costCodeId: null, itemId: null, amount: 100 }];
    assert.equal(measureCoverage(rows, new Map()).unattributed, 100);
    assert.equal(measureCoverage(rows, new Map()).codedCount, 0);
});

test("coverage keeps CROSS-JOB item dollars unattributed", () => {
    // Codex round 7, item 5. The variance report resolves an item link only
    // within the project's own item pool, so an expense pointing at another
    // job's line item is unattributed there. A global id->code map counted
    // those dollars as covered — flattering the one number this metric exists
    // to report honestly.
    const rows = [
        expense({ id: "cross", projectId: "job-1", itemId: "item-elsewhere", amount: 500 }),
        expense({ id: "own", projectId: "job-1", itemId: "item-own", amount: 300 }),
    ];
    const items = new Map([
        ["item-elsewhere", { costCodeId: "cc-frame", estimateId: "est-2", projectId: "job-2" }],
        ["item-own", { costCodeId: "cc-plumb", estimateId: "est-1", projectId: "job-1" }],
    ]);
    const scoped = scopedItemCostCodes(rows, items, ALL_PHASES);

    assert.equal(scoped.has("job-1:item-own"), true, "the same-job link counts");
    assert.equal(scoped.has("job-1:item-elsewhere"), false, "the cross-job link does not");

    const coverage = measureCoverage(rows, scoped);
    assert.equal(coverage.attributed, 300);
    assert.equal(coverage.unattributed, 500, "the cross-job dollars stay a gap");
});

test("coverage ignores an item whose code is not a live phase of the job", () => {
    // Same gate the writer applies: a code from a draft estimate is not a
    // phase, so it cannot count as coverage either.
    const rows = [expense({ id: "e1", projectId: "job-1", itemId: "item-draft", amount: 100 })];
    const items = new Map([
        ["item-draft", { costCodeId: "cc-retired", estimateId: "est-1", projectId: "job-1" }],
    ]);
    const scoped = scopedItemCostCodes(rows, items, ALL_PHASES);
    assert.equal(scoped.size, 0);
    assert.equal(measureCoverage(rows, scoped).unattributed, 100);
});

test("LABOR item dollars from another job stay unattributed too", () => {
    // The expense side was scoped in round 7; the labor side still resolved
    // through a global id->code map, so a time entry pointing at another job's
    // estimate item counted as covered when the variance page says it is not.
    const entries = [
        { projectId: "job-1", estimate: null, itemId: "item-elsewhere" },
        { projectId: "job-1", estimate: null, itemId: "item-own" },
    ];
    const items = new Map([
        ["item-elsewhere", { costCodeId: "cc-frame", estimateId: "est-2", projectId: "job-2" }],
        ["item-own", { costCodeId: "cc-plumb", estimateId: "est-1", projectId: "job-1" }],
    ]);
    const scoped = scopedItemCostCodes(entries, items, ALL_PHASES);

    assert.equal(scoped.has("job-1:item-own"), true);
    assert.equal(
        scoped.has("job-1:item-elsewhere"), false,
        "another job's item is not this job's coverage",
    );

    const labor = measureCoverage(
        [
            { projectId: "job-1", costCodeId: null, itemId: "item-elsewhere", amount: 900 },
            { projectId: "job-1", costCodeId: null, itemId: "item-own", amount: 100 },
        ],
        scoped,
    );
    assert.equal(labor.attributed, 100);
    assert.equal(labor.unattributed, 900);
});

// ── the backfill is ordered against the other three writers (round 10, #5) ──

test("each cost-code write takes the shared per-expense lock", async () => {
    const locks: unknown[] = [];
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        if (query.includes("pg_advisory_xact_lock")) locks.push(args[0]);
        return activeCode(query, ...args);
    };

    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(locks, ["expense:e1"], "one lock, namespaced per expense");
});

// ── the rows a decision is DERIVED from are held too (round 15, item 6) ────

/** Records every lock statement in order, with the ids it named. */
function lockTrace(stub: ReturnType<typeof createStub>) {
    const trace: { kind: string; args: unknown[] }[] = [];
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        const kind = query.includes("pg_advisory_xact_lock") ? "expense-lock"
            : query.includes('FROM "Project"') ? "project-share"
            : query.includes('FROM "Estimate"') ? "estimate-share"
            : query.includes('JOIN "Estimate"') ? "phase-share"
            : query.includes('FROM "EstimateItem"') ? "item-share"
            : "other";
        trace.push({ kind, args });
        return activeCode(query, ...args);
    };
    return trace;
}

test("the cost fill share-locks the estimate, the item and the phase rows BEFORE the expense lock", async () => {
    // A read taken before its lock describes a moment the lock then fails to
    // preserve. The expense's own row is protected by the advisory lock and the
    // CAS; the FACTS the answer comes from live on other rows.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", itemId: "i1", vendor: "Unknown Vendor", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    const trace = lockTrace(stub);
    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });

    const kinds = trace.map(entry => entry.kind);
    const expenseLockAt = kinds.lastIndexOf("expense-lock");
    assert.ok(expenseLockAt >= 0, "the per-expense lock is still taken");
    const before = kinds.slice(0, expenseLockAt);
    assert.ok(before.includes("estimate-share"), "the estimate is held");
    assert.ok(before.includes("item-share"), "so is the item the code is copied from");
    assert.ok(before.includes("phase-share"), "and the job's phase rows");
    // FOR SHARE, not FOR UPDATE: two readers must not block each other.
    assert.ok(trace.every(entry => !String(entry.kind).includes("update")));
});

test("the project fill takes PROJECT, estimate, then the row — the canonical order", async () => {
    // ROUND 38, ITEM 2. This pass writes `Expense.projectId`, and Postgres
    // enforces that foreign key by taking `FOR KEY SHARE` on the referenced
    // `Project` row. So omitting `phaseProjectId` from the lock set never
    // meant "no Project lock": it meant the Project was locked IMPLICITLY, by
    // the UPDATE, after this transaction already held the Estimate and the
    // Expense — Estimate -> Expense -> Project, a cycle against a job editor
    // holding its Project row FOR UPDATE. The one pass whose whole job is
    // writing this column was the one still doing it in the wrong order.
    const stub = createStub(
        [expense({ id: "e1", projectId: null, estimate: { projectId: "job-1" } })],
        [],
    );
    const trace = lockTrace(stub);
    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });

    const kinds = trace.map(entry => entry.kind);
    assert.equal(kinds[0], "project-share", "the JOB is locked before anything else");
    // ARRAY, not scalar (round 43, item 2): the helper takes SEVERAL jobs at
    // once so a re-attribution can lock the job it leaves and the job it joins
    // in ONE pass per table. A single id renders as a one-element array.
    assert.deepEqual(trace[0].args, [["job-1"]], "and it is the job about to be stamped");
    const expenseLockAt = kinds.lastIndexOf("expense-lock");
    assert.ok(expenseLockAt > 0, "the per-expense lock is still taken");
    assert.ok(
        kinds.indexOf("estimate-share") > 0 && kinds.indexOf("estimate-share") < expenseLockAt,
        "the estimate the project was read off is held, after the Project and before the row",
    );
    assert.ok(
        trace.some(entry => entry.kind === "estimate-share" && (entry.args as string[])[0] === "est-job-1"),
        "the estimate the project was read off",
    );
    // FOR SHARE throughout: two readers must not block each other.
    assert.ok(trace.every(entry => !String(entry.kind).includes("update")));
});

test("an INTERLEAVED estimate move is refused: the write no-ops", async () => {
    // Deterministic interleaving: the mover runs between the snapshot and the
    // write, which is precisely the window the share lock closes in production
    // and the predicate closes here. Either way the write must not land.
    const stub = createStub(
        [expense({ id: "e1", projectId: null, estimate: { projectId: "job-1" } })],
        [],
    );
    const sequence: string[] = [];
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        if (query.includes("FOR SHARE")) {
            sequence.push("share-lock");
            // The move lands JUST BEFORE the lock takes hold — the worst case,
            // and the one the predicate has to catch on its own.
            stub.rows[0].estimate = { projectId: "job-2" };
        }
        return activeCode(query, ...args);
    };

    const result = await runBackfill({
        db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID,
    });
    assert.ok(sequence.length > 0, "the locks were attempted");
    assert.deepEqual(
        new Set(sequence), new Set(["share-lock"]),
        "every one of them is a SHARE lock",
    );
    assert.equal(result.written.projectIds, 0, "and the stale answer was not written");
    assert.equal(stub.rows[0].projectId ?? null, null);
});

test("an expense re-pointed at a DIFFERENT estimate is skipped by the cost fill", async () => {
    // The locks were taken from the plan's view of this row. If it has since
    // moved to another estimate, the facts about to be re-read are ones nothing
    // is holding still, so this is not the moment to write.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => activeCode(query, ...args);
    const snapshot = stub.db.expense.findMany;
    stub.db.expense.findMany = async () => {
        const rows = await snapshot();
        stub.rows[0].estimateId = "est-somewhere-else";
        return rows;
    };

    const result = await runBackfill({
        db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID,
    });
    assert.equal(result.written.costCodes, 0);
    assert.equal(stub.rows[0].costCodeId ?? null, null);
});

test("a row that MOVED between the plan and the write is skipped, not coded", async () => {
    // This script's plan is the stalest of the four writers': computed for
    // every row up front, then applied in a loop that can run for minutes. The
    // CAS on the row version is what stops it acting on a state that has since
    // changed.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => activeCode(query, ...args);

    // Someone edits the row after findMany handed it to the planner.
    const realUpdateMany = stub.db.expense.updateMany;
    let moved = false;
    (stub.db.expense as any).updateMany = async (args: any) => {
        if (!moved && "updatedAt" in args.where) {
            moved = true;
            stub.rows[0].updatedAt = new Date("2026-09-02");
        }
        return realUpdateMany(args);
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 0, "the stale decision is not applied");
    assert.equal(stub.rows[0].costCodeId, null);
});

test("the CAS names the row version the plan was computed from", async () => {
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => activeCode(query, ...args);

    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    const codeWrite = stub.writes.find(w => "costCodeId" in w.data)!;
    assert.deepEqual(codeWrite.where.updatedAt, new Date("2026-09-01"));
});

test("a row the PROJECT pass just filled is re-read, not exempted", async () => {
    // Pass (a) bumps `updatedAt` itself, so the plan's version is stale for
    // exactly the rows this run just touched. The earlier fix EXEMPTED those
    // from the version check, which traded one hazard for another: an exempted
    // row had no version guard at all, so a concurrent writer was invisible to
    // it. Re-reading under the lock removes the guess — the CAS names the
    // version as it is NOW, including the projectId pass (a) wrote.
    const stub = createStub(
        [expense({
            id: "e1", projectId: null, estimate: { projectId: "job-1" },
            vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01"),
        })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => activeCode(query, ...args);
    // Model the real column: pass (a)'s write bumps the version.
    const realUpdateMany = stub.db.expense.updateMany;
    (stub.db.expense as any).updateMany = async (args: any) => {
        const result = await realUpdateMany(args);
        if (result.count > 0 && "projectId" in args.data) {
            stub.rows[0].updatedAt = new Date("2026-09-02");
        }
        return result;
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.projectIds, 1);
    assert.equal(result.written.costCodes, 1, "the code still lands");

    const codeWrite = stub.writes.find(w => "costCodeId" in w.data)!;
    assert.deepEqual(
        codeWrite.where.updatedAt,
        new Date("2026-09-02"),
        "the CAS names the POST-fill version, not the planner's snapshot",
    );
});

test("a row that became human-coded after the plan is skipped on the re-read", async () => {
    // The re-read is not just a version fetch — it re-checks eligibility, so a
    // bookkeeper who coded the row mid-run keeps their answer.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        // The PATCH lands while this row is being locked.
        stub.rows[0].costCodeId = "cc-human";
        stub.rows[0].costCodeSource = "manual";
        return activeCode(query, ...args);
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 0);
    assert.equal(stub.rows[0].costCodeId, "cc-human", "the human's phase stands");
    assert.ok(
        !stub.writes.some(w => "costCodeId" in w.data),
        "and no write is even attempted once the re-read says ineligible",
    );
});

test("a row re-attributed after the plan is skipped on the re-read", async () => {
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        stub.rows[0].projectId = "job-elsewhere";
        return activeCode(query, ...args);
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 0, "the phase was chosen for a job it is no longer on");
    assert.equal(stub.rows[0].costCodeId, null);
});

// ── mutations BEFORE the re-read (round 12, item 3) ────────────────────────

test("an expense re-pointed at another estimate is not stamped with the old job", async () => {
    // `projectId IS NULL` alone does not say the derivation is still valid.
    const stub = createStub([
        expense({ id: "e1", projectId: null, estimateId: "est-job-1", estimate: { projectId: "job-1" } }),
    ]);
    // The move happens AFTER the planner has read the row — the snapshot it
    // planned from still says est-job-1.
    const realFindMany = stub.db.expense.findMany;
    let planned = false;
    (stub.db.expense as any).findMany = async () => {
        const snapshot = await realFindMany();
        if (!planned) {
            planned = true;
            stub.rows[0].estimateId = "est-job-2";
        }
        return snapshot;
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.projectIds, 0, "the plan's derivation no longer holds");
    assert.equal(stub.rows[0].projectId, null);
});

test("a vendor edited before the re-read changes the answer, so nothing is written", async () => {
    // Eligibility was not the only thing the plan depended on: the vendor feeds
    // the rule. Re-checking eligibility alone would have written a phase chosen
    // from text that is no longer on the row.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        // The edit lands while the row is being locked, i.e. BEFORE the re-read.
        stub.rows[0].vendor = "General Hardware";
        stub.rows[0].description = "misc supplies";
        return activeCode(query, ...args);
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 0, "the planned code answered a question nobody is asking now");
    assert.equal(stub.rows[0].costCodeId, null);
});

test("a vendor edit that points at a DIFFERENT phase is refused, not applied", async () => {
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        // Now the rules would say FRAMING, not plumbing.
        stub.rows[0].vendor = "Parr Lumber";
        return activeCode(query, ...args);
    };

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 0, "the plan and the re-plan disagree, so neither is applied");
    assert.equal(stub.rows[0].costCodeId, null, "a re-run will plan it properly");
});

test("an untouched row still codes normally through the re-plan", async () => {
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => activeCode(query, ...args);

    const result = await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.equal(result.written.costCodes, 1);
    assert.equal(stub.rows[0].costCodeId, "cc-plumb");
    assert.equal(stub.rows[0].costCodeSource, "ai");
});

// ── the write re-reads what the plan assumed (Codex round 13, item 7) ───────

test("an ESTIMATE moved to another job after the plan is not stamped with the old one", async () => {
    // `estimateId` alone cannot catch this: the row never left its estimate,
    // the estimate left the job. Without the write-time join every expense on
    // that estimate would be attributed to the project it used to be on.
    const stub = createStub(
        [expense({ id: "e1", projectId: null, estimate: { projectId: "job-1" } })],
        [],
    );
    const snapshot = stub.db.expense.findMany;
    stub.db.expense.findMany = async () => {
        const rows = await snapshot();
        // ...and now somebody re-points the estimate.
        stub.rows[0].estimate = { projectId: "job-2" };
        return rows;
    };

    const result = await runBackfill({
        db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID,
    });
    assert.equal(result.written.projectIds, 0, "nothing written on a stale derivation");
    assert.equal(stub.rows[0].projectId ?? null, null);
});

test("an ITEM re-coded after the plan does not get the planned code written", async () => {
    // The plan says cc-frame because that is what the linked item said when it
    // was read. Under the lock the item says something else, so the planned
    // write is an answer to a question nobody is asking any more.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", itemId: "i1", vendor: "Unknown Vendor" })],
        [{ id: "i1", costCodeId: "cc-frame", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    // The plan reads the item universe TWICE (the link map, then the phase
    // list). Both must see the old code; the re-code lands after that, before
    // the write phase re-reads this one item under the lock.
    const readItems = stub.db.estimateItem.findMany;
    let itemReads = 0;
    stub.db.estimateItem.findMany = async (args?: any) => {
        const rows = (await readItems(args)).map((item: any) => ({ ...item }));
        itemReads += 1;
        if (itemReads === 2) stub.items[0].costCodeId = "cc-plumb";
        return rows;
    };

    const result = await runBackfill({
        db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID,
    });
    assert.equal(result.written.costCodes, 0, "the planned code is void");
    assert.equal(stub.rows[0].costCodeId ?? null, null, "and nothing else was guessed in its place");
});

test("a phase REMOVED from the job after the plan blocks the write", async () => {
    // The vendor rule still says cc-plumb. The job no longer has that phase, so
    // writing it would put money on a phase the job does not have — the exact
    // check the plan made, made again against the truth.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing" })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    // Removed AFTER the plan has read the phase list, so the plan genuinely
    // decides cc-plumb and only the write-phase re-read can catch it. (Removing
    // it earlier would make this pass for the wrong reason: nothing planned.)
    // Keyed on the QUERY SHAPE, not on a call ordinal: the ownership map now
    // loads only the items expenses actually link to (round 44, item 3), so a
    // fixture with no `itemId` skips that read entirely and every "the Nth
    // read" counter shifts under it. The plan's phase-list build is the one
    // scoped by `estimate.projectId`; clearing right after it leaves the
    // write-phase re-read looking at the truth.
    const readItems = stub.db.estimateItem.findMany;
    let phaseListReads = 0;
    stub.db.estimateItem.findMany = async (args?: any) => {
        const rows = (await readItems(args)).map((item: any) => ({ ...item }));
        if (args?.where?.estimate && ++phaseListReads === 1) stub.items.length = 0;
        return rows;
    };

    const result = await runBackfill({
        db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID,
    });
    assert.equal(result.written.costCodes, 0);
    assert.equal(stub.rows[0].costCodeId ?? null, null);
});

// ── a code retired mid-run is not written (Codex round 20, item 5) ─────────

test("a cost code DEACTIVATED before the write is skipped", async () => {
    // `isActive` is a company-wide switch, so locking the job's phase rows did
    // not hold it. Retiring a code is the company saying "stop putting money
    // here", and this pass is the one writer with no human behind it.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    costCodeActive = true;
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        if (/FOR SHARE/.test(query) && /FROM "CostCode"/.test(query)) {
            // Retired as the lock is taken — the last moment it can be, and the
            // one a pre-transaction check would miss.
            costCodeActive = false;
        }
        return activeCode(query, ...args);
    };

    try {
        const result = await runBackfill({
            db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID,
        });
        assert.equal(result.written.costCodes, 0, "a retired code is not an answer");
        assert.equal(stub.rows[0].costCodeId ?? null, null);
    } finally {
        costCodeActive = true;
    }
});

test("the candidate code is share-locked, not just the job's phase rows", async () => {
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", vendor: "Summit Plumbing", updatedAt: new Date("2026-09-01") })],
        [{ id: "i1", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    const locks: string[] = [];
    (stub.db as any).$transaction = async (fn: any) => fn(stub.db);
    (stub.db as any).$queryRawUnsafe = async (query: string, ...args: unknown[]) => {
        if (/FOR SHARE/.test(query)) locks.push(String(query.match(/FROM "(\w+)"/)?.[1]));
        return activeCode(query, ...args);
    };

    await runBackfill({ db: stub.db, apply: true, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.ok(locks.includes("CostCode"), "the code itself is held for the write");
});

// ── the phase gate is the SHARED, LOCKED proof (round 34, item 3) ──────────

test("the write phase asks the shared invariant, not a list it read itself", () => {
    // The behavioural half is above ("a phase REMOVED from the job after the
    // plan blocks the write"), and it is genuinely load-bearing: with the proof
    // call removed, that test fails. This half is about HOW the question is
    // asked, which no stub can observe.
    //
    // The hole: the write phase re-read the job's allowed phases with a plain
    // `estimateItem.findMany` — inside the transaction, but holding nothing.
    // Under READ COMMITTED a concurrent transaction can insert an estimate and
    // a line item and commit them AFTER this script's lock scans, and the next
    // statement sees them. The verdict then rested on a row nobody had locked,
    // so it could be deleted (or its estimate archived, or moved to another
    // job) before this pass's UPDATE committed.
    //
    // src/lib/phase-invariant.ts already solves exactly this, with the
    // `FOR SHARE OF ei, e` clause on the query that answers. A second copy of
    // the rule here would be a second thing to keep true; the point of the fix
    // is that there is only one.
    const source = readFileSync(
        path.join(__dirname, "..", "scripts", "backfill-expense-attribution.ts"),
        "utf8",
    );
    assert.match(
        source,
        /import \{[^}]*provePhaseMembershipTx[^}]*\} from "\.\.\/src\/lib\/phase-invariant"/,
        "the proof comes from the shared module",
    );
    assert.match(
        source,
        /await provePhaseMembershipTx\(tx, resolvedProjectId, fresh\.costCodeId\)/,
        "and it is CALLED on the write transaction, with the row's own project and code",
    );
    // ...and the unlocked re-read is gone, not merely accompanied. A phase
    // list fetched here at all is the defect: it would be an answer nothing
    // holds still, sitting next to one that does.
    assert.doesNotMatch(source, /readAllowedCodes/, "the unlocked phase re-read is removed");
    assert.ok(
        !/estimateItem\.findMany\(\{\s*where:\s*\{\s*costCodeId: \{ not: null \},\s*costCode: \{ isActive: true \},\s*estimate: \{ \.\.\.PHASE_ELIGIBLE_ESTIMATE_WHERE, projectId \}/.test(source),
        "no per-project phase list is re-fetched under the lock",
    );
    // The proof must be the LAST word before the write, not an early advisory
    // note that something else can overrule.
    const proofAt = source.indexOf("await provePhaseMembershipTx(");
    const writeAt = source.indexOf("return tx.expense.updateMany({");
    assert.ok(proofAt > 0 && writeAt > proofAt, "proved immediately before the update, not after it");
});

test("round 36 item 3: the backfill PLAN skips a cleared phase, not just its write", () => {
    // Two guards, and this is the one that was hand-written. The update
    // predicate reads HUMAN_COST_CODE_SOURCES through
    // notHumanCodedExpenseWhere(), so it learned about "manual-none" for free;
    // the planner spelled out "capture" and "manual" itself and did not. A
    // dry-run table offering a row the write then refuses is the mild version
    // of that split, and the only real fix is both sides reading one constant.
    const plan = planBackfill({
        expenses: [
            expense({ id: "cleared", projectId: "job-1", costCodeSource: "manual-none", vendor: "Summit Plumbing" }),
            expense({ id: "cleared-capture", projectId: "job-1", costCodeSource: "capture", vendor: "Summit Plumbing" }),
            expense({ id: "machine", projectId: "job-1", costCodeSource: "ai", vendor: "Summit Plumbing" }),
            expense({ id: "untouched", projectId: "job-1", costCodeSource: null, vendor: "Summit Plumbing" }),
        ],
        items: NO_ITEMS,
        costCodeIdByCode: COST_CODE_IDS,
        scopedProjectIds: ["job-1"],
        allowedCodesByProject: ALL_PHASES,
    });

    const offered = plan.codeFills.map((fill: { id: string }) => fill.id).sort();
    assert.deepEqual(
        offered,
        ["machine", "untouched"],
        "a phase a person deliberately cleared must not be offered back to them",
    );
});

// ── a cross-job link is reported whatever its code (round 44, item 3) ───────

test("a cross-job item with a NULL code is reported, not silently guessed at", async () => {
    // THE CASE FROM THE REVIEW. The ownership map was filtered to items with a
    // non-null, ACTIVE cost code, so it answered two questions at once: "who
    // owns this item" and "is its code usable". A cross-job item whose code is
    // null looked MISSING rather than foreign, the writer read that as "no
    // answer either way", and the row fell through to regex suggestion — the
    // vendor rule then coded it and nobody ever saw the broken link.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", itemId: "i-other", vendor: "Summit Plumbing" })],
        [{ id: "i-other", costCodeId: null, estimateId: "est-job-2", estimate: { projectId: "job-2" } }],
    );
    const { plan } = await runBackfill({ db: stub.db, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(plan.codeFills, [], "no guess is written over a link nobody has checked");
    assert.deepEqual(
        plan.remainder.map((row: any) => [row.id, row.reason]),
        [["e1", "item-outside-estimate"]],
        "it is reported for a human to fix",
    );
});

test("...and so is one whose code is RETIRED", async () => {
    // Same shape, the other half of the old filter: `costCode: { isActive:
    // true }`. A retired code is not a usable code, but it says nothing about
    // who owns the item.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", itemId: "i-other", vendor: "Summit Plumbing" })],
        [{
            id: "i-other", costCodeId: "cc-retired", estimateId: "est-job-2",
            estimate: { projectId: "job-2" }, costCode: { isActive: false },
        } as never],
    );
    const { plan } = await runBackfill({ db: stub.db, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(plan.codeFills, []);
    assert.deepEqual(
        plan.remainder.map((row: any) => [row.id, row.reason]),
        [["e1", "item-outside-estimate"]],
    );
});

test("a SAME-job item with a retired code still falls through to the rules", async () => {
    // The control, and the reason ownership and eligibility are separate
    // questions: this link is fine, so the only thing wrong with it is the
    // code — which is exactly the case the vendor rules exist for.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", itemId: "i-own", vendor: "Summit Plumbing" })],
        [
            {
                id: "i-own", costCodeId: "cc-retired", estimateId: "est-job-1",
                estimate: { projectId: "job-1" }, costCode: { isActive: false },
            } as never,
            { id: "i-phase", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } },
        ],
    );
    const { plan } = await runBackfill({ db: stub.db, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(
        plan.codeFills.map((fill: any) => [fill.id, fill.costCodeId, fill.costCodeSource]),
        [["e1", "cc-plumb", "ai"]],
        "the link is sound, so the rules get their turn",
    );
    assert.deepEqual(plan.remainder, []);
});

test("a SAME-job item with a usable code is still copied, not suggested", async () => {
    // The other control: reordering the checks must not stop the item fallback
    // working when it should.
    const stub = createStub(
        [expense({ id: "e1", projectId: "job-1", itemId: "i-own", vendor: "Summit Plumbing" })],
        [{ id: "i-own", costCodeId: "cc-plumb", estimateId: "est-job-1", estimate: { projectId: "job-1" } }],
    );
    const { plan } = await runBackfill({ db: stub.db, log: () => {}, overheadProjectId: OVERHEAD_ID });
    assert.deepEqual(
        plan.codeFills.map((fill: any) => [fill.id, fill.costCodeId, fill.costCodeSource]),
        [["e1", "cc-plumb", "backfill"]],
        "copied from the item, not guessed from the vendor",
    );
});
