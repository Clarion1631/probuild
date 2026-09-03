/**
 * WHAT ACTUALLY FENCES THE SWEEP'S COMPONENT TRANSACTION — measured against a
 * real Postgres.
 *
 * Codex PR #443 gate round 41, finding 4. The chaser reads its evidence
 * (ReceiptIntake rows, Expense receipt flags) and then writes ReviewIssue rows
 * from what it read. The advisory lock serializes it against ITSELF and the row
 * locks cover rows that already exist; neither sees a ReceiptIntake inserted, or
 * an Expense receipt filled in, while the component is being decided.
 *
 * The prescribed fix was SERIALIZABLE. It does not work, and CI is what proved
 * it (run 33751439581, job "Migrations reproduce production"): the transaction
 * committed rather than raising 40001. Two independent reasons, both measured
 * below rather than argued:
 *
 *   1. SSI aborts a transaction only to break a rw-antidependency CYCLE. This
 *      transaction reads evidence and writes ReviewIssue rows that the other
 *      transaction never reads — one rw edge, no cycle, and the schedule is
 *      already equivalent to "sweep, then insert". Nothing is due.
 *   2. Snapshot isolation would BLIND the check that does work. The component
 *      re-reads its evidence inside the transaction and compares fingerprints
 *      (`componentVersionOf` / `componentVersionsMatch`); under READ COMMITTED
 *      that re-read sees the concurrent commit, and under SERIALIZABLE it
 *      cannot.
 *
 * So the fence is the re-read, at READ COMMITTED, and these tests hold it to
 * that — including the control that shows what happens without it.
 *
 * Opt-in by design (same shape as receipt-intake-claim-db.test.ts): it needs a
 * THROWAWAY database and it writes rows. It runs in CI's migrations job and
 * skips everywhere else, including anywhere the URL looks like production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { componentVersionOf, componentVersionsMatch } from "../src/lib/receipt-requests";
import { RECEIPT_EVIDENCE_LOCK } from "../src/lib/receipt-evidence-lock";

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

async function seedIntake(id: string, over: Record<string, unknown> = {}) {
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
            totalCents: -12_345,
            txnDate: DAY,
            vendor: `${PREFIX}lowes`,
            ...over,
        },
    });
}

/** Exactly the evidence read the sweep's fingerprint is built from. */
async function readEvidence(client: Pick<PrismaClient, "receiptIntake">) {
    return client.receiptIntake.findMany({
        where: { txnDate: DAY, vendor: { startsWith: PREFIX } },
        select: {
            id: true, updatedAt: true, state: true, stateReason: true,
            totalCents: true, txnDate: true, vendor: true, expenseId: true, qbPurchaseId: true,
        },
    });
}

/**
 * The sweep's component transaction, in the shape the route runs it: plan
 * outside, lock and RE-READ inside, then write — with the intruder committing
 * between the re-read and the write.
 *
 * `refetch: false` is the pre-fix control: the same transaction with no re-read
 * at all, which is what the route looked like before the fingerprint check.
 */
async function sweepComponent(options: {
    isolationLevel?: "Serializable";
    targetKey: string;
    refetch: boolean;
    duringTransaction: () => Promise<void>;
}): Promise<{ opened: boolean; moved: boolean; isolation: string }> {
    const planned = componentVersionOf({ issues: [], intakes: await readEvidence(sweepDb!) });

    return sweepDb!.$transaction(async tx => {
        const [{ transaction_isolation: isolation }] = await tx.$queryRaw<Array<{ transaction_isolation: string }>>`
            SELECT current_setting('transaction_isolation') AS transaction_isolation`;

        // The evidence writer commits HERE, inside the sweep's window.
        await options.duringTransaction();

        if (options.refetch) {
            const current = componentVersionOf({ issues: [], intakes: await readEvidence(tx) });
            if (!componentVersionsMatch(planned, current)) return { opened: false, moved: true, isolation };
        }

        await tx.reviewIssue.create({
            data: {
                targetType: "bank-line",
                targetKey: options.targetKey,
                reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
                reasonHash: "ssi-fixture",
                acknowledgedCodes: "[]",
                firstObservedAt: new Date(),
                updatedAt: new Date(),
            },
        });
        return { opened: true, moved: false, isolation };
    }, options.isolationLevel ? { isolationLevel: options.isolationLevel, timeout: 15_000 } : { timeout: 15_000 });
}

