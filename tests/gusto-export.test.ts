/**
 * Gusto hours export — overtime table + golden-file CSVs (Phase 5 spec test 1
 * and 2, docs/plans/PHASE-5-GUSTO-AND-MOBILE-RELEASE-SPEC.md).
 *
 * Everything here runs against the PURE core (src/lib/gusto-export-core.ts), so
 * there is no database and no mocking. The two things most likely to go wrong
 * silently in a payroll file are (a) overtime being re-derived slightly
 * differently from src/lib/overtime.ts and (b) the WA meal deduction being
 * taken twice; both get a dedicated case below.
 *
 * The golden CSVs are byte-compared. tests/fixtures/*.csv are marked `-text` in
 * .gitattributes so a Windows checkout cannot rewrite their line endings and
 * turn a real regression into a passing (or a passing test into a failing) run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    blockingEntries,
    buildGustoExport,
    planDeferredSettlements,
    toDetailCsv,
    toSummaryCsv,
    type ExportEntry,
    type ExportUser,
} from "../src/lib/gusto-export-core";

// One test below imports hashExport from gusto-export-db, which statically
// imports prisma and (transitively) mobile-auth's module-load secret guard.
// Nothing here touches a database.
process.env.NEXTAUTH_SECRET ??= "test-secret-for-gusto-export-tests";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const TZ = "America/Los_Angeles";

const alice: ExportUser = { id: "u-alice", name: "Alice Field", email: "alice@example.com", payType: "HOURLY" };
// Matches the DEFAULT salaried list in src/lib/payroll-config.ts.
const cj: ExportUser = { id: "u-cj", name: "CJ Manager", email: "cj@goldentouchremodeling.com", payType: "SALARY" };
const zoe: ExportUser = { id: "u-zoe", name: "Zoe Zero", email: "zoe@example.com", payType: "HOURLY" };
const dana: ExportUser = { id: "u-dana", name: "Dana Danger", email: "dana@example.com", payType: "HOURLY" };

let seq = 0;
type EntryOverrides = Omit<Partial<ExportEntry>, "startTime"> & {
    userId: string;
    /** ISO instant — spelled as a string here so the fixtures read as wall-clock facts. */
    startTime: string;
    durationHours: number;
};

function entry(overrides: EntryOverrides): ExportEntry {
    seq += 1;
    const start = new Date(overrides.startTime);
    return {
        id: overrides.id ?? `e${String(seq).padStart(2, "0")}`,
        userId: overrides.userId,
        startTime: start,
        // `?? ` would swallow an explicit null — and an explicit null IS the
        // "still clocked in" case this fixture needs to express.
        endTime: "endTime" in overrides ? overrides.endTime! : new Date(start.getTime() + overrides.durationHours * 3_600_000),
        durationHours: overrides.durationHours,
        shiftHours: overrides.shiftHours ?? overrides.durationHours,
        mealDeductionHours: overrides.mealDeductionHours ?? 0,
        needsReview: overrides.needsReview ?? false,
        isEdited: overrides.isEdited ?? false,
        mealOutcome: overrides.mealOutcome ?? null,
        projectName: overrides.projectName ?? "Mueller Remodel",
        costCodeLabel: overrides.costCodeLabel ?? "01-DEMO",
    };
}

/** 8am PDT on the given day. August is PDT (UTC-7). */
const at8am = (day: string) => `${day}T15:00:00.000Z`;
/** Company-local midnight boundaries for the fixture period, Mon 2026-08-17 .. Mon 2026-08-31. */
const PERIOD_START = new Date("2026-08-17T07:00:00.000Z");
const PERIOD_END = new Date("2026-08-31T07:00:00.000Z");

function totalsFor(userId: string, result: ReturnType<typeof buildGustoExport>) {
    const row = result.employees.find((employee) => employee.user.id === userId);
    assert.ok(row, `no totals for ${userId}`);
    return row;
}

// ── Overtime table (spec test 1) ────────────────────────────────────────────

