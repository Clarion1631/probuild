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

const fakePrisma = {
    companySettings: {
        findUnique: async () => ({ timeZone: "America/Los_Angeles" }),
    },
    paymentSchedule: { findMany: async () => [] },
    retainer: { findMany: async () => [] },
    timeEntry: { findMany: async () => [] },
    estimate: { findMany: async () => [] },
    expense: {
        findMany: async (args: any) => {
            expenseCalls.push(args);
            // Three expense reads, told apart by their select — the ranking one
            // needs no date, the overhead one no project.
            const select = args.select ?? {};
            if (!select.date) return [REATTRIBUTED, SETTLED]; // all-time ranking universe
            if (!select.projectId) return []; // overhead bucket
            return [REATTRIBUTED, SETTLED]; // in-range job spend
        },
        groupBy: async () => {
            throw new Error("groupBy must no longer be used: it cannot express the resolver's fallback");
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

test("the ranking query is the shared both-ways predicate, not a relation-only filter", async () => {
    await load();
    const ranking = expenseCalls.find(call => call.select && !call.select.date);
    assert.ok(ranking, "the all-time ranking read must happen");
    assert.deepEqual(ranking.where, {
        OR: [
            { projectId: { in: ["job-a", "job-b"] } },
            { projectId: null, estimate: { projectId: { in: ["job-a", "job-b"] } } },
        ],
    });
    assert.equal(ranking.select.projectId, true);
    assert.deepEqual(ranking.select.estimate, { select: { projectId: true } });
});
