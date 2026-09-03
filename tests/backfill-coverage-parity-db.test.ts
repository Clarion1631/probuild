/**
 * THE SCRIPT'S COVERAGE NUMBERS AND THE PAGE'S, ON ONE SEED (Codex round 48,
 * items 2 and 3).
 *
 * The backfill prints a "VARIANCE-BASIS coverage" headline and the rollout is
 * judged on it. That number is the script's own re-implementation of what
 * `computeProjectVariance` does with the same rows, and the two had drifted in
 * two directions at once:
 *
 *   * the script loaded item metadata only for the items EXPENSES link to, and
 *     then resolved TIME ENTRIES through that same map — so labor whose phase
 *     comes only from `estimateItemId` counted as unattributed; and
 *   * it applied WRITE eligibility (an active cost code, on a committed
 *     estimate) to a MEASUREMENT, while the page keeps draft/archived
 *     attribution-only items and never looks at `costCode.isActive`.
 *
 * Both directions are invisible to a unit test with a hand-built fixture,
 * because the fixture is written by whoever wrote the code. So this seeds a
 * real database with exactly the shapes that used to disagree and asserts the
 * two answers are the same number.
 *
 * It also covers the OTHER half of the same class of bug (item 2): the variance
 * loader selected `costCodeSource` and then dropped it when building the rows
 * it passes to the math, so a bookkeeper's explicit "no phase" (`manual-none`)
 * silently kept charging the phase its line item names.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job and skips everywhere else, including anywhere
 * DATABASE_URL looks like production.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { runBackfill } from "../scripts/backfill-expense-attribution";

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

/** The REAL variance loader, on the singleton, pointed at this database. */
let loadProjectVariance: typeof import("../src/lib/job-variance-db").loadProjectVariance;

before(async () => {
    if (!url || looksLikeProd) return;
    const pooled = new URL(url);
    pooled.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = pooled.toString();
    ({ loadProjectVariance } = await import("../src/lib/job-variance-db"));
});

const PFX = "cov-parity";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const DRAFT_ESTIMATE = `${PFX}-draft-estimate`;
const LIVE_ESTIMATE = `${PFX}-live-estimate`;
const DRAFT_ITEM = `${PFX}-draft-item`;
const LIVE_ITEM = `${PFX}-live-item`;
const RETIRED_CODE = `${PFX}-retired-code`;
const LIVE_CODE = `${PFX}-live-code`;
/** Active, but carried ONLY by a draft estimate — so not a PHASE by the write rule. */
const DRAFT_ONLY_CODE = `${PFX}-draft-code`;
const RETIRED_ITEM = `${PFX}-retired-item`;
const LABOR_ONLY_ITEM = `${PFX}-labor-item`;
const USER = `${PFX}-user`;

async function cleanup() {
    if (!db) return;
    await db.timeEntry.deleteMany({ where: { projectId: PROJECT } });
    await db.expense.deleteMany({ where: { id: { startsWith: PFX } } });
    await db.estimateItem.deleteMany({ where: { id: { startsWith: PFX } } });
    await db.estimate.deleteMany({ where: { id: { startsWith: PFX } } });
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.costCode.deleteMany({ where: { id: { startsWith: PFX } } });
    await db.client.deleteMany({ where: { id: CLIENT } });
}

/**
 * Every shape the two readers used to disagree about, in one job:
 *
 *   * a labor entry whose phase comes ONLY from its line item (the item the
 *     script's map did not load, because no expense points at it);
 *   * an expense linked to an item on a DRAFT estimate (attribution-only on the
 *     page, ineligible for a WRITE); and
 *   * an expense linked to an item carrying a RETIRED cost code (still
 *     attributed by the page, not writable by the script).
 */
