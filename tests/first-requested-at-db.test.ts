/**
 * PaymentSchedule.firstRequestedAt, against a REAL PostgreSQL.
 *
 * tests/first-requested-at.test.ts covers the SQL text, the writer manifest
 * and the migration/apply-script twin with a fake database. What only a real
 * Postgres can prove is the set-once stamp's concurrency behavior: that the
 * IS NULL guard and the COALESCE are re-evaluated against the COMMITTED row
 * when a statement was blocked on a row lock (milestone-request-stamp.ts),
 * not against a value read before the wait.
 *
 * D4/D5 do not infer "the second transaction waited" from a fixed sleep — a
 * sleep only proves the wall clock passed, not that Postgres actually blocked
 * anything. Instead they poll a THIRD connection until pg_stat_activity shows
 * a backend in this database with wait_event_type = 'Lock', and fail loudly
 * if that is never observed within 10s.
 *
 * Opt-in by URL, like tests/qbo-client-lock-db.test.ts: a normal unit run
 * must never be able to write to a developer database. CI's `migrations` job
 * supplies the URL from its Postgres service container.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { stampFirstRequested } from "../src/lib/milestone-request-stamp";
import { statements } from "../scripts/apply-first-requested-at.mjs";

const databaseUrl = process.env.FIRST_REQUESTED_AT_TEST_URL;
const skip = !databaseUrl && "set FIRST_REQUESTED_AT_TEST_URL to a disposable PostgreSQL URL";

const ID = {
    client: "cli-frtest",
    project: "proj-frtest",
    invoiceA: "inv-frtest",
    invoiceB: "inv-frtest-other",
};

async function teardown(db: PrismaClient) {
    await db.paymentSchedule.deleteMany({ where: { invoiceId: { in: [ID.invoiceA, ID.invoiceB] } } });
    await db.invoice.deleteMany({ where: { id: { in: [ID.invoiceA, ID.invoiceB] } } });
    await db.project.deleteMany({ where: { id: ID.project } });
    await db.client.deleteMany({ where: { id: ID.client } });
}

async function seed(db: PrismaClient) {
    await teardown(db);
    await db.client.create({ data: { id: ID.client, name: "First Request Test", initials: "FR" } });
    await db.project.create({ data: { id: ID.project, name: "First Request Test Project", clientId: ID.client } });
    await db.invoice.create({ data: { id: ID.invoiceA, code: "INV-FRTEST", projectId: ID.project, clientId: ID.client } });
    await db.invoice.create({ data: { id: ID.invoiceB, code: "INV-FRTEST-2", projectId: ID.project, clientId: ID.client } });
}

function seedMilestone(
    db: PrismaClient,
    id: string,
    opts: {
        invoiceId?: string;
        status?: string;
        qbInvoiceSentAt?: Date | null;
        firstRequestedAt?: Date | null;
    } = {},
) {
    return db.paymentSchedule.create({
        data: {
            id,
            invoiceId: opts.invoiceId ?? ID.invoiceA,
            name: id,
            amount: 100,
            status: opts.status ?? "Pending",
            qbInvoiceSentAt: opts.qbInvoiceSentAt ?? null,
            firstRequestedAt: opts.firstRequestedAt ?? null,
        },
    });
}

async function readSchedule(db: PrismaClient, id: string) {
    const row = await db.paymentSchedule.findUniqueOrThrow({ where: { id } });
    return { first: row.firstRequestedAt, last: row.qbInvoiceSentAt };
}

// Helpers mirroring the two writers exactly.
function wholeInvoiceSend(db: any, invoiceId: string, ids: string[], at: Date) {
    return db.$transaction([
        stampFirstRequested(db, invoiceId, ids, at),
        db.paymentSchedule.updateMany({ where: { invoiceId, status: "Pending", id: { in: ids } }, data: { qbInvoiceSentAt: at } }),
    ]);
}

function milestoneSend(db: any, invoiceId: string, ids: string[], at: Date) {
    return db.$transaction([
        stampFirstRequested(db, invoiceId, ids, at),
        ...ids.map((id: string) => db.paymentSchedule.update({ where: { id }, data: { qbInvoiceSentAt: at } })),
    ]);
}

/** Poll a separate connection until Postgres shows a backend blocked on a
 *  row lock in this database. Throws if that is never observed. */
