/**
 * Who may delete a time entry (src/lib/time-entry-delete-policy.ts).
 *
 * Owner decision 2026-08-30: crew may delete their OWN entry only while it is still
 * today's (company day, by immutable createdAt) and nothing downstream references it;
 * managers/admins may delete anything. Pinned per Codex gate on PR #434.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    checkDeleteAllowed,
    DELETE_REFUSAL_MESSAGES,
    DeleteRefusedError,
    isLockedDownstream,
    isPrivilegedDeleter,
    type DeleteVictim,
} from "../src/lib/time-entry-delete-policy";

// Midday Pacific — well inside one company day on both sides of DST.
const NOW = new Date("2026-08-30T19:00:00.000Z");
const CREW = { id: "u-crew", role: "FIELD_CREW" };

function victim(overrides: Partial<DeleteVictim> = {}): DeleteVictim {
    return {
        userId: "u-crew",
        createdAt: new Date(NOW.getTime() - 3 * 3_600_000), // punched in three hours ago, same day
        invoiceId: null,
        invoicedAt: null,
        qbTimeActivityId: null,
        qbSyncedAt: null,
        ...overrides,
    };
}

test("owner may delete their own same-day, unlinked entry", () => {
    assert.deepEqual(checkDeleteAllowed(CREW, victim(), NOW), { ok: true });
});

test("owner may not delete another worker's entry", () => {
    assert.deepEqual(checkDeleteAllowed(CREW, victim({ userId: "u-other" }), NOW), { ok: false, code: "NOT_OWNER" });
});

test("owner may not delete an entry created on an earlier company day", () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000);
    assert.deepEqual(checkDeleteAllowed(CREW, victim({ createdAt: yesterday }), NOW), { ok: false, code: "NOT_TODAY" });
    // Even a few minutes before the company-day boundary counts as a different day.
    const lateLastNight = new Date("2026-08-30T06:55:00.000Z"); // 23:55 PDT on 08-29
    assert.deepEqual(checkDeleteAllowed(CREW, victim({ createdAt: lateLastNight }), NOW), { ok: false, code: "NOT_TODAY" });
});

test("the day is judged by createdAt, not by any editable field", () => {
    // A row created today stays deletable no matter what its (editable) times say —
    // the policy never reads startTime, so there is nothing to move.
    const created = new Date(NOW.getTime() - 60_000);
    assert.deepEqual(checkDeleteAllowed(CREW, { ...victim({ createdAt: created }), startTime: new Date("2026-01-01T00:00:00Z") } as DeleteVictim, NOW), { ok: true });
});

test("each downstream link blocks an owner delete", () => {
    const cases: Array<Partial<DeleteVictim>> = [
        { invoiceId: "inv1" },
        { invoicedAt: new Date(NOW.getTime() - 1000) },
        { qbTimeActivityId: "qb1" },
        { qbSyncedAt: new Date(NOW.getTime() - 1000) },
    ];
    for (const c of cases) {
        assert.equal(isLockedDownstream(victim(c)), true, JSON.stringify(c));
        assert.deepEqual(checkDeleteAllowed(CREW, victim(c), NOW), { ok: false, code: "LOCKED_DOWNSTREAM" }, JSON.stringify(c));
    }
    assert.equal(isLockedDownstream(victim()), false);
});

test("refusal order: ownership first, then day, then downstream lock", () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000);
    assert.deepEqual(
        checkDeleteAllowed(CREW, victim({ userId: "u-other", createdAt: yesterday, invoiceId: "inv1" }), NOW),
        { ok: false, code: "NOT_OWNER" }
    );
    assert.deepEqual(
        checkDeleteAllowed(CREW, victim({ createdAt: yesterday, invoiceId: "inv1" }), NOW),
        { ok: false, code: "NOT_TODAY" }
    );
});

test("managers and admins bypass every owner restriction; other roles do not", () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000);
    const locked = victim({ userId: "u-other", createdAt: yesterday, invoiceId: "inv1", qbSyncedAt: NOW });
    for (const role of ["MANAGER", "ADMIN"]) {
        assert.equal(isPrivilegedDeleter(role), true, role);
        assert.deepEqual(checkDeleteAllowed({ id: "u-mgr", role }, locked, NOW), { ok: true }, role);
    }
    for (const role of ["FIELD_CREW", "FINANCE", "", "admin"]) {
        assert.equal(isPrivilegedDeleter(role), false, JSON.stringify(role));
        assert.equal(checkDeleteAllowed({ id: "u-x", role }, locked, NOW).ok, false, JSON.stringify(role));
    }
});

test("DeleteRefusedError carries the code and the user-facing message", () => {
    const err = new DeleteRefusedError("LOCKED_DOWNSTREAM");
    assert.equal(err.code, "LOCKED_DOWNSTREAM");
    assert.equal(err.message, DELETE_REFUSAL_MESSAGES.LOCKED_DOWNSTREAM);
    assert.equal(err instanceof Error, true);
    assert.equal(err.name, "DeleteRefusedError");
});
