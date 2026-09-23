/**
 * THE CLAIM'S OWN CERTIFICATION AND LOCK ORDER — measured against a real
 * Postgres (cheap-sweep-restart-spec.md §14.9, Codex round 2 blocker 1, and
 * the claim-time race; §14.10 for case (d)).
 *
 * `claimOwnerDay` is the only place a card is ever selected, and everything
 * it checks — the evidence lock, both epochs, the owner epoch — is exactly
 * the machinery `tests/receipt-card-claim-certified.test.ts` exercises with
 * a recording fake. What a fake cannot prove is that the LOCKS are real:
 * that a concurrent owner reassignment genuinely blocks rather than merely
 * losing a race in JS, and that holding exactly one issue row really does
 * keep a courtesy clear (§14.10) deadlock-free against card history's own
 * multi-row locking. Both need an actual database.
 *
 * Opt-in by design (same shape as receipt-evidence-fence-db.test.ts): it
 * needs a THROWAWAY database and it writes rows. It runs in CI's migrations
 * job and skips everywhere else, including anywhere the URL looks like
 * production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { claimOwnerDay } from "../src/app/api/cron/receipt-request-cards/route";
import { closeRequestsSatisfiedBy } from "../src/lib/receipt-intake/evidence-close-store";
import { writeReceiptOwnerLocked } from "../src/lib/receipt-owner-assignment";
import { readReceiptEvidenceEpoch, readReceiptOwnerEpoch } from "../src/lib/receipt-evidence-lock";
import { readBankLedgerEpoch } from "../src/lib/bank-ledger-epoch";
import { recordCardOnIssues, type RecordableCard } from "../src/lib/receipt-card-history";
import { CYCLE_KEY, SWEEP_MARKER_KEY, formatSweepMarker } from "../src/lib/receipt-sweep-marker";
import { RECEIPT_REQUEST_TARGET_TYPE } from "../src/lib/receipt-requests";
import { hashReasonCodes, canonicalizeReasonCodes } from "../src/lib/review-alert-reasons";
import type { CardItem } from "../src/lib/receipt-request-cards";

const url = process.env.RECEIPT_INTAKE_DB_TEST_URL ?? process.env.MIGRATION_HISTORY_TEST_URL;
const looksLikeProd = !!url && /supabase\.(co|com)/i.test(url);
const skip = !url
    ? "set RECEIPT_INTAKE_DB_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

/** Two CLIENTS, because one connection cannot interleave with itself. */
const claimDb = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;
const otherDb = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const PREFIX = "certclaim-";
const RECOGNITION_POLICY = "receipt-source-v1:off";

async function cleanup() {
    if (!claimDb) return;
    await claimDb.reviewIssue.deleteMany({ where: { targetKey: { startsWith: PREFIX } } });
    await claimDb.receiptRequestCard.deleteMany({ where: { owner: { startsWith: PREFIX } } });
}

async function seedIssue(targetKey: string) {
    return otherDb!.reviewIssue.create({
        data: {
            targetType: RECEIPT_REQUEST_TARGET_TYPE,
            targetKey,
            version: 1,
            reasonCodes: JSON.stringify(["MISSING_RECEIPT"]),
            reasonHash: hashReasonCodes(canonicalizeReasonCodes(["MISSING_RECEIPT"])),
            displayDetails: JSON.stringify({ payee: "ARCO #82887", amountCents: -1_000 }),
            acknowledgedCodes: "[]",
            firstObservedAt: new Date(),
            clearedAt: null,
            currentGeneration: 1,
            updatedAt: new Date(),
        },
    });
}

/** The current epochs, through the SAME readers `claimOwnerDay` itself uses. */
async function currentEpochs() {
    const [evidence, ledger] = await Promise.all([
        readReceiptEvidenceEpoch(claimDb!),
        readBankLedgerEpoch(claimDb!),
    ]);
    return { evidence, ledger };
}

const utcToday = () => new Date().toISOString().slice(0, 10);
const pacificToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

/**
 * A cycle and marker certified against WHATEVER the ledger and evidence
 * epochs measure right now, so `cardSelectionCertified` passes at the moment
 * this writes — before anything in the test moves either counter.
 */
async function writeCertifiedMarkerAndCycle(cycleId: string) {
    const epochs = await currentEpochs();
    const now = new Date();
    await claimDb!.automationSetting.upsert({
        where: { key: CYCLE_KEY },
        create: {
            key: CYCLE_KEY,
            value: JSON.stringify({
                id: cycleId, epoch: epochs.ledger, evidenceEpoch: epochs.evidence,
                recognitionPolicy: RECOGNITION_POLICY, plannerDay: utcToday(),
            }),
        },
        update: {
            value: JSON.stringify({
                id: cycleId, epoch: epochs.ledger, evidenceEpoch: epochs.evidence,
                recognitionPolicy: RECOGNITION_POLICY, plannerDay: utcToday(),
            }),
        },
    });
    await claimDb!.automationSetting.upsert({
        where: { key: SWEEP_MARKER_KEY },
        create: {
            key: SWEEP_MARKER_KEY,
            value: formatSweepMarker({ phase: "done", chaserCompletedAt: now.toISOString(), blockedReason: null, completedCycleId: cycleId }),
        },
        update: {
            value: formatSweepMarker({ phase: "done", chaserCompletedAt: now.toISOString(), blockedReason: null, completedCycleId: cycleId }),
        },
    });
    return epochs;
}

