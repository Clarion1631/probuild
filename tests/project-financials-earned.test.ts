/**
 * computeProjectFinancials — the Phase 4 additive fields, and a regression lock
 * on everything that was there before them.
 *
 * Two jobs:
 *
 *  1. NOTHING OLD MOVED. The spec's goal 2 is "every existing field keeps its
 *     exact current meaning and value". A fixture is run through the function
 *     and each pre-Phase-4 field is asserted against its hand-computed value.
 *     If a future edit folds percent complete into `currentMargin`, or slips
 *     labor into `currentOutgoing`, this fails here rather than silently
 *     changing the numbers on /reports/company-financials.
 *
 *  2. DECIMALS DO NOT ESCAPE. Every value the fake returns is a real
 *     `Prisma.Decimal`, because that is what the database returns. The new
 *     fields cross a server → client boundary, and a Decimal does not survive
 *     JSON serialization (memory: the Decimal serialization sweep). So each new
 *     field must be a plain number or null, and the whole result must survive a
 *     JSON round trip unchanged.
 *
 * Prisma is replaced via the scoped CJS require() patch used by
 * tests/job-variance-db.test.ts — `mock.module()` is not usable here (CI pins
 * Node 20, where it corrupts the require chain).
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { Prisma } from "@prisma/client";

const D = (n: number | string) => new Prisma.Decimal(n);

interface Fixture {
    invoices: any[];
    estimates: any[];
    retainers: any[];
    expenses: any[];
    purchaseOrders: any[];
    timeEntries: any[];
    project: any;
    changeOrders: any[];
}
let fixture: Fixture;

/** Far enough out that an unpaid milestone is "scheduled", never "overdue". */
const FUTURE = new Date(Date.now() + 90 * 86_400_000);

function resetFixture() {
    fixture = {
        invoices: [
            {
                totalAmount: D(10_000),
                payments: [
                    { status: "Paid", amount: D(4_000), dueDate: null },
                    { status: "Pending", amount: D(6_000), dueDate: FUTURE },
                    // Canceled milestones are not receivables — pre-existing rule.
                    { status: "Canceled", amount: D(2_500), dueDate: FUTURE },
                ],
            },
        ],
        estimates: [
            { id: "e1", status: "Approved", totalAmount: D(20_000), balanceDue: D(0), archivedAt: null },
        ],
        retainers: [],
        expenses: [
            { amount: D(1_000), receiptUrl: "https://files/receipt.pdf", costCodeId: "cc-demo" },
            // Signed: a refund. Coverage must be measured on ABSOLUTE dollars so
            // this cannot net the denominator down and fake a high percentage.
            { amount: D(-200), receiptUrl: null, costCodeId: null },
        ],
        purchaseOrders: [{ status: "Issued", totalAmount: D(500) }],
        timeEntries: [
            { durationHours: D(10), laborCost: D(400), burdenCost: D(100), costCodeId: "cc-demo" },
        ],
        project: {
            percentComplete: D(60),
            percentCompleteSource: "MANUAL",
            percentCompleteAuto: D(70),
            percentCompleteAutoAtOverride: D(62),
        },
        changeOrders: [{ totalAmount: D(5_000) }],
    };
}

const fakePrisma = {
    invoice: { findMany: async () => fixture.invoices },
    estimate: { findMany: async () => fixture.estimates },
    retainer: { findMany: async () => fixture.retainers },
    expense: { findMany: async () => fixture.expenses },
    purchaseOrder: { findMany: async () => fixture.purchaseOrders },
    timeEntry: { findMany: async () => fixture.timeEntries },
    project: { findUnique: async () => fixture.project },
    changeOrder: { findMany: async () => fixture.changeOrders },
};

let computeProjectFinancials: (projectId: string, opts?: any) => Promise<any>;

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

    let mod: { computeProjectFinancials?: unknown };
    try {
        mod = await import("../src/lib/project-financials");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof mod.computeProjectFinancials !== "function") {
        throw new Error(
            `project-financials-earned.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply — ` +
                `computeProjectFinancials is ${typeof mod.computeProjectFinancials}. ` +
                `The require() patch ${requirePatchHit ? "WAS" : "was NOT"} hit.`,
        );
    }
    computeProjectFinancials = mod.computeProjectFinancials as any;
});

