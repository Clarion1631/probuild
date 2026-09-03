/**
 * THE PROJECT/ESTIMATE DEADLOCK, AGAINST A REAL POSTGRES (Codex round 37,
 * item 3).
 *
 * `src/lib/phase-invariant.ts` declares one acquisition order —
 * Project -> Estimate -> EstimateItem -> CostCode -> Expense — and
 * tests/phase-invariant-db.test.ts proves the BACKFILL obeys it. The live
 * writers did not. Each of them took the set in two pieces and inverted it
 * between them: `lockEstimateAttribution` / `resolveExpenseProjectUnderLock`
 * share-lock the ESTIMATE, to re-read the attribution pair, and only
 * afterwards does `assertPhaseOfProjectTx` reach for the PROJECT.
 *
 * Two share locks never conflict, so nothing here shows up between two of
 * these writers. The collision needs a real writer on the other side: a job
 * editor holding its Project row FOR UPDATE and then reaching for an estimate.
 * Against Estimate-then-Project that is a cycle, and Postgres breaks a cycle by
 * killing one side with 40P01 — the victim chosen by the server, so half the
 * time it is the person's save rather than the unattended pass.
 *
 * This file is only meaningful because of its CONTROL: the first test drives
 * the OLD sequence and asserts the deadlock is REAL, so the tests that follow
 * are measuring the fix rather than measuring an interleaving that never
 * collided. The source tripwire that every writer actually calls the shared
 * helper first lives in tests/attribution-lock-order.test.ts; what cannot be
 * asserted there is that the order buys anything, because a scripted client
 * has no lock manager.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job and skips everywhere else, including anywhere
 * DATABASE_URL looks like production.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { assertPhaseOfProjectTx, lockAttributionParents } from "../src/lib/phase-invariant";
import {
    lockEstimateAttribution,
    reattributeExpense,
    resolveExpenseProjectUnderLock,
} from "../src/lib/expense-attribution";
import { lockExpense } from "../src/lib/expense-lock";
import {
    applyQboExpenseCostCodeSuggestion,
    upsertQboExpense,
    type QboCostCodeSuggestionClient,
    type QboExpensePersistenceClient,
} from "../src/lib/qbo-expense-sync";
import { createParsedReceiptExpense } from "../src/lib/receipt-parse-expense";
import { planBackfill, runBackfill, writeUnderAttributionLocks } from "../scripts/backfill-expense-attribution";
import {
    backfillStatements,
    DDL_STATEMENTS,
    PHASE_A_STEPS,
    PROJECT_ID_BACKFILL,
    PROJECT_ID_BACKFILL_LOCK_PROJECTS,
    SPLIT_JOB_GUARD_DROP_SQL,
    SPLIT_JOB_GUARD_SQL,
    SPLIT_JOB_REPAIR,
    SPLIT_JOB_REPAIR_LOCK_PROJECTS,
    toConcurrentIndexSql,
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

// Two CONNECTIONS, not two clients on one pool: the transactions have to be
// genuinely concurrent and able to block on each other.
const writerDb = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;
const editorDb = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const PFX = "attr-lock-db";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const CODE = `${PFX}-costcode`;
const ESTIMATE = `${PFX}-estimate`;
const ITEM = `${PFX}-item`;
const EXPENSE = `${PFX}-expense`;
const PURCHASE = `${PFX}-purchase`;

/** A promise a later step resolves — how the interleaving is made deterministic. */
function gate() {
    let open!: () => void;
    const reached = new Promise<void>(resolve => (open = resolve));
    return { reached, open };
}

const deadlocked = (error: unknown) =>
    /deadlock detected|40P01/i.test(String((error as { message?: string })?.message ?? error ?? ""));

async function cleanup() {
    if (!writerDb) return;
    await writerDb.expense.deleteMany({ where: { id: EXPENSE } });
    await writerDb.estimateItem.deleteMany({ where: { id: ITEM } });
    await writerDb.estimate.deleteMany({ where: { id: ESTIMATE } });
    await writerDb.project.deleteMany({ where: { id: PROJECT } });
    await writerDb.costCode.deleteMany({ where: { id: CODE } });
    await writerDb.client.deleteMany({ where: { id: CLIENT } });
}

async function seed() {
    await cleanup();
    await writerDb!.client.create({ data: { id: CLIENT, name: "Attribution Lock Order", initials: "AL" } });
    await writerDb!.project.create({
        data: { id: PROJECT, name: "Attribution Lock Order", clientId: CLIENT, status: "In Progress" },
    });
    await writerDb!.costCode.create({
        // 03-PLUMB is what the "Summit Plumbing" vendor rule suggests, which is
        // how the QBO suggester test below reaches a real write.
        data: { id: CODE, code: "03-PLUMB", name: "Plumbing", isActive: true },
    });
    await writerDb!.estimate.create({
        data: {
            id: ESTIMATE, title: "Attribution Lock Order", code: `EST-${PFX}`, projectId: PROJECT,
            status: "Approved", totalAmount: 1000, balanceDue: 1000,
        },
    });
    await writerDb!.estimateItem.create({
        data: { id: ITEM, estimateId: ESTIMATE, name: "rough-in", costCodeId: CODE },
    });
    await writerDb!.expense.create({
        data: {
            id: EXPENSE, estimateId: ESTIMATE,
            // FALLBACK-ATTRIBUTED ON PURPOSE — `projectId` NULL, so the job
            // lives on the estimate. That is the shape the 562 backfilled
            // legacy rows have, and it is the ONLY shape in which the QBO
            // suggester reaches for the Estimate at all:
            // `resolveExpenseProjectUnderLock` returns a row's own projectId
            // without taking any lock. Seeding this test with a pinned
            // projectId would make it pass against the un-fixed code, which is
            // exactly what the mutation check caught.
            projectId: null,
            amount: 250, vendor: "Summit Plumbing", status: "Pending",
            qbPurchaseId: PURCHASE, qbSyncToken: "3",
        },
    });
}

/**
 * THE OTHER SIDE: a job editor, taking its Project row FOR UPDATE and then an
 * estimate of that job. This is the shape every ScheduleTask writer and the
 * Project cascade delete already have (`Project -> children`), and the one the
 * declared order is built to agree with.
 */
function projectFirstEditor(projectHeld: ReturnType<typeof gate>) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                await tx.$executeRawUnsafe(`SELECT id FROM "Project" WHERE id = $1 FOR UPDATE`, PROJECT);
                projectHeld.open();
                // Long enough that the writer has certainly reached its first
                // lock, whichever table that turns out to be.
                await new Promise(resolve => setTimeout(resolve, 750));
                await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, ESTIMATE);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

test("CONTROL: the OLD Estimate-then-Project order really does deadlock", { skip }, async () => {
    // The pre-fix sequence, verbatim: re-read the attribution pair off a
    // share-locked Estimate, THEN ask the phase question, which reaches for the
    // Project. Exactly what `api/expenses` POST, `createExpenseCore`,
    // receipt-ingest and the QBO suggester all did.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockEstimateAttribution(raw, ESTIMATE);
            await assertPhaseOfProjectTx(raw, PROJECT, CODE);
        }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected Postgres to break a cycle with 40P01; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanup();
    }
});

test("the shared helper first: both orders complete, one simply waits", { skip }, async () => {
    // The fix. `lockAttributionParents` takes Project before Estimate, so the
    // writer blocks on the editor's Project row and there is no cycle to break:
    // it waits, the editor commits, and the writer proceeds. The two narrower
    // helpers after it re-acquire share locks this transaction already holds,
    // which is free.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        let verdict: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockAttributionParents(raw, {
                projectId: PROJECT, estimateId: ESTIMATE, itemId: ITEM, costCodeId: CODE,
            });
            await lockEstimateAttribution(raw, ESTIMATE);
            verdict = await assertPhaseOfProjectTx(raw, PROJECT, CODE);
        }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the writer was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the writer failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        // Waiting is only the right answer if the work still happened.
        assert.deepEqual(verdict, { ok: true }, "the phase question was still answered");
    } finally {
        await cleanup();
    }
});

test("the QBO cost-code suggester, for real, against a Project-first editor", { skip }, async () => {
    // The ACTUAL writer this time, not a reconstruction of its sequence:
    // `applyQboExpenseCostCodeSuggestion` opens its own transaction, takes the
    // parents through the shared helper, re-resolves the job under lock, asks
    // the phase question and writes. It is the unattended pass, so it is the
    // one whose deadlock victim is most likely to be a person's save.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let result: string | null = null;
        let writerError: unknown = null;
        try {
            result = await applyQboExpenseCostCodeSuggestion(
                writerDb as unknown as QboCostCodeSuggestionClient,
                { qbPurchaseId: PURCHASE },
                new Map([["03-PLUMB", CODE]]),
            );
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the suggester was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the suggester failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        assert.equal(result, "written", "it waited for the editor and then did its job");

        const coded = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { costCodeId: true, costCodeSource: true },
        });
        assert.deepEqual(coded, { costCodeId: CODE, costCodeSource: "ai" });
    } finally {
        await cleanup();
    }
});