test("a week of exactly 40 hours has no overtime", () => {
    const entries = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"].map((day) =>
        entry({ userId: alice.id, startTime: at8am(day), durationHours: 8 })
    );
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    const row = totalsFor(alice.id, result);
    assert.equal(row.regularHours, 40);
    assert.equal(row.overtimeHours, 0);
    assert.equal(row.doubleOvertimeHours, 0, "WA has no double time — the column is structural");
});

test("the 41st hour is overtime, split inside the entry that crosses 40", () => {
    const entries = [
        ...["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"].map((day) =>
            entry({ userId: alice.id, startTime: at8am(day), durationHours: 10 })
        ),
        entry({ userId: alice.id, startTime: at8am("2026-08-21"), durationHours: 1 }),
    ];
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    const row = totalsFor(alice.id, result);
    assert.equal(row.regularHours, 40);
    assert.equal(row.overtimeHours, 1);
    // The entry that straddles the threshold is the one that carries the split.
    const friday = result.detail.find((d) => d.dayKey === "2026-08-21");
    assert.equal(friday?.regularHours, 0);
    assert.equal(friday?.overtimeHours, 1);
});

test("a meal-deducted 9h shift pays 8.5h and is never deducted again", () => {
    const entries = [
        entry({
            userId: alice.id,
            startTime: at8am("2026-08-17"),
            durationHours: 8.5,
            shiftHours: 9,
            mealDeductionHours: 0.5,
        }),
    ];
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    assert.equal(totalsFor(alice.id, result).totalHours, 8.5);
    const detail = result.detail[0];
    assert.equal(detail.paidHours, 8.5);
    assert.equal(detail.shiftHours, 9);
    assert.equal(detail.mealDeductionHours, 0.5);
    // The csv must report the PAID hours, not shift minus meal computed again.
    assert.match(toDetailCsv(result.detail), /"9\.00","0\.50","8\.50"/);
});

test("hours worked BEFORE the period, in the same workweek, push in-period hours into overtime", () => {
    // Period opens Wednesday; Mon+Tue of that same Mon-Sun week are outside it.
    const periodStart = new Date("2026-08-19T07:00:00.000Z");
    const entries = [
        entry({ userId: alice.id, startTime: at8am("2026-08-17"), durationHours: 10 }),
        entry({ userId: alice.id, startTime: at8am("2026-08-18"), durationHours: 10 }),
        entry({ userId: alice.id, startTime: at8am("2026-08-19"), durationHours: 10 }),
        entry({ userId: alice.id, startTime: at8am("2026-08-20"), durationHours: 10 }),
        entry({ userId: alice.id, startTime: at8am("2026-08-21"), durationHours: 4 }),
    ];
    const result = buildGustoExport({ entries, users: [alice], periodStart, periodEnd: PERIOD_END, timeZone: TZ });
    const row = totalsFor(alice.id, result);
    // 24 in-period hours: 20 of them still regular (week hits 40 mid-Friday), 4 OT.
    assert.equal(row.regularHours, 20);
    assert.equal(row.overtimeHours, 4);
    assert.equal(result.detail.length, 3, "only in-period entries are exported");
});

test("two projects on the same day are two entries and one day of hours", () => {
    const entries = [
        entry({ userId: alice.id, startTime: "2026-08-17T15:00:00.000Z", durationHours: 4, projectName: "Mueller Remodel" }),
        entry({
            userId: alice.id,
            startTime: "2026-08-17T20:00:00.000Z",
            durationHours: 4,
            shiftHours: 4.5,
            mealDeductionHours: 0.5,
            projectName: "Mesplay Kitchen",
        }),
    ];
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    assert.equal(totalsFor(alice.id, result).totalHours, 8);
    assert.equal(result.detail.length, 2);
    // One meal deduction for the day, already applied to the entry that carries it.
    assert.deepEqual(
        result.detail.map((d) => [d.projectName, d.paidHours, d.mealDeductionHours]),
        [
            ["Mueller Remodel", 4, 0],
            ["Mesplay Kitchen", 4, 0.5],
        ]
    );
});

