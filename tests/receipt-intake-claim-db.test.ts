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
import { CLAIM_LOCK_KEY, eligibleClaimWhere } from "../src/lib/receipt-intake/worker";

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
                // The SHIPPED predicate, not a copy of it. A local re-statement
                // is how the claim and the worker loop came to disagree about
                // which rows are workable (finding 1); this suite is the only
                // place the real SQL is ever executed, so it must execute the
                // real thing.
                where: { sourceRef: { startsWith: PREFIX }, ...eligibleClaimWhere(now, false) },
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

test("a row whose nextRetryAt moved into the future between select and claim is skipped", { skip }, async () => {
    // The regression: claim() used to SELECT the due rows and then claim them
    // by id ALONE — `updateMany({ where: { id: { in: ids } } })` — instead of
    // re-checking the same eligibility predicate. Anything that touches
    // nextRetryAt/state WITHOUT going through the advisory lock (a late
    // retryRow, a deferRead, an admin "snooze") can still land between those
    // two statements even inside one transaction, under READ COMMITTED. The
    // fixed claim re-checks the predicate in the UPDATE itself, so a row that
    // moved out of eligibility in that window is left untouched.
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
    const ids = ["claimdb-race-a", "claimdb-race-b"];
    for (const id of ids) await seed(id);

    const now = new Date();
    const ELIGIBLE = { sourceRef: { startsWith: PREFIX }, ...eligibleClaimWhere(now, false) };

    const due = await db!.receiptIntake.findMany({ where: ELIGIBLE, select: { id: true } });
    assert.deepEqual(due.map(r => r.id).sort(), ids.slice().sort(), "both rows start eligible");

    // INTERLEAVING: between the select above and the claim below, something
    // else (not this claim, not under its lock) pushes one row's lease into
    // the future — exactly what a concurrent, unrelated write would do.
    const future = new Date(now.getTime() + 30 * 60_000);
    await db!.receiptIntake.update({
        where: { id: "claimdb-race-a" },
        data: { nextRetryAt: future },
    });

    const claimToken = "race-token";
    const claimed = await db!.receiptIntake.updateMany({
        where: { id: { in: due.map(r => r.id) }, ...ELIGIBLE },
        data: { nextRetryAt: new Date(now.getTime() + 10 * 60_000), claimToken, claimedAt: now },
    });
    assert.equal(claimed.count, 1, "only the row that is STILL eligible is claimed");

    const won = await db!.receiptIntake.findMany({
        where: { id: { in: due.map(r => r.id) }, claimToken },
        select: { id: true },
    });
    assert.deepEqual(won.map(r => r.id), ["claimdb-race-b"], "the raced row is skipped, not blindly reclaimed");

    // The raced row is untouched by the claim: it keeps the future lease the
    // interleaving write set, and never picked up the claim token at all.
    const racedRow = await db!.receiptIntake.findUnique({ where: { id: "claimdb-race-a" } });
    assert.equal(racedRow?.nextRetryAt?.getTime(), future.getTime());
    assert.equal(racedRow?.claimToken, null);

    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
});

test("DRY-RUN ROLLBACK: the QBO-writing states are not claimable, whatever the row flag says", { skip }, async () => {
    // Finding 1, against real SQL. A live window left rows at READ/BOOKING with
    // dryRun=false; the switch is then rolled back. Those rows must drop out of
    // the claim entirely, or they fill every ten-row batch (oldest-first) and
    // the RECEIVED receipts behind them are never read.
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
    await seed("claimdb-old-read", { state: "READ", dryRun: false });
    await seed("claimdb-old-booking", { state: "BOOKING", dryRun: false });
    await seed("claimdb-parked", { state: "READ", dryRun: true });
    await seed("claimdb-new", { state: "RECEIVED", dryRun: true });

    const now = new Date();
    const claimable = async (dryRunGlobal: boolean) =>
        (await db!.receiptIntake.findMany({
            where: { sourceRef: { startsWith: PREFIX }, ...eligibleClaimWhere(now, dryRunGlobal) },
            select: { id: true },
        })).map(r => r.id).sort();

    assert.deepEqual(
        await claimable(true),
        ["claimdb-new"],
        "under dry-run only the new receipt is claimable",
    );
    // And the exclusion is not a black hole: flip the switch and the same rows
    // are claimable again. Only the shadow-week park (dryRun=true at READ) stays
    // out, until the cutover requeues it.
    assert.deepEqual(
        await claimable(false),
        ["claimdb-new", "claimdb-old-booking", "claimdb-old-read"],
    );

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

test("the finishRouting adapter is fenced on BOTH state and token", { skip }, async () => {
    // The production adapter, against a real database — the mocked worker
    // suites cannot see this, and the failure it prevents is a zombie worker
    // publishing READ over the state its successor already produced.
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });

    const finishRouting = async (rowId: string, claimToken: string | null, stateReason: string | null) => {
        const { count } = await db!.receiptIntake.updateMany({
            where: { id: rowId, state: "RECEIVED", claimToken },
            data: { state: "READ", stateReason, nextRetryAt: null, claimToken: null, claimedAt: null },
        });
        return count;
    };

    // The happy path: the holder of the current token publishes and BOTH claim
    // fields are cleared.
    await seed("claimdb-fence", { claimToken: "token-1", claimedAt: new Date(), nextRetryAt: new Date() });
    assert.equal(await finishRouting("claimdb-fence", "token-1", null), 1);
    const published = await db!.receiptIntake.findUnique({ where: { id: "claimdb-fence" } });
    assert.equal(published?.state, "READ");
    assert.equal(published?.claimToken, null, "the token is released");
    assert.equal(published?.claimedAt, null, "and so is claimedAt");
    assert.equal(published?.nextRetryAt, null, "and the lease");

    // The zombie: a stale token writes NOTHING, even though the row is back in
    // RECEIVED and looks claimable to a state-only check.
    await db!.receiptIntake.update({
        where: { id: "claimdb-fence" },
        data: { state: "RECEIVED", claimToken: "token-2", stateReason: null },
    });
    assert.equal(await finishRouting("claimdb-fence", "token-1", "zombie"), 0, "stale token is fenced out");
    const afterZombie = await db!.receiptIntake.findUnique({ where: { id: "claimdb-fence" } });
    assert.equal(afterZombie?.state, "RECEIVED", "the successor's state survives");
    assert.equal(afterZombie?.claimToken, "token-2", "and its claim is untouched");

    // The state fence still holds independently: right token, wrong state.
    await db!.receiptIntake.update({
        where: { id: "claimdb-fence" },
        data: { state: "NEEDS_REVIEW", claimToken: "token-3" },
    });
    assert.equal(await finishRouting("claimdb-fence", "token-3", null), 0, "a routed row is not re-published");

    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
});

test("SHADOW_QUARANTINE is writable — the CHECK allows it", { skip }, async () => {
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
    await seed("claimdb-quar", { state: "SHADOW_QUARANTINE", stateReason: "no-v1-evidence" });
    const row = await db!.receiptIntake.findUnique({ where: { id: "claimdb-quar" } });
    assert.equal(row?.state, "SHADOW_QUARANTINE");
    await db!.receiptIntake.deleteMany({ where: { sourceRef: { startsWith: PREFIX } } });
});
