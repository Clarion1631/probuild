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
    assertNotLegacyUnitEntry,
    assertUsableDuration,
    canWriteHoursFor,
    isLegacyUnitEntry,
    isOfficeTimeRole,
    LEGACY_UNIT_ENTRY_CODE,
} from "../src/lib/manual-time-entry-auth";

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