test("(a) a certified cycle, then a committed courtesy clear (with its bump): the claim refuses 'certification', and no row exists", { skip }, async () => {
    await cleanup();
    const owner = `${PREFIX}owner-a`;
    const targetA = `${PREFIX}line-a`;
    const issueA = await seedIssue(targetA);
    await writeCertifiedMarkerAndCycle(`${PREFIX}cycle-a`);
    const ownerEpochAtScan = await readReceiptOwnerEpoch(claimDb!);

    // The REAL atomic clear (§14.10): closeRequestsSatisfiedBy's own defaults
    // (transaction, clearOne, readEpochs) all run for real, clearing issue A
    // and bumping the evidence epoch out from under the cycle just certified.
    const closeResult = await closeRequestsSatisfiedBy(
        { totalCents: 1_000, txnDate: pacificToday(), bookedOn: pacificToday() },
        {
            findLines: async () => [{ id: targetA }],
            openIssueKeys: async () => new Map([[targetA, issueA.id]]),
            recompute: async () => [],
        },
    );
    assert.deepEqual(closeResult.cleared, [targetA], "the courtesy clear itself must have succeeded for this case to mean anything");

    const claim = await claimOwnerDay(claimDb!, {
        owner, date: pacificToday(), items: [] as CardItem[], overflow: 0, overflowExact: true,
        claimedAt: new Date(), claimToken: "tok-a", ownerEpochAtScan, recognitionPolicy: RECOGNITION_POLICY,
    });

    assert.deepEqual(claim, { kind: "refused", reason: "certification" });
    const row = await claimDb!.receiptRequestCard.findUnique({ where: { owner_pacificDate: { owner, pacificDate: pacificToday() } } });
    assert.equal(row, null, "no row was ever created");
    await cleanup();
});

test("(b) writeReceiptOwnerLocked commits after the pre-scan owner-epoch read: the claim refuses 'owner-moved'", { skip }, async () => {
    await cleanup();
    const owner = `${PREFIX}owner-b`;
    const targetB = `${PREFIX}line-b`;
    const issueB = await seedIssue(targetB);
    await writeCertifiedMarkerAndCycle(`${PREFIX}cycle-b`);
    // Snapshotted BEFORE the reassignment below — exactly what the cards
    // route reads at scan time, minutes before the claim.
    const ownerEpochAtScan = await readReceiptOwnerEpoch(claimDb!);

    const moved = await writeReceiptOwnerLocked(otherDb!, {
        issueId: issueB.id, expectedVersion: 1,
        displayDetailsJson: JSON.stringify({ payee: "ARCO #82887", amountCents: -1_000, ownerOverride: "CJ" }),
        now: new Date(),
    });
    assert.equal(moved, 1, "the reassignment itself must have committed for this case to mean anything");

    const claim = await claimOwnerDay(claimDb!, {
        owner, date: pacificToday(), items: [] as CardItem[], overflow: 0, overflowExact: true,
        claimedAt: new Date(), claimToken: "tok-b", ownerEpochAtScan, recognitionPolicy: RECOGNITION_POLICY,
    });

    assert.deepEqual(claim, { kind: "refused", reason: "owner-moved" });
    const row = await claimDb!.receiptRequestCard.findUnique({ where: { owner_pacificDate: { owner, pacificDate: pacificToday() } } });
    assert.equal(row, null, "no row was ever created");
    await cleanup();
});

/**
 * `claimOwnerDay` takes no injectable pause — its `db` parameter IS the seam,
 * so this wraps it: the real transaction runs claimOwnerDay's whole body
 * (through its own commit-worthy write) and then, on the SAME still-open
 * Postgres transaction, awaits an external signal before returning — holding
 * every lock that body took (the evidence advisory lock, from claimOwnerDay's
 * own step 2, foremost among them) until the signal fires. Same idiom as
 * receipt-evidence-fence-db.test.ts's "BLOCKS" test: an order log, not an
 * elapsed-time threshold.
 */