async function waitUntilBlocked(monitor: PrismaClient, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const rows = await monitor.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
        `;
        if (Number(rows[0]?.n ?? 0) > 0) return;
        if (Date.now() >= deadline) {
            throw new Error("expected a second transaction to be waiting on a row lock, but none was observed within 10s");
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * Hold `hold` open on a dedicated connection (dbA), start `attempt` on a
 * second dedicated connection (dbB) once dbA's write is in place, wait for
 * Postgres to actually show dbB blocked on the row lock (waitUntilBlocked),
 * THEN release dbA. Returns dbB's result.
 */
async function runWhileBlocking<T>(
    monitor: PrismaClient,
    hold: (tx: any) => Promise<void>,
    attempt: (dbB: PrismaClient) => Promise<T>,
): Promise<T> {
    const dbA = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const dbB = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        let release: () => void = () => {};
        const held = new Promise<void>((r) => { release = r; });
        let opened = false;
        const holder = dbA.$transaction(async (tx) => {
            await hold(tx);
            opened = true;
            await held;
        }, { maxWait: 10_000, timeout: 20_000 });
        while (!opened) await new Promise((r) => setTimeout(r, 10));

        let settled = false;
        const running = attempt(dbB).then((r) => { settled = true; return r; });

        await waitUntilBlocked(monitor);
        assert.equal(settled, false, "the second transaction must WAIT on the lock — finishing here means it took none");

        release();
        await holder;
        return await running;
    } finally {
        await dbA.$disconnect();
        await dbB.$disconnect();
    }
}

test("D1: first send sets both; a resend moves only qbInvoiceSentAt", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await seedMilestone(db, "ps-frtest-d1a");
        await seedMilestone(db, "ps-frtest-d1b");

        const t1 = new Date("2026-06-01T00:00:00.123Z");
        const t2 = new Date("2026-09-20T00:00:00.123Z");

        // Whole-invoice path.
        await wholeInvoiceSend(db, ID.invoiceA, ["ps-frtest-d1a"], t1);
        await wholeInvoiceSend(db, ID.invoiceA, ["ps-frtest-d1a"], t2);
        const a = await readSchedule(db, "ps-frtest-d1a");
        assert.equal(a.first!.toISOString(), t1.toISOString());
        assert.equal(a.last!.toISOString(), t2.toISOString());

        // Per-milestone path.
        await milestoneSend(db, ID.invoiceA, ["ps-frtest-d1b"], t1);
        await milestoneSend(db, ID.invoiceA, ["ps-frtest-d1b"], t2);
        const b = await readSchedule(db, "ps-frtest-d1b");
        assert.equal(b.first!.toISOString(), t1.toISOString());
        assert.equal(b.last!.toISOString(), t2.toISOString());
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("D2: a row requested before the column keeps its EARLIER send as the first request", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        const T0 = new Date("2026-05-01T00:00:00.123Z");
        await seedMilestone(db, "ps-frtest-d2", { qbInvoiceSentAt: T0, firstRequestedAt: null });

        const t3 = new Date("2026-09-20T00:00:00.123Z");
        await milestoneSend(db, ID.invoiceA, ["ps-frtest-d2"], t3);

        const row = await readSchedule(db, "ps-frtest-d2");
        assert.equal(row.first!.toISOString(), T0.toISOString());
        assert.equal(row.last!.toISOString(), t3.toISOString());
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("D3: non-Pending rows and other invoices' rows never get a first request", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await seedMilestone(db, "ps-frtest-d3-paid", { status: "Paid" });
        await seedMilestone(db, "ps-frtest-d3-other", { invoiceId: ID.invoiceB });

        const at = new Date("2026-09-20T00:00:00.123Z");
        await wholeInvoiceSend(db, ID.invoiceA, ["ps-frtest-d3-paid", "ps-frtest-d3-other"], at);

        const paid = await readSchedule(db, "ps-frtest-d3-paid");
        const other = await readSchedule(db, "ps-frtest-d3-other");
        assert.equal(paid.first, null);
        assert.equal(other.first, null);
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("D4: two concurrent sends: only the first sets it", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const monitor = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await seedMilestone(db, "ps-frtest-d4");

        const tA = new Date("2026-09-18T00:00:00.123Z");
        const tB = new Date("2026-09-20T00:00:00.123Z");

        const result = await runWhileBlocking(
            monitor,
            async (tx) => {
                await stampFirstRequested(tx, ID.invoiceA, ["ps-frtest-d4"], tA);
                await tx.paymentSchedule.update({ where: { id: "ps-frtest-d4" }, data: { qbInvoiceSentAt: tA } });
            },
            (dbB) => milestoneSend(dbB, ID.invoiceA, ["ps-frtest-d4"], tB),
        );
        const [stampCount] = result as [number, unknown];
        assert.equal(stampCount, 0, "B's stamp must see the row already claimed and update nothing");

        const row = await readSchedule(db, "ps-frtest-d4");
        assert.equal(row.first!.toISOString(), tA.toISOString());
        assert.equal(row.last!.toISOString(), tB.toISOString());
    } finally {
        await teardown(db);
        await db.$disconnect();
        await monitor.$disconnect();
    }
});

test("D5: an old-build send landing mid-flight is not lost", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const monitor = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await seedMilestone(db, "ps-frtest-d5");

        const tOld = new Date("2026-09-18T00:00:00.123Z");
        const tNew = new Date("2026-09-20T00:00:00.123Z");

        const result = await runWhileBlocking(
            monitor,
            async (tx) => {
                await tx.paymentSchedule.update({ where: { id: "ps-frtest-d5" }, data: { qbInvoiceSentAt: tOld } });
            },
            (dbB) => milestoneSend(dbB, ID.invoiceA, ["ps-frtest-d5"], tNew),
        );
        const [stampCount] = result as [number, unknown];
        assert.equal(stampCount, 1, "B's stamp must run: the row was still unset when it re-read after A committed");

        const row = await readSchedule(db, "ps-frtest-d5");
        assert.equal(row.first!.toISOString(), tOld.toISOString(), "SET re-reads the just-committed row, not a stale value read before the wait");
        assert.equal(row.last!.toISOString(), tNew.toISOString());
    } finally {
        await teardown(db);
        await db.$disconnect();
        await monitor.$disconnect();
    }
});

test("D6: the backfill copies qbInvoiceSentAt once and is a no-op on re-run", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        const T0 = new Date("2026-05-01T00:00:00.123Z");
        const T1 = new Date("2026-06-01T00:00:00.123Z");
        const T2 = new Date("2026-09-01T00:00:00.123Z");

        await seedMilestone(db, "ps-frtest-d6a", { qbInvoiceSentAt: T0, firstRequestedAt: null });
        await seedMilestone(db, "ps-frtest-d6b", { qbInvoiceSentAt: T2, firstRequestedAt: T1 });
        await seedMilestone(db, "ps-frtest-d6c", { qbInvoiceSentAt: null, firstRequestedAt: null });

        const backfill = statements[1];
        const first = await db.$executeRawUnsafe(backfill);
        assert.equal(first, 1, "only the still-NULL, requested row is touched");

        const a = await readSchedule(db, "ps-frtest-d6a");
        const b = await readSchedule(db, "ps-frtest-d6b");
        const c = await readSchedule(db, "ps-frtest-d6c");
        assert.equal(a.first!.toISOString(), T0.toISOString());
        assert.equal(a.last!.toISOString(), T0.toISOString());
        assert.equal(b.first!.toISOString(), T1.toISOString());
        assert.equal(b.last!.toISOString(), T2.toISOString());
        assert.equal(c.first, null);
        assert.equal(c.last, null);

        const second = await db.$executeRawUnsafe(backfill);
        assert.equal(second, 0, "re-run touches nothing");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});

test("D7: a non-UTC session time zone does not shift the stamped instant, and the deposit-matching bound reads it correctly", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
        await seed(db);
        await seedMilestone(db, "ps-frtest-d7");

        // A fixed instant with non-zero milliseconds, chosen so that shifting it
        // by America/Los_Angeles's offset (UTC-7 in September) lands on a
        // DIFFERENT calendar day than the true instant — the exact failure mode
        // the cast bug produces.
        const at = new Date("2026-09-20T02:00:00.123Z");

        await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/Los_Angeles'`);
            await stampFirstRequested(tx as any, ID.invoiceA, ["ps-frtest-d7"], at);
            await tx.paymentSchedule.update({ where: { id: "ps-frtest-d7" }, data: { qbInvoiceSentAt: at } });
        });

        const row = await readSchedule(db, "ps-frtest-d7");
        assert.equal(
            row.first!.toISOString(),
            at.toISOString(),
            "firstRequestedAt must be the true UTC instant regardless of the session's time zone",
        );
        assert.equal(row.last!.toISOString(), at.toISOString());

        // The exact deposit-matching where-clause from
        // src/app/api/payments/deposit-ingest/route.ts's matchAndApplyBank,
        // scoped to this seeded row by id (the seeded invoice defaults to
        // Draft, outside OPEN_INVOICE_STATUSES, so the invoice-status arm of
        // the real where-clause is left out here rather than faked).
        async function isCandidate(requestedBy: Date): Promise<boolean> {
            const rows = await db.paymentSchedule.findMany({
                where: {
                    status: "Pending",
                    id: "ps-frtest-d7",
                    OR: [
                        { firstRequestedAt: { not: null, lte: requestedBy } },
                        { firstRequestedAt: null, qbInvoiceSentAt: { not: null, lte: requestedBy } },
                    ],
                },
            });
            return rows.length === 1;
        }

        const before = new Date(at.getTime() - 30 * 60_000);
        const after = new Date(at.getTime() + 60_000);
        assert.equal(await isCandidate(before), false, "a requestedBy 30 minutes before the true instant must NOT match");
        assert.equal(await isCandidate(after), true, "a requestedBy 1 minute after the true instant must match");
    } finally {
        await teardown(db);
        await db.$disconnect();
    }
});
