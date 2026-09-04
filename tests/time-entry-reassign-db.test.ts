/**
 * Concurrent reassignment of a time entry, against a REAL database.
 *
 * The PATCH and DELETE paths both authorize, price, lock and settle from a copy
 * of the row read BEFORE their transaction opens. If another writer reassigns
 * the entry in that window, every one of those decisions is about a different
 * person — and the same-date case is the nasty one, because the day key does
 * not change and a day-only comparison never notices.
 *
 * Opt-in by URL, like the other DB tests here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

const DAY = "2026-08-24";

type Seeded = { a: string; b: string; projectId: string; entryId: string; clientId: string };

async function seed(db: PrismaClient, tag: string): Promise<Seeded> {
    const a = `owner-a-${tag}`;
    const b = `owner-b-${tag}`;
    const clientId = `client-${tag}`;
    const projectId = `project-${tag}`;
    const entryId = `entry-${tag}`;
    for (const [id, name] of [[a, "Owner A"], [b, "Owner B"]] as const) {
        await db.$executeRawUnsafe(
            `INSERT INTO "User" ("id","email","name","role","status","hourlyRate","burdenRate","payType")
             VALUES ($1,$2,$3,'FIELD_CREW','ACTIVATED',25.00,5.00,'HOURLY')`,
            id,
            `${id}@example.test`,
            name
        );
    }
    // Client has NO updatedAt column, and `initials` is NOT NULL with no default.
    // I wrote this INSERT from the shape of the neighbouring Project insert
    // instead of from the schema, so it named a column that does not exist and
    // omitted one that is required.
    await db.$executeRawUnsafe(
        `INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Reassign Test','RT')`,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Reassign Job',$2,now())`,
        projectId,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "TimeEntry" ("id","userId","projectId","startTime","endTime","durationHours","updatedAt")
         VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,8,now())`,
        entryId,
        a,
        projectId,
        `${DAY}T15:00:00Z`,
        `${DAY}T23:00:00Z`
    );
    return { a, b, projectId, entryId, clientId };
}

async function cleanup(db: PrismaClient, ids: Seeded) {
    await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = $1`, ids.entryId).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, ids.projectId).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, ids.clientId).catch(() => {});
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" IN ($1,$2)`, ids.a, ids.b).catch(() => {});
}

test("a SAME-DATE A->B reassignment changes the day LOCK KEY, so it is detectable", { skip }, async () => {
    // The whole point. Both punches are on the same date, so any comparison of
    // the DAY alone reports "unchanged" — while the advisory key the settlement
    // needs HAS changed, because the owner is part of it.
    const { dayLockKey } = await import("../src/lib/payroll-period");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const ids = await seed(db, `same-date-${Date.now()}`);
    try {
        const before = (await db.$queryRawUnsafe(
            `SELECT "userId", "startTime" FROM "TimeEntry" WHERE "id" = $1`,
            ids.entryId
        )) as Array<{ userId: string; startTime: Date }>;

        await db.$executeRawUnsafe(`UPDATE "TimeEntry" SET "userId" = $1 WHERE "id" = $2`, ids.b, ids.entryId);

        const after = (await db.$queryRawUnsafe(
            `SELECT "userId", "startTime" FROM "TimeEntry" WHERE "id" = $1`,
            ids.entryId
        )) as Array<{ userId: string; startTime: Date }>;

        assert.equal(
            before[0].startTime.getTime(),
            after[0].startTime.getTime(),
            "same instant — a day-only comparison sees nothing"
        );
        assert.notEqual(before[0].userId, after[0].userId);
        assert.notEqual(
            dayLockKey(before[0].userId, DAY),
            dayLockKey(after[0].userId, DAY),
            "the lock the settlement needs is NOT the lock the caller took"
        );
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
    }
});

test("a conditional write refuses an entry that was reassigned under it", { skip }, async () => {
    // The shape both fixed paths use: the owner goes in the WHERE, so the write
    // lands on the row the caller was authorized for, or on nothing at all.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const ids = await seed(db, `conditional-${Date.now()}`);
    try {
        await db.$executeRawUnsafe(`UPDATE "TimeEntry" SET "userId" = $1 WHERE "id" = $2`, ids.b, ids.entryId);

        // A's device reports telemetry for an entry it no longer owns.
        const claimed = await db.timeEntry.updateMany({
            where: { id: ids.entryId, userId: ids.a },
            data: { offsiteMs: 60_000, isOffsite: true },
        });
        assert.equal(claimed.count, 0, "A must not be able to stamp telemetry onto B's punch");

        const [row] = (await db.$queryRawUnsafe(
            `SELECT "offsiteMs", "isOffsite" FROM "TimeEntry" WHERE "id" = $1`,
            ids.entryId
        )) as Array<{ offsiteMs: number; isOffsite: boolean }>;
        assert.equal(row.offsiteMs, 0);
        assert.equal(row.isOffsite, false);

        // And B's own report still lands.
        const owned = await db.timeEntry.updateMany({
            where: { id: ids.entryId, userId: ids.b },
            data: { offsiteMs: 60_000, isOffsite: true },
        });
        assert.equal(owned.count, 1);
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
    }
});

test("deleteEntryAndSettle takes the NEW owner's day lock after a same-date reassignment", { skip }, async () => {
    const { deleteEntryAndSettle } = await import("../src/lib/wa-breaks-db");
    const { dayLockKey } = await import("../src/lib/payroll-period");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const holder = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const ids = await seed(db, `delete-${Date.now()}`);
    try {
        // Reassigned to B, same date, before the delete runs. The caller still
        // believes the row belongs to A.
        await db.$executeRawUnsafe(`UPDATE "TimeEntry" SET "userId" = $1 WHERE "id" = $2`, ids.b, ids.entryId);

        // A second connection holds B's day lock. Under the old day-only
        // condition the delete never asked for this key, so it would not have
        // blocked here — it would have settled B's day holding only A's lock.
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        const holding = holder.$transaction(
            async (tx) => {
                await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, dayLockKey(ids.b, DAY));
                await held;
            },
            { timeout: 20_000 }
        );
        await new Promise((r) => setTimeout(r, 300));

        // knownDayKey / userId are the STALE ones the caller read.
        // DAY is a company-local key, and the zone it was derived in is now
        // passed explicitly rather than assumed (round 7, finding 1).
        const deleting = deleteEntryAndSettle(ids.entryId, DAY, ids.a, "America/Los_Angeles");

        const blocked = await Promise.race([
            deleting.then(() => false),
            new Promise((r) => setTimeout(() => r(true), 1_000)),
        ]);
        assert.equal(blocked, true, "the delete must wait on the NEW owner's day lock");

        release();
        await holding;
        await deleting;

        const rows = (await db.$queryRawUnsafe(
            `SELECT 1 FROM "TimeEntry" WHERE "id" = $1`,
            ids.entryId
        )) as unknown[];
        assert.equal(rows.length, 0, "and it still deletes once the lock is free");
    } finally {
        await cleanup(db, ids);
        await db.$disconnect();
        await holder.$disconnect();
    }
});
