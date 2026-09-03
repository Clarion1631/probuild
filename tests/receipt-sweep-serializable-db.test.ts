/**
 * THE SWEEP'S COMPONENT TRANSACTION AGAINST A REAL POSTGRES.
 *
 * Codex PR #443 gate round 41, finding 4. The chaser reads its evidence —
 * ReceiptIntake rows and Expense receipt flags — and then writes ReviewIssue
 * rows from what it read. The advisory lock serializes it against ITSELF, and
 * row locks cover rows that already exist; neither covers a ReceiptIntake
 * INSERTED, or an Expense receipt filled in, between the read and the write.
 * Those writers are Phase 3's, not ours to fence.
 *
 * SERIALIZABLE is the fence: Postgres's SSI takes predicate locks over what the
 * transaction read, so a concurrent insert or update inside those predicates
 * makes one of the two abort with 40001 instead of letting a stale plan commit.
 * That is a database behaviour, so it is asserted against a database — mocks
 * cannot have it.
 *
 * Opt-in by design (same shape as receipt-intake-claim-db.test.ts): it needs a
 * THROWAWAY database and it writes rows. It runs in CI's migrations job and
 * skips everywhere else, including anywhere the URL looks like production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { isRetryableTxError } from "../src/lib/tx-retry";

const url = process.env.RECEIPT_INTAKE_DB_TEST_URL ?? process.env.MIGRATION_HISTORY_TEST_URL;
const looksLikeProd = !!url && /supabase\.(co|com)/i.test(url);
const skip = !url
    ? "set RECEIPT_INTAKE_DB_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

/** Two CLIENTS, because one connection cannot interleave with itself. */
const sweepDb = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;
const otherDb = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const PREFIX = "ssi-";
const DAY = new Date("2026-08-16T00:00:00.000Z");

async function cleanup() {
    if (!sweepDb) return;
    await sweepDb.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: `drive:${PREFIX}` } } });
    await sweepDb.reviewIssue.deleteMany({ where: { targetKey: { startsWith: PREFIX } } });
}

async function seedIntake(id: string, cents: number) {
    return otherDb!.receiptIntake.create({
        data: {
            id,
            source: "drive",
            sourceRef: `drive:${PREFIX}${id}`,
            state: "READ",
            dryRun: false,
            storagePath: `receipts/intake/${id}.jpg`,
            mimeType: "image/jpeg",
            fileSize: 10,
            fileSha256: "x".repeat(64),
            totalCents: cents,
            txnDate: DAY,
            vendor: `${PREFIX}lowes`,
        },
    });
}

/**
 * The shape of the sweep's component transaction: read the evidence, decide,
 * write a ReviewIssue. Runs at whatever isolation the caller asks for, so the
 * pre-fix control is the same code at READ COMMITTED.
 */
async function sweepComponent(
    isolationLevel: "Serializable" | "ReadCommitted",
    targetKey: string,
    afterRead: () => Promise<void>,
): Promise<{ opened: boolean }> {
    return sweepDb!.$transaction(async tx => {
        // 1. THE EVIDENCE READ — the predicate SSI will lock.
        const intakes = await tx.receiptIntake.findMany({
            where: { txnDate: DAY, vendor: { startsWith: PREFIX }, state: { not: "VOID" } },
            select: { id: true, totalCents: true },
        });
        const expenses = await tx.expense.findMany({
            where: { vendor: { startsWith: PREFIX } },
            select: { id: true, receiptUrl: true },
        });

        // 2. The concurrent writer commits HERE, between the read and the write.
        await afterRead();

        // 3. THE DECISION, from what step 1 saw: no evidence means the charge is
        //    still missing its receipt, so the chase opens.
        const evidence = intakes.length > 0 || expenses.some(row => row.receiptUrl !== null);
        if (evidence) return { opened: false };
        await tx.reviewIssue.create({
            data: {
                targetType: "bank-line",
                targetKey,
                reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
                reasonHash: "ssi-fixture",
                acknowledgedCodes: "[]",
                firstObservedAt: new Date(),
                updatedAt: new Date(),
            },
        });
        return { opened: true };
    }, { isolationLevel, timeout: 15_000 });
}

