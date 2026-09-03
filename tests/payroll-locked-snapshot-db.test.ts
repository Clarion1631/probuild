/**
 * A LOCKED pay period that has lost its frozen export must FAIL CLOSED.
 *
 * The hole (round 6, finding 4). `loadGustoExport` built its `snapshot` only
 * when BOTH csv columns were non-null. A row with `lockedAt` set and a null
 * snapshot therefore came back as `snapshot: null` — and still counted as "the
 * exact period is locked", so `overlapsLockWithoutBeingIt` stayed false and the
 * overlap refusal did not fire either. The download endpoint then fell straight
 * through to the live branch and served a FRESHLY RECOMPUTED CSV, headed
 * `X-Export-Source: live`, for a period that had already been paid.
 *
 * A locked period is precisely where live data is the wrong answer: the file was
 * built from mutable inputs — a name, a pay type, a Gusto id, a punch's project
 * and cost code — so recomputing it today does not reproduce what was sent. The
 * bookkeeper gets a plausible file that is not the one payroll ran on, with
 * nothing on it to say so.
 *
 * Two independent defences, and this file proves each on a real database:
 *
 *  1. the DATABASE will not hold such a row — PayrollPeriod_locked_snapshot_complete;
 *  2. if one exists anyway (written before that constraint, or by something that
 *     bypassed it), the loader THROWS and the endpoint answers 409 with a
 *     recovery instruction instead of a CSV.
 *
 * The endpoint is driven through its real DI factory against this database, so
 * the assertion is about an actual HTTP response, not about a source string.
 *
 * Opt-in by URL, like every other DB test here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-locked-snapshot";
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
const PUNCH_START = "2026-08-24T15:00:00Z";
const PUNCH_END = "2026-08-24T23:00:00Z";
const CONSTRAINT = "PayrollPeriod_locked_snapshot_complete";
const CONSTRAINT_SQL = `CHECK (
    "lockedAt" IS NULL
    OR ("summaryCsvSnapshot" IS NOT NULL AND "detailCsvSnapshot" IS NOT NULL AND "exportHash" IS NOT NULL)
)`;

/**
 * A roster with real hours, so the LIVE csv this must never serve is not empty.
 *
 * That matters: if the seeded period had no hours, the live fall-through and a
 * correct refusal would look almost the same, and the test would pass against
 * the bug. The employee's email below is what the assertions look for in the
 * response body.
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

    const email = `locked-snapshot-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email } });
    const user = await db.user.create({
        data: {
            name: `Locked Snapshot ${suffix}`,
            email,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 28.5,
        },
        select: { id: true, email: true },
    });

    const clientId = `locked-snap-client-${suffix}`;
    const projectId = `locked-snap-project-${suffix}`;
    const entryId = `locked-snap-entry-${suffix}`;
    const periodId = `locked-snap-period-${suffix}`;
    await db.$executeRawUnsafe(
        `INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Locked Snapshot','LS')`,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Locked Snapshot Job',$2,now())`,
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

    const clearPeriod = () => db.$executeRawUnsafe(`DELETE FROM "PayrollPeriod" WHERE "id" = $1`, periodId);

    return {
        user,
        periodId,
        clearPeriod,
        restore: async () => {
            await clearPeriod().catch(() => {});
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

/** The real endpoint, wired to the real loader against this database. */
async function handlerFor(db: PrismaClient) {
    const { createGustoExportHandler } = await import("../src/app/api/time-entries/export/gusto/route");
    const { loadGustoExport } = await import("../src/lib/gusto-export-db");
    return createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        resolveTimeZone: async () => TZ,
        load: (periodStart, periodEnd, keys) =>
            loadGustoExport(periodStart, periodEnd, { ...keys, client: db }),
    });
}

const request = () =>
    new Request(
        `https://example.test/api/time-entries/export/gusto?periodStart=${START_KEY}&periodEnd=${END_KEY}`
    );

