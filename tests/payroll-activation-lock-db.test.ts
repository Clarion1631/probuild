/**
 * TWO REAL CONNECTIONS, contending over a team member's ACTIVATION while a pay
 * period is being read and frozen.
 *
 * The race this closes (round 34, finding 2). loadGustoExport's roster is
 *
 *     (status = ACTIVATED AND payType = HOURLY)  OR  punched inside the period
 *
 * and it re-reads the rows that predicate RETURNED under FOR SHARE. A PENDING
 * hourly hire is not one of them. So:
 *
 *   lockPayrollPeriod   takes the exclusive payroll lock, reads the roster
 *                       (the pending hire is absent), hashes the CSVs, ...
 *   PATCH /api/users    sets that hire to ACTIVATED and COMMITS
 *   lockPayrollPeriod   ...COMMITS the reviewed hash
 *
 * and a pay period is frozen around a roster with one fewer person on it than
 * the database held at the instant of the commit. The export cannot defend
 * itself: the row it would need to hold is one its own query did not return,
 * and SELECT ... FOR SHARE can only lock rows a predicate MATCHED. That is the
 * same shape as the overlapping-period check (a predicate over rows that may
 * not qualify yet) and it has the same answer — an advisory lock, which
 * serialises against the predicate rather than against any row.
 *
 * Two halves, proven separately here:
 *
 *  1. an activation WAITS on the payroll advisory lock, so it cannot commit
 *     while a period is being locked;
 *  2. inside the lock's own transaction the roster does not move — the export
 *     read before an activation is attempted and the export read after it is
 *     blocked produce the same hash.
 *
 * tests/payroll-user-writer-manifest.test.ts pins the SHAPE (which call sites go
 * through withPayrollUserWrite). Only this file shows that PostgreSQL actually
 * holds the writer off.
 *
 * Opt-in by URL, like every other DB test here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-activation-lock";
// The app's prisma singleton (reachable through the modules imported below)
// refuses a URL without pgbouncer=true — production safety, satisfied rather
// than weakened. Nothing here uses the singleton: every call gets an explicit
// client, so the two connections stay two connections.
if (databaseUrl && !process.env.DATABASE_URL?.includes("pgbouncer=true")) {
    const url = new URL(databaseUrl);
    url.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = url.toString();
}

const TZ = "America/Los_Angeles";
const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");
const START_KEY = "2026-08-17";
const END_KEY = "2026-08-31";
/** 08:00-16:00 company-local on a Monday well inside the period — 8 hours, one week, no overtime. */
const PUNCH_START = "2026-08-24T15:00:00Z";
const PUNCH_END = "2026-08-24T23:00:00Z";
/** The key acquirePayrollLockCreationLock takes — see PAYROLL_ADVISORY_LOCK_KEY. */
const PAYROLL_LOCK_KEY = "payroll-period";

/** Resolves true once `promise` has not settled for `ms` — i.e. it is genuinely blocked. */
function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const marker = Symbol("pending");
    return Promise.race([
        promise.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

/**
 * EXACTLY what the wrapped routes do: open a transaction, and write the
 * activation through withPayrollUserWrite so the payroll advisory lock is taken
 * before the row is touched.
 *
 * Written out rather than driven through a route handler on purpose. The six
 * activation call sites are behind NextAuth sessions and Next's `after()`, and
 * a stubbed request would be proving something about the stub. That every one
 * of them really goes through this helper is the manifest test's job; this file
 * proves the helper does what it claims against a live PostgreSQL.
 */
async function activate(db: PrismaClient, userId: string, status = "ACTIVATED") {
    const { withPayrollUserWrite } = await import("../src/lib/payroll-period");
    return db.$transaction(
        async (tx) => {
            const data = { status };
            return withPayrollUserWrite(tx, data, () => tx.user.update({ where: { id: userId }, data }));
        },
        { timeout: 30_000 }
    );
}

/**
 * The settings pair the export reads, one ACTIVATED HOURLY member WITH a punch
 * inside the period (so the roster is never empty and the hash is never trivial),
 * and one PENDING HOURLY member who is NOT on the roster yet — the person this
 * whole file is about.
 *
 * The singleton rows are RESTORED, not deleted: they are shared with every other
 * test in this CI job. The users, the punch and its job are removed.
 */
async function seed(db: PrismaClient, suffix: string) {
    const { encryptObject } = await import("../src/lib/crypto");
    const priorCompany = await db.companySettings.findUnique({ where: { id: "singleton" } });
    const priorIntegration = await db.integration.findUnique({ where: { id: "system_settings" } });

    await db.companySettings.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", timeZone: TZ },
        update: { timeZone: TZ },
    });
    const settings = encryptObject({ gusto: { connected: true, employeeMappings: {} } });
    await db.integration.upsert({
        where: { id: "system_settings" },
        create: { id: "system_settings", settings },
        update: { settings },
    });

    const workerEmail = `activation-worker-${suffix}@example.test`;
    const pendingEmail = `activation-pending-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email: { in: [workerEmail, pendingEmail] } } });

    const worker = await db.user.create({
        data: {
            name: `Activation Worker ${suffix}`,
            email: workerEmail,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 28.5,
        },
        select: { id: true },
    });
    // The new hire. HOURLY already — the pay type is answered, so the only thing
    // keeping them off this period's file is their status.
    const pending = await db.user.create({
        data: {
            name: `Activation Pending ${suffix}`,
            email: pendingEmail,
            role: "FIELD_CREW",
            status: "PENDING",
            payType: "HOURLY",
            hourlyRate: 26,
        },
        select: { id: true },
    });

    const clientId = `activation-client-${suffix}`;
    const projectId = `activation-project-${suffix}`;
    const entryId = `activation-entry-${suffix}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Activation Lock','AL')`,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Activation Lock Job',$2,now())`,
        projectId,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "TimeEntry" ("id","userId","projectId","startTime","endTime","durationHours","updatedAt")
         VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,8,now())`,
        entryId,
        worker.id,
        projectId,
        PUNCH_START,
        PUNCH_END
    );

    return {
        worker,
        pending,
        restore: async () => {
            // Entry first: TimeEntry.userId and .projectId are both RESTRICT.
            await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, entryId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, projectId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, clientId).catch(() => {});
            await db.user.deleteMany({ where: { email: { in: [workerEmail, pendingEmail] } } }).catch(() => {});
            if (priorCompany) {
                await db.companySettings
                    .update({ where: { id: "singleton" }, data: { timeZone: priorCompany.timeZone } })
                    .catch(() => {});
            } else {
                await db.companySettings.delete({ where: { id: "singleton" } }).catch(() => {});
            }
            if (priorIntegration) {
                await db.integration
                    .update({ where: { id: "system_settings" }, data: { settings: priorIntegration.settings } })
                    .catch(() => {});
            } else {
                await db.integration.delete({ where: { id: "system_settings" } }).catch(() => {});
            }
        },
    };
}