test("a ReceiptIntake inserted mid-transaction is SEEN by the re-read, and the component writes nothing", { skip }, async () => {
    await cleanup();
    const targetKey = `${PREFIX}line-insert`;

    const outcome = await sweepComponent({
        targetKey,
        refetch: true,
        duringTransaction: async () => { await seedIntake(`${PREFIX}late`); },
    });

    assert.equal(outcome.isolation, "read committed", "the fence depends on a fresh snapshot per statement");
    assert.equal(outcome.moved, true, "the fingerprint moved under the component, so it is replanned");
    assert.equal(outcome.opened, false);
    assert.equal(
        await sweepDb!.reviewIssue.count({ where: { targetKey } }), 0,
        "no chase was opened against a charge whose receipt had just landed",
    );
    await cleanup();
});

test("an UPDATE to evidence mid-transaction is seen the same way", { skip }, async () => {
    // The Expense-receipt case, one table over: a real Expense needs an
    // Estimate, which needs a Project and a Client, so the same shape is
    // exercised on ReceiptIntake — the fingerprint covers both identically
    // (`componentVersionOf` hashes intake state AND expense `hasReceipt`).
    await cleanup();
    const targetKey = `${PREFIX}line-update`;
    const parked = await seedIntake(`${PREFIX}parked`, { state: "NEEDS_REVIEW" });

    const outcome = await sweepComponent({
        targetKey,
        refetch: true,
        duringTransaction: async () => {
            await otherDb!.receiptIntake.update({ where: { id: parked.id }, data: { state: "BOOKED" } });
        },
    });

    assert.equal(outcome.moved, true, "an update inside the read predicate is movement too");
    assert.equal(await sweepDb!.reviewIssue.count({ where: { targetKey } }), 0);
    await cleanup();
});

test("PRE-FIX CONTROL: with no re-read, the same interleaving commits a stale plan", { skip }, async () => {
    await cleanup();
    const targetKey = `${PREFIX}line-control`;

    const outcome = await sweepComponent({
        targetKey,
        refetch: false,
        duringTransaction: async () => { await seedIntake(`${PREFIX}control-late`); },
    });

    assert.equal(outcome.opened, true, "without the re-read the component opened a chase for a receipt that had landed");
    assert.equal(await sweepDb!.reviewIssue.count({ where: { targetKey } }), 1, "and committed it");
    await cleanup();
});

test("SERIALIZABLE would not have helped: no 40001, and the re-read goes blind", { skip }, async () => {
    /**
     * The measurement that decided the isolation level, kept so nobody
     * re-prescribes it from theory. Two facts, one run:
     *   * the transaction COMMITS — SSI has one rw edge here, not a cycle;
     *   * and its re-read cannot see the concurrent insert at all, which is
     *     exactly the check that catches it under READ COMMITTED.
     */
    await cleanup();
    const targetKey = `${PREFIX}line-serializable`;

    const outcome = await sweepComponent({
        isolationLevel: "Serializable",
        targetKey,
        refetch: true,
        duringTransaction: async () => { await seedIntake(`${PREFIX}invisible`); },
    });

    assert.equal(outcome.isolation, "serializable", "the level really was applied at BEGIN");
    assert.equal(outcome.moved, false, "snapshot isolation hides the row the fence needs to see");
    assert.equal(outcome.opened, true, "and SSI raises no serialization failure for this access pattern");
    assert.equal(await sweepDb!.reviewIssue.count({ where: { targetKey } }), 1);
    await cleanup();
});

/**
 * THE LOCK ITSELF — does it actually make an evidence writer WAIT?
 *
 * Codex PR #443 gate round 42, finding 1. The re-read above catches evidence
 * that moved; the lock is what stops it moving in the first place, so a
 * component that plans, re-reads and writes is not racing a booking at all. A
 * source-text tripwire can prove every writer CALLS lockReceiptEvidence. Only a
 * second connection can prove the call does anything.
 *
 * Both halves are measured here: an evidence writer blocks while the sweep
 * holds the lock, and the SAME writer sails straight through when the sweep
 * holds a different one. The control matters because pg_advisory_xact_lock
 * never fails — a lock nobody else takes is indistinguishable from no lock at
 * all, which is exactly what a name typo would produce.
 */