async function seed() {
    await cleanup();
    await db!.client.create({ data: { id: CLIENT, name: "Coverage Parity", initials: "CP" } });
    await db!.project.create({
        data: { id: PROJECT, name: "Coverage Parity", clientId: CLIENT, status: "In Progress" },
    });
    await db!.user.create({
        data: { id: USER, email: `${PFX}@example.test`, name: "Parity Crew", role: "FIELD_CREW" },
    });
    await db!.costCode.createMany({
        data: [
            { id: LIVE_CODE, code: `${PFX}-01`, name: "Live phase", isActive: true },
            { id: RETIRED_CODE, code: `${PFX}-02`, name: "Retired phase", isActive: false },
            { id: DRAFT_ONLY_CODE, code: `${PFX}-03`, name: "Draft-only phase", isActive: true },
        ],
    });
    await db!.estimate.createMany({
        data: [
            {
                id: LIVE_ESTIMATE, title: "Live", code: `EST-${PFX}-live`, projectId: PROJECT,
                status: "Approved", totalAmount: 5000, balanceDue: 5000,
            },
            {
                id: DRAFT_ESTIMATE, title: "Draft", code: `EST-${PFX}-draft`, projectId: PROJECT,
                status: "Draft", totalAmount: 1000, balanceDue: 1000,
            },
        ],
    });
    await db!.estimateItem.createMany({
        data: [
            { id: LIVE_ITEM, estimateId: LIVE_ESTIMATE, name: "live line", costCodeId: LIVE_CODE, total: 3000 },
            // A code the WRITE rule does not admit — it lives only on a draft
            // estimate, so `resolveProjectPhaseCodes` never offers it — while the
            // variance page attributes spend through it all the same.
            { id: DRAFT_ITEM, estimateId: DRAFT_ESTIMATE, name: "draft line", costCodeId: DRAFT_ONLY_CODE, total: 500 },
            // ...and a RETIRED code on a committed estimate: same asymmetry, the
            // other way round.
            { id: RETIRED_ITEM, estimateId: LIVE_ESTIMATE, name: "retired line", costCodeId: RETIRED_CODE, total: 800 },
            { id: LABOR_ONLY_ITEM, estimateId: LIVE_ESTIMATE, name: "labor line", costCodeId: LIVE_CODE, total: 1200 },
        ],
    });
    // Labor attributed ONLY through its line item — the case the script's item
    // universe did not cover.
    await db!.timeEntry.create({
        data: {
            projectId: PROJECT, userId: USER, estimateItemId: LABOR_ONLY_ITEM,
            startTime: new Date("2026-08-14T15:00:00.000Z"),
            endTime: new Date("2026-08-14T23:00:00.000Z"),
            durationHours: 8, laborCost: 400, burdenCost: 100,
        },
    });
    await db!.expense.createMany({
        data: [
            // Attributed through an item on a DRAFT estimate.
            {
                id: `${PFX}-draft-expense`, projectId: PROJECT, estimateId: DRAFT_ESTIMATE,
                itemId: DRAFT_ITEM, amount: 300, vendor: "Draft Supply", status: "Pending",
                date: new Date("2026-08-14T19:00:00.000Z"),
            },
            // Attributed by its own column, no item.
            {
                id: `${PFX}-coded-expense`, projectId: PROJECT, estimateId: LIVE_ESTIMATE,
                costCodeId: LIVE_CODE, costCodeSource: "manual", amount: 200,
                vendor: "Coded Supply", status: "Pending",
                date: new Date("2026-08-14T19:00:00.000Z"),
            },
            // Attributed through an item whose code has been RETIRED. The page
            // still places it; the write rule would not.
            {
                id: `${PFX}-retired-expense`, projectId: PROJECT, estimateId: LIVE_ESTIMATE,
                itemId: RETIRED_ITEM, amount: 150, vendor: "Retired Supply", status: "Pending",
                date: new Date("2026-08-14T19:00:00.000Z"),
            },
            // ...and money nobody has placed, so both sides report a share
            // strictly between 0 and 1. A seed that is 100% attributed lets a
            // broken denominator agree with a broken numerator.
            {
                id: `${PFX}-unattributed`, projectId: PROJECT, estimateId: LIVE_ESTIMATE,
                amount: 100, vendor: "Unknown Supply", status: "Pending",
                date: new Date("2026-08-14T19:00:00.000Z"),
            },
        ],
    });
}

