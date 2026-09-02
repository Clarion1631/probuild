/**
 * The FILTER, not the arithmetic (checker item 2).
 *
 * tax-at-source-report.test.ts proves the sums. This proves the three
 * conditions that decide which receipts are summed at all — and they are the
 * part that can be wrong without anything looking wrong: a report that quietly
 * includes `installedAtCustomer: null` rows overstates a tax deduction and
 * still renders a perfectly plausible table.
 *
 * Prisma is patched at require() time, the same shape as
 * tests/job-variance-db.test.ts. No mock.module — CI pins Node 20.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project";

const PACIFIC = "America/Los_Angeles";

const recorded: any[] = [];
/** Per-test override for the mixed-receipt allocation. */
let withTaxDeductibleBase: string | null = null;

const fakePrisma = {
    companySettings: {
        findUnique: async () => ({ timeZone: PACIFIC }),
    },
    expense: {
        findMany: async (args: any) => {
            recorded.push(args);
            return [
                {
                    id: "e1",
                    // 6pm Pacific on 30 September — 1 October in UTC.
                    date: new Date("2026-10-01T01:00:00.000Z"),
                    vendor: "Harbor Freight",
                    description: "[Receipt intake] Invoice 82766",
                    amount: "207.74",
                    taxAmount: "16.55",
                    taxDeductibleBase: withTaxDeductibleBase,
                    projectId: "job-b",
                    project: { name: "Mesplay Kitchen" },
                    estimate: { projectId: "job-a", project: { name: "Mueller Bath" } },
                },
            ];
        },
    },
};

let queryTaxAtSourceRows: any;
let resolveTaxAtSourceFilters: any;
let parseTaxAtSourceFilters: any;

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
        mod = await import("../src/lib/tax-at-source-report");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.queryTaxAtSourceRows !== "function") {
        throw new Error(
            "tax-at-source-query.test.ts: prisma mock did not apply — " +
                `the require patch ${requirePatchHit ? "WAS" : "was NOT"} hit.`,
        );
    }
    queryTaxAtSourceRows = mod.queryTaxAtSourceRows;
    resolveTaxAtSourceFilters = mod.resolveTaxAtSourceFilters;
    parseTaxAtSourceFilters = mod.parseTaxAtSourceFilters;
});

test("the where clause asks for all three conditions POSITIVELY", async () => {
    const filters = parseTaxAtSourceFilters({ from: "2026-07-01", to: "2026-09-30" }, PACIFIC);
    recorded.length = 0;
    await queryTaxAtSourceRows(filters);

    const where = recorded[0].where;
    assert.equal(where.taxAtSource, true);
    // `true`, not `{ not: false }`: a NULL means "nobody said", and a NULL must
    // never be spent as a tax deduction.
    assert.equal(where.installedAtCustomer, true);
    assert.deepEqual(where.taxAmount, { gt: 0 }, "a $0 tax row is an ANSWER, not a candidate");
});

test("the date window is the COMPANY quarter, in instants", async () => {
    const filters = parseTaxAtSourceFilters({ from: "2026-07-01", to: "2026-09-30" }, PACIFIC);
    recorded.length = 0;
    await queryTaxAtSourceRows(filters);

    const range = recorded[0].where.date;
    // PDT is UTC-7, so company midnight is 07:00Z. A UTC-computed bound would
    // read 00:00Z and pull in seven hours of the neighbouring quarter.
    assert.equal(range.gte.toISOString(), "2026-07-01T07:00:00.000Z");
    assert.equal(range.lt.toISOString(), "2026-10-01T07:00:00.000Z", "start of the day AFTER the last one");
});

test("resolveTaxAtSourceFilters takes the zone from company settings", async () => {
    const filters = await resolveTaxAtSourceFilters({ from: "2026-01-01", to: "2026-03-31" });
    assert.equal(filters.timeZone, PACIFIC);
    assert.equal(filters.from.toISOString(), "2026-01-01T08:00:00.000Z", "PST, not the server's zone");
});

test("an allocated deduction base replaces the whole pre-tax total", async () => {
    // The mixed-receipt correction path. Without it the report claims the
    // entire job-coded receipt, which WAC 458-20-102(12)(b) does not allow —
    // only the cost of the articles actually resold.
    const filters = parseTaxAtSourceFilters({ from: "2026-07-01", to: "2026-09-30" }, PACIFIC);
    withTaxDeductibleBase = "50.00";
    try {
        const [row] = await queryTaxAtSourceRows(filters);
        assert.equal(row.deductionBaseCents, 5000);
        assert.equal(row.baseIsAllocated, true);
        assert.equal(row.receiptTotalCents, 20774, "the gross is unchanged");
    } finally {
        withTaxDeductibleBase = null;
    }
});

test("a row is stamped with its COMPANY day and its RESOLVED job", async () => {
    const filters = parseTaxAtSourceFilters({ from: "2026-07-01", to: "2026-09-30" }, PACIFIC);
    const [row] = await queryTaxAtSourceRows(filters);

    // The instant is 1 October UTC; the company calendar says 30 September, and
    // that is the quarter the deduction belongs to.
    assert.equal(row.dayKey, "2026-09-30");
    // The fixture's projectId and estimate.projectId disagree — the column wins.
    assert.equal(row.projectId, "job-b");
    assert.equal(row.projectName, "Mesplay Kitchen");
    // Cents, from the Decimal's string form.
    assert.equal(row.receiptTotalCents, 20774);
    assert.equal(row.taxCents, 1655);
    assert.equal(row.deductionBaseCents, 19119);
    assert.equal(row.reference, "82766");
});

test("the query excludes the Shop/overhead bucket, both ways round", async () => {
    // The page has always PROMISED Shop purchases are excluded; nothing
    // enforced it, so an overhead receipt mistakenly flagged
    // installed-at-customer was claimed like any other.
    const filters = parseTaxAtSourceFilters({ from: "2026-07-01", to: "2026-09-30" }, PACIFIC);
    recorded.length = 0;
    await queryTaxAtSourceRows(filters);

    const branches = recorded[0].where.OR as Record<string, any>[];
    assert.ok(Array.isArray(branches), "the exclusion must reach the query");
    assert.equal(branches.length, 3, "direct, unattributed, and estimate-fallback");
    // Direct attribution to the bucket is out...
    assert.ok(JSON.stringify(branches[0]).includes(OVERHEAD_PROJECT_ID));
    // ...and so is reaching it through the estimate.
    assert.ok(JSON.stringify(branches[2]).includes(OVERHEAD_PROJECT_ID));
    // ...while a row attributed to NOTHING still survives.
    assert.deepEqual(branches[1], {
        AND: [{ projectId: null }, { estimate: { projectId: null } }],
    });
});

test("a row awaiting re-review is not a deduction", async () => {
    // Codex round 7, item 3. Without this the "a null taxDeductibleBase means
    // the whole pre-tax total" rule would claim the FULL amount of a receipt
    // whose gross moved under a human's tax answer and that nobody has
    // re-checked.
    const filters = parseTaxAtSourceFilters({ from: "2026-07-01", to: "2026-09-30" }, PACIFIC);
    recorded.length = 0;
    await queryTaxAtSourceRows(filters);
    assert.equal(recorded[0].where.needsTaxReview, false);
});
