/**
 * Regression for Codex round 1, blocker 2.
 *
 * The Company Financials page draws the same money twice: a top-5 project
 * RANKING (all-time) and a monthly SPEND series (in-range). Before this fix the
 * ranking resolved a row's job through `estimate.projectId` (a SQL
 * `groupBy(["estimateId"])`) while the series resolved it through
 * `resolveExpenseProjectId`. A re-attributed expense therefore ranked under its
 * OLD job and plotted under its NEW one — the same dollars in two different
 * places, on one page.
 *
 * The fixture is one expense whose `projectId` and `estimate.projectId`
 * DISAGREE. That is the only shape that can catch this: with them in agreement
 * both code paths give the same answer and the bug is invisible.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const IN_RANGE = new Date("2026-06-15T12:00:00.000Z");

/** The row a bookkeeper moved from job-a to job-b after it was imported. */
const REATTRIBUTED = {
    amount: 5000,
    date: IN_RANGE,
    createdAt: IN_RANGE,
    projectId: "job-b",
    estimate: { projectId: "job-a" },
};

/** A smaller row that never moved, so job-a is still a real series. */
const SETTLED = {
    amount: 100,
    date: IN_RANGE,
    createdAt: IN_RANGE,
    projectId: "job-a",
    estimate: { projectId: "job-a" },
};

const expenseCalls: any[] = [];
const groupByCalls: any[] = [];
const estimateCalls: any[] = [];

/**
 * The all-time ranking is read as TWO DISJOINT GROUPED SUMS — rows that carry a
 * projectId, and legacy rows that answer through their estimate. The fixture's
 * re-attributed row is in the first group under its REAL job (job-b), which is
 * the whole point: an estimate-keyed group would have put it under job-a.
 */
const fakePrisma = {
    companySettings: {
        findUnique: async () => ({ timeZone: "America/Los_Angeles" }),
    },
    paymentSchedule: { findMany: async () => [] },
    retainer: { findMany: async () => [] },
    timeEntry: { findMany: async () => [] },
    estimate: {
        findMany: async (args: any) => {
            estimateCalls.push(args);
            // The legacy group's estimate -> project lookup.
            return [{ id: "est-legacy", projectId: "job-a" }];
        },
    },
    expense: {
        findMany: async (args: any) => {
            expenseCalls.push(args);
            // Two expense row reads now, both date-ranged: in-range job spend
            // and the overhead bucket, told apart by their select.
            const select = args.select ?? {};
            if (!select.projectId) return []; // overhead bucket
            return [REATTRIBUTED, SETTLED]; // in-range job spend
        },
        groupBy: async (args: any) => {
            groupByCalls.push(args);
            if (args.by?.[0] === "projectId") {
                return [
                    { projectId: "job-b", _sum: { amount: 5000 } },
                    { projectId: "job-a", _sum: { amount: 100 } },
                ];
            }
            // The legacy half: no projectId of its own, answered through the
            // estimate lookup above.
            return [{ estimateId: "est-legacy", _sum: { amount: 25 } }];
        },
    },
};

let getCompanyFinancialsChartData: any;

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma" || id === "./prisma") {
            requirePatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/lib/company-financials-charts");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.getCompanyFinancialsChartData !== "function") {
        throw new Error(
            "company-financials-spend-attribution.test.ts: prisma mock did not apply — " +
                `the require patch ${requirePatchHit ? "WAS" : "was NOT"} hit.`,
        );
    }
    getCompanyFinancialsChartData = mod.getCompanyFinancialsChartData;
});

const JOBS = [
    { id: "job-a", name: "Mueller Bath" },
    { id: "job-b", name: "Mesplay Kitchen" },
];

async function load() {
    return getCompanyFinancialsChartData(
        {
            preset: "6m",
            from: new Date("2026-04-01T00:00:00.000Z"),
            to: new Date("2026-07-01T00:00:00.000Z"),
            projectIds: ["job-a", "job-b"],
            includeOverhead: false,
        },
        JOBS,
    );
}

test("a re-attributed expense ranks under its REAL job, not its estimate's", async () => {
    const data = await load();
    const seriesIds = data.spendByProject.series.map((s: any) => s.id);
    // job-b holds the $5,000, so it must outrank job-a's $100.
    assert.deepEqual(seriesIds, ["job-b", "job-a", "other"]);
});