/**
 * What the PAGE says, on the same basis the script measures: ABSOLUTE dollars.
 *
 * `attributedShare` is `absAttributed / (absAttributed + absUnattributed)` and
 * `unattributedGross` is `absUnattributed` — the two the script's percentage is
 * built from, so they are the two to compare against.
 */
async function pageBasis() {
    const [report] = await loadProjectVariance([PROJECT]);
    assert.ok(report, "the seeded job must appear on the variance report");
    return { coverage: report.variance.coverage, variance: report.variance };
}

after(async () => {
    if (!db) return;
    await cleanup();
    await db.$disconnect();
});

test("the script's variance-basis coverage equals the page's, on one seed", { skip }, async () => {
    await seed();
    try {
        const outcome = await runBackfill({ db, apply: false, log: () => {}, overheadProjectId: "no-such-project" });
        const { coverage } = await pageBasis();

        const cents = (n: number) => Math.round(n * 100);
        const script = outcome.coverage.varianceBasis;
        const scriptUnattributed = script.total - script.before;
        const scriptShare = script.total > 0 ? script.before / script.total : 1;

        // The seed is only meaningful if BOTH numbers are in play.
        assert.ok(coverage.attributedShare > 0 && coverage.attributedShare < 1,
            `the seed must be partly attributed, got ${coverage.attributedShare}`);

        assert.equal(
            cents(scriptUnattributed),
            cents(coverage.unattributedGross),
            "the script and the page must agree on the dollars nobody placed",
        );
        assert.ok(
            Math.abs(scriptShare - coverage.attributedShare) < 1e-9,
            `coverage disagrees: script ${scriptShare} vs page ${coverage.attributedShare}`,
        );
    } finally {
        await cleanup();
    }
});

test("labor attributed only through its line item is counted, not written off", { skip }, async () => {
    // The specific regression: `TimeEntry.estimateItemId` pointing at an item no
    // expense links to. The script loaded no metadata for it and reported the
    // labor as unattributed, understating the headline.
    await seed();
    try {
        const outcome = await runBackfill({ db, apply: false, log: () => {}, overheadProjectId: "no-such-project" });
        assert.equal(Math.round(outcome.coverage.labor.total * 100), 50_000, "the seeded labor is $500");
        assert.equal(
            Math.round(outcome.coverage.labor.attributed * 100),
            50_000,
            "and all of it resolves through the line item",
        );
    } finally {
        await cleanup();
    }
});

test("a manual-none expense contributes to NO phase, through the real loader", { skip }, async () => {
    // Item 2. The loader selected `costCodeSource` and then dropped it when
    // building `VarianceExpense`, so `manual-none` arrived as undefined — which
    // reads as "nobody has spoken" and runs the item fallback. The money went
    // on charging the phase the bookkeeper had just cleared, on the one report
    // that decision exists to correct.
    await seed();
    try {
        await db!.expense.create({
            data: {
                id: `${PFX}-cleared`, projectId: PROJECT, estimateId: LIVE_ESTIMATE,
                itemId: LIVE_ITEM, costCodeId: null, costCodeSource: "manual-none",
                amount: 900, vendor: "Cleared Supply", status: "Pending",
                date: new Date("2026-08-14T19:00:00.000Z"),
            },
        });
        const { variance } = await pageBasis();
        const livePhase = variance.phases.find(p => p.costCodeId === LIVE_CODE);

        assert.ok(livePhase, "the live phase still exists on the report");
        assert.equal(
            Math.round(Number(livePhase!.actualMaterial) * 100),
            20_000,
            "only the $200 coded expense reaches the LIVE phase, not the $900 cleared one whose item names it",
        );
        assert.equal(
            Math.round(Number(variance.coverage.unattributedMaterial) * 100),
            100_000,
            "the cleared $900 joins the $100 nobody placed, which is what 'no phase' means",
        );
    } finally {
        await cleanup();
    }
});