type RawClient = { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> };

async function takeLockNamed(tx: RawClient, name: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
}

test("an evidence writer BLOCKS while the sweep holds the receipt-evidence lock", { skip }, async () => {
    await cleanup();

    /**
     * What happened, in order. The assertion is about ORDER, not elapsed time:
     * a sleep-threshold test passes on a slow runner for the wrong reason.
     *
     * NOT a "did the sweep commit yet" boolean, which is what this test tried
     * first and CI rejected (run 33773880632). Postgres releases an
     * xact-scoped advisory lock AT COMMIT, so the parked writer is resumed by
     * the very event that ends the sweep's transaction — its `order.push` can
     * run before the sweep's own `await` resolves in JS and sets the flag. The
     * flag races the commit boundary; the sequence below does not, and proves
     * the same thing: the writer announced itself BEFORE the sweep's critical
     * section and only got through AFTER it.
     */
    const order: string[] = [];
    const lockedRef = `drive:${PREFIX}locked`;

    // The writer takes the same lock and then inserts. It cannot reach its
    // insert until the sweep's transaction ends.
    const writer = (async () => {
        // Give the sweep a moment to BEGIN and take the lock. If it has not,
        // the writer wins the lock and the order assertion fails loudly rather
        // than passing vacuously.
        await new Promise(resolve => setTimeout(resolve, 250));
        order.push("writer:waiting");
        await otherDb!.$transaction(async tx => {
            await takeLockNamed(tx, RECEIPT_EVIDENCE_LOCK);
            order.push("writer:acquired");
            await seedIntake(`${PREFIX}locked`);
        }, { timeout: 20_000 });
    })();

    await sweepDb!.$transaction(async tx => {
        await takeLockNamed(tx, RECEIPT_EVIDENCE_LOCK);
        order.push("sweep:holding");
        // While the sweep holds it the writer is parked inside
        // pg_advisory_xact_lock, before its INSERT.
        await new Promise(resolve => setTimeout(resolve, 1_000));
        // Proof it is parked rather than merely slow: the sweep's own next
        // statement, on its own connection, still sees no such row.
        const seen = await tx.receiptIntake.count({ where: { sourceRef: lockedRef } });
        assert.equal(seen, 0, "the writer got past the lock while the sweep held it");
        order.push("sweep:read-clean");
    }, { timeout: 20_000 });

    await writer;

    assert.deepEqual(order, [
        "sweep:holding",
        "writer:waiting",
        "sweep:read-clean",
        "writer:acquired",
    ], "the writer was parked across the sweep's whole critical section");
    // Without the lock the writer would have acquired immediately and landed at
    // index 2, ahead of "sweep:read-clean". That inversion is what this ordering
    // detects — and the sweep's own count of 0, asserted above, is the
    // independent second witness that nothing got in.
    await cleanup();
});

test("PRE-FIX CONTROL: a DIFFERENT lock name blocks nothing at all", { skip }, async () => {
    /**
     * The same interleaving with the sweep holding "receipt-evidence-typo".
     * pg_advisory_xact_lock cannot fail, so from the writer's side a fence on
     * the wrong name looks identical to a real one — which is what makes the
     * single-lock-name tripwire in receipt-evidence-lock.test.ts load bearing
     * rather than cosmetic.
     */
    await cleanup();
    let acquiredWhileHeld = false;

    const writer = (async () => {
        await new Promise(resolve => setTimeout(resolve, 250));
        await otherDb!.$transaction(async tx => {
            await takeLockNamed(tx, RECEIPT_EVIDENCE_LOCK);
            acquiredWhileHeld = true;
        }, { timeout: 20_000 });
    })();

    await sweepDb!.$transaction(async tx => {
        await takeLockNamed(tx, `${RECEIPT_EVIDENCE_LOCK}-typo`);
        await new Promise(resolve => setTimeout(resolve, 1_000));
        assert.equal(acquiredWhileHeld, true, "with a mismatched name the writer should NOT have been held up");
    }, { timeout: 20_000 });

    await writer;
    await cleanup();
});

test.after(async () => {
    await sweepDb?.$disconnect();
    await otherDb?.$disconnect();
});