test("two attribution writers never block each other at all", { skip }, async () => {
    // The other half of the argument for FOR SHARE. The order above only has
    // to agree with something taking these rows EXCLUSIVELY; two callers of the
    // helper hold compatible locks, so neither waits and neither can deadlock,
    // whatever ids they name.
    await seed();
    try {
        const first = gate();
        const both = await Promise.all([
            writerDb!.$transaction(async tx => {
                const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
                await lockAttributionParents(raw, { projectId: PROJECT, estimateId: ESTIMATE, costCodeId: CODE });
                first.open();
                await new Promise(resolve => setTimeout(resolve, 300));
                return "a";
            }),
            (async () => {
                await first.reached;
                return editorDb!.$transaction(async tx => {
                    const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
                    await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
                    // Would time out rather than pass if the first holder's
                    // locks were exclusive.
                    await lockAttributionParents(raw, { projectId: PROJECT, estimateId: ESTIMATE, costCodeId: CODE });
                    return "b";
                });
            })(),
        ]);
        assert.deepEqual(both, ["a", "b"]);
    } finally {
        await cleanup();
    }
});

// ── the lock nobody writes down: foreign keys (round 38, item 1) ────────────
//
// An INSERT or UPDATE that sets `Expense.projectId` makes Postgres take
// `FOR KEY SHARE` on the referenced `Project` row to enforce the foreign key,
// and `FOR KEY SHARE` conflicts with the `FOR UPDATE` a Project-first job
// editor holds. So a transaction can be `Estimate -> Project` without its
// source ever containing the string `"Project"` — which is how three writers
// survived round 37 untouched: the QBO create path, the QBO attribution fill,
// and the AI receipt parser. None of them runs under `withTxRetry`, so the
// 40P01 is not absorbed anywhere; it surfaces as a failed sync or a failed
// upload, and the victim Postgres picks is as likely to be the person's save.

const OTHER_PURCHASE = `${PFX}-purchase-2`;

test("CONTROL: an implicit FK write of projectId deadlocks all on its own", { skip }, async () => {
    // The pre-fix sequence with no explicit Project lock anywhere: share-lock
    // the estimate, then INSERT a row carrying `projectId`. Nothing here names
    // `"Project"`, and it is still a cycle.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockEstimateAttribution(raw, ESTIMATE);
            await tx.expense.create({
                data: {
                    id: `${PFX}-fk-control`, estimateId: ESTIMATE, projectId: PROJECT,
                    amount: 10, vendor: "FK control", status: "Pending",
                },
            });
        }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `a foreign key alone must be able to deadlock; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await writerDb!.expense.deleteMany({ where: { id: `${PFX}-fk-control` } });
        await cleanup();
    }
});

test("the QBO CREATE path, for real, against a Project-first editor", { skip }, async () => {
    // `upsertQboExpense` with no existing row: it share-locks the estimate and
    // then inserts a row carrying `projectId`. Round 37 read it as
    // estimate-only because it never mentions the Project.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let result: string | null = null;
        let writerError: unknown = null;
        try {
            result = await upsertQboExpense(writerDb as unknown as QboExpensePersistenceClient, {
                qbPurchaseId: OTHER_PURCHASE,
                qbSyncToken: "1",
                qbSyncedAt: new Date(),
                estimateId: ESTIMATE,
                projectId: PROJECT,
                amount: 125.5,
                vendor: "Summit Plumbing",
                date: new Date("2026-09-01T12:00:00Z"),
                description: "[QuickBooks import] rough-in",
                status: "Reviewed",
            });
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the sync was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the sync failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        assert.equal(result, "imported", "it waited for the editor and then did its job");

        const created = await editorDb!.expense.findUnique({
            where: { qbPurchaseId: OTHER_PURCHASE },
            select: { projectId: true, estimateId: true },
        });
        assert.deepEqual(created, { projectId: PROJECT, estimateId: ESTIMATE });
    } finally {
        await writerDb!.expense.deleteMany({ where: { qbPurchaseId: OTHER_PURCHASE } });
        await cleanup();
    }
});

test("the QBO ATTRIBUTION FILL, for real, against a Project-first editor", { skip }, async () => {
    // The other half of `upsertQboExpense`: an existing row with no job. It
    // takes the per-expense lock, share-locks the estimate, and then UPDATES
    // `projectId` — `Expense -> Estimate -> Project` before the fix.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let result: string | null = null;
        let writerError: unknown = null;
        try {
            result = await upsertQboExpense(writerDb as unknown as QboExpensePersistenceClient, {
                qbPurchaseId: PURCHASE,
                qbSyncToken: "4",
                qbSyncedAt: new Date(),
                estimateId: ESTIMATE,
                projectId: PROJECT,
                amount: 375,
                vendor: "Summit Plumbing",
                date: new Date("2026-09-01T12:00:00Z"),
                description: "[QuickBooks import] rough-in, revised",
                status: "Reviewed",
            });
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the fill was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the fill failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        assert.equal(result, "updated", "the attribution fill landed");

        const filled = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true },
        });
        assert.deepEqual(filled, { projectId: PROJECT }, "the job it had none of");
    } finally {
        await cleanup();
    }
});

test("the AI receipt parser's write, for real, against a Project-first editor", { skip }, async () => {
    // `createParsedReceiptExpense` is the parse route's transaction, split out
    // so two connections can drive it: the handler around it needs an image, an
    // Anthropic key and a session, none of which has anything to do with the
    // lock order.
    await seed();
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let created: { id: string } | null = null;
        let writerError: unknown = null;
        try {
            created = await createParsedReceiptExpense(writerDb as never, {
                projectId: PROJECT,
                estimateId: ESTIMATE,
                description: "[AI 92%] Summit Plumbing receipt — pending bookkeeper review",
                amount: 88.4,
                date: new Date("2026-09-01T12:00:00Z"),
                vendor: "Summit Plumbing",
            });
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the parser was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the parser failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        assert.ok(created?.id, "it waited for the editor and then wrote the row");
        await writerDb!.expense.deleteMany({ where: { id: created!.id } });
    } finally {
        await cleanup();
    }
});

test("the BACKFILL's project-fill pass, for real, against a Project-first editor", { skip }, async () => {
    // ROUND 38, ITEM 2. `runBackfill` is the production script, driven here
    // exactly as an operator drives it (`--apply`). Its project pass called
    // `writeUnderAttributionLocks` with no `phaseProjectId`, which did not mean
    // "no Project lock" — it meant the Project was locked implicitly, by the
    // UPDATE, after the Estimate and the Expense.
    await seed();
    // The pass fills rows that have NO job; the seeded expense has none.
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let written: { projectIds: number } | null = null;
        let writerError: unknown = null;
        try {
            const outcome = await runBackfill({
                db: writerDb as never,
                apply: true,
                log: () => {},
                overheadProjectId: `${PFX}-overhead-not-a-real-job`,
            });
            written = outcome.written;
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the backfill was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the backfill failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        assert.ok((written?.projectIds ?? 0) >= 1, "it waited for the editor and then attributed the row");

        const filled = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true },
        });
        assert.deepEqual(filled, { projectId: PROJECT });
    } finally {
        await cleanup();
    }
});

// ── EXPENSE IS LAST (round 40, item 1) ─────────────────────────────────────
//
// The other half of the order, and the half rounds 37 and 38 never checked.
// The approve and receipt routes took the per-expense lock FIRST and only then
// called `resolveExpenseProjectUnderLock`, which share-locks the ESTIMATE for a
// fallback-attributed row. That is Expense -> Estimate; booking is
// Estimate -> Expense. Neither route runs under `withTxRetry`, so the 40P01
// surfaces as a failed approval, or a failed upload with the object already
// sitting in the bucket.
//
// Both handlers are driven here as the SEQUENCE OF SHARED HELPERS they are
// made of, not through their HTTP entry points: those return 401 before
// opening a transaction unless a real NextAuth session exists, so a
// route-level call would prove nothing about locks. What ties this to the
// shipped code is tests/attribution-lock-order.test.ts, which fails if either
// route stops calling `lockAttributionParents` before `lockExpense` (both
// directions mutation-checked).

/**
 * THE OTHER SIDE: hold the Estimate EXCLUSIVELY, then reach for the same
 * per-expense lock.
 *
 * `lockExpense` is a `pg_advisory_xact_lock`, not a row lock, so the cycle
 * needs a holder that blocks a FOR SHARE on the estimate -- i.e. FOR UPDATE,
 * which is exactly what `lockMoneyParents` takes. Every writer that reaches
 * both tables TODAY takes the estimate FOR SHARE, so this inversion is a
 * LATENT hazard rather than a live outage: it costs nothing until the first
 * transaction that locks an estimate exclusively also takes a per-expense
 * lock, and then it is a 40P01 on a money path with no `withTxRetry` around
 * it. The control below proves the cycle is real; the fix removes it before
 * that writer exists.
 */
function estimateExclusiveWriter(estimateHeld: ReturnType<typeof gate>) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, ESTIMATE);
                estimateHeld.open();
                await new Promise(resolve => setTimeout(resolve, 750));
                await lockExpense(
                    tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> },
                    EXPENSE,
                );
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

test("CONTROL: taking the Expense row before the Estimate really does deadlock", { skip }, async () => {
    // The pre-fix sequence of BOTH routes, verbatim: the per-expense lock, and
    // then the resolver's share lock on the estimate.
    await seed();
    try {
        const estimateHeld = gate();
        const booker = estimateExclusiveWriter(estimateHeld);
        await estimateHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockExpense(raw, EXPENSE);
            await resolveExpenseProjectUnderLock(raw, { projectId: null, estimateId: ESTIMATE });
        }).catch(caught => { writerError = caught; });

        await booker.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(booker.error),
            `expected 40P01 from Expense -> Estimate; writer=${writerError} other=${booker.error}`,
        );
    } finally {
        await cleanup();
    }
});

test("the APPROVE sequence, parents first, against an exclusive Estimate holder", { skip }, async () => {
    await seed();
    try {
        const estimateHeld = gate();
        const booker = estimateExclusiveWriter(estimateHeld);
        await estimateHeld.reached;

        let writerError: unknown = null;
        let approved: number | null = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockAttributionParents(raw, { projectId: PROJECT, estimateId: ESTIMATE });
            await lockExpense(raw, EXPENSE);
            const locked = await resolveExpenseProjectUnderLock(raw, {
                projectId: null,
                estimateId: ESTIMATE,
            });
            if (locked !== PROJECT) { approved = 0; return; }
            const result = await tx.expense.updateMany({
                where: { id: EXPENSE, status: "Pending" },
                data: { status: "Reviewed" },
            });
            approved = result.count;
        }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

        await booker.done;

        assert.equal(deadlocked(writerError), false, `the approval was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(booker.error), false, `the other writer was killed by a deadlock: ${booker.error}`);
        assert.equal(writerError, null, `the approval failed: ${writerError}`);
        assert.equal(booker.error, null, `the other writer failed: ${booker.error}`);
        // Waiting is only the right answer if the work still happened.
        assert.equal(approved, 1, "it waited for the other writer and then stamped the row Reviewed");
    } finally {
        await cleanup();
    }
});

