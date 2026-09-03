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
import { readFileSync } from "node:fs";
import path from "node:path";
import { startOfDateInTimeZone } from "../src/lib/tz-date";

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

/**
 * The real endpoint, wired to the real loader against this database.
 *
 * `beforeLiveRead` runs while the handler HOLDS the payroll advisory lock,
 * just before it re-checks for a frozen row — the instant the round-16
 * finding-2 race lives in.
 */
async function handlerFor(db: PrismaClient, beforeLiveRead?: () => Promise<void>) {
    const { createGustoExportHandler } = await import("../src/app/api/time-entries/export/gusto/route");
    const { loadGustoExport, loadLockedSnapshot } = await import("../src/lib/gusto-export-db");
    const { acquirePayrollWriteLock } = await import("../src/lib/payroll-period");
    return createGustoExportHandler({
        authenticate: async () => ({ role: "ADMIN", canReadFinancialReports: true }),
        resolveTimeZone: async () => TZ,
        // The REAL lock, on this database.
        withPayrollReadLock: (body) =>
            db.$transaction(
                async (tx) => {
                    await acquirePayrollWriteLock(tx);
                    if (beforeLiveRead) await beforeLiveRead();
                    return body();
                },
                { timeout: 30_000, maxWait: 20_000 }
            ),
        // The real frozen-file read, against this database — the endpoint tries
        // it before it touches any live input (round 10, finding 4).
        loadSnapshot: (keys) => loadLockedSnapshot(keys.startKey, keys.endKey, db),
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

// ── A locked download does not depend on LIVE payroll (round 10, finding 4) ──
//
// Serving a locked period used to go through loadGustoExport, which reads the
// integration settings, every entry in the envelope and the whole roster BEFORE
// it assembles the snapshot. Any of those can refuse: a missing Integration row
// is a hard error, and a non-employee with hours throws NonStaffOnPayrollError.
// Either one threw before the endpoint reached its snapshot branch, so a file
// that had already been frozen AND ALREADY PAID became undownloadable because
// of something that happened to the company afterwards.
//
// The endpoint now reads the frozen row FIRST and returns it. Each case below
// breaks one live input, downloads anyway, and carries the pre-fix control: the
// live path, on the same broken state, still throws.

/** A locked period whose frozen CSVs are present and correct. */
async function seedLockedPeriod(db: PrismaClient, periodId: string) {
    await db.$executeRawUnsafe(
        `INSERT INTO "PayrollPeriod"
           ("id","periodStart","periodEnd","periodStartKey","periodEndKey","lockedAt","timeZone",
            "exportHash","summaryCsvSnapshot","detailCsvSnapshot")
         VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,now(),$6,'frozen-hash','FROZEN-SUMMARY','FROZEN-DETAIL')`,
        periodId,
        PERIOD_START.toISOString(),
        PERIOD_END.toISOString(),
        START_KEY,
        END_KEY,
        TZ
    );
}

test("the frozen file downloads without consulting the integration settings", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "no-settings");
    const prior = await db.integration.findUnique({ where: { id: "system_settings" } });
    try {
        await seedLockedPeriod(db, seeded.periodId);
        // The integration row is GONE — the state a fresh install, or a wiped
        // credential, leaves behind.
        await db.integration.delete({ where: { id: "system_settings" } }).catch(() => {});

        const res = await (await handlerFor(db)).GET(request());
        assert.equal(res.status, 200, "a period that was already paid stays downloadable");
        assert.equal(res.headers.get("x-export-source"), "snapshot");
        assert.equal(await res.text(), "FROZEN-SUMMARY");

        // NO PRE-FIX CONTROL ON THIS ONE, deliberately, and worth saying so: a
        // MISSING Integration row is tolerated by readSettings (it answers `{}`
        // and only a database FAILURE propagates), so the live path would have
        // survived this too. What this case guards is that the download does
        // not read the settings at all. The control lives in the next test,
        // where the live path genuinely refuses.
    } finally {
        if (prior) {
            await db.integration
                .upsert({
                    where: { id: "system_settings" },
                    create: { id: "system_settings", settings: prior.settings },
                    update: { settings: prior.settings },
                })
                .catch(() => {});
        }
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("the frozen file downloads with a NON-STAFF account on the live roster", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "non-staff");
    const customerEmail = "locked-snapshot-customer@example.test";
    try {
        await seedLockedPeriod(db, seeded.periodId);
        // A portal account with hours in the period: the live path refuses this
        // outright (round 8), and it used to take the frozen file with it.
        await db.user.deleteMany({ where: { email: customerEmail } });
        const customer = await db.user.create({
            data: { name: "Dana Customer", email: customerEmail, role: "CLIENT", status: "ACTIVATED" },
            select: { id: true },
        });
        await db.$executeRawUnsafe(
            `UPDATE "TimeEntry" SET "userId" = $1 WHERE "id" = $2`,
            customer.id,
            `locked-snap-entry-non-staff`
        );

        const res = await (await handlerFor(db)).GET(request());
        assert.equal(res.status, 200, "the frozen file does not care who is on the roster today");
        assert.equal(res.headers.get("x-export-source"), "snapshot");
        assert.equal(await res.text(), "FROZEN-SUMMARY");

        // THE PRE-FIX CONTROL: the live path, on this exact state, still throws
        // — which is what used to happen before the endpoint reached its
        // snapshot branch.
        const { loadGustoExport, isNonStaffOnPayrollError } = await import("../src/lib/gusto-export-db");
        await assert.rejects(
            () =>
                loadGustoExport(PERIOD_START, PERIOD_END, {
                    startKey: START_KEY,
                    endKey: END_KEY,
                    timeZone: TZ,
                    client: db,
                }),
            (error: Error) => isNonStaffOnPayrollError(error)
        );
    } finally {
        await db.user.deleteMany({ where: { email: customerEmail } }).catch(() => {});
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("the frozen file is served VERBATIM after the project is renamed", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "renamed");
    try {
        await seedLockedPeriod(db, seeded.periodId);
        await db.$executeRawUnsafe(
            `UPDATE "Project" SET "name" = 'RENAMED AFTER THE LOCK' WHERE "id" = $1`,
            `locked-snap-project-renamed`
        );

        const res = await (await handlerFor(db)).GET(request());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-export-source"), "snapshot");
        const csv = await res.text();
        assert.equal(csv, "FROZEN-SUMMARY");
        assert.ok(!csv.includes("RENAMED AFTER THE LOCK"), "a rename cannot rewrite a file that was already sent");
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

test("loadLockedSnapshot reads ONE row — it is null for an unlocked period and never touches live inputs", { skip }, async () => {
    const { loadLockedSnapshot } = await import("../src/lib/gusto-export-db");
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const seeded = await seed(db, "one-row");
    try {
        // No period row at all.
        assert.equal(await loadLockedSnapshot(START_KEY, END_KEY, db), null);

        // An UNLOCKED row is not a snapshot either — the live path owns that case.
        await db.$executeRawUnsafe(
            `INSERT INTO "PayrollPeriod" ("id","periodStart","periodEnd","periodStartKey","periodEndKey","timeZone")
             VALUES ($1,$2::timestamptz,$3::timestamptz,$4,$5,$6)`,
            seeded.periodId,
            PERIOD_START.toISOString(),
            PERIOD_END.toISOString(),
            START_KEY,
            END_KEY,
            TZ
        );
        assert.equal(await loadLockedSnapshot(START_KEY, END_KEY, db), null);

        // Locked and complete: the frozen values, verbatim.
        await db.$executeRawUnsafe(
            `UPDATE "PayrollPeriod"
                SET "lockedAt" = now(), "exportHash" = 'h', "summaryCsvSnapshot" = 'S', "detailCsvSnapshot" = 'D'
              WHERE "id" = $1`,
            seeded.periodId
        );
        const snapshot = await loadLockedSnapshot(START_KEY, END_KEY, db);
        assert.equal(snapshot?.summaryCsv, "S");
        assert.equal(snapshot?.detailCsv, "D");
        assert.equal(snapshot?.exportHash, "h");
    } finally {
        await seeded.restore();
        await db.$disconnect().catch(() => {});
    }
});

// -- A live download racing a period lock (round 16, finding 2) -------------
//
// The endpoint checked for a frozen row, found none, and then spent the rest
// of the request reading live data with NOTHING held. A lockPayrollPeriod
// committing in that window meant the bytes going out said
// `X-Export-Source: live` for a period that was, by then, locked and frozen
// around different numbers — the one file payroll was actually paid from,
// contradicted by a download that looked authoritative.
//
// The live path now runs under the payroll advisory lock in SHARE mode and
// re-asks for the frozen row before it reads anything live.

const RACED = {
    exportHash: "racedhash",
    summaryCsvSnapshot: "RACED-SUMMARY\n",
    detailCsvSnapshot: "RACED-DETAIL\n",
};

/** Freeze the period on `db`, the way a lock that won the race leaves it. */
async function freezePeriod(db: PrismaClient) {
    await db.payrollPeriod.create({
        data: {
            periodStartKey: START_KEY,
            periodEndKey: END_KEY,
            periodStart: new Date(`${START_KEY}T08:00:00.000Z`),
            periodEnd: new Date(`${END_KEY}T08:00:00.000Z`),
            timeZone: TZ,
            lockedAt: new Date(),
            ...RACED,
        },
    });
}

const dropPeriod = (db: PrismaClient) =>
    db.payrollPeriod
        .deleteMany({ where: { periodStartKey: START_KEY, periodEndKey: END_KEY } })
        .catch(() => {});

test("a lock committing mid-download makes the response the SNAPSHOT, not live", { skip }, async () => {
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { restore } = await seed(db, "race");
    try {
        let raced = false;
        // The lock is staged to commit at the exact instant the handler holds
        // the shared lock and is about to re-check — the window the race lives
        // in. It commits on a SECOND connection.
        const handler = await handlerFor(db, async () => {
            if (raced) return;
            raced = true;
            await freezePeriod(locker);
        });

        const res = await handler.GET(request());
        assert.equal(raced, true, "the race must actually have been staged");
        assert.equal(res.status, 200);
        // THE point: the frozen bytes, not a recomputed live CSV.
        assert.equal(res.headers.get("x-export-source"), "snapshot");
        assert.equal(res.headers.get("x-export-hash"), RACED.exportHash);
        assert.equal(await res.text(), RACED.summaryCsvSnapshot);
    } finally {
        await dropPeriod(locker);
        await restore();
        await Promise.all([db.$disconnect(), locker.$disconnect()]);
    }
});

test("PRE-FIX CONTROL: the old sequence serves LIVE bytes for a locked period", { skip }, async () => {
    // The vulnerable order, written out: ask once, then build the file with
    // nothing held. Without this the case above could be passing on a race that
    // never actually lands in the window.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { restore } = await seed(db, "race-prefix");
    try {
        const { loadGustoExport, loadLockedSnapshot } = await import("../src/lib/gusto-export-db");

        // 1. The check. Nothing is locked yet, so this is null — and under the
        //    old code that answer was final for the rest of the request.
        assert.equal(await loadLockedSnapshot(START_KEY, END_KEY, db), null);

        // 2. The lock commits, in full, in the gap.
        await freezePeriod(locker);

        // 3. The live read proceeds anyway, because nothing was held.
        const live = await loadGustoExport(
            startOfDateInTimeZone(START_KEY, TZ),
            startOfDateInTimeZone(END_KEY, TZ),
            { startKey: START_KEY, endKey: END_KEY, timeZone: TZ, client: db }
        );

        // The period IS locked now, and the bytes the old path would have sent
        // are NOT the bytes payroll was paid from. That disagreement is the bug.
        const frozen = await loadLockedSnapshot(START_KEY, END_KEY, db);
        assert.ok(frozen, "the period really did get locked in the gap");
        assert.equal(frozen!.summaryCsv, RACED.summaryCsvSnapshot);
        assert.notEqual(
            live.summaryCsv,
            frozen!.summaryCsv,
            "the live CSV must differ from the frozen one, or this proves nothing"
        );
    } finally {
        await dropPeriod(locker);
        await restore();
        await Promise.all([db.$disconnect(), locker.$disconnect()]);
    }
});

test("a REAL period lock waits behind an in-flight download", { skip }, async () => {
    // The other half of the guarantee. The staged race above commits a row
    // directly; a real lockPayrollPeriod takes the EXCLUSIVE advisory lock
    // first, so while a download holds the shared one it cannot even start —
    // which is why the shared mode is the right one: it queues writers without
    // blocking other readers.
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const locker = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    const { restore } = await seed(db, "race-wait");
    try {
        const { acquirePayrollLockCreationLock } = await import("../src/lib/payroll-period");
        let creating: Promise<unknown> = Promise.resolve();
        let stillWaiting: boolean | null = null;

        const handler = await handlerFor(db, async () => {
            if (stillWaiting !== null) return;
            creating = locker.$transaction(
                async (tx) => {
                    await acquirePayrollLockCreationLock(tx as never);
                },
                { timeout: 30_000 }
            );
            stillWaiting = await Promise.race([
                creating.then(() => false).catch(() => false),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 600)),
            ]);
        });

        const res = await handler.GET(request());
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-export-source"), "live", "nothing was locked, so this is a live export");
        assert.equal(
            stillWaiting,
            true,
            "a period lock must WAIT while a download holds the shared payroll lock"
        );
        // ...and once the download is done it goes through.
        await creating;
    } finally {
        await dropPeriod(locker);
        await restore();
        await Promise.all([db.$disconnect(), locker.$disconnect()]);
    }
});

test("the live path is WRAPPED — source order, because the race needs it", () => {
    // The behavioural cases prove the re-check; this proves the LOCK is what it
    // happens under, and that nothing live is read before it.
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "api", "time-entries", "export", "gusto", "route.ts"),
        "utf8"
    );
    const wrap = source.indexOf("dependencies.withPayrollReadLock(");
    const recheck = source.indexOf("dependencies.loadSnapshot(", wrap);
    const zone = source.indexOf("await dependencies.resolveTimeZone()");
    const load = source.indexOf("await dependencies.load(");
    assert.ok(wrap > 0, "the live path must run under the payroll lock");
    assert.ok(recheck > wrap, "it must re-check for a snapshot INSIDE the lock");
    assert.ok(zone > recheck, "and only then touch live state");
    assert.ok(load > zone);
    // SHARE mode: the same tier-1 lock every payroll writer takes, so two
    // downloads do not block each other.
    assert.match(source, /acquirePayrollWriteLock\(tx\)/);
});