test("...and the monthly series puts the same dollars on the same job", async () => {
    const data = await load();
    const withSpend = data.spendByProject.data.filter(
        (point: any) => Number(point["job-a"] ?? 0) + Number(point["job-b"] ?? 0) > 0,
    );
    assert.equal(withSpend.length, 1, "one month carries the fixture's spend");
    assert.equal(withSpend[0]["job-b"], 5000, "the re-attributed dollars follow projectId");
    assert.equal(withSpend[0]["job-a"], 100);
    // The failure this guards: ranking said job-a, the series said job-b, and
    // the chart drew a legend entry with no bar under it.
    assert.ok(
        data.spendByProject.series.some((s: any) => s.id === "job-b"),
        "the job the money is plotted under must also be in the legend",
    );
});

test("the ranking covers BOTH ways a row reaches a job, not just the relation", async () => {
    // The predicate that matters is unchanged in meaning — a row counts if it
    // carries the project OR if its estimate does — it is now expressed as two
    // disjoint aggregates instead of one OR over materialized rows (round 16,
    // item 4). A relation-only filter would silently drop every re-attributed
    // row, which is exactly the bug this file exists for.
    groupByCalls.length = 0;
    await load();
    const wheres = groupByCalls.map(call => JSON.stringify(call.where));
    assert.deepEqual(wheres, [
        JSON.stringify({ projectId: { in: ["job-a", "job-b"] } }),
        JSON.stringify({ projectId: null, estimate: { projectId: { in: ["job-a", "job-b"] } } }),
    ]);
    // And the IN-RANGE series still reads the columns the resolver needs, so
    // the two charts cannot drift apart again.
    const series = expenseCalls.find(call => call.select?.projectId);
    assert.equal(series.select.projectId, true);
    assert.deepEqual(series.select.estimate, { select: { projectId: true } });
});

// ── the ranking is an AGGREGATE, not a row scan (Codex round 16, item 4) ───

test("the all-time ranking materializes NO expense rows", async () => {
    // Correct but unbounded is still unbounded: an all-time, all-jobs row fetch
    // grows forever to produce five numbers. Every remaining `findMany` on
    // Expense must therefore be date-bounded — the ranking has none, so if one
    // shows up without a date filter the row scan is back.
    expenseCalls.length = 0;
    await load();
    for (const call of expenseCalls) {
        const where = JSON.stringify(call.where ?? {});
        assert.match(
            where + JSON.stringify(call ?? {}),
            /date/,
            `an unbounded expense row read came back: ${JSON.stringify(call.select)}`,
        );
    }
    assert.ok(
        expenseCalls.every(call => call.select?.date === true),
        "every remaining row read is the in-range series or the overhead bucket",
    );
});

test("the two grouped sums are DISJOINT, and in the resolver's precedence", async () => {
    // Overlapping predicates would double-count a row; `projectId: null` on the
    // second is what makes them a partition rather than two overlapping sets,
    // and it is the same precedence resolveExpenseProjectId applies row by row.
    groupByCalls.length = 0;
    await load();
    const direct = groupByCalls.find(call => call.by?.[0] === "projectId");
    const legacy = groupByCalls.find(call => call.by?.[0] === "estimateId");
    assert.ok(direct && legacy, "both halves are read");
    assert.deepEqual(direct.where, { projectId: { in: ["job-a", "job-b"] } });
    assert.deepEqual(legacy.where, {
        projectId: null,
        estimate: { projectId: { in: ["job-a", "job-b"] } },
    });
    assert.deepEqual(direct._sum, { amount: true });
    assert.deepEqual(legacy._sum, { amount: true });
});

test("the legacy half is folded in under its estimate's job", async () => {
    // $25 of legacy spend on est-legacy (job-a) has to land on job-a, not be
    // dropped and not be ranked under an estimate id.
    estimateCalls.length = 0;
    const data = await load();
    assert.deepEqual(estimateCalls[0]?.where, { id: { in: ["est-legacy"] } });
    // job-b: 5000, job-a: 100 + 25 — order unchanged, but the legacy dollars
    // are counted.
    assert.deepEqual(
        data.spendByProject.series.map((entry: any) => entry.id),
        ["job-b", "job-a", "other"],
    );
});
