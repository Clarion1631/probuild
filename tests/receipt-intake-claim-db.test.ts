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
import { lockQboExpense } from "../src/lib/qbo-expense-sync";
import { reconcileExistingExpense } from "../src/lib/receipt-intake/book";

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

test("the PER-OBJECT lock really is mutually exclusive, and really is per path", { skip }, async () => {
    // The lock that stops the storage-cleanup sweep deleting an object a
    // publish has sealed but not yet committed. The unit suites drive it
    // through a fake, so this is the only place the SQL itself is exercised:
    // that `hashtext('receipt-object:' || $1)` is a legal argument to
    // pg_advisory_xact_lock (hashtext returns int4, which has to widen to the
    // bigint overload), that $executeRaw is the right verb for a void return,
    // and that two concurrent transactions on the same path actually serialize.
    // A DIFFERENT path does not block: the try-variant succeeds while the
    // first transaction still holds its own lock.
    const other = await db!.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('receipt-object:' || ${"receipts/a/v1/aa.png"}))`;
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext('receipt-object:' || ${"receipts/b/v1/bb.png"})) AS locked`,
        );
        return row.locked;
    });
    assert.equal(other, true, "two different object paths never wait on each other");

    // The SAME path does: the second attempt is refused while the first
    // transaction holds it, and granted once that transaction has ended.
    const same = await db!.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('receipt-object:' || ${"receipts/a/v1/aa.png"}))`;
        // A SEPARATE connection, so this is a real contender rather than the
        // same transaction re-entering its own lock (which always succeeds).
        const [row] = await db!.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext('receipt-object:' || ${"receipts/a/v1/aa.png"})) AS locked`,
        );
        return row.locked;
    });
    assert.equal(same, false, "a second holder of the SAME path is made to wait");

    // ...and the lock is transaction scoped, so it is gone now. pgbouncer's
    // transaction pooling is why it has to be: a session lock would be taken on
    // a connection handed straight to somebody else, and released never.
    const [after] = await db!.$queryRaw<{ locked: boolean }[]>(
        Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext('receipt-object:' || ${"receipts/a/v1/aa.png"})) AS locked`,
    );
    assert.equal(after.locked, true, "the lock was released when its transaction ended");
});

// ── The importer-wins race, against a REAL Postgres (round-12 item 2) ───────
//
// The expected crash gap: the worker creates the QBO Purchase, dies before its
// commit, and `syncQboExpenses` imports that Purchase before the retry comes
// round. The retry then finds an Expense it did not write — right about the
// money, silent about this receipt, because `QboExpenseWrite` carries neither
// `costCodeId` nor `receiptUrl`.
//
// The unit suite drives `reconcileExistingExpense` directly. What it cannot
// show is that the two writers actually take the SAME advisory lock, and that
// the reconcile survives a real `Decimal` column and a real `@db.Timestamptz`
// round trip — a `Number(Decimal)` that lost a cent, or a date that came back
// in a different anchor, would park every imported receipt in production while
// every mock stayed green.

const EXPENSE_PREFIX = "QBTEST-";

async function cleanupExpenses() {
    await db!.expense.deleteMany({ where: { qbPurchaseId: { startsWith: EXPENSE_PREFIX } } });
    await db!.estimate.deleteMany({ where: { code: { startsWith: EXPENSE_PREFIX } } });
}

/**
 * A disposable Estimate to hang the Expense off. CREATED, never found: CI's
 * database is built from migrations with no seed data, so a test that skipped
 * when it could not find one would be a silent no-op in the one place it is
 * meant to run. Estimate needs no foreign key of its own.
 */
async function disposableEstimateId(): Promise<string> {
    const estimate = await db!.estimate.create({
        data: {
            title: "receipt-intake expense reconcile",
            code: `${EXPENSE_PREFIX}EST`,
            totalAmount: new Prisma.Decimal("0"),
            balanceDue: new Prisma.Decimal("0"),
        },
        select: { id: true },
    });
    return estimate.id;
}

test("the per-Purchase lock is SHARED, and it really serializes", { skip }, async () => {
    // lockQboExpense is exported from qbo-expense-sync and called by book.ts —
    // one function, so the two writers cannot drift onto different keys. This
    // proves the SQL runs and that the key actually excludes a second holder.
    const purchaseId = `${EXPENSE_PREFIX}lock-1`;
    const blocked = await db!.$transaction(async tx => {
        await lockQboExpense(tx, purchaseId);
        const [row] = await db!.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${purchaseId}, 0)) AS locked`,
        );
        return row.locked;
    });
    assert.equal(blocked, false, "a second writer of the same Purchase id waits");

    // A DIFFERENT Purchase id never waits — the lock is per-Purchase, not global.
    const other = await db!.$transaction(async tx => {
        await lockQboExpense(tx, purchaseId);
        const [row] = await db!.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${EXPENSE_PREFIX}lock-2`}, 0)) AS locked`,
        );
        return row.locked;
    });
    assert.equal(other, true);
});

