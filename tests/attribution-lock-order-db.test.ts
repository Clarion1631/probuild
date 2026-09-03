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
import { lockEstimateAttribution } from "../src/lib/expense-attribution";
import {
    applyQboExpenseCostCodeSuggestion,
    type QboCostCodeSuggestionClient,
} from "../src/lib/qbo-expense-sync";

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

after(async () => {
    await Promise.all([writerDb?.$disconnect(), editorDb?.$disconnect()]);
});
