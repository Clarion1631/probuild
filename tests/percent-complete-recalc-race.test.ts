/**
 * The nightly recalc must not clobber a manual override saved WHILE it runs.
 *
 * recalcProjectPercentComplete does roughly eight queries per job before it
 * writes. An earlier version read `percentCompleteSource` in JS and then chose
 * its update shape from that read — a textbook lost update: anyone saving an
 * override inside that window had it stamped straight back to AUTO, silently,
 * on a number the owner had deliberately corrected.
 *
 * The fix is that the guard is evaluated by the DATABASE, in the same UPDATE
 * that writes (`percentCompleteSource IS DISTINCT FROM 'MANUAL'`). So the test
 * below models the interleaving directly: the fake flips the row to MANUAL
 * mid-read, exactly as a human clicking Save would, and the row is then checked
 * after the write.
 *
 * The fake `$queryRaw` implements the same conditional semantics Postgres
 * would, and asserts the statement actually carries the guard — a rewrite that
 * drops the CASE clauses fails here rather than in production six months later.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

interface Row {
    id: string;
    name: string;
    percentComplete: number | null;
    percentCompleteSource: "AUTO" | "MANUAL" | null;
    percentCompleteAuto: number | null;
    percentCompleteAsOf: Date | null;
}

let row: Row;
let sqlSeen: string[];
/** Runs during the recalc's READ phase, standing in for a concurrent save. */
let duringReads: (() => void) | null;
/** When true the fake UPDATE matches no row — a project deleted mid-sweep. */
let rowDeleted: boolean;

function resetFixture() {
    row = {
        id: "p1",
        name: "Berg ADU",
        percentComplete: 10,
        percentCompleteSource: "AUTO",
        percentCompleteAuto: 10,
        percentCompleteAsOf: null,
    };
    sqlSeen = [];
    duringReads = null;
    rowDeleted = false;
}

// One coded phase worth $10,000 with a single Complete task → auto = 100.
const ESTIMATES = [
    {
        id: "e1",
        items: [
            {
                id: "i1", name: "Demo", type: "Labor", parentId: null, total: 10_000,
                costCodeId: "cc-demo",
                costCode: { code: "01-DEMO", name: "Demolition" },
                costType: { name: "Labor" },
            },
        ],
    },
];

const fakePrisma = {
    project: {
        findMany: async () => [{ id: row.id, name: row.name, status: "In Progress" }],
    },
    costCode: { findMany: async () => [{ id: "cc-demo", code: "01-DEMO", name: "Demolition" }] },
    estimate: { findMany: async () => ESTIMATES },
    estimateItem: { findMany: async () => [] },
    changeOrderItem: { findMany: async () => [] },
    timeEntry: { findMany: async () => [] },
    expense: { findMany: async () => [] },
    scheduleTask: {
        findMany: async () => [
            { id: "t1", status: "Complete", type: "task", estimateItem: { costCodeId: "cc-demo" } },
        ],
    },
    dailyLog: {
        findMany: async () => {
            // The last read before the write — the concurrent save lands here.
            if (duringReads) {
                duringReads();
                duringReads = null;
            }
            return [];
        },
    },

    /**
     * Stands in for Postgres. Every CASE in the real statement is evaluated
     * against the row's PRE-UPDATE percentCompleteSource, so the branch is
     * decided once, here, before anything is assigned.
     */
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        sqlSeen.push(sql);

        const auto = values[0] as number | null;
        const now = values.find((v) => v instanceof Date) as Date | undefined;

        // WHERE "id" = ... matched nothing.
        if (rowDeleted) return [];

        row.percentCompleteAuto = auto;
        if (row.percentCompleteSource !== "MANUAL") {
            row.percentComplete = auto;
            row.percentCompleteSource = "AUTO";
            row.percentCompleteAsOf = now ?? null;
        }
        return [{ percentComplete: row.percentComplete, percentCompleteSource: row.percentCompleteSource }];
    },
};

let recalcProjectPercentComplete: (p: { id: string; name: string }) => Promise<any>;

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

    let mod: { recalcProjectPercentComplete?: unknown };
    try {
        mod = await import("../src/lib/percent-complete-db");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof mod.recalcProjectPercentComplete !== "function") {
        throw new Error(
            `percent-complete-recalc-race.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply — ` +
                `recalcProjectPercentComplete is ${typeof mod.recalcProjectPercentComplete}. ` +
                `The require() patch ${requirePatchHit ? "WAS" : "was NOT"} hit.`,
        );
    }
    recalcProjectPercentComplete = mod.recalcProjectPercentComplete as any;
});

