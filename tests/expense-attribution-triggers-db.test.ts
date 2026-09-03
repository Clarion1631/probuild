/**
 * THE DEPLOY BRIDGE, AGAINST A REAL POSTGRES (Codex round 37, item 2).
 *
 * `scripts/apply-expense-attribution.mjs` runs BEFORE the new build deploys —
 * it has to, or every page selecting the new columns throws P2022 — so for the
 * length of the drain window the OLD build is still serving with a Prisma
 * client that predates every tax column. Its QBO sync writes the whole expense
 * record on every changed purchase, `amount` included, and cannot restate a
 * tax figure or `needsTaxReview` because it has never heard of them.
 *
 * Two failures come out of that, and only one of them is loud:
 *
 *   * the gross moves under a human's tax classification and NOTHING says so.
 *     The figures still satisfy every CHECK, so the tax report reads a stale,
 *     unreviewed deduction as certified; and
 *   * the new gross is smaller than the recorded tax (or leaves the deduction
 *     base above `amount - taxAmount`), the row violates a CHECK this script
 *     just added, and the old writer simply fails — repeatedly, on a Purchase
 *     that already exists in QuickBooks.
 *
 * `AMOUNT_TAX_GUARD_SQL` closes both. This drives the SHIPPED SQL — the same
 * constant the apply script and the committed migration both carry — against a
 * real server, because a plpgsql trigger is exactly the kind of thing a
 * scripted fake cannot have an opinion about. Every case that asserts the
 * guard prevents a failure is paired with a CONTROL that drops the trigger and
 * shows the failure actually happens without it.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job and skips everywhere else, including anywhere
 * DATABASE_URL looks like production.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
    AMOUNT_TAX_GUARD_DROP_SQL,
    AMOUNT_TAX_GUARD_SQL,
} from "../scripts/apply-expense-attribution.mjs";

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

const PFX = "amt-tax-db";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const ESTIMATE = `${PFX}-estimate`;
const EXPENSE = `${PFX}-expense`;

async function installGuard() {
    for (const sql of AMOUNT_TAX_GUARD_SQL as string[]) await db!.$executeRawUnsafe(sql);
}
async function removeGuard() {
    for (const sql of AMOUNT_TAX_GUARD_DROP_SQL as string[]) await db!.$executeRawUnsafe(sql);
}

async function cleanup() {
    if (!db) return;
    await db.expense.deleteMany({ where: { id: EXPENSE } });
    await db.estimate.deleteMany({ where: { id: ESTIMATE } });
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.client.deleteMany({ where: { id: CLIENT } });
}

/**
 * A row in the shape the NEW build's tax PATCH leaves behind: a gross, a
 * bookkeeper's tax figure, their hand allocation, both provenances stamped
 * "manual", and `needsTaxReview` explicitly false because a person just looked.
 */
async function seedClassified(overrides: Record<string, unknown> = {}) {
    await cleanup();
    await db!.client.create({ data: { id: CLIENT, name: "Amount/Tax Guard", initials: "AG" } });
    await db!.project.create({
        data: { id: PROJECT, name: "Amount/Tax Guard", clientId: CLIENT, status: "In Progress" },
    });
    await db!.estimate.create({
        data: {
            id: ESTIMATE, title: "Amount/Tax Guard", code: `EST-${PFX}`, projectId: PROJECT,
            status: "Approved", totalAmount: 1000, balanceDue: 1000,
        },
    });
    await db!.expense.create({
        data: {
            id: EXPENSE, estimateId: ESTIMATE, projectId: PROJECT,
            amount: 412.10, taxAmount: 34.06, taxAtSource: true, taxSource: "manual",
            taxDeductibleBase: 200, taxDeductibleBaseSource: "manual",
            installedAtCustomer: true, needsTaxReview: false,
            vendor: "Lowe's", status: "Pending",
            ...overrides,
        },
    });
}

/** The OLD build's write: the gross alone, in raw SQL, saying nothing about tax. */
const oldBuildSetsAmount = (amount: number) =>
    db!.$executeRawUnsafe(`UPDATE "Expense" SET "amount" = $1 WHERE id = $2`, amount, EXPENSE);

