import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AUTO_ASSIGN_PROJECT_STATUS,
    crewIdsToConnect,
    isAlwaysAssignUser,
    isAutoAssignProjectStatus,
    nameMatchesAlwaysKey,
    parseAlwaysAssignKeys,
    selectAutoAssignUsers,
    shouldAutoAssignUser,
    type AutoAssignUser,
} from "../src/lib/crew-auto-assign";
import { PROJECT_STATUS_VALUES } from "../src/lib/project-status";

function user(overrides: Partial<AutoAssignUser> = {}): AutoAssignUser {
    return {
        id: "u1",
        name: "Some Person",
        email: "some.person@example.com",
        role: "FIELD_CREW",
        status: "ACTIVATED",
        ...overrides,
    };
}

// ── the core rule: ACTIVATED FIELD_CREW ───────────────────────────────────

test("ACTIVATED FIELD_CREW is assigned", () => {
    assert.equal(shouldAutoAssignUser(user()), true);
});

test("DISABLED FIELD_CREW is NOT assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ status: "DISABLED" })), false);
});

test("PENDING FIELD_CREW is NOT assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ status: "PENDING" })), false);
});

test("a missing/unknown status is NOT assigned (fail closed)", () => {
    assert.equal(shouldAutoAssignUser(user({ status: null })), false);
    assert.equal(shouldAutoAssignUser(user({ status: "activated" })), false);
});

// ── CJ, by name, despite not being FIELD_CREW ─────────────────────────────

test("CJ as a MANAGER is assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ id: "cj", name: "CJ", role: "MANAGER" })), true);
});

test("CJ as an ADMIN is assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ id: "cj", name: "CJ", role: "ADMIN" })), true);
});

test("CJ name matching is case- and punctuation-insensitive, and matches a full name", () => {
    for (const name of ["CJ", "cj", "Cj", "C.J.", "CJ Adkins", "c.j. adkins"]) {
        assert.equal(
            shouldAutoAssignUser(user({ name, role: "MANAGER" })),
            true,
            `expected "${name}" to match`,
        );
    }
});

test("names that merely contain the letters cj do NOT match", () => {
    for (const name of ["Cjay Miller", "Marcj", "Jason CJell"]) {
        assert.equal(
            shouldAutoAssignUser(user({ name, role: "MANAGER" })),
            false,
            `expected "${name}" NOT to match`,
        );
    }
});

test("CJ is still NOT assigned when DISABLED — the status gate beats the name rule", () => {
    assert.equal(shouldAutoAssignUser(user({ name: "CJ", role: "MANAGER", status: "DISABLED" })), false);
    assert.equal(shouldAutoAssignUser(user({ name: "CJ", role: "MANAGER", status: "PENDING" })), false);
});

// ── everybody else is excluded ────────────────────────────────────────────

test("other MANAGER / ADMIN / FINANCE users are NOT assigned", () => {
    for (const role of ["MANAGER", "ADMIN", "FINANCE"]) {
        assert.equal(
            shouldAutoAssignUser(user({ name: "Dana Example", role })),
            false,
            `expected role ${role} NOT to be assigned`,
        );
    }
});

test("an unknown role is NOT assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ name: "Dana Example", role: "SUBCONTRACTOR" })), false);
    assert.equal(shouldAutoAssignUser(user({ name: "Dana Example", role: null })), false);
});

// ── configurable always-assign keys ───────────────────────────────────────

test("an email key matches only on email, never fuzzily on name", () => {
    const opts = { alwaysAssignKeys: ["cj@goldentouchremodeling.com"] };
    assert.equal(
        isAlwaysAssignUser(user({ name: "Nobody", email: "CJ@GoldenTouchRemodeling.com" }), opts),
        true,
    );
    assert.equal(isAlwaysAssignUser(user({ name: "CJ", email: "other@example.com" }), opts), false);
});

test("parseAlwaysAssignKeys: unset -> default CJ; empty string -> nobody extra", () => {
    assert.deepEqual(parseAlwaysAssignKeys(undefined), ["CJ"]);
    assert.deepEqual(parseAlwaysAssignKeys(null), ["CJ"]);
    assert.deepEqual(parseAlwaysAssignKeys(""), []);
    assert.deepEqual(parseAlwaysAssignKeys("CJ, dana@example.com"), ["CJ", "dana@example.com"]);
});