function holdOpenAfterBody(real: PrismaClient, hold: () => Promise<void>): Pick<PrismaClient, "$transaction"> {
    const wrapped = async (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        real.$transaction(async tx => {
            const result = await fn(tx);
            await hold();
            return result;
        }, options as never);
    return { $transaction: wrapped as PrismaClient["$transaction"] };
}

test("(c) a concurrent writeReceiptOwnerLocked blocks while the claim's transaction is open, and commits only after the claim does", { skip }, async () => {
    await cleanup();
    const owner = `${PREFIX}owner-c`;
    const targetC = `${PREFIX}line-c`;
    const issueC = await seedIssue(targetC);
    await writeCertifiedMarkerAndCycle(`${PREFIX}cycle-c`);
    const ownerEpochAtScan = await readReceiptOwnerEpoch(claimDb!);

    const order: string[] = [];
    let releaseHold: () => void = () => {};
    const holdSignal = new Promise<void>(resolve => { releaseHold = resolve; });

    const claimPromise = (async () => {
        const result = await claimOwnerDay(
            holdOpenAfterBody(claimDb!, async () => { order.push("claim:holding"); await holdSignal; }),
            {
                owner, date: pacificToday(), items: [] as CardItem[], overflow: 0, overflowExact: true,
                claimedAt: new Date(), claimToken: "tok-c", ownerEpochAtScan, recognitionPolicy: RECOGNITION_POLICY,
            },
        );
        order.push("claim:committed");
        return result;
    })();

    const writerPromise = (async () => {
        // Give the claim a moment to begin and take the evidence lock. If it
        // has not, the writer wins the lock and the order assertion below
        // fails loudly rather than passing vacuously.
        await new Promise(resolve => setTimeout(resolve, 250));
        order.push("writer:waiting");
        const count = await writeReceiptOwnerLocked(otherDb!, {
            issueId: issueC.id, expectedVersion: 1,
            displayDetailsJson: JSON.stringify({ payee: "ARCO #82887", amountCents: -1_000, ownerOverride: "Richard" }),
            now: new Date(),
        });
        order.push("writer:committed");
        return count;
    })();

    // While the claim holds its lock the writer is parked inside
    // pg_advisory_xact_lock, before its own write.
    await new Promise(resolve => setTimeout(resolve, 1_000));
    releaseHold();

    const [claim, writerCount] = await Promise.all([claimPromise, writerPromise]);

    assert.deepEqual(order, ["claim:holding", "writer:waiting", "claim:committed", "writer:committed"],
        "the writer was parked across the claim's whole transaction, and only proceeded once it committed");
    assert.deepEqual(claim, { kind: "claimed", id: (claim as { kind: "claimed"; id: string }).id },
        "the claim itself succeeded — the writer never got in ahead of it, so ownerEpochAtScan still matched");
    assert.equal(writerCount, 1, "the writer then committed normally once the lock was free");
    await cleanup();
});

test("(d) a courtesy clear and recordCardOnIssues over two issues in reverse order both finish without a deadlock error", { skip }, async () => {
    await cleanup();
    const targetD1 = `${PREFIX}line-d1`;
    const targetD2 = `${PREFIX}line-d2`;
    const issue1 = await seedIssue(targetD1);
    const issue2 = await seedIssue(targetD2);

    const card: RecordableCard = {
        items: [
            // REVERSE of creation order: issue2 first, issue1 second — so
            // card history's own transaction locks issue2's row, THEN reaches
            // for issue1's, while the courtesy clear below reaches for
            // issue1's row from the other side. Holding exactly one issue row
            // (§14.0) is what keeps this from ever deadlocking, whichever
            // order either side reaches for it in.
            { n: 1, fingerprint: "fp-2", date: "2026-09-01", vendor: "ARCO", cents: 1_000, amount: "10.00", cardTail: null, issueId: issue2.id, targetKey: targetD2 },
            { n: 2, fingerprint: "fp-1", date: "2026-09-01", vendor: "ARCO", cents: 1_000, amount: "10.00", cardTail: null, issueId: issue1.id, targetKey: targetD1 },
        ],
        date: pacificToday(),
        requestId: `${PREFIX}req-d`,
    };

    const historyPromise = otherDb!.$transaction(
        tx => recordCardOnIssues(card, "spaces/AAA/threads/BBB", "spaces/AAA/threads/BBB/messages/CCC", new Date(), tx, "report"),
        { timeout: 20_000 },
    );
    const clearPromise = closeRequestsSatisfiedBy(
        { totalCents: 1_000, txnDate: pacificToday(), bookedOn: pacificToday() },
        {
            findLines: async () => [{ id: targetD1 }],
            openIssueKeys: async () => new Map([[targetD1, issue1.id]]),
            recompute: async () => [],
        },
    );

    // Neither promise may reject — a real Postgres deadlock (40P01) would
    // throw from whichever side Postgres chose as the victim.
    const [historyResult, clearResult] = await Promise.all([historyPromise, clearPromise]);

    assert.equal(historyResult.lostRaces, 0, "no lost CAS — the two transactions serialized on issue1's row rather than colliding");
    assert.equal(historyResult.recorded, 2);
    assert.deepEqual(clearResult.cleared, [targetD1]);
    await cleanup();
});

test.after(async () => {
    await claimDb?.$disconnect();
    await otherDb?.$disconnect();
});