test("IMPORTER WINS: the retry reconciles a real imported Expense", { skip }, async () => {
    await cleanupExpenses();
    const estimateId = await disposableEstimateId();
    const qbPurchaseId = `${EXPENSE_PREFIX}race-1`;
    try {
        // The sync imports the Purchase first. Exactly what upsertQboExpense
        // writes — note the UTC-midnight date anchor and the absent cost code.
        const imported = await db!.expense.create({
            data: {
                estimateId,
                qbPurchaseId,
                qbSyncToken: "0",
                amount: new Prisma.Decimal("364.98"),
                vendor: "Lowes",
                date: new Date("2026-08-03T00:00:00.000Z"),
                description: "[QBO] Lowes",
                status: "Reviewed",
            },
            select: {
                id: true, estimateId: true, amount: true, vendor: true,
                date: true, costCodeId: true, receiptUrl: true,
            },
        });

        // The worker retry reads it back through the SAME select book.ts uses,
        // and reconciles against the receipt's canonical values.
        const verdict = reconcileExistingExpense(imported, {
            estimateId,
            amountCents: 36498,
            vendor: "Lowes",
            // The worker's own anchor: local midnight, hours away from the
            // importer's UTC marker for the same day.
            date: new Date("2026-08-03T07:00:00.000Z"),
            calendarDay: "2026-08-03",
            timeZone: "America/Los_Angeles",
            costCodeId: null,
            receiptUrl: "https://drive.google.com/file/d/FILE123/view",
        });

        // A real Decimal and a real Timestamptz round trip, and the two date
        // anchors, are all non-conflicts.
        assert.deepEqual(verdict.conflicts, [], "the imported row is not a conflict");
        assert.deepEqual(
            Object.keys(verdict.fill),
            ["receiptUrl"],
            "only the attribution the importer could not write",
        );

        await db!.expense.update({ where: { id: imported.id }, data: verdict.fill });
        const healed = await db!.expense.findUnique({
            where: { id: imported.id },
            select: { receiptUrl: true, amount: true, vendor: true },
        });
        assert.match(healed!.receiptUrl!, /FILE123/);
        assert.equal(Number(healed!.amount), 364.98, "and the money was not touched");

        // THE CONFLICTING VARIANT. A populated amount that disagrees is a real
        // contradiction about real money — it parks rather than linking.
        const conflicting = reconcileExistingExpense(
            { ...imported, amount: new Prisma.Decimal("401.11") },
            {
                estimateId,
                amountCents: 36498,
                vendor: "Lowes",
                date: new Date("2026-08-03T07:00:00.000Z"),
                calendarDay: "2026-08-03",
                timeZone: "America/Los_Angeles",
                costCodeId: null,
                receiptUrl: "https://drive.google.com/file/d/FILE123/view",
            },
        );
        assert.deepEqual(conflicting.conflicts, ["amount"]);
    } finally {
        await cleanupExpenses();
    }
});