beforeEach(() => {
    resetFixture();
});

// ── 1. regression lock on the pre-Phase-4 fields ────────────────────────────

test("every pre-Phase-4 field keeps its exact prior value on the fixture", async () => {
    const fin = await computeProjectFinancials("p1");

    // Incoming: $4,000 collected, $6,000 scheduled, the Canceled $2,500 ignored.
    assert.equal(fin.currentIncoming, 4_000);
    assert.equal(fin.scheduledIncoming, 6_000);
    assert.equal(fin.overdueIncoming, 0);
    assert.equal(fin.invoicedTotal, 10_000);
    assert.equal(fin.forecastedIncomingFromEstimates, 20_000);
    assert.equal(fin.totalForecastedIncoming, 30_000);
    assert.equal(fin.clientOwes, 6_000);

    // Outgoing: expenses net (1,000 − 200), PO $500 forecast.
    assert.equal(fin.totalExpenses, 800);
    assert.equal(fin.plannedExpenses, 500);
    assert.equal(fin.currentOutgoing, 800);
    assert.equal(fin.forecastedOutgoing, 1_300);

    // Margins: cash only, NO labor and NO percent complete. This is the pair
    // most at risk of being "improved" by the earned-margin work.
    assert.equal(fin.currentMargin, ((4_000 - 800) / 4_000) * 100);
    assert.equal(fin.forecastedMargin, ((30_000 - 1_300) / 30_000) * 100);

    // Labor stays tracked separately from currentOutgoing/currentMargin.
    assert.equal(fin.totalTimeHours, 10);
    assert.equal(fin.totalTimeCost, 500);

    assert.equal(fin.hasExpenses, true);
    assert.equal(fin.hasTimeEntries, true);
    assert.deepEqual(fin.estimateStatus, {
        pendingApproval: { count: 0, totalAmount: 0 },
        uninvoiced: { count: 1, totalAmount: 20_000 },
    });
});

test("currentMargin still excludes labor — earned margin is the field that includes it", async () => {
    const fin = await computeProjectFinancials("p1");
    // 80% cash margin ignores the $500 of labor; earned margin does not.
    assert.equal(fin.currentMargin, 80);
    assert.equal(fin.earnedMargin, 15_000 - (800 + 500));
});

// ── 2. the new fields ───────────────────────────────────────────────────────

test("percent complete is read from the stored columns, never computed here", async () => {
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.percentComplete, 60);
    assert.equal(fin.percentCompleteSource, "MANUAL");
    // auto 70 vs the 62 snapshotted at override time = 8 points of drift.
    assert.equal(fin.percentCompleteNeedsReview, true);
});

test("a manual override within 5 points of its snapshot does not ask for review", async () => {
    fixture.project.percentCompleteAuto = D(67);
    fixture.project.percentCompleteAutoAtOverride = D(62);
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.percentCompleteNeedsReview, false);
});

test("contractValue = accepted estimates + APPROVED change orders", async () => {
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.contractValue, 25_000);
});

test("a Sent estimate is a proposal, not contract value", async () => {
    fixture.estimates = [{ id: "e1", status: "Sent", totalAmount: D(20_000), balanceDue: D(0), archivedAt: null }];
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.contractValue, 5_000); // the approved CO only
});

test("an ARCHIVED accepted estimate is not contract value", async () => {
    // A superseded estimate keeps its accepted status after archiving. Counting
    // it would double the contract on any job that was re-estimated -- while
    // leaving every EXISTING field untouched, because archivedAt is selected
    // but deliberately not filtered on in the query.
    fixture.estimates = [
        { id: "e1", status: "Approved", totalAmount: D(20_000), balanceDue: D(0), archivedAt: null },
        { id: "e0", status: "Approved", totalAmount: D(18_000), balanceDue: D(0), archivedAt: new Date("2026-07-01") },
    ];
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.contractValue, 25_000);
    // The pre-Phase-4 field still counts BOTH, exactly as it did before.
    assert.equal(fin.forecastedIncomingFromEstimates, 38_000);
});

test("a manual override with no auto snapshot still reviews when auto disagrees", async () => {
    // Overridden before the cron had ever produced an auto value, so there was
    // nothing to snapshot. The manual value becomes the comparison baseline.
    fixture.project.percentCompleteAutoAtOverride = null;
    fixture.project.percentComplete = D(60);
    fixture.project.percentCompleteAuto = D(90);
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.percentCompleteNeedsReview, true);
});