test("the RECEIPT sequence, parents first, against an exclusive Estimate holder", { skip }, async () => {
    await seed();
    try {
        const estimateHeld = gate();
        const booker = estimateExclusiveWriter(estimateHeld);
        await estimateHeld.reached;

        let writerError: unknown = null;
        let outcome: string | null = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockAttributionParents(raw, { projectId: PROJECT, estimateId: ESTIMATE });
            await lockExpense(raw, EXPENSE);
            const locked = await tx.expense.findUnique({
                where: { id: EXPENSE },
                select: { projectId: true, estimateId: true, receiptUrl: true },
            });
            const lockedProjectId = await resolveExpenseProjectUnderLock(raw, locked!);
            const result = await tx.expense.updateMany({
                where: { id: EXPENSE, receiptUrl: locked!.receiptUrl },
                data: { receiptUrl: `https://example.test/${PFX}.jpg` },
            });
            outcome = result.count > 0 && lockedProjectId === PROJECT ? "won" : "lost";
        }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

        await booker.done;

        assert.equal(deadlocked(writerError), false, `the upload was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(booker.error), false, `the other writer was killed by a deadlock: ${booker.error}`);
        assert.equal(writerError, null, `the upload failed: ${writerError}`);
        assert.equal(booker.error, null, `the other writer failed: ${booker.error}`);
        assert.equal(outcome, "won", "it waited and then wrote the receipt url");
    } finally {
        await cleanup();
    }
});

// ── the MIGRATION's own backfill has the same order to obey (round 41, item 1)
//
// `PROJECT_ID_BACKFILL` locks Estimate rows and then UPDATEs
// `Expense.projectId`. That UPDATE is not the estimate-only statement it looks
// like: the foreign key the same script adds makes Postgres take FOR KEY SHARE
// on every referenced Project row to enforce it, so the statement's real order
// is Estimate -> Project. A job editor holding its Project row FOR UPDATE while
// reaching for an estimate closes the cycle — and because the script runs
// everything in ONE transaction, the 40P01 victim is the whole DDL run, not one
// row.
//
// These execute the SHIPPED SQL strings, imported from the apply script (it is
// inert on import, asserted by tests/apply-scripts-inert-on-import.test.ts), so
// what is measured is what will run against production.

test("CONTROL: the backfill UPDATE alone deadlocks through its foreign key", { skip }, async () => {
    // The pre-fix shape: the locked-CTE fill with no Project lock in front of
    // it. Nothing in that SQL names "Project"; the foreign key does.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await tx.$executeRawUnsafe(PROJECT_ID_BACKFILL as string);
        }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from the FK's implicit Project lock; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanup();
    }
});

test("the shipped pair — lock the jobs, then fill — waits instead of deadlocking", { skip }, async () => {
    // Both statements, in the order the script runs them, in one transaction.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await tx.$executeRawUnsafe(PROJECT_ID_BACKFILL_LOCK_PROJECTS as string);
            await tx.$executeRawUnsafe(PROJECT_ID_BACKFILL as string);
        }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the backfill was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the backfill failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        // Waiting is only the right answer if the work still happened.
        const filled = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true },
        });
        assert.deepEqual(filled, { projectId: PROJECT }, "it waited and then attributed the row");
    } finally {
        await cleanup();
    }
});

test("the project lock covers exactly the jobs the fill will touch", { skip }, async () => {
    // A lock statement that selects nothing protects nothing. This proves the
    // predicate finds the job of an unattributed expense — and stops finding it
    // once the fill has run, which is the same idempotency the fill has.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        const before = (await writerDb!.$queryRawUnsafe(
            (PROJECT_ID_BACKFILL_LOCK_PROJECTS as string).replace(/\s+FOR SHARE$/, ""),
        )) as { id: string }[];
        assert.ok(before.some(row => row.id === PROJECT), "the job of an unattributed expense is locked");

        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(PROJECT_ID_BACKFILL_LOCK_PROJECTS as string);
            await tx.$executeRawUnsafe(PROJECT_ID_BACKFILL as string);
        });

        const after = (await writerDb!.$queryRawUnsafe(
            (PROJECT_ID_BACKFILL_LOCK_PROJECTS as string).replace(/\s+FOR SHARE$/, ""),
        )) as { id: string }[];
        assert.ok(!after.some(row => row.id === PROJECT), "and stops locking it once there is nothing to fill");
    } finally {
        await cleanup();
    }
});

after(async () => {
    await Promise.all([writerDb?.$disconnect(), editorDb?.$disconnect()]);
});

// ── an estimate may not delete spend (round 42, item 4b) ────────────────────

test("deleting an ESTIMATE leaves the expense, with a null estimateId", { skip }, async () => {
    // `Expense_estimateId_fkey` was NOT NULL + ON DELETE CASCADE, so deleting
    // an estimate DELETED every expense booked through it. Phase 3 makes that
    // worse: a re-attributed row is reported under a DIFFERENT job (its own
    // projectId) while still hanging off the estimate it left, so tidying up a
    // superseded estimate silently destroyed another job's cost — money with a
    // QuickBooks Purchase behind it.
    await seed();
    // The fixture is fallback-attributed on purpose (the QBO suggester case),
    // so pin the job first: this test is about a row that HAS one.
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: PROJECT } });
    try {
        await writerDb!.estimate.delete({ where: { id: ESTIMATE } });
        const survivor = await writerDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { estimateId: true, projectId: true, amount: true },
        });
        assert.ok(survivor, "the spend is still there");
        assert.equal(survivor!.estimateId, null, "with no estimate behind it");
        assert.equal(survivor!.projectId, PROJECT, "and still on its job");
        assert.equal(Number(survivor!.amount), 250);
    } finally {
        await cleanup();
    }
});

test("...and the FK carries SET NULL on a NULLABLE column, per the catalog", { skip }, async () => {
    // Both halves, read from the catalog rather than inferred from the DDL
    // having run: a SET NULL rule on a NOT NULL column is a constraint that can
    // only ever raise an error.
    const [fk] = (await writerDb!.$queryRawUnsafe(
        `SELECT confdeltype::text AS rule FROM pg_constraint
          WHERE conname = 'Expense_estimateId_fkey' AND conrelid = '"Expense"'::regclass`,
    )) as { rule: string }[];
    assert.equal(fk?.rule, "n", "confdeltype 'n' is SET NULL");
    const [column] = (await writerDb!.$queryRawUnsafe(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'Expense' AND column_name = 'estimateId'`,
    )) as { is_nullable: string }[];
    assert.equal(column?.is_nullable, "YES");
});

test("a fallback-attributed row whose estimate is deleted keeps NOTHING it should not", { skip }, async () => {
    // The other shape: `projectId` NULL, so the job lives on the estimate. With
    // the estimate gone the row is genuinely unattributed — which is honest and
    // reportable, and strictly better than the row being deleted outright.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        await writerDb!.estimate.delete({ where: { id: ESTIMATE } });
        const survivor = await writerDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { estimateId: true, projectId: true },
        });
        assert.deepEqual(survivor, { estimateId: null, projectId: null }, "the cost survives, unattributed");
    } finally {
        await cleanup();
    }
});

// ── re-attribution locks per TABLE, not per project (round 43, item 2) ──────
//
// `reattributeExpense` touches TWO jobs: the one the row leaves and the one it
// joins. Locking them with two calls walks Project A, Estimates A, Items A,
// Project B — the global table order broken between the calls, which is the one
// thing the helper exists to keep. A job editor holding Project B while
// reaching for an estimate of A closes the cycle.

const TARGET_PROJECT = `${PFX}-project-2`;
const TARGET_ESTIMATE = `${PFX}-estimate-2`;
const NEWER_ESTIMATE = `${PFX}-estimate-3`;
const CROSS_ITEM = `${PFX}-item-2`;

