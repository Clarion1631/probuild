/**
 * WA meal settlement happens in the COMPANY'S zone, not in Pacific.
 *
 * The hole (round 7, finding 1). settleDeferredDaysForPeriod built its window
 * from the resolved CompanySettings.timeZone, and then derived every per-row day
 * key with toCompanyDayKey — hardcoded to America/Los_Angeles. settleDay
 * selected the rows it rewrites with that same hardcoded helper, so the two
 * "agreed" and the code read as consistent. It was consistent only for a Pacific
 * company.
 *
 * For a New York company a punch at 00:30 on MONDAY is 21:30 the previous
 * SUNDAY in Pacific. So the Monday punch was settled under a Sunday key, and the
 * WA meal rule — which is a per-DAY rule — was computed over a day that also
 * contained the previous local day's hours. That is not a labelling detail: the
 * rule counts hours worked to decide how many meal periods are owed, so pulling
 * a neighbouring day in changes what comes off somebody's paycheque.
 *
 * Every fixture below is a real pair of rows in a disposable database, at the
 * 00:30 and 23:30 local boundaries, in one zone west of UTC and one east. Each
 * runs the same settlement twice: once in the company zone (the fix) and once
 * under the Pacific key the old code produced (the pre-fix control), from the
 * same starting state. The control is what makes this a demonstration rather
 * than an assertion.
 *
 * Opt-in by URL, like every other DB test here: a normal unit run must never be
 * able to touch a developer database. The migrations CI job supplies the URL.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.PAYROLL_LOCK_TEST_URL;
const skip = !databaseUrl && "set PAYROLL_LOCK_TEST_URL to a disposable PostgreSQL URL";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-payroll-settlement-zone";
// settleDay reaches the app's prisma singleton, which refuses a URL without
// pgbouncer=true — production safety, satisfied rather than weakened.
if (databaseUrl && !process.env.DATABASE_URL?.includes("pgbouncer=true")) {
    const url = new URL(databaseUrl);
    url.searchParams.set("pgbouncer", "true");
    process.env.DATABASE_URL = url.toString();
}

const PACIFIC = "America/Los_Angeles";

type Settled = { mealOutcome: string | null; durationHours: number | null; mealDeductionHours: number | null };

/**
 * Instants are spelled as UTC rather than computed, so each fixture STATES the
 * fact it depends on instead of re-deriving it with the helper under test. The
 * premise test below asserts every one of them, so a tzdata change fails loudly
 * rather than quietly making the fixture test nothing.
 */
