/**
 * THE PHANTOM ROW, AGAINST A REAL POSTGRES.
 *
 * `tests/phase-invariant.test.ts` drives the helper against a scripted fake, so
 * it can prove the SQL is emitted and prove the order it is emitted in. It
 * cannot prove the one thing that matters here, because the fake has no lock
 * manager: that the row which ANSWERED "yes, this cost code is a phase of this
 * job" is actually held until the caller's transaction commits.
 *
 * The hole this closes (Codex round 32): `lockPhaseRowsForShare` share-locks the
 * estimates and estimate items that EXIST when it runs. Under READ COMMITTED a
 * concurrent transaction can insert a new estimate + line item and commit it
 * afterwards, and the next statement in the holder's transaction sees it — it
 * takes a fresh snapshot. Before the fix the proof query read that phantom and
 * returned "ok" while holding nothing, so the row could be deleted (or its
 * estimate reassigned) before the expense write landed on it.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job (which has a disposable Postgres) and skips everywhere
 * else, including anywhere DATABASE_URL looks like production.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { lockPhaseRowsForShare, provePhaseMembershipTx } from "../src/lib/phase-invariant";
import { writeUnderAttributionLocks } from "../scripts/backfill-expense-attribution";

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

// Three CONNECTIONS, not three clients on one pool: the whole point is that
// these transactions are genuinely concurrent and can block on each other.
const holder = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;
const inserter = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;
const deleter = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const PFX = "phinv-db";
const CLIENT = `${PFX}-client`;
const PROJECT = `${PFX}-project`;
const CODE = `${PFX}-costcode`;
const ESTIMATE = `${PFX}-estimate`;
const ITEM = `${PFX}-item`;
/**
 * The expense's OWN estimate, deliberately separate from the phantom one and
 * deliberately carrying no line items. It exists because `Expense.estimateId`
 * is a required FK, so the row cannot be seeded at all without an estimate —
 * and if the expense hung off the phantom estimate, the phantom could not be
 * a phantom (it would have to exist before the scans ran).
 */
const CARRIER = `${PFX}-carrier`;
const EXPENSE = `${PFX}-expense`;

/** A promise a later step resolves — how the interleaving is made deterministic. */
function gate() {
    let open!: () => void;
    const reached = new Promise<void>(resolve => (open = resolve));
    return { reached, open };
}

async function cleanup() {
    if (!holder) return;
    await holder.expense.deleteMany({ where: { id: EXPENSE } });
    await holder.estimateItem.deleteMany({ where: { id: ITEM } });
    await holder.estimate.deleteMany({ where: { id: { in: [ESTIMATE, CARRIER] } } });
    await holder.project.deleteMany({ where: { id: PROJECT } });
    await holder.costCode.deleteMany({ where: { id: CODE } });
    await holder.client.deleteMany({ where: { id: CLIENT } });
}

async function seedWithoutTheItem() {
    await cleanup();
    await holder!.client.create({ data: { id: CLIENT, name: "Phase Invariant DB", initials: "PI" } });
    await holder!.project.create({
        data: { id: PROJECT, name: "Phase Invariant DB", clientId: CLIENT, status: "In Progress" },
    });
    await holder!.costCode.create({
        data: { id: CODE, code: `${PFX}-99-TEST`, name: "Phase invariant probe", isActive: true },
    });
}

/** The phantom: an estimate AND its line item, created after the scans ran. */
async function insertThePhantom() {
    await inserter!.$transaction(async tx => {
        await tx.estimate.create({
            data: {
                id: ESTIMATE,
                title: "Phase Invariant DB",
                code: `EST-${PFX}`,
                projectId: PROJECT,
                status: "Approved",
                totalAmount: 100,
                balanceDue: 100,
            },
        });
        await tx.estimateItem.create({
            data: { id: ITEM, estimateId: ESTIMATE, name: "probe line", costCodeId: CODE },
        });
    });
}