async function seedTwoJobs() {
    await seed();
    await writerDb!.project.create({
        data: { id: TARGET_PROJECT, name: "Attribution Lock Order 2", clientId: CLIENT, status: "In Progress" },
    });
    await writerDb!.estimate.create({
        data: {
            id: TARGET_ESTIMATE, title: "Attribution Lock Order 2", code: `EST-${PFX}-2`,
            projectId: TARGET_PROJECT, status: "Approved", totalAmount: 500, balanceDue: 500,
        },
    });
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: PROJECT } });
}

async function cleanupTwoJobs() {
    await writerDb!.expense.deleteMany({ where: { id: EXPENSE } });
    await writerDb!.estimate.deleteMany({ where: { id: { in: [TARGET_ESTIMATE, NEWER_ESTIMATE] } } });
    await writerDb!.project.deleteMany({ where: { id: TARGET_PROJECT } });
    await cleanup();
}

/** Holds ONE project FOR UPDATE, then reaches for the OTHER job's estimate. */
function crossJobEditor(held: ReturnType<typeof gate>, holdProject: string, wantEstimate: string) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                await tx.$executeRawUnsafe(`SELECT id FROM "Project" WHERE id = $1 FOR UPDATE`, holdProject);
                held.open();
                await new Promise(resolve => setTimeout(resolve, 750));
                await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, wantEstimate);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

test("CONTROL: locking one project at a time really does invert the order", { skip }, async () => {
    // The pre-fix sequence, verbatim: two calls, one per job. The writer ends
    // up holding the SOURCE job's estimates while still reaching for the TARGET
    // job's Project row.
    await seedTwoJobs();
    try {
        const held = gate();
        const editor = crossJobEditor(held, TARGET_PROJECT, ESTIMATE);
        await held.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            for (const projectId of [PROJECT, TARGET_PROJECT]) {
                await lockAttributionParents(raw, { projectId });
            }
        }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from per-project locking; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanupTwoJobs();
    }
});

for (const holdSource of [true, false]) {
    const label = holdSource ? "the SOURCE" : "the TARGET";
    test(`the real move waits out an editor holding ${label} job`, { skip }, async () => {
        // Both orders, through the ACTUAL helper. One pass per table means the
        // writer simply queues behind whichever Project row the editor holds.
        await seedTwoJobs();
        try {
            const held = gate();
            const editor = crossJobEditor(
                held,
                holdSource ? PROJECT : TARGET_PROJECT,
                holdSource ? TARGET_ESTIMATE : ESTIMATE,
            );
            await held.reached;

            let writerError: unknown = null;
            let outcome: unknown = null;
            await writerDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                outcome = await reattributeExpense(tx as never, {
                    expenseId: EXPENSE,
                    toProjectId: TARGET_PROJECT,
                });
            }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

            await editor.done;

            assert.equal(deadlocked(writerError), false, `the move was killed by a deadlock: ${writerError}`);
            assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
            assert.equal(writerError, null, `the move failed: ${writerError}`);
            assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
            assert.deepEqual(
                outcome,
                { moved: true, projectId: TARGET_PROJECT, estimateId: TARGET_ESTIMATE },
                "it waited and then moved BOTH halves",
            );
            const after = await editorDb!.expense.findUnique({
                where: { id: EXPENSE },
                select: { projectId: true, estimateId: true },
            });
            assert.deepEqual(after, { projectId: TARGET_PROJECT, estimateId: TARGET_ESTIMATE });
        } finally {
            await cleanupTwoJobs();
        }
    });
}

test("an estimate created between the peek and the lock is REFUSED, not moved onto", { skip }, async () => {
    // The other half of the contract. The target estimate is chosen by a
    // lock-free peek so the acquisition can be one ordered pass; a newer
    // estimate landing after that peek is a row the lock set never covered, so
    // moving onto it would derive an attribution from something nothing holds.
    await seedTwoJobs();
    try {
        let peeks = 0;
        const outcome = await writerDb!.$transaction(async tx => {
            const real = tx as unknown as Record<string, unknown>;
            const client = new Proxy(real, {
                get(target, prop: string) {
                    if (prop !== "estimate") return target[prop];
                    const estimate = target.estimate as {
                        findFirst(args: unknown): Promise<{ id: string } | null>;
                    };
                    return {
                        findFirst: async (args: unknown) => {
                            const answer = await estimate.findFirst(args);
                            // AFTER the peek, before the locked re-read: a
                            // second connection commits a NEWER estimate on the
                            // target job.
                            if (++peeks === 1) {
                                await editorDb!.estimate.create({
                                    data: {
                                        id: NEWER_ESTIMATE, title: "Newer", code: `EST-${PFX}-3`,
                                        projectId: TARGET_PROJECT, status: "Approved",
                                        totalAmount: 900, balanceDue: 900,
                                    },
                                });
                            }
                            return answer;
                        },
                    };
                },
            });
            return reattributeExpense(client as never, { expenseId: EXPENSE, toProjectId: TARGET_PROJECT });
        }, { timeout: 30_000 });

        assert.equal(peeks, 2, "the peek and the locked re-read both ran");
        assert.deepEqual(outcome, { moved: false, reason: "target-moved" });
        const untouched = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true, estimateId: true },
        });
        assert.deepEqual(untouched, { projectId: PROJECT, estimateId: ESTIMATE }, "nothing moved");
    } finally {
        await cleanupTwoJobs();
    }
});

// ── the WHOLE production sequence, against a live writer (round 44, item 1) ─
//
// The tests above run the two backfill statements. They cannot see the lock the
// migration actually holds: the first `ALTER TABLE "Expense"` takes ACCESS
// EXCLUSIVE on the table and keeps it until COMMIT, so running the backfill in
// that same transaction means holding the Expense TABLE while reaching for
// Project and Estimate ROW locks. A concurrent estimate move — holding its
// Estimate row and needing to read Expense — is the other half of a cycle.
//
// These execute the SHIPPED statement lists, imported from the apply script
// (inert on import, asserted by tests/apply-scripts-inert-on-import.test.ts),
// so what is measured is the sequence that will run against production.

/** A bookkeeper's estimate move: hold the Estimate row, then read Expense. */
function estimateMover(held: ReturnType<typeof gate>) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, ESTIMATE);
                held.open();
                await new Promise(resolve => setTimeout(resolve, 900));
                // Reading Expense needs the table, which phase A holds while it
                // is inside the same transaction as the backfill.
                await tx.$executeRawUnsafe(`SELECT count(*)::int FROM "Expense" WHERE "estimateId" = $1`, ESTIMATE);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

test("CONTROL: the whole sequence in ONE transaction deadlocks a live estimate move", { skip }, async () => {
    // The pre-fix shape: DDL first, backfill after, all in one transaction.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        const held = gate();
        const mover = estimateMover(held);
        await held.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
            for (const sql of [...(DDL_STATEMENTS as string[]), ...backfillStatements("UTC")]) {
                await tx.$executeRawUnsafe(sql);
            }
        }, { timeout: 60_000 }).catch(caught => { writerError = caught; });

        await mover.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(mover.error),
            `expected 40P01 from holding the Expense table across the backfill; migration=${writerError} mover=${mover.error}`,
        );
    } finally {
        await cleanup();
    }
});

