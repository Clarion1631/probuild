/**
 * The claim transaction against a REAL Postgres.
 *
 * Everything else in this feature's suites mocks the database, so the SQL is
 * the one part they cannot check — and both bugs that live there are silent
 * until production: a void-returning function read through $queryRaw, and a
 * claim whose real behaviour differs from the mocked stand-in.
 *
 * Opt-in by design: it needs a THROWAWAY database and it writes rows. It runs
 * in CI's migrations job (which has a disposable Postgres) and skips everywhere
 * else, including anywhere DATABASE_URL looks like production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient, Prisma } from "@prisma/client";
import { CLAIM_LOCK_KEY } from "../src/lib/receipt-intake/worker";

const url = process.env.RECEIPT_INTAKE_DB_TEST_URL ?? process.env.MIGRATION_HISTORY_TEST_URL;
const looksLikeProd = !!url && /supabase\.(co|com)/i.test(url);
const skip = !url
    ? "set RECEIPT_INTAKE_DB_TEST_URL to a disposable PostgreSQL URL"
    : looksLikeProd
        ? "refusing to run against what looks like production"
        : false;

const db = url && !looksLikeProd ? new PrismaClient({ datasources: { db: { url } } }) : null;

const PREFIX = "drive:claimdb-";

async function seed(id: string, over: Partial<Prisma.ReceiptIntakeUncheckedCreateInput> = {}) {
    return db!.receiptIntake.create({
        data: {
            id,
            source: "drive",
            sourceRef: `${PREFIX}${id}`,
            state: "RECEIVED",
            dryRun: false,
            storagePath: `receipts/intake/${id}.jpg`,
            mimeType: "image/jpeg",
            fileSize: 10,
            fileSha256: "x".repeat(64),
            ...over,
        },
    });
}

test("the blocking advisory lock runs without error inside a transaction", { skip }, async () => {
    // The regression: `SELECT pg_advisory_xact_lock(...)` through $queryRaw.
    // pg_advisory_xact_lock returns VOID, and reading that column can throw —
    // inside the promotion transaction, which then looks like a transient DB
    // fault forever while the lock was never taken.
    await db!.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"weak-key-probe"}, 0))`;
    });

    // ...and the TRY variant genuinely returns a readable boolean.
    const [row] = await db!.$queryRaw<{ locked: boolean }[]>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
    );
    assert.equal(typeof row.locked, "boolean");
});

test("two overlapping claims never hand out the same row", { skip }, async () => {
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
    const ids = ["claimdb-a", "claimdb-b", "claimdb-c"];
    for (const id of ids) await seed(id);

    const now = new Date();
    const claimOnce = async () =>
        db!.$transaction(async tx => {
            const [lock] = await tx.$queryRaw<{ locked: boolean }[]>(
                Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${CLAIM_LOCK_KEY}, 0)) AS locked`,
            );
            if (!lock?.locked) return null;
            const due = await tx.receiptIntake.findMany({
                where: {
                    sourceRef: { startsWith: PREFIX },
                    state: { in: ["RECEIVED", "READ", "BOOKING"] },
                    OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
                },
                select: { id: true },
            });
            if (due.length === 0) return [];
            await tx.receiptIntake.updateMany({
                where: { id: { in: due.map(r => r.id) } },
                data: { nextRetryAt: new Date(now.getTime() + 10 * 60_000) },
            });
            return due.map(r => r.id);
        });

    const first = await claimOnce();
    const second = await claimOnce();

    assert.deepEqual([...(first ?? [])].sort(), ids.slice().sort(), "the first claim takes them");
    // The lease is what guarantees this, not the lock: the lock is released the
    // moment the first transaction commits.
    assert.deepEqual(second, [], "the second claim finds nothing left");

    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
});

test("SHADOW_DONE and the new columns are writable — the CHECK really allows them", { skip }, async () => {
    // The cutover writes SHADOW_DONE on every shadow row in ONE statement. If
    // the CHECK constraint did not allow it, that fails inside the claim
    // transaction and takes the whole cutover with it.
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
    await seed("claimdb-shadow", {
        state: "SHADOW_DONE",
        stateReason: "booked-by-v1",
        archivedByV1: true,
        sendAttempted: false,
        expectedSha256: "y".repeat(64),
    });
    const row = await db!.receiptIntake.findUnique({ where: { id: "claimdb-shadow" } });
    assert.equal(row?.state, "SHADOW_DONE");
    assert.equal(row?.archivedByV1, true);
    assert.equal(row?.expectedSha256, "y".repeat(64));

    // And an invented state is still refused.
    await assert.rejects(
        () => seed("claimdb-bogus", { state: "NOT_A_STATE" }),
        /violates check constraint|check constraint/i,
    );

    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
});

test.after(async () => {
    if (db) {
        await db.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } }).catch(() => {});
        await db.$disconnect();
    }
});
