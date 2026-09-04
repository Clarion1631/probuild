/**
 * THE EXCISE DEDUCTION'S FILTER, AGAINST A REAL POSTGRES (Codex round 43,
 * item 3).
 *
 * `tests/tax-at-source-query.test.ts` drives the same query against a patched
 * Prisma and can prove the predicate is SHAPED a certain way. It cannot prove
 * what that shape MEANS to the database, and the difference is the whole bug:
 *
 *   `{ estimate: { projectId: null } }` is a filter on a RELATED ROW. Prisma
 *   compiles it to an EXISTS, so it requires an estimate to be there and to
 *   have a null project. An expense with `estimateId: null` — the shape
 *   `ON DELETE SET NULL` creates the moment an estimate is deleted (round 42,
 *   item 4b) — matches no branch of `expenseNotOnProjectWhere` and drops out of
 *   the report entirely. A deep-equality assertion over the predicate object
 *   agreed with itself and said nothing about that.
 *
 * So this seeds a tax-qualified receipt, deletes its estimate, and asks the
 * REAL query whether the deduction is still there.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job and skips everywhere else, including anywhere
 * DATABASE_URL looks like production.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { OVERHEAD_PROJECT_ID } from "../src/lib/overhead-project";

// The report reads the PRISMA SINGLETON, which refuses a DATABASE_URL without
// `pgbouncer=true` (the Supabase pooler rule). CI hands this job a plain
// localhost URL, so the param is added here and the module is imported
// dynamically AFTER it -- an `import` declaration would hoist above the
// assignment and throw at load.
let parseTaxAtSourceFilters: typeof import("../src/lib/tax-at-source-report").parseTaxAtSourceFilters;
let queryTaxAtSourceRows: typeof import("../src/lib/tax-at-source-report").queryTaxAtSourceRows;

const url =
    process.env.PHASE_INVARIANT_DB_TEST_URL ??
    process.env.RECEIPT_INTAKE_DB_TEST_URL ??
    process.env.MIGRATION_HISTORY_TEST_URL;
const looksLikeProd = !!url && /supabase\.(co|com)/i.test(url);
const skip = !url
    ? "set PHASE_INVARIANT_DB_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

const db = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

before(async () => {
    if (!url || looksLikeProd) return;
    const pooled = new URL(url);
    pooled.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = pooled.toString();
    const mod = await import("../src/lib/tax-at-source-report");
    parseTaxAtSourceFilters = mod.parseTaxAtSourceFilters;
    queryTaxAtSourceRows = mod.queryTaxAtSourceRows;
});

const PFX = "tax-src-db";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const ESTIMATE = `${PFX}-estimate`;
const ORPHAN = `${PFX}-orphan`;
const ON_JOB = `${PFX}-on-job`;
const PACIFIC = "America/Los_Angeles";

/** Everything the report requires of a deductible receipt. */
const QUALIFIED = {
    amount: 207.74,
    taxAmount: 16.55,
    taxAtSource: true,
    installedAtCustomer: true,
    needsTaxReview: false,
    taxSource: "manual",
    vendor: "Summit Plumbing",
    status: "Pending",
    date: new Date("2026-08-15T19:00:00.000Z"),
};

async function cleanup() {
    if (!db) return;
    await db.expense.deleteMany({ where: { id: { in: [ORPHAN, ON_JOB] } } });
    await db.estimate.deleteMany({ where: { id: ESTIMATE } });
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.client.deleteMany({ where: { id: CLIENT } });
}

async function seed() {
    await cleanup();
    await db!.client.create({ data: { id: CLIENT, name: "Tax At Source DB", initials: "TS" } });
    await db!.project.create({
        data: { id: PROJECT, name: "Tax At Source DB", clientId: CLIENT, status: "In Progress" },
    });
    await db!.estimate.create({
        data: {
            id: ESTIMATE, title: "Tax At Source DB", code: `EST-${PFX}`, projectId: PROJECT,
            status: "Approved", totalAmount: 1000, balanceDue: 1000,
        },
    });
    // FALLBACK-ATTRIBUTED: no projectId of its own, so the job lives on the
    // estimate. Deleting that estimate is what produces the orphan shape.
    await db!.expense.create({ data: { id: ORPHAN, estimateId: ESTIMATE, projectId: null, ...QUALIFIED } });
    // ...and a control that is attributed directly, so a failure below cannot
    // be "the query returns nothing at all".
    await db!.expense.create({ data: { id: ON_JOB, estimateId: ESTIMATE, projectId: PROJECT, ...QUALIFIED } });
}

const rowsInRange = () =>
    queryTaxAtSourceRows(parseTaxAtSourceFilters({ from: "2026-08-01", to: "2026-08-31" }, PACIFIC));

test("an ESTIMATE-LESS qualifying receipt is still in the excise deduction", { skip }, async () => {
    await seed();
    try {
        const before = await rowsInRange();
        assert.ok(before.some(row => row.id === ORPHAN), "the fallback-attributed row starts in the report");

        // The estimate goes; SET NULL leaves the row with neither half.
        await db!.estimate.delete({ where: { id: ESTIMATE } });
        const orphan = await db!.expense.findUnique({
            where: { id: ORPHAN },
            select: { projectId: true, estimateId: true },
        });
        assert.deepEqual(orphan, { projectId: null, estimateId: null }, "the shape this test is about");

        const after = await rowsInRange();
        assert.ok(
            after.some(row => row.id === ORPHAN),
            "an expense with no estimate and no project is unattributed, NOT overhead — it stays deductible",
        );
        assert.ok(after.some(row => row.id === ON_JOB), "and the directly-attributed control is untouched");
    } finally {
        await cleanup();
    }
});

test("...and the overhead bucket is still excluded, both ways round", { skip }, async () => {
    // The control for the branch that was added: widening the predicate must
    // not let Shop purchases back in. Directly attributed to the bucket, and
    // reaching it through an estimate.
    await seed();
    try {
        await db!.project.upsert({
            where: { id: OVERHEAD_PROJECT_ID },
            update: {},
            create: { id: OVERHEAD_PROJECT_ID, name: "Shop", clientId: CLIENT, status: "In Progress" },
        });
        await db!.expense.updateMany({ where: { id: ON_JOB }, data: { projectId: OVERHEAD_PROJECT_ID } });
        await db!.estimate.updateMany({ where: { id: ESTIMATE }, data: { projectId: OVERHEAD_PROJECT_ID } });

        const rows = await rowsInRange();
        assert.ok(!rows.some(row => row.id === ON_JOB), "direct attribution to the bucket is excluded");
        assert.ok(!rows.some(row => row.id === ORPHAN), "and so is reaching it through the estimate");
    } finally {
        await db!.expense.deleteMany({ where: { id: { in: [ORPHAN, ON_JOB] } } });
        await db!.estimate.deleteMany({ where: { id: ESTIMATE } });
        await db!.project.deleteMany({ where: { id: OVERHEAD_PROJECT_ID } });
        await cleanup();
    }
});

after(async () => {
    await db?.$disconnect();
});