test("the SHIPPED two-phase sequence waits instead, and lands the right state", { skip }, async () => {
    // Phase A commits — releasing the Expense table — before phase B asks for
    // its first Project row. The mover finishes; the migration then proceeds.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        const held = gate();
        const mover = estimateMover(held);
        await held.reached;

        let writerError: unknown = null;
        try {
            await writerDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                for (const sql of DDL_STATEMENTS as string[]) await tx.$executeRawUnsafe(sql);
            }, { timeout: 60_000 });
            await writerDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                for (const sql of backfillStatements("UTC")) await tx.$executeRawUnsafe(sql);
            }, { timeout: 60_000 });
        } catch (caught) {
            writerError = caught;
        }

        await mover.done;

        assert.equal(deadlocked(writerError), false, `the migration was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(mover.error), false, `the estimate move was killed by a deadlock: ${mover.error}`);
        assert.equal(writerError, null, `the migration failed: ${writerError}`);
        assert.equal(mover.error, null, `the estimate move failed: ${mover.error}`);

        // Waiting is only the right answer if the work still happened: the
        // fallback-attributed row is attributed, which is what phase B is for.
        const filled = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true },
        });
        assert.deepEqual(filled, { projectId: PROJECT }, "phase B ran and attributed the row");
    } finally {
        await cleanup();
    }
});

test("a crash between the phases is safe to re-run", { skip }, async () => {
    // Atomicity is re-argued through idempotency, so this is the claim that
    // replaces "all or nothing": run phase A, stop, then run BOTH phases again
    // from the top and land in the same state with no error.
    await seed();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        await writerDb!.$transaction(async tx => {
            for (const sql of DDL_STATEMENTS as string[]) await tx.$executeRawUnsafe(sql);
        }, { timeout: 60_000 });

        // ...the "crash" is simply not running phase B. Now re-run everything.
        await writerDb!.$transaction(async tx => {
            for (const sql of DDL_STATEMENTS as string[]) await tx.$executeRawUnsafe(sql);
        }, { timeout: 60_000 });
        await writerDb!.$transaction(async tx => {
            for (const sql of backfillStatements("UTC")) await tx.$executeRawUnsafe(sql);
        }, { timeout: 60_000 });

        const filled = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true },
        });
        assert.deepEqual(filled, { projectId: PROJECT }, "the end state is the same either way");
    } finally {
        await cleanup();
    }
});

test("the SOURCE estimate moving between the peek and the lock is REFUSED", { skip }, async () => {
    // ROUND 44, ITEM 2. Only the target used to be re-checked, and the source
    // peek is the one that decides WHO IS ALLOWED to do this. For a
    // fallback-attributed row the job comes from the estimate, so when that
    // estimate moves from job A to job C in the gap, the expense's own two
    // columns do not change at all: the CAS still matches, and a caller
    // authorized against A moves an expense that now belongs to C. The row
    // never looked wrong; the authority did.
    await seedTwoJobs();
    // FALLBACK-ATTRIBUTED: the job lives on the estimate, which is the only
    // shape in which the source can move invisibly.
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        let peeks = 0;
        const outcome = await writerDb!.$transaction(async tx => {
            const real = tx as unknown as Record<string, unknown>;
            const client = new Proxy(real, {
                get(target, prop: string) {
                    if (prop !== "$queryRawUnsafe") return target[prop];
                    const raw = target.$queryRawUnsafe as (q: string, ...v: unknown[]) => Promise<unknown>;
                    return async (query: string, ...values: unknown[]) => {
                        const answer = await raw.call(target, query, ...values);
                        // The SOURCE peek is the first unlocked read of the
                        // estimate's project. Right after it, a second
                        // connection moves that estimate to the target job.
                        if (/SELECT "projectId" FROM "Estimate"/.test(query) && ++peeks === 1) {
                            await editorDb!.estimate.update({
                                where: { id: ESTIMATE },
                                data: { projectId: TARGET_PROJECT },
                            });
                        }
                        return answer;
                    };
                },
            });
            return reattributeExpense(client as never, { expenseId: EXPENSE, toProjectId: TARGET_PROJECT });
        }, { timeout: 30_000 });

        assert.deepEqual(outcome, { moved: false, reason: "source-moved" });
        const untouched = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true, estimateId: true },
        });
        assert.deepEqual(
            untouched,
            { projectId: null, estimateId: ESTIMATE },
            "nothing moved under a stale authority",
        );
    } finally {
        await editorDb!.estimate.updateMany({ where: { id: ESTIMATE }, data: { projectId: PROJECT } });
        await cleanupTwoJobs();
    }
});

test("...and a source that stays put still moves", { skip }, async () => {
    // The control: the source re-read must not refuse the ordinary case.
    await seedTwoJobs();
    await writerDb!.expense.updateMany({ where: { id: EXPENSE }, data: { projectId: null } });
    try {
        const outcome = await writerDb!.$transaction(
            async tx => reattributeExpense(tx as never, { expenseId: EXPENSE, toProjectId: TARGET_PROJECT }),
            { timeout: 30_000 },
        );
        assert.deepEqual(outcome, { moved: true, projectId: TARGET_PROJECT, estimateId: TARGET_ESTIMATE });
    } finally {
        await cleanupTwoJobs();
    }
});

// ── PHASE A ITSELF CAN DEADLOCK PRODUCTION (Codex round 15, item 1) ─────────
//
// The tests above prove the two-phase SPLIT (round 44) is not enough on its
// own. `ALTER TABLE "Expense" ADD CONSTRAINT ... REFERENCES "Project"` takes
// SHARE ROW EXCLUSIVE on the REFERENCED table too -- Postgres needs it to
// install the FK's enforcement trigger, and it takes it even for a `NOT
// VALID` constraint. Bundled into ONE phase-A transaction (round 44's shape),
// that statement runs while the SAME transaction still holds ACCESS
// EXCLUSIVE on Expense from the very first `ALTER TABLE` -- so a writer that
// takes an actual write lock on Project (an `UPDATE`/`DELETE`, not merely a
// `SELECT ... FOR UPDATE` row lock -- a plain row lock's table-level ROW
// SHARE intent does not conflict with SHARE ROW EXCLUSIVE, which is why the
// existing `projectFirstEditor` control above cannot reproduce THIS defect)
// and then reads Expense is the other half of a cycle.
//
// A real Prisma `.update()`/`.delete()` on Project or Estimate is exactly
// this: `reattributeExpense`'s target-estimate write, an ordinary project
// edit, or the Project cascade-delete path all take ROW EXCLUSIVE at the
// table level, not merely ROW SHARE.
//
// PHASE_A_STEPS is executed exactly as main() executes it -- imported as
// data, not reconstructed -- so what these tests measure is the sequence that
// will actually run against production.
function projectRowUpdater(held: ReturnType<typeof gate>) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                // A REAL write -- ROW EXCLUSIVE at the table level -- not the
                // FOR UPDATE row lock every other control in this file uses.
                await tx.$executeRawUnsafe(`UPDATE "Project" SET name = name WHERE id = $1`, PROJECT);
                held.open();
                await new Promise(resolve => setTimeout(resolve, 900));
                // Reading Expense needs the table, which a monolithic phase A
                // holds ACCESS EXCLUSIVE on for the whole transaction.
                await tx.$executeRawUnsafe(`SELECT count(*)::int FROM "Expense" WHERE "projectId" = $1`, PROJECT);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

function estimateRowUpdater(held: ReturnType<typeof gate>) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                await tx.$executeRawUnsafe(`UPDATE "Estimate" SET title = title WHERE id = $1`, ESTIMATE);
                held.open();
                await new Promise(resolve => setTimeout(resolve, 900));
                await tx.$executeRawUnsafe(`SELECT count(*)::int FROM "Expense" WHERE "estimateId" = $1`, ESTIMATE);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

test("CONTROL: bundling PHASE_A_STEPS into ONE transaction deadlocks a Project writer", { skip }, async () => {
    // The pre-round-15 shape: every phase-A statement -- including the
    // Project FK's explicit LOCK TABLE and its NOT VALID add -- run together
    // in one transaction, exactly as round 44 shipped it. NOT VALID and the
    // explicit lock alone do not fix anything if they are not ALSO split into
    // their own transaction.
    await seed();
    try {
        const held = gate();
        const editor = projectRowUpdater(held);
        await held.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
            for (const step of PHASE_A_STEPS as { statements: string[] }[]) {
                for (const sql of step.statements) await tx.$executeRawUnsafe(sql);
            }
        }, { timeout: 60_000 }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from holding Expense across the Project FK step; migration=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanup();
    }
});