test("earned revenue and margin follow contract value × percent complete", async () => {
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.earnedRevenue, 15_000);
    assert.equal(fin.earnedMargin, 13_700);
});

test("no percent complete → earned revenue and margin are null, not zero", async () => {
    fixture.project.percentComplete = null;
    fixture.project.percentCompleteSource = null;
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.percentComplete, null);
    assert.equal(fin.percentCompleteSource, null);
    assert.equal(fin.earnedRevenue, null);
    assert.equal(fin.earnedMargin, null);
    // contractValue is still a real, knowable number.
    assert.equal(fin.contractValue, 25_000);
});

test("no contract value → earned revenue is null (nothing to earn against)", async () => {
    fixture.estimates = [];
    fixture.changeOrders = [];
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.contractValue, 0);
    assert.equal(fin.earnedRevenue, null);
    assert.equal(fin.earnedMargin, null);
});

test("a project row that cannot be loaded degrades to null, never throws", async () => {
    fixture.project = null;
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.percentComplete, null);
    assert.equal(fin.percentCompleteSource, null);
    assert.equal(fin.percentCompleteNeedsReview, false);
});

test("receipt completeness is a share of ABSOLUTE expense dollars", async () => {
    const fin = await computeProjectFinancials("p1");
    // $1,000 with a receipt out of $1,200 moved (the −$200 refund counts gross).
    assert.equal(fin.receiptCompleteness, 1_000 / 1_200);
    // The two sides are exposed for dollar-weighted company roll-ups, and are
    // ABSOLUTE — deliberately different from the signed $800 `totalExpenses`.
    assert.equal(fin.expenseDollarsAbs, 1_200);
    assert.equal(fin.receiptedExpenseDollarsAbs, 1_000);
    assert.equal(fin.totalExpenses, 800);
});

test("a blank receiptUrl does not count as a receipt", async () => {
    fixture.expenses = [{ amount: D(500), receiptUrl: "   ", costCodeId: null }];
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.receiptCompleteness, 0);
});

test("no expenses at all → receipt completeness is null, not 0 or 1", async () => {
    fixture.expenses = [];
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.receiptCompleteness, null);
});

test("phase coverage spans expense AND labor dollars", async () => {
    const fin = await computeProjectFinancials("p1");
    // coded: $1,000 expense + $500 labor. total moved: $1,200 + $500.
    assert.equal(fin.phaseCoverage, 1_500 / 1_700);
});

test("no actuals at all → phase coverage is null", async () => {
    fixture.expenses = [];
    fixture.timeEntries = [];
    const fin = await computeProjectFinancials("p1");
    assert.equal(fin.phaseCoverage, null);
});

// ── 3. Decimal serialization ────────────────────────────────────────────────

const NEW_FIELDS = [
    "percentComplete",
    "contractValue",
    "earnedRevenue",
    "earnedMargin",
    "receiptCompleteness",
    "expenseDollarsAbs",
    "receiptedExpenseDollarsAbs",
    "phaseCoverage",
] as const;

test("every new numeric field is a plain number or null — never a Prisma Decimal", async () => {
    const fin = await computeProjectFinancials("p1");
    for (const key of NEW_FIELDS) {
        const value = fin[key];
        assert.ok(
            value === null || typeof value === "number",
            `${key} is ${typeof value} (${String(value)}) — a Decimal here breaks the server → client boundary`,
        );
        assert.ok(!(value instanceof Prisma.Decimal), `${key} leaked a Prisma.Decimal`);
    }
    assert.equal(typeof fin.percentCompleteNeedsReview, "boolean");
    assert.ok(fin.percentCompleteSource === null || typeof fin.percentCompleteSource === "string");
});

test("the whole result survives a JSON round trip unchanged", async () => {
    const fin = await computeProjectFinancials("p1");
    assert.deepEqual(JSON.parse(JSON.stringify(fin)), fin);
});

test("null-valued new fields also survive the round trip", async () => {
    fixture.project = null;
    fixture.expenses = [];
    fixture.timeEntries = [];
    const fin = await computeProjectFinancials("p1");
    assert.deepEqual(JSON.parse(JSON.stringify(fin)), fin);
});