test("the row that proved membership cannot be deleted until the holder commits", { skip }, async () => {
    await seedWithoutTheItem();
    try {
        const scansDone = gate();
        const phantomLanded = gate();
        const deleteSettled = gate();
        let deleteError: unknown = null;
        let deleteSucceededBeforeCommit = false;

        const held = holder!.$transaction(
            async tx => {
                // Step 1: the four scans, with NOTHING for them to lock — no
                // estimate of this project exists yet.
                await lockPhaseRowsForShare(tx, PROJECT, CODE);
                scansDone.open();

                // Step 2 happens on another connection; wait for it to commit.
                await phantomLanded.reached;

                // Step 3: the proof query. It sees the phantom (fresh snapshot)
                // and — this is the fix — locks it.
                const verdict = await provePhaseMembershipTx(tx, PROJECT, CODE);
                assert.equal(verdict, true, "the phantom is visible to the proof query");

                // Step 4: another connection tries to delete the proving row.
                await deleteSettled.reached;
                assert.equal(
                    deleteSucceededBeforeCommit,
                    false,
                    "the proving row was deleted while the verdict was still being relied on",
                );
                return verdict;
            },
            { timeout: 30_000, maxWait: 20_000 },
        );

        await scansDone.reached;
        await insertThePhantom();
        phantomLanded.open();

        // Give the holder a moment to actually run the proof query before the
        // delete races it; without this the delete can win on timing rather
        // than on locking, which would make the assertion meaningless.
        await new Promise(resolve => setTimeout(resolve, 300));

        try {
            await deleter!.$transaction(async tx => {
                // A bounded wait: if the share lock is held this raises 55P03
                // rather than hanging until the holder's own timeout.
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
                await tx.$executeRawUnsafe(`DELETE FROM "EstimateItem" WHERE id = $1`, ITEM);
                deleteSucceededBeforeCommit = true;
            });
        } catch (error) {
            deleteError = error;
        }
        deleteSettled.open();

        assert.equal(await held, true);
        assert.ok(deleteError, "the delete must have been refused, not merely slow");
        assert.match(
            String((deleteError as { message?: string })?.message ?? deleteError),
            /lock timeout|55P03|canceling statement/i,
            "it is blocked by the share lock, not by some unrelated failure",
        );

        // And once the holder commits, the row is free again — a share lock,
        // not a permanent one.
        await deleter!.estimateItem.delete({ where: { id: ITEM } });
        assert.equal(await deleter!.estimateItem.findUnique({ where: { id: ITEM } }), null);
    } finally {
        await cleanup();
    }
});