const readRow = () =>
    db!.expense.findUnique({
        where: { id: EXPENSE },
        select: {
            amount: true, taxAmount: true, taxAtSource: true, taxSource: true,
            taxDeductibleBase: true, taxDeductibleBaseSource: true,
            installedAtCustomer: true, needsTaxReview: true,
        },
    });

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

before(async () => {
    if (!db) return;
    // The committed migration creates BOTH compatibility triggers and then
    // drops them again, so a database built from it starts here with neither —
    // which is production's END state, and the right place to start from.
    await installGuard();
});

after(async () => {
    if (!db) return;
    await removeGuard();
    await cleanup();
    await db.$disconnect();
});

test("an ordinary gross move flags a classified row for review", { skip }, async () => {
    // The quiet failure. $412.10 re-syncing as $498.30 breaks no CHECK — the
    // $34.06 of tax and the $200 allocation both still fit — so nothing else
    // in the database would ever ask whether they still describe this receipt.
    await seedClassified();
    await oldBuildSetsAmount(498.30);
    const row = await readRow();
    assert.equal(num(row!.amount), 498.3);
    assert.equal(row!.needsTaxReview, true, "the classification is re-opened");
    // Nothing is thrown away: the figures may well still be right, and it is
    // not this trigger's job to decide that.
    assert.equal(num(row!.taxAmount), 34.06);
    assert.equal(num(row!.taxDeductibleBase), 200);
    assert.equal(row!.taxSource, "manual");
    assert.equal(row!.installedAtCustomer, true);
});

test("...and WITHOUT the guard that same write is silent", { skip }, async () => {
    // The control. Without it the test above passes on a database that flags
    // every row for any reason.
    await seedClassified();
    await removeGuard();
    try {
        await oldBuildSetsAmount(498.30);
        const row = await readRow();
        assert.equal(num(row!.amount), 498.3);
        assert.equal(row!.needsTaxReview, false, "this is the failure the guard exists to prevent");
        assert.equal(num(row!.taxAmount), 34.06, "a stale figure, reportable and unreviewed");
    } finally {
        await installGuard();
    }
});

test("a gross that no longer fits the tax clears the classification instead of failing", { skip }, async () => {
    // The loud failure: $34.06 of tax on a $20 gross violates
    // Expense_taxAmount_check. The old writer cannot restate the tax, so
    // without help its UPDATE just fails, forever, on a Purchase QuickBooks
    // already has.
    await seedClassified();
    await oldBuildSetsAmount(20);
    const row = await readRow();
    assert.equal(num(row!.amount), 20);
    assert.equal(row!.taxAmount, null, "the figure that cannot be true is cleared");
    assert.equal(row!.taxAtSource, false, "and the flag derived from it");
    assert.equal(row!.taxSource, null, "provenance goes with the figure it described");
    assert.equal(row!.taxDeductibleBase, null);
    assert.equal(row!.taxDeductibleBaseSource, null);
    assert.equal(row!.installedAtCustomer, null);
    assert.equal(row!.needsTaxReview, true, "a person decides what the row should say");
});

test("...and WITHOUT the guard that same write is refused by the CHECK", { skip }, async () => {
    await seedClassified();
    await removeGuard();
    try {
        await assert.rejects(
            () => oldBuildSetsAmount(20),
            (error: { message?: string }) =>
                /Expense_taxAmount_check|violates check constraint/i.test(String(error?.message ?? error)),
            "the old writer fails outright without the bridge",
        );
    } finally {
        await installGuard();
    }
});

test("a gross that only breaks the ALLOCATION clears the allocation, not the tax", { skip }, async () => {
    // $200 of base needs at least $200 + $34.06 of gross. $100 does not, but
    // the tax itself still fits — so only the allocation and its provenance go.
    await seedClassified();
    await oldBuildSetsAmount(100);
    const row = await readRow();
    assert.equal(num(row!.amount), 100);
    assert.equal(num(row!.taxAmount), 34.06, "the tax still fits and is kept");
    assert.equal(row!.taxSource, "manual");
    assert.equal(row!.taxDeductibleBase, null, "the allocation that cannot fit is cleared");
    assert.equal(row!.taxDeductibleBaseSource, null);
    assert.equal(row!.needsTaxReview, true);
});

