/**
 * Variance report DATA LOADING rules (src/lib/job-variance-db.ts).
 *
 * `tests/job-variance.test.ts` covers the pure math in `computeProjectVariance`.
 * It cannot cover this file, and this file is where the highest-severity bugs
 * have actually lived:
 *
 *   - Expense has no `projectId` column. Querying it threw
 *     PrismaClientValidationError and once made a job's expenses read $0.
 *   - Approved CHANGE ORDERS are budget. Omitting them manufactured an overrun
 *     on every job with an approved CO (Berg ADU, overstated by $4,629.63).
 *   - Draft/Sent change orders are NOT budget. Counting them would inflate the
 *     budget and hide real overruns (~$67k of Draft/Sent scope on prod).
 *   - Expenses are DELIBERATELY not filtered by estimate status, while budget
 *     is. Making that symmetric hid $84,741 of real spend.
 *
 * Every one of those is a property of the QUERY, not of the math — so these
 * tests assert on the exact `where` clauses the loader sends to Prisma, plus
 * the numbers that come out the far end. A refactor that drops the
 * changeOrderItem query, flips the "Approved" status string, or "tidies up"
 * the expense asymmetry now fails here instead of silently shipping.
 *
 * Prisma is replaced with an in-memory fake via the same scoped CJS require()
 * patch used by tests/takeoff-convert-tax.test.ts — see that file's header for
 * why `mock.module()` is not used in this repo.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ── recorded queries ────────────────────────────────────────────────────────
// Every call the loader makes is captured so tests can assert on the filter,
// not just on the arithmetic that follows it.

interface Recorded {
    project: any[];
    costCode: any[];
    estimate: any[];
    estimateItem: any[];
    changeOrderItem: any[];
    timeEntry: any[];
    expense: any[];
}
let recorded: Recorded;

// ── fixture data the fake returns ───────────────────────────────────────────

interface Fixture {
    projects: any[];
    costCodes: any[];
    estimates: any[];
    attributionOnlyItems: any[];
    changeOrderItems: any[];
    timeEntries: any[];
    expenses: any[];
}
let fixture: Fixture;

function resetFixture() {
    recorded = {
        project: [], costCode: [], estimate: [], estimateItem: [],
        changeOrderItem: [], timeEntry: [], expense: [],
    };
    fixture = {
        projects: [{ id: "p1", name: "Berg ADU", status: "In Progress" }],
        costCodes: [{ id: "cc-demo", code: "01-DEMO", name: "Demolition" }],
        estimates: [],
        attributionOnlyItems: [],
        changeOrderItems: [],
        timeEntries: [],
        expenses: [],
    };
}

const fakePrisma = {
    project: {
        findMany: async (args: any) => {
            recorded.project.push(args);
            return fixture.projects;
        },
    },
    costCode: {
        findMany: async (args: any) => {
            recorded.costCode.push(args);
            return fixture.costCodes;
        },
    },
    estimate: {
        findMany: async (args: any) => {
            recorded.estimate.push(args);
            return fixture.estimates;
        },
    },
    estimateItem: {
        findMany: async (args: any) => {
            recorded.estimateItem.push(args);
            return fixture.attributionOnlyItems;
        },
    },
    changeOrderItem: {
        findMany: async (args: any) => {
            recorded.changeOrderItem.push(args);
            return fixture.changeOrderItems;
        },
    },
    timeEntry: {
        findMany: async (args: any) => {
            recorded.timeEntry.push(args);
            return fixture.timeEntries;
        },
    },
    expense: {
        findMany: async (args: any) => {
            recorded.expense.push(args);
            return fixture.expenses;
        },
    },
};

// Populated in `before()`; tsx transpiles this file to CJS so top-level await
// is not available.
let loadProjectVariance: (projectIds?: string[]) => Promise<any[]>;

const PRISMA_SPECIFIER = "@/lib/prisma";

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) {
            requirePatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { loadProjectVariance?: unknown };
    try {
        mod = await import("../src/lib/job-variance-db");
    } finally {
        Module.prototype.require = originalRequire;
    }

    // Loud guard: a mock that silently fails to apply must not surface as a
    // scatter of confusing downstream failures.
    if (typeof mod.loadProjectVariance !== "function") {
        throw new Error(
            `job-variance-db.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply — ` +
                `loadProjectVariance export is ${typeof mod.loadProjectVariance}, not a function. ` +
                `The require() patch ${requirePatchHit ? "WAS" : "was NOT"} hit. ` +
                `If this fires, job-variance-db.ts's prisma import resolves to something other ` +
                `than the literal string "${PRISMA_SPECIFIER}" on this Node/tsx combination.`,
        );
    }
    loadProjectVariance = mod.loadProjectVariance as any;
});

beforeEach(() => {
    resetFixture();
});

// ── helpers ─────────────────────────────────────────────────────────────────

function estimateWith(items: any[]) {
    return {
        id: "e1",
        items: items.map((i) => ({
            id: i.id,
            name: i.name ?? i.id,
            type: i.type ?? null,
            parentId: i.parentId ?? null,
            total: i.total,
            costCodeId: i.costCodeId ?? "cc-demo",
            costCode: i.costCode === null ? null : { code: "01-DEMO", name: "Demolition" },
            costType: { name: i.costTypeName ?? "Material" },
        })),
    };
}

function coItem(o: { id: string; total: number; name?: string | null; costTypeName?: string }) {
    return {
        id: o.id,
        name: o.name === undefined ? o.id : o.name,
        total: o.total,
        type: null,
        costCodeId: "cc-demo",
        costCode: { code: "01-DEMO", name: "Demolition" },
        costType: { name: o.costTypeName ?? "Material" },
    };
}

// ════════════════════════════════════════════════════════════════════════════
// APPROVED CHANGE ORDERS ARE BUDGET  (the HIGH-severity peer-review finding)
// ════════════════════════════════════════════════════════════════════════════

test("approved change-order scope is ADDED to budget", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    fixture.changeOrderItems = [coItem({ id: "co1", total: 4629.63 })];

    const [report] = await loadProjectVariance();

    // Compared to the cent, not exactly: this module sums money in JS floats,
    // so 10000 + 4629.63 lands on 14629.630000000001. That drift is real but
    // sub-cent and the report rounds for display. Asserting exact equality here
    // would make this test fail for a reason that has nothing to do with the
    // rule it exists to protect.
    assert.ok(
        Math.abs(report.variance.totalBudget - 14629.63) < 0.005,
        `budget must be estimate + approved CO; dropping the CO manufactures a fake overrun. ` +
            `Got ${report.variance.totalBudget}, expected ~14629.63`,
    );
});

test("ONLY Approved change orders are queried — Draft and Sent are proposals, not budget", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    await loadProjectVariance();

    assert.equal(recorded.changeOrderItem.length, 1, "the change-order query must not be dropped");
    const where = recorded.changeOrderItem[0].where;
    assert.deepEqual(
        where,
        { changeOrder: { projectId: "p1", status: "Approved" } },
        'the CO filter must stay exactly status:"Approved" scoped to the project — ' +
            "widening it counts proposal scope as budget and hides real overruns",
    );
});

test("a job with no approved change orders is unaffected", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    fixture.changeOrderItems = [];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalBudget, 10000);
});

test("change-order line items are LABELLED (CO) so a phase's budget is traceable", async () => {
    fixture.estimates = [];
    fixture.changeOrderItems = [coItem({ id: "co1", total: 500, name: "  Extra outlets  " })];

    const [report] = await loadProjectVariance();
    const names = report.variance.phases.flatMap((p: any) => (p.items ?? []).map((i: any) => i.name));
    assert.ok(
        names.includes("Extra outlets (CO)"),
        `change-order rows must be name-tagged and trimmed; got ${JSON.stringify(names)}`,
    );
});

test("an unnamed change-order row gets a readable placeholder, never a blank", async () => {
    fixture.estimates = [];
    fixture.changeOrderItems = [
        coItem({ id: "co1", total: 500, name: null }),
        coItem({ id: "co2", total: 500, name: "   " }),
    ];

    const [report] = await loadProjectVariance();
    const names = report.variance.phases.flatMap((p: any) => (p.items ?? []).map((i: any) => i.name));
    assert.ok(!names.includes(""), "a blank row name is unreadable in the report");
    assert.ok(
        names.every((n: string) => n && n.trim().length > 0),
        `every row needs a name; got ${JSON.stringify(names)}`,
    );
});

test("ChangeOrderItem is FLAT — no section-header exclusion is applied to it", async () => {
    // EstimateItem headers mirror their children and must be skipped. The CO
    // table has no parentId, so nothing may be dropped here: every approved CO
    // row is real budget. A copy-paste of the estimate section filter onto this
    // loop would silently delete CO budget.
    fixture.estimates = [];
    fixture.changeOrderItems = [
        coItem({ id: "co1", total: 1000 }),
        coItem({ id: "co2", total: 2000 }),
        coItem({ id: "co3", total: 3000 }),
    ];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalBudget, 6000, "all three CO rows are budget");
});

// ════════════════════════════════════════════════════════════════════════════
// EXPENSE REACHES A PROJECT THROUGH ITS ESTIMATE
// ════════════════════════════════════════════════════════════════════════════

test("expenses are queried through the estimate relation, NOT expense.projectId", async () => {
    // Expense has no projectId column. `where: { projectId }` throws
    // PrismaClientValidationError and once made a job's expenses read $0.
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    await loadProjectVariance();

    const where = recorded.expense[0].where;
    assert.deepEqual(where, { estimate: { projectId: "p1" } });
    assert.ok(!("projectId" in where), "expense.projectId does not exist and throws at runtime");
});

test("expenses are DELIBERATELY not filtered by estimate status", async () => {
    // The asymmetry with the budget side is intentional and load-bearing: an
    // estimate's status governs what we PROMISED, never what we PAID. Filtering
    // here hid $84,741 of real spend across 320 expenses on Draft estimates —
    // including 100% of Hoppe Bathroom's costs.
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    await loadProjectVariance();

    const where = recorded.expense[0].where;
    assert.equal(
        JSON.stringify(where).includes("status"),
        false,
        "adding an estimate-status filter to the expense query hides money that was genuinely spent",
    );
});

test("spend on a Draft estimate still counts as actual cost", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    fixture.expenses = [{ costCodeId: "cc-demo", itemId: null, amount: 12000 }];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalActual, 12000);
    assert.equal(report.variance.variance, -2000, "negative means over budget — the honest answer");
});

// ════════════════════════════════════════════════════════════════════════════
// BUDGET-SIDE QUERY SHAPE
// ════════════════════════════════════════════════════════════════════════════

test("the budget side IS filtered by phase eligibility, scoped to the project", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 100 }])];
    await loadProjectVariance();

    const where = recorded.estimate[0].where;
    assert.equal(where.projectId, "p1");
    assert.ok(where.status, "estimate status eligibility must be applied to the BUDGET side");
    assert.equal(where.archivedAt, null, "archived estimates are not budget");
});

test("only In Progress projects are reported", async () => {
    await loadProjectVariance();
    assert.equal(recorded.project[0].where.status, "In Progress");
});

test("an explicit project filter WINS over any default project scoping", async () => {
    // Deliberately its own test rather than a second load inside the one above:
    // sharing `recorded` across two calls made the assertions order-dependent
    // and it failed only under the full suite, not in isolation.
    //
    // NOTE: this asserts only the `projectIds` branch, which is stable. A
    // parallel session is adding a default exclusion of the overhead bucket
    // ("Shop") to the no-argument branch; that rule is theirs to land and to
    // test, and this file stays green either way rather than racing it.
    await loadProjectVariance(["p1", "p2"]);
    const where = recorded.project[0].where;
    assert.equal(where.status, "In Progress");
    assert.deepEqual(where.id, { in: ["p1", "p2"] }, "an explicit request must not be silently filtered");
});

test("section headers are excluded from budget — counting one doubles its phase", async () => {
    // The header mirrors its children's rolled-up total.
    fixture.estimates = [
        estimateWith([
            { id: "hdr", total: 5000, type: "Section" },
            { id: "kid", total: 5000, parentId: "hdr" },
        ]),
    ];

    const [report] = await loadProjectVariance();
    assert.equal(
        report.variance.totalBudget,
        5000,
        "10000 here means the header was counted alongside its child, manufacturing a fake favourable variance",
    );
});

test("a parent row inferred by parentId is excluded even without type:Section", async () => {
    fixture.estimates = [
        estimateWith([
            { id: "hdr", total: 5000, type: null },
            { id: "kid", total: 5000, parentId: "hdr" },
        ]),
    ];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalBudget, 5000);
});

// ════════════════════════════════════════════════════════════════════════════
// NUMERIC COERCION  (Prisma Decimal / null)
// ════════════════════════════════════════════════════════════════════════════

test("null money columns coerce to 0, never NaN", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: null }])];
    fixture.changeOrderItems = [coItem({ id: "co1", total: null as any })];
    fixture.timeEntries = [{ costCodeId: "cc-demo", estimateItemId: null, laborCost: null, burdenCost: null }];
    fixture.expenses = [{ costCodeId: "cc-demo", itemId: null, amount: null }];

    const [report] = await loadProjectVariance();
    assert.equal(Number.isNaN(report.variance.totalBudget), false, "NaN renders as a broken number to Justin");
    assert.equal(Number.isNaN(report.variance.totalActual), false);
    assert.equal(report.variance.totalBudget, 0);
    assert.equal(report.variance.totalActual, 0);
});

test("Prisma Decimal-like objects coerce to their numeric value", async () => {
    // Prisma returns Decimal, not number, for money columns. A Decimal has a
    // toString/valueOf that Number() honours; dropping the Number() call would
    // concatenate strings instead of adding money.
    const decimal = (v: string) => ({ toString: () => v, valueOf: () => Number(v) });
    fixture.estimates = [estimateWith([{ id: "i1", total: decimal("1000.50") }])];
    fixture.expenses = [{ costCodeId: "cc-demo", itemId: null, amount: decimal("250.25") }];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalBudget, 1000.5);
    assert.equal(report.variance.totalActual, 250.25);
    assert.equal(typeof report.variance.totalBudget, "number");
});

test("burden is part of the real cost of labor", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000, costTypeName: "Labor" }])];
    fixture.timeEntries = [{ costCodeId: "cc-demo", estimateItemId: null, laborCost: 3000, burdenCost: 900 }];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalActual, 3900, "omitting burden understates the true cost of labor");
});

// ════════════════════════════════════════════════════════════════════════════
// UNBUDGETED PHASES ARE NAMED, NOT "N/A"
// ════════════════════════════════════════════════════════════════════════════

test("cost-code labels are loaded so unbudgeted spend is NAMED, not anonymous", async () => {
    fixture.costCodes = [
        { id: "cc-demo", code: "01-DEMO", name: "Demolition" },
        { id: "cc-elec", code: "05-ELEC", name: "Electrical" },
    ];
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    // Spend on a phase that was never budgeted.
    fixture.expenses = [{ costCodeId: "cc-elec", itemId: null, amount: 800 }];

    const [report] = await loadProjectVariance();
    const elec = report.variance.phases.find((p: any) => p.code === "05-ELEC");
    assert.ok(
        elec,
        `unbudgeted spend must surface under a NAMED phase, never an anonymous "N/A" row. ` +
            `Phases: ${JSON.stringify(report.variance.phases.map((p: any) => ({ code: p.code, name: p.name })))}`,
    );
    assert.equal(elec.name, "Electrical", "the cost-code lookup is what supplies this label");
    assert.equal(elec.totalActual, 800);
    assert.equal(elec.totalBudget, 0, "it is genuinely unbudgeted — that is the honest signal");
});

test("the cost-code lookup runs once for the whole report, not once per project", async () => {
    fixture.projects = [
        { id: "p1", name: "Berg ADU", status: "In Progress" },
        { id: "p2", name: "Hoppe Bathroom", status: "In Progress" },
    ];
    await loadProjectVariance();
    assert.equal(recorded.costCode.length, 1, "one lookup for every active cost code, hoisted out of the loop");
});

// ════════════════════════════════════════════════════════════════════════════
// REPORT SHAPE
// ════════════════════════════════════════════════════════════════════════════

test("each report carries the project identity the page renders", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 100 }])];
    const [report] = await loadProjectVariance();
    assert.equal(report.projectId, "p1");
    assert.equal(report.projectName, "Berg ADU");
    assert.equal(report.status, "In Progress");
    assert.ok(report.variance, "the computed variance must be attached");
});

test("every In Progress project gets its own report, in name order", async () => {
    fixture.projects = [
        { id: "p1", name: "Berg ADU", status: "In Progress" },
        { id: "p2", name: "Hoppe Bathroom", status: "In Progress" },
    ];
    const reports = await loadProjectVariance();
    assert.equal(reports.length, 2);
    assert.equal(recorded.project[0].orderBy.name, "asc");
});

test("a project with no estimates, no COs and no spend does not throw", async () => {
    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalBudget, 0);
    assert.equal(report.variance.totalActual, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// ATTRIBUTION POOL IS BROADER THAN THE BUDGET POOL
// ════════════════════════════════════════════════════════════════════════════
//
// Spend on a Draft/archived estimate can carry an `itemId` pointing at that
// estimate's own coded item. Resolving links against the budget pool alone
// would discard the link and dump the money into "unattributed" — overstating
// how little we know. These rows carry a cost code for ATTRIBUTION but must
// contribute ZERO budget.

test("attribution-only items are fetched, excluding rows already counted as budget", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    fixture.changeOrderItems = [coItem({ id: "co1", total: 500 })];
    await loadProjectVariance();

    assert.equal(recorded.estimateItem.length, 1, "the attribution query must not be dropped");
    const where = recorded.estimateItem[0].where;
    assert.deepEqual(where.estimate, { projectId: "p1" }, "not status-filtered — Draft rows are needed here");
    assert.deepEqual(
        where.id.notIn.slice().sort(),
        ["co1", "i1"],
        "every budget row (estimate items AND approved CO items) must be excluded, or it is counted twice",
    );
    assert.deepEqual(where.costCodeId, { not: null }, "an uncoded row cannot attribute anything");
});

test("attribution-only items contribute ZERO budget", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000 }])];
    fixture.attributionOnlyItems = [
        {
            id: "draft-1", name: "Draft line", type: null,
            costCodeId: "cc-demo",
            costCode: { code: "01-DEMO", name: "Demolition" },
            costType: { name: "Material" },
            total: 99999, // must be ignored — this row exists only to route spend
        },
    ];

    const [report] = await loadProjectVariance();
    assert.equal(
        report.variance.totalBudget,
        10000,
        "an attribution-only row must be passed with total:0; counting its own total inflates the budget " +
            "and hides a real overrun",
    );
});

test("spend linked to an attribution-only item reaches its phase instead of 'unattributed'", async () => {
    fixture.estimates = [estimateWith([{ id: "i1", total: 10000, costCodeId: "cc-demo" }])];
    fixture.attributionOnlyItems = [
        {
            id: "draft-1", name: "Draft line", type: null,
            costCodeId: "cc-elec",
            costCode: { code: "05-ELEC", name: "Electrical" },
            costType: { name: "Material" },
            total: 0,
        },
    ];
    fixture.costCodes = [
        { id: "cc-demo", code: "01-DEMO", name: "Demolition" },
        { id: "cc-elec", code: "05-ELEC", name: "Electrical" },
    ];
    fixture.expenses = [{ costCodeId: null, itemId: "draft-1", amount: 750 }];

    const [report] = await loadProjectVariance();
    assert.equal(report.variance.totalActual, 750, "the money is real either way");
    const elec = report.variance.phases.find((p: any) => p.code === "05-ELEC");
    assert.ok(
        elec,
        `spend must land on the Electrical phase, not vanish into unattributed. ` +
            `Phases: ${JSON.stringify(report.variance.phases.map((p: any) => p.code))}`,
    );
    assert.equal(elec.totalActual, 750);
    assert.equal(elec.totalBudget, 0, "an attribution-only phase has no budget — it shows as unbudgeted, honestly");
});

test("an attribution-only row with no name still renders readably", async () => {
    fixture.estimates = [];
    fixture.attributionOnlyItems = [
        {
            id: "draft-1", name: "   ", type: null,
            costCodeId: "cc-demo",
            costCode: { code: "01-DEMO", name: "Demolition" },
            costType: { name: "Material" },
            total: 0,
        },
    ];

    const [report] = await loadProjectVariance();
    const names = report.variance.phases.flatMap((p: any) => (p.items ?? []).map((i: any) => i.name));
    assert.ok(
        names.every((n: string) => n && n.trim().length > 0),
        `every row needs a name; got ${JSON.stringify(names)}`,
    );
});