test("a Sunday-to-Monday midnight shift belongs to the week it STARTED in", () => {
    // Sun 2026-08-23 23:00 PDT = 2026-08-24 06:00Z; the following Monday's week
    // starts at 2026-08-24 07:00Z, so the instant alone is ambiguous.
    const entries = [
        // 40 hours already banked in the Mon 8/17 week.
        ...["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"].map((day) =>
            entry({ userId: alice.id, startTime: at8am(day), durationHours: 8 })
        ),
        entry({ userId: alice.id, startTime: "2026-08-24T06:00:00.000Z", durationHours: 4 }),
    ];
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    const row = totalsFor(alice.id, result);
    // Attributed to the 8/17 week, which was already at 40 — so all 4 are OT.
    assert.equal(row.regularHours, 40);
    assert.equal(row.overtimeHours, 4);
});

// ── Readiness (spec test 2, the 409 condition) ──────────────────────────────

test("open, flagged, zero-hour and unsettled-meal entries all block; outside the period they do not", () => {
    const entries = [
        entry({ userId: alice.id, id: "open-1", startTime: at8am("2026-08-18"), durationHours: 0, endTime: null }),
        entry({ userId: alice.id, id: "flagged-1", startTime: at8am("2026-08-19"), durationHours: 8, needsReview: true }),
        // CLOSED with no hours. buildGustoExport drops it, which is exactly why
        // it has to block: a silently missing shift is a silently missing wage.
        entry({ userId: alice.id, id: "zero-1", startTime: at8am("2026-08-20"), durationHours: 0 }),
        // Settlement could not run for this day (worker mid-shift, or it
        // failed). DEFERRED means "paid in full, meal not taken out yet".
        entry({ userId: alice.id, id: "deferred-1", startTime: at8am("2026-08-21"), durationHours: 8, mealOutcome: "DEFERRED" }),
        entry({ userId: alice.id, id: "fine", startTime: at8am("2026-08-24"), durationHours: 8, mealOutcome: "AUTO_DEDUCTED" }),
        // Same workweek, before the period — fetched for the 40h threshold only.
        entry({ userId: alice.id, id: "outside", startTime: at8am("2026-08-14"), durationHours: 8, needsReview: true }),
    ];
    const blocking = blockingEntries(entries, [alice], PERIOD_START, PERIOD_END);
    assert.deepEqual(
        blocking.map((row) => [row.id, row.reason]),
        [
            ["open-1", "open"],
            ["flagged-1", "needsReview"],
            ["zero-1", "zeroDuration"],
            ["deferred-1", "deferred"],
        ]
    );
    assert.equal(blocking[0].userLabel, "Alice Field");
});