const FIXTURES = [
    {
        name: "America/New_York, 00:30 Monday against a punch ending 23:30 Sunday",
        zone: "America/New_York", // UTC-4 in August
        inPeriodStart: "2026-08-24T04:30:00.000Z", // Mon 00:30 EDT
        inPeriodEnd: "2026-08-24T12:30:00.000Z", // Mon 08:30 EDT
        inPeriodLocalDay: "2026-08-24",
        outOfPeriodStart: "2026-08-23T19:30:00.000Z", // Sun 15:30 EDT
        outOfPeriodEnd: "2026-08-24T03:30:00.000Z", // Sun 23:30 EDT
        outOfPeriodLocalDay: "2026-08-23",
        outOfPeriodHours: 8,
        localSettled: { mealOutcome: "AUTO_DEDUCTED", durationHours: 7.5, mealDeductionHours: 0.5 },
        // COINCIDENCE, recorded on purpose. The 1-hour gap between 23:30 and
        // 00:30 reads as a punched meal, so the wider Pacific day happens to owe
        // the same half hour. The rows it was computed from are still the wrong
        // set — see the loadDayEntries test — and the next fixture is the same
        // boundary with a gap too short to be a meal, where the money moves.
        pacificSettled: { mealOutcome: "AUTO_DEDUCTED", durationHours: 7.5, mealDeductionHours: 0.5 },
    },
    {
        name: "America/New_York, 00:30 Monday with no punched-meal gap before it",
        zone: "America/New_York",
        inPeriodStart: "2026-08-24T04:30:00.000Z", // Mon 00:30 EDT
        inPeriodEnd: "2026-08-24T12:30:00.000Z", // Mon 08:30 EDT
        inPeriodLocalDay: "2026-08-24",
        outOfPeriodStart: "2026-08-23T20:15:00.000Z", // Sun 16:15 EDT
        outOfPeriodEnd: "2026-08-24T04:15:00.000Z", // Mon 00:15 EDT — a 15-minute gap, too short to be a meal
        outOfPeriodLocalDay: "2026-08-23",
        outOfPeriodHours: 8,
        localSettled: { mealOutcome: "AUTO_DEDUCTED", durationHours: 7.5, mealDeductionHours: 0.5 },
        // THE MONEY. Sixteen hours in one Pacific "day" owes a SECOND meal
        // period, so the worker is docked a full hour instead of half of one.
        pacificSettled: { mealOutcome: "AUTO_DEDUCTED", durationHours: 7, mealDeductionHours: 1 },
    },
    {
        name: "Asia/Tokyo, 00:30 Monday against a punch ending 23:30 Sunday",
        zone: "Asia/Tokyo", // UTC+9, no DST
        inPeriodStart: "2026-08-23T15:30:00.000Z", // Mon 00:30 JST
        inPeriodEnd: "2026-08-23T23:30:00.000Z", // Mon 08:30 JST
        inPeriodLocalDay: "2026-08-24",
        outOfPeriodStart: "2026-08-23T12:30:00.000Z", // Sun 21:30 JST
        outOfPeriodEnd: "2026-08-23T14:30:00.000Z", // Sun 23:30 JST
        outOfPeriodLocalDay: "2026-08-23",
        outOfPeriodHours: 2,
        localSettled: { mealOutcome: "AUTO_DEDUCTED", durationHours: 7.5, mealDeductionHours: 0.5 },
        // The harm the other way round: the previous local day's punch and the
        // gap after it look like a taken meal, so the Monday shift is deducted
        // NOTHING and payroll over-pays.
        pacificSettled: { mealOutcome: "PUNCHED", durationHours: 8, mealDeductionHours: 0 },
    },
] as const;

type Fixture = (typeof FIXTURES)[number];

async function seed(db: PrismaClient, suffix: string, fixture: Fixture) {
    const email = `settle-zone-${suffix}@example.test`;
    await db.user.deleteMany({ where: { email } });
    const user = await db.user.create({
        data: {
            name: `Settle Zone ${suffix}`,
            email,
            role: "FIELD_CREW",
            status: "ACTIVATED",
            payType: "HOURLY",
            hourlyRate: 30,
            burdenRate: 5,
        },
        select: { id: true },
    });

    const clientId = `settle-zone-client-${suffix}`;
    const projectId = `settle-zone-project-${suffix}`;
    const inPeriodId = `settle-zone-in-${suffix}`;
    const outOfPeriodId = `settle-zone-out-${suffix}`;

    await db.$executeRawUnsafe(
        `INSERT INTO "Client" ("id","name","initials") VALUES ($1,'Settle Zone','SZ')`,
        clientId
    );
    await db.$executeRawUnsafe(
        `INSERT INTO "Project" ("id","name","clientId","updatedAt") VALUES ($1,'Settle Zone Job',$2,now())`,
        projectId,
        clientId
    );

    const hours = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 3_600_000;

    /**
     * Put both rows back in their pre-settlement state.
     *
     * DEFERRED is what the "Settle deferred days" button exists to clear, and it
     * is never a settled outcome — so it doubles as the marker for "nothing has
     * touched this row". Called before EACH settlement so the fix and the
     * control start from identical rows.
     */
    const reset = async () => {
        await db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = ANY($1::text[])`, [inPeriodId, outOfPeriodId]);
        for (const [id, start, end] of [
            [inPeriodId, fixture.inPeriodStart, fixture.inPeriodEnd],
            [outOfPeriodId, fixture.outOfPeriodStart, fixture.outOfPeriodEnd],
        ] as const) {
            await db.$executeRawUnsafe(
                `INSERT INTO "TimeEntry"
                   ("id","userId","projectId","startTime","endTime","durationHours","shiftHours","mealOutcome","updatedAt")
                 VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$6,'DEFERRED',now())`,
                id,
                user.id,
                projectId,
                start,
                end,
                hours(start, end)
            );
        }
    };
    await reset();

    const read = async (id: string): Promise<Settled> => {
        const row = await db.timeEntry.findUniqueOrThrow({
            where: { id },
            select: { mealOutcome: true, durationHours: true, mealDeductionHours: true },
        });
        return {
            mealOutcome: row.mealOutcome,
            durationHours: row.durationHours == null ? null : Number(row.durationHours),
            mealDeductionHours: row.mealDeductionHours == null ? null : Number(row.mealDeductionHours),
        };
    };

    return {
        user,
        inPeriodId,
        outOfPeriodId,
        reset,
        read,
        restore: async () => {
            await db
                .$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "id" = ANY($1::text[])`, [inPeriodId, outOfPeriodId])
                .catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, projectId).catch(() => {});
            await db.$executeRawUnsafe(`DELETE FROM "Client" WHERE "id" = $1`, clientId).catch(() => {});
            await db.user.deleteMany({ where: { email } }).catch(() => {});
        },
    };
}