test("...and WITHOUT the guard THAT one is refused too", { skip }, async () => {
    await seedClassified();
    await removeGuard();
    try {
        await assert.rejects(
            () => oldBuildSetsAmount(100),
            (error: { message?: string }) =>
                /Expense_taxDeductibleBase_check|violates check constraint/i.test(String(error?.message ?? error)),
        );
    } finally {
        await installGuard();
    }
});

test("an UNCLASSIFIED row is not flagged by an amount move", { skip }, async () => {
    // No false positives: nobody has said anything about tax on this row, so
    // there is no classification to re-open and no review to ask for.
    await seedClassified({
        taxAmount: null, taxAtSource: false, taxSource: null,
        taxDeductibleBase: null, taxDeductibleBaseSource: null,
        installedAtCustomer: null,
    });
    await oldBuildSetsAmount(500);
    const row = await readRow();
    assert.equal(num(row!.amount), 500);
    assert.equal(row!.needsTaxReview, false);
});

test("a bookkeeper's explicit 'no tax here' IS a classification", { skip }, async () => {
    // The single most reviewable row: every figure is NULL, so only
    // `taxSource: "manual-none"` records that a person looked. Reading
    // "classified" off the figures alone would say nothing about it — the same
    // trap HUMAN_TAX_SOURCES exists for on the application side.
    await seedClassified({
        taxAmount: null, taxAtSource: false, taxSource: "manual-none",
        taxDeductibleBase: null, taxDeductibleBaseSource: null,
        installedAtCustomer: null,
    });
    await oldBuildSetsAmount(500);
    assert.equal((await readRow())!.needsTaxReview, true);
});

test("an UPDATE that does not move the gross changes nothing", { skip }, async () => {
    // A form that posts all its fields re-sends the same total on every save.
    // The trigger is the gross MOVING, not the column being present.
    await seedClassified();
    await db!.$executeRawUnsafe(
        `UPDATE "Expense" SET "amount" = $1, "vendor" = $2 WHERE id = $3`,
        412.10, "Home Depot", EXPENSE,
    );
    const row = await readRow();
    assert.equal(row!.needsTaxReview, false, "nobody disturbed the classification");
    assert.equal(num(row!.taxAmount), 34.06);
});

test("a NEW-BUILD write that restates the tax with the amount is left coherent", { skip }, async () => {
    // Both builds serve during a deploy window, so the guard has to be a no-op
    // against the build that already knows these rules. This is the shape
    // planExpenseUpdate produces: the gross and the tax moved together, and
    // the row it wrote is internally consistent.
    await seedClassified();
    await db!.$executeRawUnsafe(
        `UPDATE "Expense"
            SET "amount" = $1, "taxAmount" = $2, "taxAtSource" = true,
                "taxDeductibleBase" = $3, "needsTaxReview" = true
          WHERE id = $4`,
        1000, 82.5, 400, EXPENSE,
    );
    const row = await readRow();
    assert.equal(num(row!.amount), 1000);
    assert.equal(num(row!.taxAmount), 82.5, "the new build's figure survives verbatim");
    assert.equal(num(row!.taxDeductibleBase), 400);
    assert.equal(row!.taxSource, "manual", "and the human provenance with it");
    assert.equal(row!.taxAtSource, true);
    assert.equal(row!.needsTaxReview, true);
});

test("the guard is idempotent to re-create, and the teardown really removes it", { skip }, async () => {
    // Both halves of the deploy procedure. Postgres has no CREATE TRIGGER IF
    // NOT EXISTS, so a second pre-deploy run has to survive its own trigger;
    // and --post-deploy has to leave the database with none.
    await installGuard();
    await installGuard();
    await seedClassified();
    await oldBuildSetsAmount(498.30);
    assert.equal((await readRow())!.needsTaxReview, true, "still exactly one guard, still firing");

    await removeGuard();
    await removeGuard();
    const [{ n }] = (await db!.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n
           FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE c.relname = 'Expense'
            AND NOT t.tgisinternal
            AND t.tgname = 'probuild_expense_amount_tax_guard'`,
    )) as { n: number }[];
    assert.equal(n, 0, "the post-deploy teardown leaves no scaffolding behind");
    await installGuard();
});