test("with an empty key list, CJ the MANAGER is no longer assigned", () => {
    assert.equal(
        shouldAutoAssignUser(user({ name: "CJ", role: "MANAGER" }), { alwaysAssignKeys: [] }),
        false,
    );
    // ...but FIELD_CREW still is — the role rule is independent.
    assert.equal(shouldAutoAssignUser(user({ role: "FIELD_CREW" }), { alwaysAssignKeys: [] }), true);
});

test("nameMatchesAlwaysKey ignores blank names and blank keys", () => {
    assert.equal(nameMatchesAlwaysKey(null, "CJ"), false);
    assert.equal(nameMatchesAlwaysKey("", "CJ"), false);
    assert.equal(nameMatchesAlwaysKey("CJ", ""), false);
    assert.equal(nameMatchesAlwaysKey("CJ", "   "), false);
});

// ── project status gate ───────────────────────────────────────────────────

test('only "In Progress" projects get auto-assignment', () => {
    assert.equal(isAutoAssignProjectStatus(AUTO_ASSIGN_PROJECT_STATUS), true);
    for (const status of PROJECT_STATUS_VALUES.filter((s) => s !== AUTO_ASSIGN_PROJECT_STATUS)) {
        assert.equal(isAutoAssignProjectStatus(status), false, `expected "${status}" to be excluded`);
    }
});

test("no status at all is excluded", () => {
    assert.equal(isAutoAssignProjectStatus(null), false);
    assert.equal(isAutoAssignProjectStatus(undefined), false);
    assert.equal(isAutoAssignProjectStatus(""), false);
    assert.equal(isAutoAssignProjectStatus("Nonsense"), false);
});

test('legacy statuses that canonicalize to "In Progress" count', () => {
    assert.equal(isAutoAssignProjectStatus("Open"), true);
    assert.equal(isAutoAssignProjectStatus("Active"), true);
    assert.equal(isAutoAssignProjectStatus("Done"), false);
});

// ── selection + idempotency ───────────────────────────────────────────────

const ROSTER: AutoAssignUser[] = [
    user({ id: "crew-a", name: "Alex Crew", role: "FIELD_CREW", status: "ACTIVATED" }),
    user({ id: "crew-b", name: "Bella Crew", role: "FIELD_CREW", status: "ACTIVATED" }),
    user({ id: "crew-disabled", name: "Gone Crew", role: "FIELD_CREW", status: "DISABLED" }),
    user({ id: "crew-pending", name: "New Crew", role: "FIELD_CREW", status: "PENDING" }),
    user({ id: "cj", name: "CJ", role: "MANAGER", status: "ACTIVATED" }),
    user({ id: "mgr", name: "Other Manager", role: "MANAGER", status: "ACTIVATED" }),
    user({ id: "admin", name: "Justin Admin", role: "ADMIN", status: "ACTIVATED" }),
    user({ id: "fin", name: "Fin Ance", role: "FINANCE", status: "ACTIVATED" }),
];

test("selectAutoAssignUsers picks exactly the two crew plus CJ", () => {
    assert.deepEqual(selectAutoAssignUsers(ROSTER).map((u) => u.id), ["crew-a", "crew-b", "cj"]);
});

test("crewIdsToConnect returns everyone eligible when the project has no crew", () => {
    assert.deepEqual(crewIdsToConnect(ROSTER, []), ["crew-a", "crew-b", "cj"]);
});

test("re-running is a no-op: nothing to connect when all eligible users are already crew", () => {
    const first = crewIdsToConnect(ROSTER, []);
    const second = crewIdsToConnect(ROSTER, first);
    assert.deepEqual(second, [], "second pass must produce zero writes");
});

test("crewIdsToConnect only returns the missing ids, and never removes anyone", () => {
    // "stranger" is on the crew by hand and is not eligible — we must not
    // propose anything about them (this helper only ever adds).
    const toConnect = crewIdsToConnect(ROSTER, ["crew-a", "stranger"]);
    assert.deepEqual(toConnect, ["crew-b", "cj"]);
});

test("crewIdsToConnect drops blank ids and dedupes", () => {
    const dupes: AutoAssignUser[] = [
        user({ id: "crew-a", role: "FIELD_CREW" }),
        user({ id: "crew-a", role: "FIELD_CREW" }),
        user({ id: "", role: "FIELD_CREW" }),
    ];
    assert.deepEqual(crewIdsToConnect(dupes, []), ["crew-a"]);
});