test("activating a pending hourly member WAITS for the payroll lock", { skip }, async () => {
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { pending, restore } = await seed(holder, "advisory");

    try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Hold the EXACT key lock creation takes. If the activation writer ever
        // stopped taking it — or took a different one — this would not block,
        // and an activation would again be free to land mid-lock.
        const holding = holder.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, PAYROLL_LOCK_KEY);
                await held;
            },
            { timeout: 30_000 }
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        const write = activate(writer, pending.id);
        assert.equal(
            await stillPending(write, 1_000),
            true,
            "an activation must serialise on the payroll lock — status is half the Gusto roster predicate"
        );

        release();
        await holding;
        await write;
        const after = await holder.user.findUnique({ where: { id: pending.id }, select: { status: true } });
        assert.equal(after?.status, "ACTIVATED", "and it lands once the period is done");
    } finally {
        await restore();
        await holder.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("the roster cannot move between a lock's read and its COMMIT", { skip }, async () => {
    // The end-to-end invariant, in the shape lockPayrollPeriod actually runs:
    // exclusive payroll lock FIRST, then the recompute, then the commit. The
    // second recompute inside the same transaction is the falsifiable part —
    // under READ COMMITTED it WOULD see a concurrent activation that managed to
    // commit, so an unchanged hash is evidence that none did.
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const { acquirePayrollLockCreationLock } = await import("../src/lib/payroll-period");
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { worker, pending, restore } = await seed(locker, "roster");

    try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let firstRoster: string[] = [];
        let firstHash = "";
        let secondRoster: string[] = [];
        let secondHash = "";

        const locking = locker.$transaction(
            async (tx) => {
                await acquirePayrollLockCreationLock(tx as never);
                const before = await loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: START_KEY,
                    endKey: END_KEY,
                    timeZone: TZ,
                });
                firstRoster = before.employees.map((employee) => employee.user.id).sort();
                firstHash = before.exportHash;

                await held;

                const after = await loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: START_KEY,
                    endKey: END_KEY,
                    timeZone: TZ,
                });
                secondRoster = after.employees.map((employee) => employee.user.id).sort();
                secondHash = after.exportHash;
            },
            { timeout: 30_000 }
        );

        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.deepEqual(firstRoster, [worker.id], "the pending hire is NOT on the roster the lock is about to freeze");
        assert.ok(firstHash, "and there is a hash to compare against");

        // The activation the period lock has to survive.
        const write = activate(writer, pending.id);
        assert.equal(
            await stillPending(write, 1_000),
            true,
            "the activation must block while the period is being locked"
        );

        release();
        await locking;
        await write;

        assert.deepEqual(
            secondRoster,
            firstRoster,
            "the roster inside the lock's transaction must not have moved — this is the frozen hash's whole promise"
        );
        assert.equal(secondHash, firstHash, "and neither did the bytes it freezes");

        // THE CONTROL. Without it the two assertions above would pass just as
        // well against an activation that never changed anything: a fresh
        // export, after the transaction is done, must show the new hire on the
        // roster and a different hash.
        const fresh = await loadGustoExport(PERIOD_START, PERIOD_END, { startKey: START_KEY, endKey: END_KEY, timeZone: TZ });
        assert.deepEqual(
            fresh.employees.map((employee) => employee.user.id).sort(),
            [worker.id, pending.id].sort(),
            "the activation really does add somebody to this period's file"
        );
        assert.notEqual(fresh.exportHash, firstHash, "and really does change the bytes that would be frozen");
    } finally {
        await restore();
        await locker.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("a write that touches NO export column takes no payroll lock", { skip }, async () => {
    // The other edge, and the reason withPayrollUserWrite looks at the payload:
    // if every User write queued behind payroll, a project-access edit or a
    // "seen" timestamp would block for the duration of a pay-period lock, for no
    // guarantee at all. This must NOT block.
    const { withPayrollUserWrite } = await import("../src/lib/payroll-period");
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { pending, restore } = await seed(holder, "no-lock");

    try {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holding = holder.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, PAYROLL_LOCK_KEY);
                await held;
            },
            { timeout: 30_000 }
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        const write = writer.$transaction(async (tx) => {
            const data = { fieldUpdatesSeenAt: new Date() };
            return withPayrollUserWrite(tx, data, () => tx.user.update({ where: { id: pending.id }, data }));
        });
        assert.equal(
            await stillPending(write, 700),
            false,
            "a non-export column must not queue behind a pay period being locked"
        );

        release();
        await holding;
        await write;
    } finally {
        await restore();
        await holder.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});