test("a ReceiptIntake inserted between the read and the write aborts the sweep with 40001", { skip }, async () => {
    await cleanup();
    const targetKey = `${PREFIX}line-intake`;

    const error = await sweepComponent("Serializable", targetKey, async () => {
        // A SECOND CONNECTION, committed inside the sweep's window. This is the
        // receipt landing while the sweep is deciding the charge has none.
        await seedIntake(`${PREFIX}late`, -12_345);
    }).then(() => null, (e: unknown) => e as Error);

    assert.ok(error, "the sweep must not commit a plan drawn from evidence that changed under it");
    assert.ok(
        isRetryableTxError(error),
        `expected a retryable serialization failure, got ${String((error as { message?: string })?.message)}`,
    );
    // NOTHING committed: the chase was not opened against a receipt that exists.
    const issues = await sweepDb!.reviewIssue.count({ where: { targetKey } });
    assert.equal(issues, 0, "the whole component rolled back, which is what makes the retry safe");

    // AND THE RETRY SEES IT. Re-running against fresh state finds the receipt.
    const second = await sweepComponent("Serializable", targetKey, async () => {});
    assert.equal(second.opened, false, "the retry reads the intake that just landed and opens nothing");
    await cleanup();
});

test("an UPDATE that moves a row INTO the read predicate aborts it too", { skip }, async () => {
    /**
     * The Expense case, one table over. An `Expense.receiptUrl` filled in by
     * the QBO sync is an UPDATE inside a predicate this transaction read — and
     * a real Expense needs an Estimate, which needs a Project and a Client, so
     * the same shape is exercised on ReceiptIntake, which stands alone. The
     * mechanism under test is SSI's predicate lock, and it does not care which
     * table it is: the sweep reads BOTH inside the transaction (see
     * `sweepComponent`), so both are covered by the same rw-conflict.
     *
     * An UPDATE, deliberately, not an insert: it is the case no count of newly
     * created rows could ever detect.
     */
    await cleanup();
    const targetKey = `${PREFIX}line-update`;
    // Starts OUTSIDE the predicate: the sweep's read excludes VOID rows.
    const parked = await seedIntake(`${PREFIX}parked`, -12_345);
    await otherDb!.receiptIntake.update({ where: { id: parked.id }, data: { state: "VOID" } });

    const error = await sweepComponent("Serializable", targetKey, async () => {
        // ...and is moved INTO it while the sweep is deciding.
        await otherDb!.receiptIntake.update({ where: { id: parked.id }, data: { state: "READ" } });
    }).then(() => null, (e: unknown) => e as Error);

    assert.ok(error, "an update inside the read predicate is movement too");
    assert.ok(isRetryableTxError(error), `expected 40001, got ${String((error as { message?: string })?.message)}`);
    assert.equal(await sweepDb!.reviewIssue.count({ where: { targetKey } }), 0);
    await cleanup();
});

test("PRE-FIX CONTROL: at READ COMMITTED the same interleaving commits a stale plan", { skip }, async () => {
    await cleanup();
    const targetKey = `${PREFIX}line-control`;

    const outcome = await sweepComponent("ReadCommitted", targetKey, async () => {
        await seedIntake(`${PREFIX}control-late`, -12_345);
    });

    assert.equal(outcome.opened, true, "the old isolation opened a chase for a charge whose receipt had just landed");
    assert.equal(await sweepDb!.reviewIssue.count({ where: { targetKey } }), 1, "and committed it");
    await cleanup();
});

test.after(async () => {
    await sweepDb?.$disconnect();
    await otherDb?.$disconnect();
});