test("a worker with no payType blocks the export — guessing is a wrong paycheque either way", () => {
    const unknown: ExportUser = { id: "u-new", name: "New Hire", email: "new@example.com", payType: null };
    const result = buildGustoExport({
        entries: [entry({ userId: unknown.id, startTime: at8am("2026-08-18"), durationHours: 8 })],
        users: [unknown],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    assert.deepEqual(result.blocking.map((row) => row.reason), ["unknownPayType"]);
    assert.equal(result.blocking[0].userLabel, "New Hire");
});

test("a payType-less worker with NO hours in the period does not block it", () => {
    const unknown: ExportUser = { id: "u-new", name: "New Hire", email: "new@example.com", payType: null };
    const result = buildGustoExport({
        // Same workweek, before the period — fetched for the 40h threshold only.
        entries: [entry({ userId: unknown.id, startTime: at8am("2026-08-14"), durationHours: 8 })],
        users: [unknown],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    assert.deepEqual(result.blocking, [], "only people actually being paid for this period need an answer");
});

test("readiness looks at the whole workweek ENVELOPE, not just the period", () => {
    // Period ends Thu 2026-08-27; the trailing partial week runs to Sun 08-30.
    // An open punch on Fri 08-28 is outside the period but inside the week, and
    // it still decides how much of the period's time is overtime.
    const periodEnd = new Date("2026-08-27T07:00:00.000Z");
    const envelopeEnd = new Date("2026-08-31T07:00:00.000Z");
    const entries = [
        entry({ userId: alice.id, id: "in-period", startTime: at8am("2026-08-18"), durationHours: 8, mealOutcome: "AUTO_DEDUCTED" }),
        entry({ userId: alice.id, id: "open-after", startTime: at8am("2026-08-28"), durationHours: 0, endTime: null }),
    ];
    const withEnvelope = buildGustoExport({
        entries,
        users: [alice],
        periodStart: PERIOD_START,
        periodEnd,
        timeZone: TZ,
        envelopeStart: PERIOD_START,
        envelopeEnd,
    });
    assert.deepEqual(withEnvelope.blocking.map((row) => row.id), ["open-after"]);

    // Without the envelope the same open punch is invisible — the bug.
    const withoutEnvelope = buildGustoExport({
        entries,
        users: [alice],
        periodStart: PERIOD_START,
        periodEnd,
        timeZone: TZ,
    });
    assert.deepEqual(withoutEnvelope.blocking, []);
});

test("a manual entry with hours but no endTime is COMPLETED, not open", () => {
    // Manual entries recorded durationHours with endTime NULL. Treating that as
    // "still clocked in" blocked every export containing one, and dropped its
    // hours from the totals. OPEN now means endTime null AND no duration.
    const manual = entry({ userId: alice.id, id: "manual", startTime: at8am("2026-08-18"), durationHours: 8 });
    const result = buildGustoExport({
        entries: [{ ...manual, endTime: null }],
        users: [alice],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    assert.deepEqual(result.blocking, [], "a completed manual entry must not block payroll");
    assert.equal(totalsFor(alice.id, result).totalHours, 8, "and its hours must be exported");
});

test("a genuinely open punch — no endTime AND no duration — still blocks", () => {
    const result = buildGustoExport({
        entries: [entry({ userId: alice.id, id: "open", startTime: at8am("2026-08-18"), durationHours: 0, endTime: null })],
        users: [alice],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    assert.deepEqual(result.blocking.map((row) => row.reason), ["open"]);
});

test("a zero-hour entry is dropped from the totals — which is why blocking has to catch it", () => {
    const entries = [entry({ userId: alice.id, id: "zero-1", startTime: at8am("2026-08-20"), durationHours: 0 })];
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    assert.equal(totalsFor(alice.id, result).totalHours, 0);
    assert.equal(result.detail.length, 0);
    assert.equal(result.blocking.length, 1, "silently exporting nothing for it is the bug");
});

// ── DEFERRED-day settlement plan (carried over from the deleted route) ──────

test("settlement skips today, the day a worker is still punched into, and any locked day", () => {
    const unsettled = [
        { userId: "u1", dayKey: "2026-08-20" },
        { userId: "u1", dayKey: "2026-08-20" }, // same day twice — one settle
        { userId: "u2", dayKey: "2026-08-21" },
        { userId: "u3", dayKey: "2026-08-25" }, // today
    ];
    const plan = planDeferredSettlements({
        unsettled,
        openPunchDayKeys: ["u2|2026-08-21"],
        todayKey: "2026-08-25",
        isDayLocked: () => false,
    });
    assert.deepEqual(plan, [{ userId: "u1", dayKey: "2026-08-20" }]);

    assert.deepEqual(
        planDeferredSettlements({ unsettled, openPunchDayKeys: [], todayKey: "2026-08-25", isDayLocked: () => true }),
        [],
        "re-downloading a LOCKED period must be a read-only recompute"
    );
});

test("an open punch TODAY does not suppress settlement of that worker's DEFERRED day weeks ago", () => {
    // The regression this pins: the open-punch guard used to be company-wide and
    // time-unbounded, so u1 clocking in this morning left their 2026-08-20
    // DEFERRED day unsettled — and it then exported at FULL pay, no meal out.
    const plan = planDeferredSettlements({
        unsettled: [{ userId: "u1", dayKey: "2026-08-20" }],
        openPunchDayKeys: ["u1|2026-09-15"],
        todayKey: "2026-09-15",
        isDayLocked: () => false,
    });
    assert.deepEqual(plan, [{ userId: "u1", dayKey: "2026-08-20" }]);
});

test("a locked day is never settled even when the requested range itself is unlocked", () => {
    const plan = planDeferredSettlements({
        unsettled: [
            { userId: "u1", dayKey: "2026-08-20" },
            { userId: "u1", dayKey: "2026-09-10" },
        ],
        openPunchDayKeys: [],
        todayKey: "2026-09-15",
        isDayLocked: (dayKey) => dayKey < "2026-08-31",
    });
    assert.deepEqual(plan, [{ userId: "u1", dayKey: "2026-09-10" }]);
});

// ── CSV injection (a payroll file is opened by a bookkeeper) ───────────────

test("formula leads in free text are defused, and quoting alone would not have done it", () => {
    const entries = [
        entry({
            userId: alice.id,
            startTime: at8am("2026-08-17"),
            durationHours: 8,
            projectName: '=HYPERLINK("http://evil.test","Invoice")',
            costCodeLabel: "+1",
        }),
    ];
    const result = buildGustoExport({ entries, users: [alice], periodStart: PERIOD_START, periodEnd: PERIOD_END, timeZone: TZ });
    const csv = toDetailCsv(result.detail);
    // The apostrophe sits INSIDE the quotes — a spreadsheet strips the quotes
    // and then sees text, not a formula.
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"",""Invoice"")","'+1"`), csv);
    assert.ok(!csv.includes(`"=HYPERLINK`), "an unescaped formula lead reached the file");
});

test("a leading minus in a NAME is defused", () => {
    const weird: ExportUser = { id: "u-x", name: "-Bob", email: "bob@example.com", payType: "HOURLY" };
    const result = buildGustoExport({
        entries: [entry({ userId: weird.id, startTime: at8am("2026-08-17"), durationHours: 8 })],
        users: [weird],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    assert.ok(toSummaryCsv(result.employees).includes(`"'-Bob"`));
});

// ── Golden files (spec test 2) ─────────────────────────────────────────────

function fixtureScenario(options: { shuffled?: boolean } = {}) {
    seq = 0;
    const entries: ExportEntry[] = [
        // Alice: five 9-hour shifts paying 8.5 each = 42.5 -> 40 regular + 2.5 OT.
        ...["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"].map((day) =>
            entry({
                userId: alice.id,
                startTime: at8am(day),
                durationHours: 8.5,
                shiftHours: 9,
                mealDeductionHours: 0.5,
                mealOutcome: "AUTO_DEDUCTED",
            })
        ),
        // CJ is salaried: present in DETAIL, absent from SUMMARY.
        entry({
            userId: cj.id,
            startTime: "2026-08-17T16:00:00.000Z",
            durationHours: 8,
            projectName: "Mesplay Kitchen",
            costCodeLabel: "99-PM",
            isEdited: true,
        }),
        // Dana carries the CSV-injection case INTO the golden file, so the byte
        // compare — not just a unit assertion — is what pins the escaping.
        entry({
            userId: dana.id,
            startTime: "2026-08-18T16:00:00.000Z",
            durationHours: 4,
            projectName: '=cmd|" /C calc"!A0',
            costCodeLabel: "-2",
        }),
        // Zoe has no entries at all — she still gets a 0.00 summary row.
    ];
    return buildGustoExport({
        entries: options.shuffled ? [...entries].reverse() : entries,
        users: options.shuffled ? [zoe, dana, cj, alice] : [alice, cj, dana, zoe],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
        employeeMappings: { [alice.id]: "GUSTO-1001", [cj.id]: "GUSTO-1002" },
        isSalaried: (user) => user.email === cj.email,
    });
}

function readFixture(name: string): string {
    return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

test("summary CSV matches the golden file (salaried excluded, zero-hours row kept)", () => {
    const result = fixtureScenario();
    assert.equal(totalsFor(alice.id, result).regularHours, 40);
    assert.equal(totalsFor(alice.id, result).overtimeHours, 2.5);
    assert.equal(toSummaryCsv(result.employees), readFixture("gusto-export-summary.csv"));
});

test("detail CSV matches the golden file (salaried included, meal columns preserved)", () => {
    const result = fixtureScenario();
    assert.equal(toDetailCsv(result.detail), readFixture("gusto-export-detail.csv"));
});

test("the export hash covers the DETAIL too — identical summary totals are not enough", async () => {
    const { hashExport } = await import("../src/lib/gusto-export-db");

    const oneShift = buildGustoExport({
        entries: [entry({ userId: alice.id, startTime: at8am("2026-08-17"), durationHours: 8, projectName: "Mueller Remodel" })],
        users: [alice],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    // Same person, same day, same 8 paid hours — split across two projects. The
    // SUMMARY csv is byte-identical; only the detail moved.
    const splitShift = buildGustoExport({
        entries: [
            entry({ userId: alice.id, startTime: "2026-08-17T15:00:00.000Z", durationHours: 4, projectName: "Mueller Remodel" }),
            entry({ userId: alice.id, startTime: "2026-08-17T20:00:00.000Z", durationHours: 4, projectName: "Mesplay Kitchen" }),
        ],
        users: [alice],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });

    const summaryA = toSummaryCsv(oneShift.employees);
    const summaryB = toSummaryCsv(splitShift.employees);
    assert.equal(summaryA, summaryB, "premise: the summaries really are identical");
    assert.notEqual(toDetailCsv(oneShift.detail), toDetailCsv(splitShift.detail));

    const hashA = hashExport(summaryA, toDetailCsv(oneShift.detail));
    const hashB = hashExport(summaryB, toDetailCsv(splitShift.detail));
    assert.notEqual(hashA, hashB, "a summary-only hash would have called these two periods identical");
    assert.equal(hashA, hashExport(summaryA, toDetailCsv(oneShift.detail)), "and it is deterministic");
});

test("the same period exports byte-identically twice — the lock's exportHash depends on it", () => {
    // Entries are fed in a different order the second time: employee and detail
    // ordering must come from the data, not from however the query returned it,
    // or a re-download of a locked period would hash differently for no reason.
    assert.equal(toSummaryCsv(fixtureScenario().employees), toSummaryCsv(fixtureScenario({ shuffled: true }).employees));
    assert.equal(toDetailCsv(fixtureScenario().detail), toDetailCsv(fixtureScenario({ shuffled: true }).detail));
});

test("the settle button and the readiness check look at the SAME window", () => {
    // Readiness blocks on a deferred day anywhere in the workweek envelope, so
    // settling only the literal pay period left a blocker just outside a
    // midweek or Sunday-start period that the button could never clear.
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "actions.ts"), "utf8");
    const action = source.slice(source.indexOf("export async function settleDeferredDaysForPeriod"));
    const body = action.slice(0, action.indexOf("\nexport async function"));
    assert.match(body, /payrollLockEnvelope\(/, "the settle action must use the envelope, not the raw period");
    assert.match(body, /startTime: \{ gte: envelope\.start, lt: envelope\.end \}/);
});

test("an UNRECOGNISED payType is unknown, never a default", () => {
    // The DB CHECK rejects these, but a value that somehow exists must block the
    // export rather than being quietly treated as hourly or salaried.
    const odd: ExportUser = { id: "u-odd", name: "Odd One", email: "odd@example.com", payType: "CONTRACT" };
    const result = buildGustoExport({
        entries: [entry({ userId: odd.id, startTime: at8am("2026-08-18"), durationHours: 8 })],
        users: [odd],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        timeZone: TZ,
    });
    assert.deepEqual(result.blocking.map((row) => row.reason), ["unknownPayType"]);
});

test("the zero-hour roster is driven by payType HOURLY, not by role", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "gusto-export-db.ts"), "utf8");
    // An hourly ADMIN or FINANCE user is a real arrangement; keying the roster
    // off role alone dropped them from the file entirely.
    assert.match(source, /status: "ACTIVATED", payType: "HOURLY"/);
    assert.match(source, /status: "ACTIVATED", payType: null, role: \{ in: \[\.\.\.HOURLY_PAID_ROLES\] \}/);
});