test("the SHIPPED per-step transactions wait instead, against a Project writer", { skip }, async () => {
    // Each PHASE_A_STEPS entry commits (or, for the concurrent index step,
    // completes) before the next one starts -- exactly what main() does. By
    // the time the project-FK step asks for Project, the columns/normalize/
    // checks/indexes/triggers/receiptIntake steps have already committed and
    // released Expense, so there is nothing left for a cycle to close over.
    await seed();
    try {
        const held = gate();
        const editor = projectRowUpdater(held);
        await held.reached;

        let writerError: unknown = null;
        try {
            for (const step of PHASE_A_STEPS as { statements: string[]; concurrent?: boolean }[]) {
                if (!step.statements.length) continue;
                if (step.concurrent) {
                    for (const sql of step.statements) {
                        await writerDb!.$executeRawUnsafe(toConcurrentIndexSql(sql));
                    }
                } else {
                    await writerDb!.$transaction(async tx => {
                        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                        for (const sql of step.statements) await tx.$executeRawUnsafe(sql);
                    }, { timeout: 60_000 });
                }
            }
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `phase A was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the project writer was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `phase A failed: ${writerError}`);
        assert.equal(editor.error, null, `the project writer failed: ${editor.error}`);

        // Correct end state, not just "no error": the FK exists and is VALID
        // (VALIDATE CONSTRAINT ran, in its own later step).
        const [row] = await editorDb!.$queryRawUnsafe<{ def: string }[]>(
            `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'Expense_projectId_fkey' AND conrelid = '"Expense"'::regclass`,
        );
        assert.match(row.def, /FOREIGN KEY \("projectId"\)/);
        assert.match(row.def, /ON DELETE SET NULL/);
        assert.ok(!/NOT VALID/.test(row.def), "the FK must be VALID after its own validate step ran");
    } finally {
        await cleanup();
    }
});

test("CONTROL: bundling PHASE_A_STEPS into ONE transaction deadlocks an Estimate writer", { skip }, async () => {
    await seed();
    try {
        const held = gate();
        const editor = estimateRowUpdater(held);
        await held.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
            for (const step of PHASE_A_STEPS as { statements: string[] }[]) {
                for (const sql of step.statements) await tx.$executeRawUnsafe(sql);
            }
        }, { timeout: 60_000 }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from holding Expense across the Estimate FK step; migration=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanup();
    }
});

test("the SHIPPED per-step transactions wait instead, against an Estimate writer", { skip }, async () => {
    await seed();
    try {
        const held = gate();
        const editor = estimateRowUpdater(held);
        await held.reached;

        let writerError: unknown = null;
        try {
            for (const step of PHASE_A_STEPS as { statements: string[]; concurrent?: boolean }[]) {
                if (!step.statements.length) continue;
                if (step.concurrent) {
                    for (const sql of step.statements) {
                        await writerDb!.$executeRawUnsafe(toConcurrentIndexSql(sql));
                    }
                } else {
                    await writerDb!.$transaction(async tx => {
                        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '20s'`);
                        for (const sql of step.statements) await tx.$executeRawUnsafe(sql);
                    }, { timeout: 60_000 });
                }
            }
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `phase A was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the estimate writer was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `phase A failed: ${writerError}`);
        assert.equal(editor.error, null, `the estimate writer failed: ${editor.error}`);

        const [row] = await editorDb!.$queryRawUnsafe<{ def: string }[]>(
            `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'Expense_estimateId_fkey' AND conrelid = '"Expense"'::regclass`,
        );
        assert.match(row.def, /FOREIGN KEY \("estimateId"\)/);
        assert.match(row.def, /ON DELETE SET NULL/);
        assert.ok(!/NOT VALID/.test(row.def), "the FK must be VALID after its own validate step ran");
    } finally {
        await cleanup();
    }
});

// ── THE SPLIT-JOB REPAIR HAD THE SAME DEFECT (Codex round 15, item 2) ───────
//
// SPLIT_JOB_REPAIR locks Estimate rows and then UPDATEs Expense.projectId --
// which takes FOR KEY SHARE on every referenced Project through the FK this
// script adds, so on its own it is Estimate -> Project. SPLIT_JOB_REPAIR_LOCK_PROJECTS
// closes it exactly like PROJECT_ID_BACKFILL_LOCK_PROJECTS does for the
// ordinary backfill.
test("CONTROL: the split-job repair without its project lock deadlocks a Project-first editor", { skip }, async () => {
    await seedTwoJobs();
    // Give the expense a split pair so SPLIT_JOB_REPAIR has a candidate row:
    // qbPurchaseId set, projectId disagreeing with its estimate's (est.
    // projectId is PROJECT; the row currently claims TARGET_PROJECT, which
    // seedTwoJobs already created). The repair re-derives PROJECT from the
    // estimate, so PROJECT is the job SPLIT_JOB_REPAIR_LOCK_PROJECTS locks.
    await writerDb!.expense.update({
        where: { id: EXPENSE },
        data: { projectId: TARGET_PROJECT, qbPurchaseId: PURCHASE },
    });
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            // The pre-fix shape: the repair alone, no preceding project lock.
            await tx.$executeRawUnsafe(SPLIT_JOB_REPAIR);
        }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from the repair's implicit FOR KEY SHARE; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanupTwoJobs();
    }
});

test("the SHIPPED repair locks its projects first, and waits instead", { skip }, async () => {
    await seedTwoJobs();
    await writerDb!.expense.update({
        where: { id: EXPENSE },
        data: { projectId: TARGET_PROJECT, qbPurchaseId: PURCHASE },
    });
    try {
        const projectHeld = gate();
        const editor = projectFirstEditor(projectHeld);
        await projectHeld.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await tx.$executeRawUnsafe(SPLIT_JOB_REPAIR_LOCK_PROJECTS);
            await tx.$executeRawUnsafe(SPLIT_JOB_REPAIR);
        }, { timeout: 30_000 }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the repair was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the repair failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);

        const repaired = await editorDb!.expense.findUnique({ where: { id: EXPENSE }, select: { projectId: true } });
        assert.deepEqual(repaired, { projectId: PROJECT }, "the repair actually ran and re-derived the project");
    } finally {
        await cleanupTwoJobs();
    }
});

// ── THE ROLLOUT PAIR GUARD CAN PERSIST A SPLIT ATTRIBUTION (round 15, item 3) ─
//
// The compatibility trigger's estimate lookup used to be a plain MVCC SELECT:
// it can read the previous committed Estimate.projectId, stamp it onto the
// row, and let the estimate move commit right after -- landing a split
// attribution the guard exists to prevent. `FOR KEY SHARE` makes the trigger
// block behind an in-flight estimate move that holds FOR UPDATE / NO KEY
// UPDATE on the same estimate row.
// The pre-round-15 trigger body, verbatim except for the plain (unlocked)
// SELECT -- used only as the CONTROL below, to prove the race is real before
// measuring the fix against it.
const UNLOCKED_PAIR_GUARD_SQL = [
    `CREATE OR REPLACE FUNCTION probuild_expense_estimate_pair_guard()
     RETURNS trigger
     LANGUAGE plpgsql
     AS $guard$
     DECLARE
         est_project TEXT;
     BEGIN
         IF NEW."estimateId" IS DISTINCT FROM OLD."estimateId"
            AND NEW."projectId" IS NOT DISTINCT FROM OLD."projectId"
            AND OLD."projectId" IS NOT NULL
            AND NEW."estimateId" IS NOT NULL
         THEN
             SELECT est."projectId" INTO est_project
               FROM "Estimate" est
              WHERE est.id = NEW."estimateId";
             IF est_project IS NOT NULL THEN
                 NEW."projectId" := est_project;
             END IF;
         END IF;
         RETURN NEW;
     END;
     $guard$`,
    `DROP TRIGGER IF EXISTS probuild_expense_estimate_pair_guard ON "Expense"`,
    `CREATE TRIGGER probuild_expense_estimate_pair_guard
     BEFORE UPDATE OF "estimateId" ON "Expense"
     FOR EACH ROW
     EXECUTE FUNCTION probuild_expense_estimate_pair_guard()`,
];

/**
 * Both the CONTROL and the fix test share this choreography: job B's
 * estimate (`TARGET_ESTIMATE`) is mid-move to a THIRD project while an
 * old-build-shaped write re-points `EXPENSE` at that same estimate without
 * touching `projectId`. The third project makes a stale read observable --
 * PROJECT (pre-test), TARGET_PROJECT (pre-move) and the third project
 * (post-move) are all different values, so whichever one lands says exactly
 * which snapshot the guard's SELECT used.
 */
async function raceEstimateMoveAgainstPairGuard() {
    const THIRD_PROJECT = `${PFX}-project-3`;
    await writerDb!.project.create({
        data: { id: THIRD_PROJECT, name: "Attribution Lock Order 3", clientId: CLIENT, status: "In Progress" },
    });
    try {
        const held = gate();
        // The mover: holds the estimate FOR UPDATE (as a real estimate move
        // would, e.g. reattributeExpense), then commits its project change
        // slowly, so the guard's SELECT has time to arrive while it is still
        // in flight.
        let moverError: unknown = null;
        const moverDone = (async () => {
            try {
                await editorDb!.$transaction(async tx => {
                    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                    await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, TARGET_ESTIMATE);
                    held.open();
                    await new Promise(resolve => setTimeout(resolve, 700));
                    await tx.$executeRawUnsafe(
                        `UPDATE "Estimate" SET "projectId" = $1 WHERE id = $2`,
                        THIRD_PROJECT, TARGET_ESTIMATE,
                    );
                });
            } catch (caught) {
                moverError = caught;
            }
        })();
        await held.reached;

        // The old-build write: moves estimateId while leaving projectId
        // untouched (still PROJECT) -- exactly what fires the guard.
        let guardError: unknown = null;
        try {
            await writerDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                await tx.$executeRawUnsafe(
                    `UPDATE "Expense" SET "estimateId" = $1 WHERE id = $2`,
                    TARGET_ESTIMATE, EXPENSE,
                );
            }, { timeout: 30_000 });
        } catch (caught) {
            guardError = caught;
        }

        await moverDone;
        assert.equal(guardError, null, `the guard write failed: ${guardError}`);
        assert.equal(moverError, null, `the estimate move failed: ${moverError}`);

        const row = await editorDb!.expense.findUnique({
            where: { id: EXPENSE },
            select: { projectId: true, estimateId: true },
        });
        return { row, THIRD_PROJECT };
    } finally {
        await writerDb!.project.deleteMany({ where: { id: THIRD_PROJECT } });
    }
}

test("CONTROL: an unlocked pair-guard read lands a split attribution", { skip }, async () => {
    await seedTwoJobs();
    try {
        for (const sql of UNLOCKED_PAIR_GUARD_SQL) await writerDb!.$executeRawUnsafe(sql);
        const { row, THIRD_PROJECT } = await raceEstimateMoveAgainstPairGuard();

        assert.equal(row?.estimateId, TARGET_ESTIMATE);
        // The bug: the guard's unlocked SELECT read the PRE-move project
        // (TARGET_PROJECT) because it never waited for the mover to commit,
        // so the expense now claims a job (TARGET_PROJECT) that the estimate
        // it points at has already LEFT (the estimate itself ends up on
        // THIRD_PROJECT) -- a split pair, exactly what MISMATCHED_PAIRS_QUERY
        // exists to catch.
        assert.equal(row?.projectId, TARGET_PROJECT, "the unlocked guard read the STALE pre-move project");
        assert.notEqual(row?.projectId, THIRD_PROJECT, "and disagrees with where the estimate actually ended up");
    } finally {
        for (const sql of SPLIT_JOB_GUARD_DROP_SQL) await writerDb!.$executeRawUnsafe(sql);
        await cleanupTwoJobs();
    }
});

test("the SHIPPED pair guard's estimate read blocks behind an in-flight estimate move", { skip }, async () => {
    await seedTwoJobs();
    try {
        // Install the guard trigger (it is dropped again by --post-deploy;
        // here we only need it standing to exercise its SELECT).
        for (const sql of SPLIT_JOB_GUARD_SQL) await writerDb!.$executeRawUnsafe(sql);
        const { row, THIRD_PROJECT } = await raceEstimateMoveAgainstPairGuard();

        assert.equal(row?.estimateId, TARGET_ESTIMATE);
        // The fix: FOR KEY SHARE blocked the guard's SELECT behind the
        // mover's FOR UPDATE, so it only ran AFTER the move committed and
        // read the estimate's FINAL project -- the pair stays consistent.
        assert.equal(row?.projectId, THIRD_PROJECT, "the guard read the estimate's project AFTER the move committed, not before");
    } finally {
        for (const sql of SPLIT_JOB_GUARD_DROP_SQL) await writerDb!.$executeRawUnsafe(sql);
        await cleanupTwoJobs();
    }
});

/**
 * THE BACKFILL'S OWN CROSS-JOB HOLE (Codex round 46, item 2).
 *
 * `writeUnderAttributionLocks` was fixed in round 36 by hoisting the
 * job-scoped scan to the FRONT, and that fixed the tables it covers. It left a
 * hole exactly the width of the rows it does NOT cover: the planner names
 * estimates and items belonging to another job (or to none), which the
 * project-scoped scan never sees, and those were locked in two further calls
 * AFTERWARDS. So the sequence was
 *
 *     Items(job A) ... then Estimate(job B)
 *
 * — EstimateItem before Estimate, the declared order inverted, one job over
 * from where the round-36 test was looking. The other side of the cycle is
 * ordinary: anything holding job B's estimate and reaching for a line item.
 */
function itemEditor(held: ReturnType<typeof gate>, holdEstimate: string, wantItem: string) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, holdEstimate);
                held.open();
                await new Promise(resolve => setTimeout(resolve, 750));
                await tx.$executeRawUnsafe(`SELECT id FROM "EstimateItem" WHERE id = $1 FOR UPDATE`, wantItem);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

async function seedCrossJobItem() {
    await seedTwoJobs();
    await writerDb!.estimateItem.create({
        data: { id: CROSS_ITEM, estimateId: TARGET_ESTIMATE, name: "other job rough-in", costCodeId: CODE },
    });
}

async function cleanupCrossJobItem() {
    await writerDb!.estimateItem.deleteMany({ where: { id: CROSS_ITEM } });
    await cleanupTwoJobs();
}

test("CONTROL: the backfill's post-scan Estimate lock really does invert the order", { skip }, async () => {
    // The pre-fix sequence, verbatim: the job-scoped scan, then the named
    // estimates, then the named items. The writer ends up holding job A's LINE
    // ITEMS while still reaching for job B's ESTIMATE.
    await seedCrossJobItem();
    try {
        const held = gate();
        const editor = itemEditor(held, TARGET_ESTIMATE, ITEM);
        await held.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            await lockAttributionParents(raw, { projectId: PROJECT });
            await raw.$queryRawUnsafe(
                `SELECT id FROM "Estimate" WHERE id IN ($1) ORDER BY id FOR SHARE`, TARGET_ESTIMATE,
            );
            await raw.$queryRawUnsafe(
                `SELECT id FROM "EstimateItem" WHERE id IN ($1) ORDER BY id FOR SHARE`, CROSS_ITEM,
            );
        }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from the post-scan estimate lock; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanupCrossJobItem();
    }
});

test("the backfill takes the WHOLE union in one call, and simply waits", { skip }, async () => {
    // The fix, through the real function rather than a reconstruction of it:
    // one `lockAttributionParents` call carrying the project, the cross-job
    // estimate and the cross-job item, so every Estimate is reached before
    // every EstimateItem. The writer blocks on the editor's estimate holding
    // no items at all, the editor finishes, and the write still happens.
    await seedCrossJobItem();
    try {
        const held = gate();
        const editor = itemEditor(held, TARGET_ESTIMATE, ITEM);
        await held.reached;

        let writerError: unknown = null;
        let wrote: unknown = null;
        await writeUnderAttributionLocks(
            writerDb,
            {
                expenseId: EXPENSE,
                phaseProjectId: PROJECT,
                estimateIds: [TARGET_ESTIMATE],
                estimateItemIds: [CROSS_ITEM],
                costCodeId: CODE,
            },
            async () => { wrote = "written"; return wrote; },
        ).catch((caught: unknown) => { writerError = caught; });

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the backfill was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the backfill failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        // Waiting is only the right answer if the work still happened.
        assert.equal(wrote, "written", "the guarded write still ran");
    } finally {
        await cleanupCrossJobItem();
    }
});

/**
 * A BATCH INTERLEAVES ITS PARENT AND EXPENSE LOCKS (Codex round 46, item 3).
 *
 * `deleteExpenses` and `tagExpensesToChangeOrderCore` walk their batch one row
 * at a time: re-resolve row 1's job from its share-locked estimate, write row
 * 1 — which takes that Expense exclusively and, through the foreign keys, a
 * KEY SHARE on its Project and Estimate — and only THEN reach for row 2's
 * estimate. That is Expense -> Estimate inside one transaction, the declared
 * order backwards, and it needs no exotic other side: anything holding an
 * estimate while touching one of the batch's expenses closes the cycle.
 *
 * The second hazard is Expense against Expense, with no parent involved at
 * all: two people acting on overlapping selections take the same rows
 * exclusively, and an UNORDERED `findMany` lets the server hand them back in
 * different orders. That half is pinned in tests/expense-delete-scope.test.ts,
 * which can see the `orderBy` the shipped query carries; here the CONTROL
 * shows what it buys — two transactions taking the same two expense rows in
 * opposite orders really do deadlock.
 */
const BATCH_ESTIMATE = `${PFX}-estimate-batch`;
const BATCH_A = `${PFX}-expense-a`;
const BATCH_B = `${PFX}-expense-b`;
const BATCH_CO = `${PFX}-changeorder`;

async function seedBatch() {
    await seed();
    // A SECOND estimate on the SAME job: the batch's rows have to resolve to
    // the change order's project, so the two parents that get interleaved are
    // two estimates rather than two jobs.
    await writerDb!.estimate.create({
        data: {
            id: BATCH_ESTIMATE, title: "Batch", code: `EST-${PFX}-batch`, projectId: PROJECT,
            status: "Approved", totalAmount: 400, balanceDue: 400,
        },
    });
    await writerDb!.changeOrder.create({
        data: {
            id: BATCH_CO, projectId: PROJECT, estimateId: ESTIMATE, code: `CO-${PFX}`,
            title: "Batch CO", status: "Approved", pricingType: "COST_PLUS", markupPercent: 10,
        },
    });
    // FALLBACK-ATTRIBUTED, both of them: `projectId` NULL, so each row's job is
    // re-read from its OWN estimate under lock. A pinned projectId would skip
    // that read entirely and the interleaving would not exist to measure.
    for (const [id, estimateId] of [[BATCH_A, ESTIMATE], [BATCH_B, BATCH_ESTIMATE]] as const) {
        await writerDb!.expense.create({
            data: { id, estimateId, projectId: null, amount: 100, status: "Pending", vendor: "Batch" },
        });
    }
}

async function cleanupBatch() {
    await writerDb!.expense.deleteMany({ where: { id: { in: [BATCH_A, BATCH_B] } } });
    await writerDb!.changeOrder.deleteMany({ where: { id: BATCH_CO } });
    await writerDb!.estimate.deleteMany({ where: { id: BATCH_ESTIMATE } });
    await cleanup();
}

/** Holds the SECOND row's estimate, then reaches for the FIRST row's expense. */
function estimateThenExpenseEditor(held: ReturnType<typeof gate>, holdEstimate: string, wantExpense: string) {
    let error: unknown = null;
    const done = (async () => {
        try {
            await editorDb!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                await tx.$executeRawUnsafe(`SELECT id FROM "Estimate" WHERE id = $1 FOR UPDATE`, holdEstimate);
                held.open();
                await new Promise(resolve => setTimeout(resolve, 750));
                await tx.$executeRawUnsafe(`SELECT id FROM "Expense" WHERE id = $1 FOR UPDATE`, wantExpense);
            });
        } catch (caught) {
            error = caught;
        }
    })();
    return { done, get error() { return error; } };
}

test("CONTROL: a row-at-a-time batch deadlocks against an estimate holder", { skip }, async () => {
    // The pre-fix sequence, verbatim: resolve row A's parent, write row A,
    // then resolve row B's parent.
    await seedBatch();
    try {
        const held = gate();
        const editor = estimateThenExpenseEditor(held, BATCH_ESTIMATE, BATCH_A);
        await held.reached;

        let writerError: unknown = null;
        await writerDb!.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            await raw.$queryRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
            for (const [id, estimateId] of [[BATCH_A, ESTIMATE], [BATCH_B, BATCH_ESTIMATE]] as const) {
                await resolveExpenseProjectUnderLock(raw, { projectId: null, estimateId });
                await tx.expense.updateMany({ where: { id }, data: { changeOrderId: BATCH_CO } });
            }
        }).catch(caught => { writerError = caught; });

        await editor.done;

        assert.ok(
            deadlocked(writerError) || deadlocked(editor.error),
            `expected 40P01 from the interleaved batch; writer=${writerError} editor=${editor.error}`,
        );
    } finally {
        await cleanupBatch();
    }
});

test("the SHIPPED tag-to-change-order takes every parent first, and waits", { skip }, async () => {
    // The real function this time, not a reconstruction: it locks the job and
    // both estimates in one call before it touches an Expense, so it blocks on
    // the editor's estimate holding nothing, the editor commits, and the batch
    // then does its work.
    await seedBatch();
    try {
        const held = gate();
        const editor = estimateThenExpenseEditor(held, BATCH_ESTIMATE, BATCH_A);
        await held.reached;

        // The singleton builds its client on FIRST USE and insists on the
        // pooler flag, so the URL is set before the module is loaded.
        process.env.DATABASE_URL = url!.includes("?") ? `${url}&pgbouncer=true` : `${url}?pgbouncer=true`;
        const { tagExpensesToChangeOrderCore } = await import("../src/lib/time-expense-core");

        let writerError: unknown = null;
        let updated = 0;
        try {
            ({ updated } = await tagExpensesToChangeOrderCore(
                { ids: [BATCH_B, BATCH_A], changeOrderId: BATCH_CO },
                "batch-test",
            ));
        } catch (caught) {
            writerError = caught;
        }

        await editor.done;

        assert.equal(deadlocked(writerError), false, `the batch was killed by a deadlock: ${writerError}`);
        assert.equal(deadlocked(editor.error), false, `the editor was killed by a deadlock: ${editor.error}`);
        assert.equal(writerError, null, `the batch failed: ${writerError}`);
        assert.equal(editor.error, null, `the editor failed: ${editor.error}`);
        // Waiting is only the right answer if the work still happened — and it
        // happened for BOTH rows, in ascending id order, whatever order the
        // caller listed them in.
        assert.equal(updated, 2, "both rows were tagged");
        const rows = await writerDb!.expense.findMany({
            where: { id: { in: [BATCH_A, BATCH_B] } },
            select: { id: true, changeOrderId: true },
            orderBy: { id: "asc" },
        });
        assert.deepEqual(rows.map(row => row.changeOrderId), [BATCH_CO, BATCH_CO]);
    } finally {
        await cleanupBatch();
    }
});

test("CONTROL: two batches taking the same rows in opposite orders deadlock", { skip }, async () => {
    // Why the shipped query carries `orderBy: { id: "asc" }`. No parent table
    // is involved here at all — this is Expense against Expense, and the only
    // thing that prevents it is both batches walking the rows the same way.
    await seedBatch();
    try {
        const first = gate();
        const second = gate();
        const walk = async (db: typeof writerDb, order: readonly string[], reached: ReturnType<typeof gate>, other: Promise<void>) => {
            try {
                await db!.$transaction(async tx => {
                    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '15s'`);
                    await tx.$executeRawUnsafe(`SELECT id FROM "Expense" WHERE id = $1 FOR UPDATE`, order[0]);
                    reached.open();
                    await other;
                    await new Promise(resolve => setTimeout(resolve, 250));
                    await tx.$executeRawUnsafe(`SELECT id FROM "Expense" WHERE id = $1 FOR UPDATE`, order[1]);
                });
                return null;
            } catch (caught) {
                return caught;
            }
        };
        const ascending = walk(writerDb, [BATCH_A, BATCH_B], first, second.reached);
        const descending = walk(editorDb, [BATCH_B, BATCH_A], second, first.reached);
        const [ascError, descError] = await Promise.all([ascending, descending]);

        assert.ok(
            deadlocked(ascError) || deadlocked(descError),
            `expected 40P01 from opposite row orders; asc=${ascError} desc=${descError}`,
        );
    } finally {
        await cleanupBatch();
    }
});