let suffixSeq = 0;

for (const fixture of FIXTURES) {
    test(`the fixture straddles a Pacific day boundary — ${fixture.name}`, { skip }, async () => {
        // The control for every assertion below: without it they could all pass
        // on a fixture where the two zones happen to agree, which would prove
        // nothing at all.
        const { dayKeyInTimeZone } = await import("../src/lib/tz-date");
        const inStart = new Date(fixture.inPeriodStart);
        const outStart = new Date(fixture.outOfPeriodStart);

        assert.equal(dayKeyInTimeZone(inStart, fixture.zone), fixture.inPeriodLocalDay, "00:30 Monday, local");
        assert.equal(dayKeyInTimeZone(outStart, fixture.zone), fixture.outOfPeriodLocalDay, "the Sunday punch, local");
        assert.notEqual(
            fixture.inPeriodLocalDay,
            fixture.outOfPeriodLocalDay,
            "the two punches are on DIFFERENT days in the company zone"
        );

        // ...and on the SAME day in Pacific. That collision is the bug.
        assert.equal(dayKeyInTimeZone(inStart, PACIFIC), dayKeyInTimeZone(outStart, PACIFIC));
        assert.notEqual(
            dayKeyInTimeZone(inStart, PACIFIC),
            fixture.inPeriodLocalDay,
            "and the Pacific key is not the local one — the old derivation really did produce a different day"
        );
    });

    test(`settlement uses the company zone — ${fixture.name}`, { skip }, async () => {
        const { settleDay } = await import("../src/lib/wa-breaks-db");
        const { dayKeyInTimeZone } = await import("../src/lib/tz-date");
        const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
        const seeded = await seed(db, `f${(suffixSeq += 1)}`, fixture);

        try {
            const localKey = dayKeyInTimeZone(new Date(fixture.inPeriodStart), fixture.zone);
            const pacificKey = dayKeyInTimeZone(new Date(fixture.inPeriodStart), PACIFIC);
            assert.equal(localKey, fixture.inPeriodLocalDay);

            // ---- THE FIX: the operator's day, in the company's zone ----
            assert.ok(
                (await settleDay(seeded.user.id, localKey, null, fixture.zone)) > 0,
                "the Monday punch was re-planned"
            );
            assert.deepEqual(
                await seeded.read(seeded.inPeriodId),
                fixture.localSettled,
                "the Monday punch is settled over the Monday alone"
            );
            const outAfterFix = await seeded.read(seeded.outOfPeriodId);
            assert.equal(outAfterFix.mealOutcome, "DEFERRED", "and the Sunday punch is not touched at all");
            assert.equal(outAfterFix.durationHours, fixture.outOfPeriodHours, "its paid hours are exactly as seeded");

            // ---- THE PRE-FIX CONTROL: the same rows, the Pacific key ----
            await seeded.reset();
            await settleDay(seeded.user.id, pacificKey, null, PACIFIC);
            assert.deepEqual(
                await seeded.read(seeded.inPeriodId),
                fixture.pacificSettled,
                "settling under the Pacific key computes the WA meal rule over both local days"
            );
        } finally {
            await seeded.restore();
            await db.$disconnect().catch(() => {});
        }
    });

    test(`loadDayEntries sees one local day — ${fixture.name}`, { skip }, async () => {
        // The other zone-sensitive filter on this path: at clock-out the meal
        // rule asks "what else did this person work today". Answered in Pacific
        // it was handed the previous local day as well, which is exactly how the
        // hours above end up wrong.
        const { loadDayEntries } = await import("../src/lib/wa-breaks-db");
        const { dayKeyInTimeZone } = await import("../src/lib/tz-date");
        const db = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
        const seeded = await seed(db, `l${(suffixSeq += 1)}`, fixture);

        try {
            const localKey = dayKeyInTimeZone(new Date(fixture.inPeriodStart), fixture.zone);
            const sameDay = await loadDayEntries(seeded.user.id, localKey, "no-such-entry", fixture.zone);
            assert.equal(sameDay.length, 1, "only the Monday punch is on the Monday");
            assert.equal(sameDay[0].startTime.toISOString(), fixture.inPeriodStart);

            // The pre-fix control: in Pacific the two share a day.
            const pacific = await loadDayEntries(
                seeded.user.id,
                dayKeyInTimeZone(new Date(fixture.inPeriodStart), PACIFIC),
                "no-such-entry",
                PACIFIC
            );
            assert.equal(pacific.length, 2, "which is what the hardcoded Pacific helper used to return");
        } finally {
            await seeded.restore();
            await db.$disconnect().catch(() => {});
        }
    });
}

