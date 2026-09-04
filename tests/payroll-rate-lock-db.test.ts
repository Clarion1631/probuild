/**
 * TWO REAL CONNECTIONS. Not an injected sequence.
 *
 * Every concurrency proof in this suite so far drives one branch through a fake,
 * which shows the branch exists but says nothing about whether PostgreSQL
 * actually serializes the two transactions the way the code assumes. This one
 * opens two connections to a disposable database and makes them contend.
 *
 * What it pins: settlement takes `SELECT ... FOR SHARE` on the User row before
 * reading rates, and every rate writer takes `FOR UPDATE` on the same row — so a
 * rate import cannot commit halfway through a multi-entry day and leave one
 * day's shifts priced at two different rates.
 *
 * Opt-in by URL, like tests/migration-history-blind-spots.test.ts: a normal unit
 * run must never be able to touch a developer database. The migrations CI job
 * supplies the URL from its Postgres service container.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

/** Resolves once `promise` has not settled for `ms` — i.e. it is genuinely blocked. */
function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
    const marker = Symbol("pending");
    return Promise.race([
        promise.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(marker), ms)).then((v) => v === marker),
    ]) as Promise<boolean>;
}

test("FOR SHARE on the owner row BLOCKS a concurrent rate write until settlement commits", { skip }, async () => {
    const reader = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const writer = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const userId = `lock-test-${Date.now()}`;

    try {
        await reader.$executeRawUnsafe(
            `INSERT INTO "User" ("id", "email", "name", "role", "status", "hourlyRate", "burdenRate")
             VALUES ($1, $2, 'Lock Test', 'FIELD_CREW', 'ACTIVATED', 25.00, 5.00)`,
            userId,
            `${userId}@example.test`
        );

        // Connection A: settlement. Takes the shared lock and HOLDS it.
        let releaseA: () => void = () => {};
        const holdA = new Promise<void>((resolve) => { releaseA = resolve; });
        let sawRate: string | null = null;

        const settlement = reader.$transaction(async (tx) => {
            const rows = (await tx.$queryRawUnsafe(
                `SELECT "hourlyRate" FROM "User" WHERE "id" = $1 FOR SHARE`,
                userId
            )) as Array<{ hourlyRate: unknown }>;
            sawRate = String(rows[0].hourlyRate);
            // Stand still, the way a multi-entry day's re-plan does.
            await holdA;
        }, { timeout: 20_000 });

        // Let A actually reach its lock.
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(sawRate, "25", "settlement read the rate it is about to price from");

        // Connection B: a rate import. FOR UPDATE on the same row must WAIT.
        const rateWrite = writer.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(`SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE`, userId);
            await tx.$executeRawUnsafe(`UPDATE "User" SET "hourlyRate" = 40.00 WHERE "id" = $1`, userId);
        }, { timeout: 20_000 });

        assert.equal(
            await stillPending(rateWrite, 1_000),
            true,
            "the rate write must BLOCK while a day is mid-reprice — otherwise one day gets two rates"
        );

        // Settlement commits; the write is then free.
        releaseA();
        await settlement;
        await rateWrite;

        const after = (await reader.$queryRawUnsafe(
            `SELECT "hourlyRate" FROM "User" WHERE "id" = $1`,
            userId
        )) as Array<{ hourlyRate: unknown }>;
        assert.equal(String(after[0].hourlyRate), "40", "and it lands once settlement is done");
    } finally {
        await reader.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
        await reader.$disconnect();
        await writer.$disconnect();
    }
});

test("two settlements for DIFFERENT days do not block each other", { skip }, async () => {
    // The reason it is FOR SHARE and not FOR UPDATE. If settlement took the
    // exclusive lock, a normal payroll day with two people clocking out at once
    // would serialize for no reason.
    const a = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const b = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const userId = `share-test-${Date.now()}`;

    try {
        await a.$executeRawUnsafe(
            `INSERT INTO "User" ("id", "email", "name", "role", "status", "hourlyRate", "burdenRate")
             VALUES ($1, $2, 'Share Test', 'FIELD_CREW', 'ACTIVATED', 25.00, 5.00)`,
            userId,
            `${userId}@example.test`
        );

        let release: () => void = () => {};
        const hold = new Promise<void>((resolve) => { release = resolve; });
        const first = a.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(`SELECT "hourlyRate" FROM "User" WHERE "id" = $1 FOR SHARE`, userId);
            await hold;
        }, { timeout: 20_000 });

        await new Promise((resolve) => setTimeout(resolve, 300));

        const second = b.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(`SELECT "hourlyRate" FROM "User" WHERE "id" = $1 FOR SHARE`, userId);
        }, { timeout: 20_000 });

        assert.equal(await stillPending(second, 800), false, "two shared readers must not block each other");
        release();
        await first;
    } finally {
        await a.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
        await a.$disconnect();
        await b.$disconnect();
    }
});

