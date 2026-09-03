/**
 * TWO REAL CONNECTIONS, contending over a team member's PAY TYPE while a pay
 * period is being read and frozen.
 *
 * The race this closes (round 33, finding 1). lockPayrollPeriod holds the
 * EXCLUSIVE payroll advisory lock, recomputes the CSVs through its own
 * transaction, hashes them, and commits. The recompute reads the roster with an
 * ordinary `user.findMany` — it held nothing — and no pay-type or rate writer
 * took the payroll advisory lock at all. So a pay type could be changed AFTER
 * the "confirmed" read and BEFORE the commit, and the period was frozen around
 * a roster that had already moved. payType is not decoration in that file: it
 * decides whether somebody is on the Gusto export as an hourly employee.
 *
 * Two independent defences, and this file proves each on its own:
 *
 *  1. every rate / pay-type writer takes the SHARED payroll advisory lock
 *     before its row lock, so it waits for a period being locked;
 *  2. the export re-reads the roster's User rows FOR SHARE inside the caller's
 *     transaction, so a writer that somehow skips (1) still blocks until the
 *     lock commits — and the values that get hashed are the ones held.
 *
 * tests/pay-rate-write.test.ts pins the SHAPE of (1) from a recording fake:
 * which lock is taken, and in what order. It cannot show that PostgreSQL
 * actually holds the writer off. This does, on a disposable database.
 *
 * Opt-in by URL, like every other DB test here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-paytype-lock";
// The app's prisma singleton (imported by pay-rate-write.ts) refuses a URL
// without pgbouncer=true — that guard is production safety, so it is satisfied
// rather than weakened. Nothing here uses the singleton: every call gets an
// explicit client, so the two connections stay two connections.
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
const ADMIN = { role: "ADMIN" };
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
 * A settings pair the export can read, plus one ACTIVATED HOURLY team member
 * WHO ACTUALLY PUNCHED inside the period — enough to put exactly one known row
 * on the roster, and to keep it there across a pay-type change.
 *
 * The punch is load-bearing, not decoration. loadGustoExport's roster is
 * `ACTIVATED && payType HOURLY` OR `punched inside the period`, so a member with
 * NO hours leaves the roster entirely the moment they become SALARY — correctly:
 * a salaried person with no punches has nothing to say on a Gusto hours file.
 * Seeded without hours, this test's closing re-read found no row at all and read
 * `undefined` where it meant to read the NEW pay type, which says nothing about
 * whether the lock held. One punch inside the period keeps the same person on
 * the roster under both pay types, so the before/after comparison is about the
 * value that changed rather than about roster membership.
 *
 * The singleton rows are RESTORED, not deleted: they are shared with every
 * other test in this CI job. The user, their punch and its job are removed.
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

    const email = `paytype-lock-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email } });
    const user = await db.user.create({
        data: {
            name: `Pay Type ${suffix}`,
            email,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 28.5,
        },
        select: { id: true, email: true },
    });

    // One closed 8-hour punch, inside the period and inside one workweek, so it
    // adds hours without adding overtime. TimeEntry.projectId is NOT NULL and
    // Project.clientId is too, so both come along; every id is suffixed, so the
    // three tests in this file never collide.
    const clientId = `paytype-client-${suffix}`;
    const projectId = `paytype-project-${suffix}`;
    const entryId = `paytype-entry-${suffix}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Pay Type Lock','PL')`,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Pay Type Lock Job',$2,now())`,
        projectId,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "TimeEntry" ("id","userId","projectId","startTime","endTime","durationHours","updatedAt")
         VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,8,now())`,
        entryId,
        user.id,
        projectId,
        PUNCH_START,
        PUNCH_END
    );

    return {
        user,
        restore: async () => {
            // Entry first: TimeEntry.userId and .projectId are both RESTRICT, so
            // the person and the job cannot go while the punch still points at
            // them.
            await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, entryId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, projectId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, clientId).catch(() => {});
            await db.user.deleteMany({ where: { email } }).catch(() => {});
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

test("the export's FOR SHARE blocks a concurrent pay-type change, and hashes the value it held", { skip }, async () => {
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    const { applyRateChange } = await import("../src/lib/pay-rate-write");
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, restore } = await seed(reader, "share");

    try {
        // Connection A: the export, inside a transaction, HOLDING after its read
        // — exactly the window lockPayrollPeriod occupies between recomputing
        // the CSVs and committing the frozen hash.
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let sawSalaried: boolean | null = null;
        let sawHours: number | null = null;
        let sawHash: string | null = null;

        const exporting = reader.$transaction(
            async (tx) => {
                const result = await loadGustoExport(PERIOD_START, PERIOD_END, {
                    client: tx,
                    startKey: START_KEY,
                    endKey: END_KEY,
                });
                const row = result.employees.find((employee) => employee.user.id === user.id);
                assert.ok(row, "the seeded hourly member is on this period's roster");
                sawSalaried = row.salaried;
                sawHours = row.totalHours;
                sawHash = result.exportHash;
                await held;
            },
            { timeout: 30_000 }
        );

        // Let A actually reach and pass its locks.
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(sawSalaried, false, "the export read the pay type it is about to hash a period around");
        // The seeded punch really is in this period. If it ever stopped being,
        // roster membership would go back to depending on payType alone and the
        // closing re-read below would quietly stop testing anything.
        assert.equal(sawHours, 8, "and the hours it is about to freeze");

        // Connection B: somebody switches that member to salaried, through the
        // real writer every route and the rates panel use. It must WAIT.
        const change = applyRateChange(ADMIN, user.id, { payType: "SALARY" }, writer as never);
        assert.equal(
            await stillPending(change, 1_000),
            true,
            "a pay-type change must block while a period is mid-read — it decides who is on the Gusto file"
        );

        release();
        await exporting;
        const result = await change;
        assert.equal(result.ok, true, "and it lands once the export is done");

        // The snapshot the export would have frozen describes the value it
        // held, not the one that committed afterwards.
        assert.equal(sawSalaried, false);
        assert.equal(typeof sawHash, "string");
        const after = await reader.user.findUnique({ where: { id: user.id }, select: { payType: true } });
        assert.equal(after?.payType, "SALARY");

        // And a fresh read now sees the change — so the first read was a
        // snapshot, not a stale cache. The seeded punch is what keeps this
        // person on the roster under BOTH pay types (see seed): without it the
        // row is simply absent here and `salaried` reads undefined, which would
        // prove nothing about the lock.
        const reread = await loadGustoExport(PERIOD_START, PERIOD_END, { startKey: START_KEY, endKey: END_KEY });
        const rereadRow = reread.employees.find((employee) => employee.user.id === user.id);
        assert.ok(rereadRow, "the member still has hours in this period, so they are still on the roster");
        assert.equal(rereadRow.salaried, true, "and the fresh read sees the pay type that committed after the export");
        assert.notEqual(reread.exportHash, sawHash, "a pay-type change really does change the frozen bytes");
    } finally {
        await restore();
        await reader.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("a pay-type or rate write WAITS for the payroll advisory lock", { skip }, async () => {
    // The other half, and the one that keeps the FOR SHARE above deadlock-free:
    // a writer takes the payroll lock BEFORE any User row, so it can never hold
    // a row while waiting for the period. Hold the EXACT key lock creation
    // takes; if the writer ever stopped taking it, this would not block.
    const { applyRateChange } = await import("../src/lib/pay-rate-write");
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, restore } = await seed(holder, "advisory");

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

        const write = applyRateChange(ADMIN, user.id, { payType: "SALARY" }, writer as never);
        assert.equal(
            await stillPending(write, 1_000),
            true,
            "a pay-type change must serialise on the payroll lock, not just on the row"
        );

        release();
        await holding;
        assert.equal((await write).ok, true, "and it lands once the period is done");
        const after = await holder.user.findUnique({ where: { id: user.id }, select: { payType: true } });
        assert.equal(after?.payType, "SALARY");
    } finally {
        await restore();
        await holder.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});

test("the rate half of the same writer also waits", { skip }, async () => {
    const { applyRateChange } = await import("../src/lib/pay-rate-write");
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, restore } = await seed(holder, "advisory-rate");

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

        const write = applyRateChange(ADMIN, user.id, { hourlyRate: "31.00" }, writer as never);
        assert.equal(await stillPending(write, 1_000), true, "hourlyRate is an export input too — it prices the hours");

        release();
        await holding;
        assert.equal((await write).ok, true);
        const after = await holder.user.findUnique({ where: { id: user.id }, select: { hourlyRate: true } });
        assert.equal(after?.hourlyRate.toFixed(2), "31.00");
    } finally {
        await restore();
        await holder.$disconnect().catch(() => {});
        await writer.$disconnect().catch(() => {});
    }
});
