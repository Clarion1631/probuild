/**
 * Unit tests for the Dispatch Day lens's plain-list row derivations. See
 * src/app/company-dashboard/schedule-board/dispatch-day-rows.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildDispatchDayCollisions,
    buildDispatchDayJobGroups,
    chipLabelsForRow,
    collisionDelta,
    disambiguateMemberNames,
    finalTaskUserIds,
    findConflictOtherProject,
    findReviewCollisions,
    getRosterNotOnJobToday,
    type DispatchDayCrewConflictInput,
    type DispatchDayCrewDraft,
    type DispatchDayProjectInput,
    type DispatchReviewTaskInput,
} from "../src/app/company-dashboard/schedule-board/dispatch-day-rows";

const dayKey = "2026-08-29";

function task(overrides: Partial<DispatchDayProjectInput["tasks"][number]> = {}): DispatchDayProjectInput["tasks"][number] {
    return {
        id: "t1",
        name: "Hang drywall in hall bath",
        type: "task",
        startDate: "2026-08-29T00:00:00.000Z",
        endDate: "2026-08-30T00:00:00.000Z",
        doneWhen: null,
        estimateItemId: "ei1",
        costCode: "07-DRYWALL",
        assignments: [],
        ...overrides,
    };
}

function project(overrides: Partial<DispatchDayProjectInput> = {}): DispatchDayProjectInput {
    return {
        id: "p1",
        name: "Hoppe Bathroom Remodel",
        crew: [],
        tasks: [task()],
        ...overrides,
    };
}

test("buildDispatchDayJobGroups: a project with no active task today still gets a group, with empty rows", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-09-02T00:00:00.000Z" })] })],
        dayKey, {}, null, new Map(),
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].projectId, "p1");
    assert.deepEqual(groups[0].rows, []);
});

test("buildDispatchDayJobGroups: every project passed in gets a group, active or not", () => {
    const groups = buildDispatchDayJobGroups(
        [
            project({ id: "p1", tasks: [task({ id: "t1" })] }),
            project({ id: "p2", name: "Idle Job", tasks: [task({ id: "t2", startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-09-02T00:00:00.000Z" })] }),
        ],
        dayKey, {}, null, new Map(),
    );
    assert.deepEqual(groups.map(g => g.projectId), ["p1", "p2"]);
    assert.equal(groups[0].rows.length, 1);
    assert.equal(groups[1].rows.length, 0);
});

test("buildDispatchDayJobGroups: one row per active task, isCosted derived from the resolved costCode alone", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [
            task({ id: "t1", estimateItemId: "ei1", costCode: "07-DRYWALL" }),
            task({ id: "t2", name: "drywall start (not costed)", estimateItemId: null, costCode: null }),
            // A leaf whose estimate item resolved through resolveChargeableItems
            // to null — an ineligible estimate, or a chain with no coded item
            // at all — must read "not costed" too, even though it IS linked.
            task({ id: "t3", name: "linked but unresolved", estimateItemId: "ei3", costCode: null }),
        ] })],
        dayKey, {}, null, new Map(),
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].rows.length, 3);
    assert.equal(groups[0].rows[0].costCode, "07-DRYWALL");
    assert.equal(groups[0].rows[0].isCosted, true);
    assert.equal(groups[0].rows[1].costCode, null);
    assert.equal(groups[0].rows[1].isCosted, false);
    assert.equal(groups[0].rows[2].costCode, null);
    assert.equal(groups[0].rows[2].isCosted, false);
});

test("buildDispatchDayJobGroups: solid assignment renders assigned, lead flagged", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [
            { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "lead", showOnDispatch: true },
            { userId: "u2", name: "CJ", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, {}, null, new Map(),
    );
    const people = groups[0].rows[0].people;
    assert.equal(people.length, 2);
    assert.deepEqual(people.map(p => [p.id, p.lead, p.state]), [["u1", true, "assigned"], ["u2", false, "assigned"]]);
});

test("buildDispatchDayJobGroups: draft removal drops a solid assignment", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [
            { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, { t1: { addUserIds: [], removeUserIds: ["u1"] } }, null, new Map(),
    );
    assert.equal(groups[0].rows[0].people.length, 0);
});

test("buildDispatchDayJobGroups: draft addition renders as a drafted person with a resolved name", () => {
    const memberNamesById = new Map([["u9", "Kevin"]]);
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [] })] })],
        dayKey, { t1: { addUserIds: ["u9"], removeUserIds: [] } }, null, memberNamesById,
    );
    const people = groups[0].rows[0].people;
    assert.equal(people.length, 1);
    assert.deepEqual([people[0].id, people[0].name, people[0].state], ["u9", "Kevin", "drafted"]);
});

test("buildDispatchDayJobGroups: a solid assignment also present in addUserIds is not duplicated, and renders drafted", () => {
    // This mirrors ScheduleBoard's boardData, which already overlays
    // crewDrafts into task.assignments for other previews before this
    // function ever runs — so a drafted add's id showing up in
    // task.assignments (not just addUserIds) is the normal case, not an
    // edge case. It must still classify as "drafted" (dashed chip), not
    // "assigned" (solid chip), or a not-yet-saved add renders solid.
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [
            { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, { t1: { addUserIds: ["u1"], removeUserIds: [] } }, null, new Map(),
    );
    const people = groups[0].rows[0].people;
    assert.equal(people.length, 1);
    assert.deepEqual([people[0].id, people[0].state], ["u1", "drafted"]);
});

test("buildDispatchDayJobGroups: non-dispatchable assignment (e.g. FINANCE role) is excluded", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [
            { userId: "u1", name: "Vanessa", status: "ACTIVATED", userRole: "FINANCE", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, {}, null, new Map(),
    );
    assert.equal(groups[0].rows[0].people.length, 0);
});

const conflictPair = {
    projectA: { id: "p1", name: "Hoppe Bathroom Remodel" },
    projectB: { id: "p2", name: "Mesplay Kitchen" },
    overlapStart: "2026-08-29T00:00:00.000Z",
    overlapEnd: "2026-08-30T00:00:00.000Z",
    taskA: { id: "t1", name: "Drywall", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-30T00:00:00.000Z" },
    taskB: { id: "t2", name: "Cabs", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-30T00:00:00.000Z" },
};
const conflicts: DispatchDayCrewConflictInput[] = [{ userId: "u1", name: "Garrett", pairs: [conflictPair] }];

test("findConflictOtherProject: returns the other job's name when double-booked that day", () => {
    assert.equal(findConflictOtherProject(conflicts, "u1", dayKey, "p1"), "Mesplay Kitchen");
    assert.equal(findConflictOtherProject(conflicts, "u1", dayKey, "p2"), "Hoppe Bathroom Remodel");
});

test("findConflictOtherProject: null when the day is outside the overlap window", () => {
    assert.equal(findConflictOtherProject(conflicts, "u1", "2026-09-05", "p1"), null);
});

test("findConflictOtherProject: null for a user with no conflict entry", () => {
    assert.equal(findConflictOtherProject(conflicts, "u2", dayKey, "p1"), null);
});

test("buildDispatchDayJobGroups: a conflicted person is flagged with the other job's name", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ id: "p1", tasks: [task({ id: "t1", assignments: [
            { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, {}, conflicts, new Map(),
    );
    const person = groups[0].rows[0].people[0];
    assert.equal(person.conflicted, true);
    assert.equal(person.conflictTitle, "Also on Mesplay Kitchen today");
});

test("getRosterNotOnJobToday: excludes assigned and drafted-added, includes everyone else", () => {
    const roster = [{ id: "u1", name: "Garrett" }, { id: "u2", name: "CJ" }, { id: "u3", name: "Chris" }];
    const projects = [project({ tasks: [task({ assignments: [
        { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
    ] })] })];
    const result = getRosterNotOnJobToday(roster, projects, dayKey, { t1: { addUserIds: ["u2"], removeUserIds: [] } });
    assert.deepEqual(result.map(m => m.id), ["u3"]);
});

test("getRosterNotOnJobToday: a draft-removed assignee is treated as not on a job", () => {
    const roster = [{ id: "u1", name: "Garrett" }];
    const projects = [project({ tasks: [task({ assignments: [
        { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
    ] })] })];
    const result = getRosterNotOnJobToday(roster, projects, dayKey, { t1: { addUserIds: [], removeUserIds: ["u1"] } });
    assert.deepEqual(result.map(m => m.id), ["u1"]);
});

test("disambiguateMemberNames: two accounts with the same name get their email appended", () => {
    const labels = disambiguateMemberNames([
        { id: "u1", name: "Justin Adkins", email: "justin@constructionio.com" },
        { id: "u2", name: "Justin Adkins", email: "jadkins@goldentouchremodeling.com" },
        { id: "u3", name: "Garrett", email: "garrett@goldentouchremodeling.com" },
    ]);
    assert.equal(labels.get("u1"), "Justin Adkins (justin@constructionio.com)");
    assert.equal(labels.get("u2"), "Justin Adkins (jadkins@goldentouchremodeling.com)");
    assert.equal(labels.get("u3"), "Garrett");
});

test("disambiguateMemberNames: collision detection is case-insensitive and trims whitespace", () => {
    const labels = disambiguateMemberNames([
        { id: "u1", name: "justin adkins", email: "justin@constructionio.com" },
        { id: "u2", name: " Justin Adkins ", email: "jadkins@goldentouchremodeling.com" },
    ]);
    assert.equal(labels.get("u1"), "justin adkins (justin@constructionio.com)");
    assert.equal(labels.get("u2"), " Justin Adkins  (jadkins@goldentouchremodeling.com)");
});

test("disambiguateMemberNames: a single member with no collision is returned bare", () => {
    const labels = disambiguateMemberNames([{ id: "u1", name: "Garrett", email: "garrett@goldentouchremodeling.com" }]);
    assert.equal(labels.get("u1"), "Garrett");
});

test("disambiguateMemberNames: empty list returns an empty map", () => {
    assert.equal(disambiguateMemberNames([]).size, 0);
});

test("chipLabelsForRow: two email-disambiguated full names sharing a first name get distinct compact labels", () => {
    const people = [
        { id: "u1", name: "Justin Adkins (jadkins@goldentouchremodeling.com)" },
        { id: "u2", name: "Justin Smith (jsmith@goldentouchremodeling.com)" },
    ];
    const memberEmailsById = new Map([
        ["u1", "jadkins@goldentouchremodeling.com"],
        ["u2", "jsmith@goldentouchremodeling.com"],
    ]);
    const labels = chipLabelsForRow(people, memberEmailsById);
    assert.equal(labels.get("u1"), "Justin (jadkins)");
    assert.equal(labels.get("u2"), "Justin (jsmith)");
});

test("chipLabelsForRow: no first-name collision in the row renders a bare first name", () => {
    const people = [
        { id: "u1", name: "Justin Adkins" },
        { id: "u2", name: "CJ Miller" },
    ];
    const labels = chipLabelsForRow(people, new Map());
    assert.equal(labels.get("u1"), "Justin");
    assert.equal(labels.get("u2"), "CJ");
});

test("chipLabelsForRow: a colliding person missing from memberEmailsById falls back to the bare first name", () => {
    const people = [
        { id: "u1", name: "Justin Adkins" },
        { id: "u2", name: "Justin Smith" },
    ];
    const memberEmailsById = new Map([["u1", "jadkins@goldentouchremodeling.com"]]);
    const labels = chipLabelsForRow(people, memberEmailsById);
    assert.equal(labels.get("u1"), "Justin (jadkins)");
    assert.equal(labels.get("u2"), "Justin");
});

test("buildDispatchDayJobGroups: a solid assignment's name prefers the (disambiguated) roster label over the raw assignment name", () => {
    const memberNamesById = new Map([["u1", "Justin Adkins (jadkins@goldentouchremodeling.com)"]]);
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [
            { userId: "u1", name: "Justin Adkins", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, {}, null, memberNamesById,
    );
    assert.equal(groups[0].rows[0].people[0].name, "Justin Adkins (jadkins@goldentouchremodeling.com)");
});

test("buildDispatchDayJobGroups: a solid assignment falls back to the raw assignment name when absent from memberNamesById", () => {
    const groups = buildDispatchDayJobGroups(
        [project({ tasks: [task({ assignments: [
            { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] })],
        dayKey, {}, null, new Map(),
    );
    assert.equal(groups[0].rows[0].people[0].name, "Garrett");
});

// ── finalTaskUserIds ─────────────────────────────────────────────────────

test("finalTaskUserIds: solid dispatchable assignments, no draft", () => {
    const t = task({ assignments: [
        { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "lead", showOnDispatch: true },
        { userId: "u2", name: "Vanessa", status: "ACTIVATED", userRole: "FINANCE", assignmentRole: "assigned", showOnDispatch: true },
    ] });
    assert.deepEqual(finalTaskUserIds(t, undefined), ["u1"]);
});

test("finalTaskUserIds: draft removal drops a solid id, draft addition appends a new one, no duplicate for an already-solid id", () => {
    const t = task({ assignments: [
        { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        { userId: "u2", name: "CJ", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
    ] });
    const draft: DispatchDayCrewDraft = { addUserIds: ["u2", "u9"], removeUserIds: ["u1"] };
    assert.deepEqual(finalTaskUserIds(t, draft), ["u2", "u9"]);
});

// ── findReviewCollisions ─────────────────────────────────────────────────

function reviewTask(overrides: Partial<DispatchReviewTaskInput> = {}): DispatchReviewTaskInput {
    return {
        id: "t1",
        projectId: "p1",
        projectName: "Hoppe Bathroom Remodel",
        name: "Drywall",
        startDate: "2026-08-29T00:00:00.000Z",
        endDate: "2026-08-30T00:00:00.000Z",
        savedUserIds: ["u1"],
        ...overrides,
    };
}

test("findReviewCollisions: two tasks on different projects, same user, overlapping windows → one collision", () => {
    const collisions = findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", savedUserIds: ["u1"] }),
    ]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].userId, "u1");
    assert.equal(collisions[0].pairs.length, 1);
    assert.equal(collisions[0].pairs[0].projectA.id, "p1");
    assert.equal(collisions[0].pairs[0].projectB.id, "p2");
});

test("findReviewCollisions: same project, same user, overlapping windows → no collision", () => {
    const collisions = findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p1", savedUserIds: ["u1"] }),
    ]);
    assert.deepEqual(collisions, []);
});

test("findReviewCollisions: different projects, same user, non-overlapping windows → no collision", () => {
    const collisions = findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-30T00:00:00.000Z", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", startDate: "2026-09-05T00:00:00.000Z", endDate: "2026-09-06T00:00:00.000Z", savedUserIds: ["u1"] }),
    ]);
    assert.deepEqual(collisions, []);
});

test("findReviewCollisions: multi-day task windows overlapping on a day neither task 'starts' on still collide", () => {
    const collisions = findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", startDate: "2026-08-25T00:00:00.000Z", endDate: "2026-08-31T00:00:00.000Z", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", startDate: "2026-08-30T00:00:00.000Z", endDate: "2026-09-03T00:00:00.000Z", savedUserIds: ["u1"] }),
    ]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].pairs[0].overlapStart, "2026-08-30T00:00:00.000Z");
    assert.equal(collisions[0].pairs[0].overlapEnd, "2026-08-31T00:00:00.000Z");
});

test("findReviewCollisions: two drafted adds to different projects' tasks in the SAME review collide with each other", () => {
    // Neither task carries the user in savedUserIds (server truth) — both
    // additions come purely from this review's crewChanges.
    const tasks = [
        reviewTask({ id: "t1", projectId: "p1", savedUserIds: [] }),
        reviewTask({ id: "t2", projectId: "p2", savedUserIds: [] }),
    ];
    const collisions = findReviewCollisions(tasks, [
        { taskId: "t1", afterUserIds: ["u9"] },
        { taskId: "t2", afterUserIds: ["u9"] },
    ]);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].userId, "u9");
});

test("findReviewCollisions: a crewChanges entry fully overrides that task's savedUserIds (removal isn't re-added)", () => {
    const tasks = [
        reviewTask({ id: "t1", projectId: "p1", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", savedUserIds: ["u1"] }),
    ];
    // t1's review change removes u1 entirely — the saved u1 on t1 must not
    // leak back in.
    const collisions = findReviewCollisions(tasks, [{ taskId: "t1", afterUserIds: [] }]);
    assert.deepEqual(collisions, []);
});

test("findReviewCollisions: no tasks/no shared users → empty", () => {
    assert.deepEqual(findReviewCollisions([]), []);
    assert.deepEqual(findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", savedUserIds: ["u2"] }),
    ]), []);
});

// ── collisionDelta ────────────────────────────────────────────────────────

test("collisionDelta: a pre-existing collision untouched by the review is not flagged", () => {
    const canonical = findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", savedUserIds: ["u1"] }),
    ]);
    // Review's final state is identical — nothing in this review touched
    // either task's crew or dates.
    const final = findReviewCollisions([
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", savedUserIds: ["u1"] }),
    ]);
    assert.deepEqual(collisionDelta(canonical, final), []);
});

test("collisionDelta: a new collision from a drafted add is flagged", () => {
    const tasks = [
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", savedUserIds: [] }),
    ];
    const canonical = findReviewCollisions(tasks);
    assert.deepEqual(canonical, []); // no collision yet — t2 has no crew
    const final = findReviewCollisions(tasks, [{ taskId: "t2", afterUserIds: ["u1"] }]);
    const delta = collisionDelta(canonical, final);
    assert.equal(delta.length, 1);
    assert.equal(delta[0].userId, "u1");
    assert.equal(delta[0].pairs.length, 1);
});

test("collisionDelta: a drafted removal that resolves a collision is not flagged", () => {
    const tasks = [
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", savedUserIds: ["u1"] }),
    ];
    const canonical = findReviewCollisions(tasks);
    assert.equal(canonical.length, 1); // collision exists before the review
    const final = findReviewCollisions(tasks, [{ taskId: "t2", afterUserIds: [] }]);
    assert.deepEqual(collisionDelta(canonical, final), []);
});

test("collisionDelta: a widened overlap window on an already-colliding pair is flagged as worsened", () => {
    const canonicalTasks = [
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-30T00:00:00.000Z", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-30T00:00:00.000Z", savedUserIds: ["u1"] }),
    ];
    const canonical = findReviewCollisions(canonicalTasks);
    assert.equal(canonical.length, 1);
    // Same tasks, both windows extended by the review so the overlap itself
    // widens from 08-29—08-30 to 08-29—08-31 (a same-length shift of just
    // one task wouldn't change the *overlap*, since overlap = min(ends)).
    const finalTasks = [
        reviewTask({ id: "t1", projectId: "p1", projectName: "Hoppe", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-31T00:00:00.000Z", savedUserIds: ["u1"] }),
        reviewTask({ id: "t2", projectId: "p2", projectName: "Mesplay", startDate: "2026-08-29T00:00:00.000Z", endDate: "2026-08-31T00:00:00.000Z", savedUserIds: ["u1"] }),
    ];
    const final = findReviewCollisions(finalTasks);
    const delta = collisionDelta(canonical, final);
    assert.equal(delta.length, 1);
});

test("collisionDelta: empty before/after → empty", () => {
    assert.deepEqual(collisionDelta([], []), []);
});

// ── buildDispatchDayCollisions ───────────────────────────────────────────

test("buildDispatchDayCollisions: two drafted adds on different projects' tasks collide, before either is saved", () => {
    const projects = [
        project({ id: "p1", name: "Hoppe", tasks: [task({ id: "t1", assignments: [] })] }),
        project({ id: "p2", name: "Mesplay", tasks: [task({ id: "t2", assignments: [] })] }),
    ];
    const crewDrafts = {
        t1: { addUserIds: ["u9"], removeUserIds: [] },
        t2: { addUserIds: ["u9"], removeUserIds: [] },
    };
    const collisions = buildDispatchDayCollisions(projects, crewDrafts);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].userId, "u9");
    assert.equal(collisions[0].pairs[0].projectA.id, "p1");
    assert.equal(collisions[0].pairs[0].projectB.id, "p2");
});

test("buildDispatchDayCollisions: feeds findConflictOtherProject directly, matching the row-level red-name lookup", () => {
    const projects = [
        project({ id: "p1", name: "Hoppe", tasks: [task({ id: "t1", assignments: [
            { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
        ] })] }),
        project({ id: "p2", name: "Mesplay", tasks: [task({ id: "t2", assignments: [] })] }),
    ];
    // A drafted add of the ALREADY-solid u1 onto a different project's task
    // the same day — the row for p1's t1 should now show u1 as conflicted.
    const crewDrafts = { t2: { addUserIds: ["u1"], removeUserIds: [] } };
    const collisions = buildDispatchDayCollisions(projects, crewDrafts);
    assert.equal(findConflictOtherProject(collisions, "u1", dayKey, "p1"), "Mesplay");
});

test("buildDispatchDayCollisions: no drafts, no overlaps beyond same-project → empty", () => {
    const projects = [project({ id: "p1", tasks: [task({ id: "t1", assignments: [
        { userId: "u1", name: "Garrett", status: "ACTIVATED", userRole: "FIELD_CREW", assignmentRole: "assigned", showOnDispatch: true },
    ] })] })];
    assert.deepEqual(buildDispatchDayCollisions(projects, {}), []);
});