test("the scans alone would NOT have caught it", { skip }, async () => {
    // The control: this is the state of the world the fix exists for. With only
    // `lockPhaseRowsForShare` held, a row inserted afterwards is locked by
    // nothing, so the delete goes straight through. If this ever starts failing,
    // the test above is no longer proving what it claims — something else in the
    // transaction is holding the row.
    await seedWithoutTheItem();
    try {
        const scansDone = gate();
        const deleteSettled = gate();
        let deleted = false;

        const held = holder!.$transaction(
            async tx => {
                await lockPhaseRowsForShare(tx, PROJECT, CODE);
                scansDone.open();
                await deleteSettled.reached;
                return deleted;
            },
            { timeout: 30_000, maxWait: 20_000 },
        );

        await scansDone.reached;
        await insertThePhantom();
        await deleter!.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '2s'`);
            await tx.$executeRawUnsafe(`DELETE FROM "EstimateItem" WHERE id = $1`, ITEM);
            deleted = true;
        });
        deleteSettled.open();
        assert.equal(await held, true, "the four scans cannot hold a row that did not exist yet");
    } finally {
        await cleanup();
    }
});

// ── the BACKFILL reaches the same proof, on its own lock stack ─────────────

/** The expense the backfill would code, plus the estimate it must hang off. */
async function seedTheExpense() {
    await holder!.estimate.create({
        data: {
            id: CARRIER,
            title: "Phase Invariant DB carrier",
            code: `EST-${PFX}-carrier`,
            projectId: PROJECT,
            status: "Approved",
            totalAmount: 100,
            balanceDue: 100,
        },
    });
    await holder!.expense.create({
        data: {
            id: EXPENSE,
            estimateId: CARRIER,
            projectId: PROJECT,
            amount: 120.5,
            vendor: "Phase invariant probe",
            costCodeId: null,
            costCodeSource: null,
        },
    });
}

test("the backfill's cost-code write holds the row its phase verdict came from", { skip }, async () => {
    // WHY THIS IS NOT THE TEST ABOVE. That one drives the helper directly.
    // The backfill reaches it through its OWN lock stack —
    // `writeUnderAttributionLocks` takes the estimate, item, phase and cost-code
    // share locks and the per-expense advisory lock before the callback runs —
    // and until this round it then decided phase membership from an UNLOCKED
    // `estimateItem.findMany` inside that transaction. Those scans lock what
    // EXISTS when they run; a concurrent transaction can insert an estimate and
    // a line item and commit them afterwards, and the next statement sees them
    // (READ COMMITTED takes a fresh snapshot per statement). The pass then wrote
    // a cost code justified by a row nothing was holding, which could be deleted
    // — or its estimate archived or moved to another job — before the UPDATE
    // committed. That is money on a phase the job does not have, written by the
    // one writer with no human behind it.
    //
    // So: same interleaving, but through the real entry point, and it ends with
    // the write actually landing — the lock must protect the verdict without
    // deadlocking the pass against its own locks.
    await seedWithoutTheItem();
    await seedTheExpense();
    try {
        const scansDone = gate();
        const phantomLanded = gate();
        const deleteSettled = gate();
        let deleteError: unknown = null;
        let deleteSucceededBeforeCommit = false;
        let verdict: boolean | null = null;

        const written = writeUnderAttributionLocks(
            holder!,
            {
                expenseId: EXPENSE,
                estimateIds: [CARRIER],
                estimateItemIds: [null],
                phaseProjectId: PROJECT,
                costCodeId: CODE,
            },
            async (tx: any) => {
                // Every lock the backfill takes is held by now, and there is
                // no estimate item of this project for them to have locked.
                scansDone.open();
                await phantomLanded.reached;

                verdict = await provePhaseMembershipTx(tx, PROJECT, CODE);
                assert.equal(verdict, true, "the phantom is visible to the proof query");

                await deleteSettled.reached;
                assert.equal(
                    deleteSucceededBeforeCommit,
                    false,
                    "the proving row was deleted while the backfill was still relying on it",
                );
                return tx.expense.updateMany({
                    where: { id: EXPENSE, costCodeId: null },
                    data: { costCodeId: CODE, costCodeSource: "backfill", costCodeConfidence: null },
                });
            },
        );

        await scansDone.reached;
        await insertThePhantom();
        phantomLanded.open();

        // Let the holder actually run the proof before the delete races it, or
        // the assertion would be about timing rather than about locking.
        await new Promise(resolve => setTimeout(resolve, 200));

        try {
            await deleter!.$transaction(async tx => {
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1s'`);
                await tx.$executeRawUnsafe(`DELETE FROM "EstimateItem" WHERE id = $1`, ITEM);
                deleteSucceededBeforeCommit = true;
            });
        } catch (error) {
            deleteError = error;
        }
        deleteSettled.open();

        assert.deepEqual(await written, { count: 1 }, "and the code is actually written");
        assert.ok(deleteError, "the delete was refused, not merely slow");
        assert.match(
            String((deleteError as { message?: string })?.message ?? deleteError),
            /lock timeout|55P03|canceling statement/i,
            "blocked by the share lock, not by some unrelated failure",
        );

        const coded = await deleter!.expense.findUnique({
            where: { id: EXPENSE },
            select: { costCodeId: true, costCodeSource: true },
        });
        assert.deepEqual(coded, { costCodeId: CODE, costCodeSource: "backfill" });
    } finally {
        await cleanup();
    }
});

after(async () => {
    await Promise.all([holder?.$disconnect(), inserter?.$disconnect(), deleter?.$disconnect()]);
});
