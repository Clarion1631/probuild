import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    AUTO_ASSIGN_PROJECT_STATUS,
    AUTO_ASSIGN_STATUS_VALUES,
    autoAssignStatusWhere,
    crewIdsToConnect,
    isAutoAssignProjectStatus,
    selectAutoAssignUsers,
    shouldAutoAssignUser,
    type AutoAssignUser,
} from "../src/lib/crew-auto-assign";
import { PROJECT_STATUS_VALUES } from "../src/lib/project-status";

const __dirname = dirname(fileURLToPath(import.meta.url));

function user(overrides: Partial<AutoAssignUser> = {}): AutoAssignUser {
    return {
        id: "u1",
        role: "FIELD_CREW",
        status: "ACTIVATED",
        showOnDispatch: true,
        ...overrides,
    };
}

// ── the core rule: exactly isDispatchable ─────────────────────────────────

test("ACTIVATED FIELD_CREW with the dispatch switch on is assigned", () => {
    assert.equal(shouldAutoAssignUser(user()), true);
});

test("a manager with the dispatch switch on is assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ role: "MANAGER", showOnDispatch: true })), true);
});

test("an admin with the dispatch switch on is assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ role: "ADMIN", showOnDispatch: true })), true);
});

test("field crew with the dispatch switch off is NOT assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ role: "FIELD_CREW", showOnDispatch: false })), false);
});

test("a manager with the dispatch switch off is NOT assigned", () => {
    assert.equal(shouldAutoAssignUser(user({ role: "MANAGER", showOnDispatch: false })), false);
});

test("FINANCE is never assigned, even with the switch on", () => {
    assert.equal(shouldAutoAssignUser(user({ role: "FINANCE", showOnDispatch: true })), false);
});

test("DISABLED users are NOT assigned, even with the switch on", () => {
    assert.equal(shouldAutoAssignUser(user({ status: "DISABLED", showOnDispatch: true })), false);
});

test("PENDING users are NOT assigned, even with the switch on", () => {
    assert.equal(shouldAutoAssignUser(user({ status: "PENDING", showOnDispatch: true })), false);
});

test("a missing/unknown status is NOT assigned (fail closed)", () => {
    assert.equal(shouldAutoAssignUser(user({ status: null, showOnDispatch: true })), false);
    assert.equal(shouldAutoAssignUser(user({ status: "activated", showOnDispatch: true })), false);
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

// ── AUTO_ASSIGN_STATUS_VALUES / autoAssignStatusWhere ─────────────────────

test("AUTO_ASSIGN_STATUS_VALUES contains the canonical status plus every legacy status that maps to it", () => {
    assert.deepEqual(new Set(AUTO_ASSIGN_STATUS_VALUES), new Set(["In Progress", "Open", "Active"]));
});

test("AUTO_ASSIGN_STATUS_VALUES agrees with isAutoAssignProjectStatus for every value it contains, and disagrees for everything else", () => {
    for (const status of AUTO_ASSIGN_STATUS_VALUES) {
        assert.equal(isAutoAssignProjectStatus(status), true, `expected "${status}" to be a recognized auto-assign status`);
    }
    const allKnown = [...PROJECT_STATUS_VALUES, "Open", "Active", "Paid Ready to Start", "Done", "Closed", "Completed"];
    for (const status of allKnown.filter((s) => !AUTO_ASSIGN_STATUS_VALUES.includes(s))) {
        assert.equal(isAutoAssignProjectStatus(status), false, `expected "${status}" to be excluded`);
    }
});

test("autoAssignStatusWhere is a Prisma `in` filter over AUTO_ASSIGN_STATUS_VALUES", () => {
    assert.deepEqual(autoAssignStatusWhere, { status: { in: AUTO_ASSIGN_STATUS_VALUES } });
});

// ── scripts/sync-crew-to-in-progress.mjs stays in lockstep ───────────────
// That script can't import this TS module (bare `node scripts/*.mjs`, no
// alias/TS transform), so it mirrors AUTO_ASSIGN_STATUS_VALUES as a plain JS
// literal. Assert the two never drift apart by reading the script's source.

test("sync-crew-to-in-progress.mjs's TARGET_STATUSES literal matches AUTO_ASSIGN_STATUS_VALUES", () => {
    const scriptPath = join(__dirname, "..", "scripts", "sync-crew-to-in-progress.mjs");
    const source = readFileSync(scriptPath, "utf8");
    const match = source.match(/const TARGET_STATUSES = (\[[^\]]*\]);/);
    assert.ok(match, "expected to find a `const TARGET_STATUSES = [...]` literal in sync-crew-to-in-progress.mjs");
    const scriptStatuses: string[] = JSON.parse(match[1].replace(/'/g, '"'));
    assert.deepEqual(
        new Set(scriptStatuses),
        new Set(AUTO_ASSIGN_STATUS_VALUES),
        "scripts/sync-crew-to-in-progress.mjs's TARGET_STATUSES has drifted from AUTO_ASSIGN_STATUS_VALUES in src/lib/crew-auto-assign.ts",
    );
});

// ── selection + idempotency ───────────────────────────────────────────────

const ROSTER: AutoAssignUser[] = [
    user({ id: "crew-a", role: "FIELD_CREW", status: "ACTIVATED", showOnDispatch: true }),
    user({ id: "crew-b", role: "FIELD_CREW", status: "ACTIVATED", showOnDispatch: true }),
    user({ id: "crew-off", role: "FIELD_CREW", status: "ACTIVATED", showOnDispatch: false }),
    user({ id: "crew-disabled", role: "FIELD_CREW", status: "DISABLED", showOnDispatch: true }),
    user({ id: "crew-pending", role: "FIELD_CREW", status: "PENDING", showOnDispatch: true }),
    user({ id: "mgr-on", role: "MANAGER", status: "ACTIVATED", showOnDispatch: true }),
    user({ id: "mgr-off", role: "MANAGER", status: "ACTIVATED", showOnDispatch: false }),
    user({ id: "admin-on", role: "ADMIN", status: "ACTIVATED", showOnDispatch: true }),
    user({ id: "fin-on", role: "FINANCE", status: "ACTIVATED", showOnDispatch: true }),
];

test("selectAutoAssignUsers picks exactly the dispatchable ones", () => {
    assert.deepEqual(
        selectAutoAssignUsers(ROSTER).map((u) => u.id),
        ["crew-a", "crew-b", "mgr-on", "admin-on"],
    );
});

test("crewIdsToConnect returns everyone eligible when the project has no crew", () => {
    assert.deepEqual(crewIdsToConnect(ROSTER, []), ["crew-a", "crew-b", "mgr-on", "admin-on"]);
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
    assert.deepEqual(toConnect, ["crew-b", "mgr-on", "admin-on"]);
});

test("crewIdsToConnect drops blank ids and dedupes", () => {
    const dupes: AutoAssignUser[] = [
        user({ id: "crew-a", role: "FIELD_CREW" }),
        user({ id: "crew-a", role: "FIELD_CREW" }),
        user({ id: "", role: "FIELD_CREW" }),
    ];
    assert.deepEqual(crewIdsToConnect(dupes, []), ["crew-a"]);
});
