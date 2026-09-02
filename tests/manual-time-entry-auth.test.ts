/**
 * Who may write a manual time entry, and for whom (review round 14, items 1-3).
 *
 * Two holes this pins shut, both live until now:
 *
 *  1. The project timeclock actions checked only "can you see this project".
 *     `userId` came from the request body, so any FIELD_CREW member could post
 *     hours — priced from the TARGET's stored rates — against any colleague.
 *  2. deleteTimeEntry had a bare session check and nothing else: any signed-in
 *     account could delete any entry in the system by id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    assertNotClockGeneratedEntry,
    assertNotLegacyUnitEntry,
    assertUsableDuration,
    canWriteHoursFor,
    isLegacyUnitEntry,
    isOfficeTimeRole,
    isClockGeneratedEntry,
    CLOCK_GENERATED_ENTRY_CODE,
    LEGACY_UNIT_ENTRY_CODE,
} from "../src/lib/manual-time-entry-auth";
import { settleDayPlan } from "../src/lib/wa-breaks";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-manual-entry-auth";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

test("crew write only their OWN hours; the office writes anyone's", () => {
    const crew = { id: "u-crew", role: "FIELD_CREW" };
    assert.equal(canWriteHoursFor(crew, "u-crew"), true, "their own, always");
    assert.equal(canWriteHoursFor(crew, "u-other"), false, "never a colleague's");

    // The legacy role is crew too.
    assert.equal(canWriteHoursFor({ id: "u1", role: "EMPLOYEE" }, "u2"), false);

    for (const role of ["ADMIN", "MANAGER", "FINANCE"]) {
        assert.equal(canWriteHoursFor({ id: "u-office", role }, "u-other"), true, role);
        assert.equal(isOfficeTimeRole(role), true, role);
    }
    assert.equal(isOfficeTimeRole("FIELD_CREW"), false);
    assert.equal(isOfficeTimeRole(null), false);
});

test("both manual action files authorize the target user, not just the project", () => {
    for (const file of [
        ["src", "app", "projects", "[id]", "timeclock", "actions.ts"],
        ["src", "lib", "time-expense-actions.ts"],
    ]) {
        const source = readFileSync(path.join(__dirname, "..", ...file), "utf8");
        // The old gate took a project and nothing else.
        assert.doesNotMatch(source, /assertTimeclockProjectAccess\(/, file.join("/"));
        assert.match(source, /assertManualEntryWrite\(/, file.join("/"));
        // Deletes authorize against the STORED row.
        assert.match(source, /assertManualEntryDelete\(id\)/, file.join("/"));
    }
});

test("the delete path never trusts a caller-supplied id alone", () => {
    const source = readFileSync(path.join(__dirname, "..", "src", "lib", "manual-time-entry-auth.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function assertManualEntryDelete"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    // Everything is read off the row: its project and its owner.
    assert.match(body, /canAccessProject\(user, entry\.projectId\)/);
    assert.match(body, /canWriteHoursFor\(user, entry\.userId\)/);
    assert.match(body, /hasPermission\(user, "timeClock"\)/);
});

test("the timeclock delete no longer passes on a bare session", () => {
    const source = readFileSync(
        path.join(__dirname, "..", "src", "app", "projects", "[id]", "timeclock", "actions.ts"),
        "utf8"
    );
    const fn = source.slice(source.indexOf("export async function deleteTimeEntry"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.doesNotMatch(body, /getServerSession/);
    assert.match(body, /assertManualEntryDelete\(id\)/);
});

test("a legacy flat-cost entry is refused, with a code the client can branch on", () => {
    // Zero hours carrying a hand-typed cost. The new paths price from
    // hours x rate, so "just editing" one silently reprices it to $0 and
    // destroys a real recorded cost.
    const legacy = { durationHours: 0, laborCost: 150 };
    assert.equal(isLegacyUnitEntry(legacy), true);
    assert.equal(isLegacyUnitEntry({ durationHours: null, laborCost: 150 }), true);
    // A normal entry is not one, and neither is a genuinely zero-cost row.
    assert.equal(isLegacyUnitEntry({ durationHours: 8, laborCost: 200 }), false);
    assert.equal(isLegacyUnitEntry({ durationHours: 0, laborCost: 0 }), false);
    assert.equal(isLegacyUnitEntry({ durationHours: 0, laborCost: null }), false);

    assert.throws(
        () => assertNotLegacyUnitEntry(legacy),
        (error: Error & { code?: string }) => {
            assert.equal(error.code, LEGACY_UNIT_ENTRY_CODE);
            return true;
        }
    );
    assertNotLegacyUnitEntry({ durationHours: 8, laborCost: 200 });
});

test("durations are validated before anything is priced from them", () => {
    assert.equal(assertUsableDuration(8), 8);
    assert.equal(assertUsableDuration("7.5"), 7.5);
    for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, "abc", {}]) {
        assert.throws(() => assertUsableDuration(bad), /greater than zero/, String(bad));
    }
});

test("both pricing helpers honour the shared acknowledge predicate", () => {
    // Not "is the caller privileged" written out twice — one predicate, so the
    // API routes and the server actions cannot drift apart.
    for (const file of [
        ["src", "app", "projects", "[id]", "timeclock", "actions.ts"],
        ["src", "lib", "time-expense-actions.ts"],
    ]) {
        const source = readFileSync(path.join(__dirname, "..", ...file), "utf8");
        assert.match(source, /canAcknowledgeZeroRate\(actor, data\.userId\)/, file.join("/"));
    }
});


// ---------------------------------------------------------------------------
// Review round 15, item 2: the manual actions refuse clocked rows, and they
// re-settle the day they touched inside the same transaction.
// ---------------------------------------------------------------------------

const MANUAL_ACTION_FILES = [
    "src/lib/time-expense-actions.ts",
    "src/app/projects/[id]/timeclock/actions.ts",
];

function actionSource(file: string): string {
    return readFileSync(path.join(process.cwd(), file), "utf8");
}

test("a clocked row is one with a real endTime; a manual row has none", () => {
    assert.equal(isClockGeneratedEntry({ endTime: new Date("2026-09-01T17:00:00Z") }), true);
    assert.equal(isClockGeneratedEntry({ endTime: null }), false);
    // An unparseable date is not evidence of a punch.
    assert.equal(isClockGeneratedEntry({ endTime: new Date("nonsense") }), false);
});

test("the manual actions refuse a clocked row with a CODED error", () => {
    let error: (Error & { code?: string }) | null = null;
    try {
        assertNotClockGeneratedEntry({ endTime: new Date("2026-09-01T17:00:00Z") });
    } catch (thrown) {
        error = thrown as Error & { code?: string };
    }
    assert.ok(error, "a clocked row must be refused");
    assert.equal(error!.code, CLOCK_GENERATED_ENTRY_CODE);
    // Says where to go instead, rather than just refusing.
    assert.match(error!.message, /time clock/i);
    // A manual row passes.
    assert.doesNotThrow(() => assertNotClockGeneratedEntry({ endTime: null }));
});

test("BOTH manual update/delete paths call the clocked-row guard", () => {
    for (const file of MANUAL_ACTION_FILES) {
        const source = actionSource(file);
        const update = source.slice(source.indexOf("export async function updateTimeEntry"));
        assert.match(
            update.slice(0, update.indexOf("export async function deleteTimeEntry")),
            /assertNotClockGeneratedEntry\(/,
            `${file}: update`
        );
        const del = source.slice(source.indexOf("export async function deleteTimeEntry"));
        assert.match(del, /assertNotClockGeneratedEntry\(entry\)/, `${file}: delete`);
        // Which means both must READ endTime — a guard cannot fire on a column
        // that was never selected.
        assert.match(source, /endTime: true/, `${file}: selects endTime`);
    }
});

test("the manual paths do NOT settle — a manual row has no endTime to plan", () => {
    // Round 15 added settlement here; round 16 removed it after checking the
    // premise. settleDayInTx selects `endTime: { not: null }`, and
    // assertNotClockGeneratedEntry guarantees these rows have none — so the
    // settle call could only take locks and re-plan a day this write cannot
    // have touched. Settlement belongs to the clocked paths.
    const settle = readFileSync(path.join(process.cwd(), "src/lib/wa-breaks-db.ts"), "utf8");
    assert.match(settle, /endTime: \{ not: null \}/);

    for (const file of MANUAL_ACTION_FILES) {
        const source = actionSource(file);
        assert.doesNotMatch(source, /settleDayWithinTx/, file);
        assert.doesNotMatch(source, /dayKeys:/, file);
    }
});

test("deleting one of two shifts drops the meal deduction the day no longer earns", () => {
    // Two shifts, 4h and 3h, on one day: 7h worked, which is over the WA
    // threshold, so the day carries a meal deduction.
    const day = (id: string, from: string, to: string) => ({
        id,
        startTime: new Date(from),
        endTime: new Date(to),
        mealOutcome: null,
        mealSkipStatus: null,
        reviewReason: null,
    });
    const both = settleDayPlan({
        entries: [
            // A SHORT gap: anything over PUNCHED_MEAL_GAP_MINUTES would count
            // as the break already taken, and the day would owe nothing.
            day("a", "2026-09-01T15:00:00Z", "2026-09-01T19:00:00Z"),
            day("b", "2026-09-01T19:10:00Z", "2026-09-01T22:10:00Z"),
        ],
    });
    const deductedTogether = both.reduce((sum, row) => sum + row.mealDeductionHours, 0);
    assert.ok(deductedTogether > 0, "7 worked hours earn a meal deduction");

    // Now shift "b" is deleted. What is LEFT is 4 hours, under the threshold —
    // so the deduction must come off. Without a re-settle the surviving row
    // would keep a deduction for a break the day no longer requires, and the
    // member would be short-paid half an hour.
    const remaining = settleDayPlan({
        entries: [day("a", "2026-09-01T15:00:00Z", "2026-09-01T19:00:00Z")],
    });
    const deductedAlone = remaining.reduce((sum, row) => sum + row.mealDeductionHours, 0);
    assert.equal(deductedAlone, 0, "4 hours alone earn none");
    assert.equal(remaining[0].paidHours, 4, "and the paid hours go back up");
});