/**
 * The crash of round 18, against a real database.
 *
 * Every rate route runs its write inside its own interactive transaction. An
 * interactive Prisma client has no `$transaction` method, so a version of
 * applyRateChange that opened one unconditionally threw TypeError on every rate
 * edit in production — and type-checked, because all four call sites cast their
 * tx with `as never`. The unit tests use a hand-written fake, which cannot prove
 * the real Prisma tx object behaves this way. This does.
 */
test("a rate edit through a REAL interactive transaction saves", { skip }, async () => {
    const { applyRateChangeInTx } = await import("../src/lib/pay-rate-write");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const userId = `rate-route-${Date.now()}`;

    try {
        await db.$executeRawUnsafe(
            `INSERT INTO "User" ("id", "email", "name", "role", "status", "hourlyRate", "burdenRate")
             VALUES ($1, $2, 'Route Test', 'FIELD_CREW', 'ACTIVATED', 25.00, 5.00)`,
            userId,
            `${userId}@example.test`
        );

        // Exactly the shape the routes use: their own interactive transaction,
        // other columns updated alongside the rate, one commit.
        const result = await db.$transaction(async (tx) => {
            const rate = await applyRateChangeInTx(tx as never, { role: "ADMIN" }, userId, {
                hourlyRate: "31.25",
                burdenRate: "7.50",
                payType: "HOURLY",
            });
            await tx.user.update({ where: { id: userId }, data: { name: "Route Test Renamed" } });
            return rate;
        });
        assert.deepEqual(result, { ok: true, changed: true });

        const [saved] = (await db.$queryRawUnsafe(
            `SELECT "hourlyRate", "burdenRate", "payType", "name", "lastRateSyncAt" FROM "User" WHERE "id" = $1`,
            userId
        )) as Array<Record<string, unknown>>;
        assert.equal(String(saved.hourlyRate), "31.25");
        assert.equal(String(saved.burdenRate), "7.5");
        assert.equal(saved.payType, "HOURLY");
        assert.equal(saved.name, "Route Test Renamed", "the rate and the profile edit commit together");
        assert.ok(saved.lastRateSyncAt, "every rate write stamps the staleness marker");
    } finally {
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
        await db.$disconnect();
    }
});

test("a refused rate edit rolls the whole transaction back", { skip }, async () => {
    const { applyRateChangeInTx, RateChangeError } = await import("../src/lib/pay-rate-write");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const userId = `rate-refuse-${Date.now()}`;

    try {
        await db.$executeRawUnsafe(
            `INSERT INTO "User" ("id", "email", "name", "role", "status", "hourlyRate", "burdenRate")
             VALUES ($1, $2, 'Refuse Test', 'FIELD_CREW', 'ACTIVATED', 25.00, 5.00)`,
            userId,
            `${userId}@example.test`
        );

        await assert.rejects(() =>
            db.$transaction(async (tx) => {
                await tx.user.update({ where: { id: userId }, data: { name: "Should Not Persist" } });
                const rate = await applyRateChangeInTx(tx as never, { role: "FIELD_CREW" }, userId, {
                    hourlyRate: "99.00",
                });
                if (!rate.ok) throw new RateChangeError(rate.status, rate.error);
                return rate;
            })
        );

        const [after] = (await db.$queryRawUnsafe(
            `SELECT "name", "hourlyRate" FROM "User" WHERE "id" = $1`,
            userId
        )) as Array<Record<string, unknown>>;
        assert.equal(after.name, "Refuse Test", "the profile edit rolls back with the refused rate");
        assert.equal(String(after.hourlyRate), "25");
    } finally {
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
        await db.$disconnect();
    }
});