/**
 * THE LOCKED RE-READ MUST NOT FORGET WHO OWNS THE ITEM (round 48, item 4).
 *
 * `readItem` used to return an EMPTY map when the linked item had no cost
 * code, or a retired one. `planBackfill` cannot tell that apart from "there is
 * no such item", so the cross-job check it does FIRST never ran, and the row
 * fell through to vendor-regex inference — the locked re-plan reintroducing,
 * one transaction later, exactly the bug round 44 fixed in the snapshot.
 *
 * The interleaving that makes it bite: the item is on this job when the plan
 * is made, and its estimate moves to another job before the write.
 */
const CODELESS_ITEM = `${PFX}-item-codeless`;
/** A SECOND estimate of job A carrying the same code, so the phase survives the move. */
const KEEPER_ESTIMATE = `${PFX}-estimate-keeper`;
const KEEPER_ITEM = `${PFX}-item-keeper`;
const REGEX_EXPENSE = `${PFX}-expense-regex`;

async function seedCodelessCrossJob() {
    await seedTwoJobs();
    // The phase has to OUTLIVE the estimate move, or a later guard
    // (provePhaseMembershipTx) refuses the write for its own good reason and
    // this test proves nothing about the item read. A second committed
    // estimate of job A carries the same code.
    await writerDb!.estimate.create({
        data: {
            id: KEEPER_ESTIMATE, title: "Keeper", code: `EST-${PFX}-keeper`, projectId: PROJECT,
            status: "Approved", totalAmount: 100, balanceDue: 100,
        },
    });
    await writerDb!.estimateItem.create({
        data: { id: KEEPER_ITEM, estimateId: KEEPER_ESTIMATE, name: "keeps the phase", costCodeId: CODE },
    });
    // A line item with NO cost code, on job A's estimate.
    await writerDb!.estimateItem.create({
        data: { id: CODELESS_ITEM, estimateId: ESTIMATE, name: "uncoded line", costCodeId: null },
    });
    // An expense the VENDOR RULE can code on its own ("Summit Plumbing" ->
    // 03-PLUMB, the seeded cost code), linked to that uncoded item. This is
    // the row the pre-fix read would machine-code.
    await writerDb!.expense.create({
        data: {
            id: REGEX_EXPENSE, projectId: PROJECT, estimateId: ESTIMATE, itemId: CODELESS_ITEM,
            costCodeId: null, amount: 250, vendor: "Summit Plumbing", status: "Pending",
        },
    });
}