beforeEach(() => {
    resetFixture();
});

// ── control ─────────────────────────────────────────────────────────────────

test("with no override, the recalc adopts the computed value as AUTO", async () => {
    const result = await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

    assert.equal(result.auto, 100);
    assert.equal(result.notFound, false);
    assert.equal(result.manualOverrideKept, false);
    assert.equal(row.percentComplete, 100);
    assert.equal(row.percentCompleteSource, "AUTO");
    assert.equal(row.percentCompleteAuto, 100);
});

test("a NULL source is still treated as auto — IS DISTINCT FROM, not <>", async () => {
    // `NULL <> 'MANUAL'` is NULL (false in a CASE), which would skip exactly the
    // jobs that have never been computed and most need an auto value.
    row.percentCompleteSource = null;
    row.percentComplete = null;

    const result = await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

    assert.equal(result.manualOverrideKept, false);
    assert.equal(row.percentCompleteSource, "AUTO");
    assert.equal(row.percentComplete, 100);
});

// ── the race ────────────────────────────────────────────────────────────────

test("a manual save landing MID-RECALC survives the recalc's write", async () => {
    // The interleaving under test:
    //   recalc reads → human saves 60 as MANUAL → recalc writes.
    duringReads = () => {
        row.percentComplete = 60;
        row.percentCompleteSource = "MANUAL";
    };

    const result = await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

    // The override stands, untouched.
    assert.equal(row.percentCompleteSource, "MANUAL");
    assert.equal(row.percentComplete, 60);
    // ...and the auto value was refreshed anyway, which is what the >5-point
    // drift flag needs in order to fire later.
    assert.equal(row.percentCompleteAuto, 100);

    assert.equal(result.manualOverrideKept, true);
    assert.equal(result.percentComplete, 60);
    assert.equal(result.auto, 100);
});

// ── the row vanished ────────────────────────────────────────────────────────

test("a project deleted mid-recalc reports notFound, not a successful null", async () => {
    // Zero rows from RETURNING used to be indistinguishable from "computed, and
    // the trust gate refused to guess" — both surfaced as percentComplete null
    // with notFound absent, so a vanished project looked like a clean recalc.
    rowDeleted = true;

    const result = await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

    assert.equal(result.notFound, true);
    assert.equal(result.percentComplete, null);
    assert.equal(result.manualOverrideKept, false);
    // The computed value is still reported — it was computed, just not stored.
    assert.equal(result.auto, 100);
});

test("a vanished project is distinguishable from an unmeasurable one", async () => {
    rowDeleted = true;
    const vanished = await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

    resetFixture();
    // Uncoded estimate → the trust gate returns null. A real, stored recalc.
    ESTIMATES[0].items[0].costCodeId = null as unknown as string;
    const unmeasurable = await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });
    ESTIMATES[0].items[0].costCodeId = "cc-demo";

    assert.equal(vanished.percentComplete, null);
    assert.equal(unmeasurable.percentComplete, null);
    // Same percentage, different meaning — which is the whole point of the flag.
    assert.equal(vanished.notFound, true);
    assert.equal(unmeasurable.notFound, false);
    assert.equal(unmeasurable.auto, null);
});

test("the recalc never reads the source into JS to decide — one guarded statement", async () => {
    await recalcProjectPercentComplete({ id: "p1", name: "Berg ADU" });

    assert.equal(sqlSeen.length, 1, "the recalc must write exactly one statement per project");
    const sql = sqlSeen[0];
    assert.match(sql, /IS DISTINCT FROM 'MANUAL'/, "the manual guard must be evaluated by the database");
    assert.match(sql, /"percentCompleteAuto" =/, "the auto value must always be written");
    // percentComplete, percentCompleteSource and percentCompleteAsOf are each
    // guarded; percentCompleteAuto is not. Three CASEs, no more, no fewer.
    assert.equal((sql.match(/IS DISTINCT FROM 'MANUAL'/g) ?? []).length, 3);
});