test("the DATABASE refuses a locked period with no snapshot", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { periodId, clearPeriod, restore } = await seed(db, "constraint");
    try {
        await assert.rejects(
            () =>
                db.$executeRawUnsafe(
                    `INSERT INTO "PayrollPeriod"
                       ("id","periodStart","periodEnd","periodStartKey","periodEndKey","lockedAt","timeZone")
                     VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,now(),$6)`,
                    periodId,
                    PERIOD_START.toISOString(),
                    PERIOD_END.toISOString(),
                    START_KEY,
                    END_KEY,
                    TZ
                ),
            new RegExp(CONSTRAINT),
            "a locked row with no frozen CSVs must not be insertable"
        );

        // And it cannot be reached by UPDATE either — an unlocked row cannot be
        // flipped to locked without its snapshot coming with it.
        await db.$executeRawUnsafe(
            `INSERT INTO "PayrollPeriod"
               ("id","periodStart","periodEnd","periodStartKey","periodEndKey","timeZone")
             VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,$6)`,
            periodId,
            PERIOD_START.toISOString(),
            PERIOD_END.toISOString(),
            START_KEY,
            END_KEY,
            TZ
        );
        await assert.rejects(
            () => db.$executeRawUnsafe(`UPDATE "PayrollPeriod" SET "lockedAt" = now() WHERE "id" = $1`, periodId),
            new RegExp(CONSTRAINT)
        );

        // A PARTIAL snapshot is refused too — two of the three is not a file.
        await assert.rejects(
            () =>
                db.$executeRawUnsafe(
                    `UPDATE "PayrollPeriod"
                        SET "lockedAt" = now(), "summaryCsvSnapshot" = 'S', "detailCsvSnapshot" = 'D'
                      WHERE "id" = $1`,
                    periodId
                ),
            new RegExp(CONSTRAINT),
            "a snapshot with no exportHash cannot answer 'is this the file that went to payroll'"
        );

        // THE CONTROL: the complete shape is accepted, so the rejections above
        // are about what is missing rather than about the statement itself.
        await db.$executeRawUnsafe(
            `UPDATE "PayrollPeriod"
                SET "lockedAt" = now(), "summaryCsvSnapshot" = 'S', "detailCsvSnapshot" = 'D', "exportHash" = 'h'
              WHERE "id" = $1`,
            periodId
        );
        // ...and an UNLOCKED row is free to have no snapshot at all, which is
        // exactly what unlockPayrollPeriod leaves behind.
        await db.$executeRawUnsafe(
            `UPDATE "PayrollPeriod"
                SET "lockedAt" = NULL, "summaryCsvSnapshot" = NULL, "detailCsvSnapshot" = NULL
              WHERE "id" = $1`,
            periodId
        );
        await clearPeriod();
    } finally {
        await restore();
        await db.$disconnect().catch(() => {});
    }
});

test("a malformed locked row makes the endpoint REFUSE — it never serves live data", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { user, periodId, restore } = await seed(db, "endpoint");
    let constraintDropped = false;
    try {
        // Simulate the row the constraint now prevents: one written before it
        // existed, or by something that bypassed it. The constraint is dropped
        // for the length of this test and put back in the finally.
        await db.$executeRawUnsafe(
            `ALTER TABLE "PayrollPeriod" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`
        );
        constraintDropped = true;
        await db.$executeRawUnsafe(
            `INSERT INTO "PayrollPeriod"
               ("id","periodStart","periodEnd","periodStartKey","periodEndKey","lockedAt","timeZone","exportHash")
             VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,now(),$6,'stale-hash')`,
            periodId,
            PERIOD_START.toISOString(),
            PERIOD_END.toISOString(),
            START_KEY,
            END_KEY,
            TZ
        );

        const handler = await handlerFor(db);
        const res = await handler.GET(request());

        assert.equal(res.status, 409, "a locked period with no frozen export has no file to hand over");
        assert.equal(
            res.headers.get("x-export-source"),
            null,
            "and no CSV of any kind — 'live' here is the exact bug"
        );
        const body = (await res.json()) as { error: string; code: string };
        assert.equal(body.code, "LOCKED_SNAPSHOT_MISSING");
        assert.match(body.error, /unlock the period and lock it again/, "the refusal says how to recover");
        // The live CSV would have carried this person's email and 8.00 hours.
        assert.ok(
            !JSON.stringify(body).includes(user.email),
            "not one row of recomputed payroll data leaks through the refusal"
        );
    } finally {
        await db.$executeRawUnsafe(`DELETE FROM "PayrollPeriod" WHERE "id" = $1`, periodId).catch(() => {});
        if (constraintDropped) {
            await db
                .$executeRawUnsafe(
                    `ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "${CONSTRAINT}" ${CONSTRAINT_SQL}`
                )
                .catch(() => {});
        }
        await restore();
        await db.$disconnect().catch(() => {});
    }
});

test("a WELL-FORMED locked period still serves its snapshot — the refusal is about the row, not the path", { skip }, async () => {
    // The control for the test above. Without it, "409" could just as well mean
    // the harness cannot serve a locked period at all.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { periodId, restore } = await seed(db, "control");
    try {
        await db.$executeRawUnsafe(
            `INSERT INTO "PayrollPeriod"
               ("id","periodStart","periodEnd","periodStartKey","periodEndKey","lockedAt","timeZone",
                "exportHash","summaryCsvSnapshot","detailCsvSnapshot")
             VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,now(),$6,'frozen-hash','FROZEN-SUMMARY',E'FROZEN-DETAIL')`,
            periodId,
            PERIOD_START.toISOString(),
            PERIOD_END.toISOString(),
            START_KEY,
            END_KEY,
            TZ
        );

        const handler = await handlerFor(db);
        const res = await handler.GET(request());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-export-source"), "snapshot");
        assert.equal(res.headers.get("x-export-hash"), "frozen-hash");
        assert.equal(await res.text(), "FROZEN-SUMMARY", "verbatim, never recomputed");
    } finally {
        await db.$executeRawUnsafe(`DELETE FROM "PayrollPeriod" WHERE "id" = $1`, periodId).catch(() => {});
        await restore();
        await db.$disconnect().catch(() => {});
    }
});