async function cleanupCodelessCrossJob() {
    await writerDb!.expense.deleteMany({ where: { id: REGEX_EXPENSE } });
    await writerDb!.estimateItem.deleteMany({ where: { id: { in: [CODELESS_ITEM, KEEPER_ITEM] } } });
    await writerDb!.estimate.deleteMany({ where: { id: KEEPER_ESTIMATE } });
    await cleanupTwoJobs();
}

test("CONTROL: a codeless item read as MISSING gets machine-coded across jobs", { skip }, async () => {
    // The pre-fix read, verbatim: an empty map. `planBackfill` is the single
    // copy of the rules, so driving it with each map is the honest way to show
    // what the two reads make it decide about the SAME row.
    await seedCodelessCrossJob();
    try {
        const expense = {
            id: REGEX_EXPENSE, projectId: PROJECT, estimateId: ESTIMATE, itemId: CODELESS_ITEM,
            costCodeId: null, costCodeSource: null, vendor: "Summit Plumbing",
            description: null, amount: 250, estimate: { projectId: TARGET_PROJECT },
        };
        const args = {
            costCodeIdByCode: new Map([["03-PLUMB", CODE]]),
            scopedProjectIds: [PROJECT],
            allowedCodesByProject: new Map([[PROJECT, new Set([CODE])]]),
        };

        const preFix = planBackfill({ expenses: [expense], items: new Map(), ...args });
        assert.equal(preFix.codeFills.length, 1, "the pre-fix read machine-codes it");
        assert.equal(preFix.codeFills[0].costCodeId, CODE);
        assert.equal(preFix.remainder.length, 0, "...and never reports the corrupt link");

        // The SHIPPED read: ownership survives the missing code, so the
        // cross-job check runs and the row is reported instead of guessed at.
        const postFix = planBackfill({
            expenses: [expense],
            items: new Map([[CODELESS_ITEM, {
                costCodeId: null, estimateId: ESTIMATE, projectId: TARGET_PROJECT,
            }]]),
            ...args,
        });
        assert.equal(postFix.codeFills.length, 0, "nothing is written");
        assert.equal(postFix.remainder[0]?.reason, "item-outside-estimate");
    } finally {
        await cleanupCodelessCrossJob();
    }
});

test("an estimate that moves between the plan and the write is REFUSED, not guessed", { skip }, async () => {
    // End to end, through the real script. The move lands between the snapshot
    // and the write transaction — the exact window the locked re-plan exists
    // for — by intercepting the FIRST `$transaction` the write loop opens.
    await seedCodelessCrossJob();
    try {
        let moved = false;
        const client = writerDb as unknown as Record<string, unknown>;
        const proxy = new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "$transaction") {
                    return async (...args: unknown[]) => {
                        if (!moved) {
                            moved = true;
                            await editorDb!.estimate.update({
                                where: { id: ESTIMATE },
                                data: { projectId: TARGET_PROJECT },
                            });
                        }
                        return (target as { $transaction: (...a: unknown[]) => Promise<unknown> })
                            .$transaction(...args);
                    };
                }
                const value = Reflect.get(target, prop, receiver);
                return typeof value === "function" ? value.bind(target) : value;
            },
        });

        const outcome = await runBackfill({
            db: proxy, apply: true, log: () => {}, overheadProjectId: "no-such-project",
        });

        assert.ok(moved, "the estimate really did move between the plan and the write");
        // THIS row, not the run: the seed also holds an ordinary expense the
        // vendor rule may legitimately code, and counting the whole run would
        // make this test pass or fail for reasons that have nothing to do with
        // the cross-job link.
        assert.ok((outcome.skipped?.costCodes ?? 0) >= 1, "the planned write was skipped, not silently dropped");
        const row = await editorDb!.expense.findUnique({
            where: { id: REGEX_EXPENSE },
            select: { costCodeId: true, costCodeSource: true },
        });
        assert.deepEqual(row, { costCodeId: null, costCodeSource: null },
            "the row is left for a human, which is what item-outside-estimate means");
    } finally {
        await editorDb!.estimate.update({ where: { id: ESTIMATE }, data: { projectId: PROJECT } })
            .catch(() => {});
        await cleanupCodelessCrossJob();
    }
});