test("the deferred-settlement action derives its day keys from the RESOLVED zone", async () => {
    // The DB tests above prove settleDay behaves. This pins that the payroll
    // button actually hands it the resolved zone rather than a Pacific key.
    // Source-level on purpose: the action sits behind requirePayrollAccess, and
    // a stubbed session would be proving something about the stub.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const start = source.indexOf("export async function settleDeferredDaysForPeriod");
    assert.ok(start > 0);
    const body = source.slice(start, source.indexOf("\nexport ", start + 1));
    // Comments stripped: this is about the CODE, and the prose here explains the
    // very helpers it must no longer call.
    const code = body.replace(/^\s*\/\/.*$/gm, "");

    assert.match(code, /const timeZone = await resolveCompanyTimeZone\(\)/);
    assert.match(code, /const dayKey = \(instant: Date\) => dayKeyInTimeZone\(instant, timeZone\)/);
    // Round 21 added a fifth argument, the operator whose payroll authority
    // settleDay re-decides inside each per-day transaction. The zone is still
    // the fourth, and still the resolved one — which is what this pins.
    assert.match(code, /settleDay\(item\.userId, item\.dayKey, null, timeZone, settler\.id\)/);
    assert.match(code, /startOfDateInTimeZone\(key, timeZone\), \{ timeZone \}/);
    assert.ok(!/toCompanyDayKey\(/.test(code), "toCompanyDayKey is Pacific-only and must not be called here");
    assert.ok(!/COMPANY_TIME_ZONE/.test(code), "nor the constant behind it");
});

test("nothing on the settlement path can fall back to a hardcoded zone", async () => {
    // The rule the finding asked for, stated once: no hidden default. Every day
    // key in wa-breaks-db comes from a REQUIRED parameter, so a caller that
    // forgets the zone is a compile error rather than a silently Pacific day.
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "wa-breaks-db.ts"), "utf8");
    const code = source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

    assert.ok(!/toCompanyDayKey/.test(code), "the Pacific-only helper is gone from the settlement path");
    assert.ok(!/COMPANY_TIME_ZONE/.test(code), "and so is the constant behind it");
    assert.match(code, /import \{ dayKeyInTimeZone \} from "@\/lib\/tz-date"/);
    // Every filter passes a zone through rather than picking one.
    for (const match of code.matchAll(/dayKeyInTimeZone\(([^)]*)\)/g)) {
        assert.match(match[1], /,\s*timeZone\s*$/, `dayKeyInTimeZone(${match[1]}) must take the caller's zone`);
    }
    // And it is not optional anywhere.
    assert.ok(!/timeZone\?\s*:/.test(code), "the zone must never be an optional parameter here");
});
