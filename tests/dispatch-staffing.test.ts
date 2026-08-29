import assert from "node:assert/strict";
import test from "node:test";
import { getCardStaffing } from "@/app/company-dashboard/schedule-board/dispatch-staffing";

const DAY = "2026-08-28";

function task(over: Partial<Parameters<typeof getCardStaffing>[1][number]> = {}) {
    return {
        id: "task-1",
        startDate: `${DAY}T00:00:00.000Z`,
        endDate: "2026-08-29T00:00:00.000Z",
        type: "task",
        assignments: [],
        ...over,
    };
}

const project = {
    crew: [
        { id: "u1", name: "Ann", status: "ACTIVATED", role: "FIELD_CREW" },
        { id: "u2", name: "Bo", status: "ACTIVATED", role: "FIELD_CREW" },
        { id: "u3", name: "Cy", status: "ACTIVATED", role: "FIELD_CREW" },
        { id: "u4", name: "Deactivated", status: "PENDING", role: "FIELD_CREW" },
        { id: "u5", name: "Manager", status: "ACTIVATED", role: "MANAGER" },
    ],
};

test("members reflect solid assignment, draft addition, or idle", () => {
    const tasks = [
        task({ id: "t1", assignments: [{ userId: "u1", status: "ACTIVATED", userRole: "FIELD_CREW" }] }),
    ];
    const crewDrafts = { t1: { addUserIds: ["u2"], removeUserIds: [] } };
    const staffing = getCardStaffing(project, tasks, crewDrafts, DAY);

    assert.equal(staffing.members.length, 3); // only ACTIVATED FIELD_CREW project crew
    const byId = new Map(staffing.members.map(m => [m.id, m.state]));
    assert.equal(byId.get("u1"), "assigned");
    assert.equal(byId.get("u2"), "drafted");
    assert.equal(byId.get("u3"), "idle");
    assert.equal(byId.has("u4"), false);
    assert.equal(byId.has("u5"), false);
});

test("staffedTaskCount counts tasks with a solid OR drafted crew member", () => {
    const tasks = [
        task({ id: "t1", assignments: [{ userId: "u1", status: "ACTIVATED", userRole: "FIELD_CREW" }] }),
        task({ id: "t2", assignments: [] }),
        task({ id: "t3", assignments: [] }),
    ];
    const crewDrafts = { t2: { addUserIds: ["u2"], removeUserIds: [] } };
    const staffing = getCardStaffing(project, tasks, crewDrafts, DAY);

    assert.equal(staffing.taskCount, 3);
    assert.equal(staffing.staffedTaskCount, 2); // t1 (solid), t2 (drafted); t3 unstaffed
});

test("tasks outside the given day are excluded from both member state and counts", () => {
    const tasks = [
        task({ id: "t1", startDate: "2026-08-27T00:00:00.000Z", endDate: "2026-08-28T00:00:00.000Z", assignments: [{ userId: "u1", status: "ACTIVATED", userRole: "FIELD_CREW" }] }),
    ];
    const staffing = getCardStaffing(project, tasks, {}, DAY);

    assert.equal(staffing.taskCount, 0);
    assert.equal(staffing.staffedTaskCount, 0);
    assert.ok(staffing.members.every(m => m.state === "idle"));
});

test("a removed-then-re-added draft on the same task still counts the task as staffed via addUserIds", () => {
    const tasks = [task({ id: "t1", assignments: [] })];
    const crewDrafts = { t1: { addUserIds: ["u3"], removeUserIds: ["u1"] } };
    const staffing = getCardStaffing(project, tasks, crewDrafts, DAY);

    assert.equal(staffing.staffedTaskCount, 1);
    const byId = new Map(staffing.members.map(m => [m.id, m.state]));
    assert.equal(byId.get("u3"), "drafted");
});

test("no tasks today yields zero counts and every crew member idle", () => {
    const staffing = getCardStaffing(project, [], {}, DAY);
    assert.equal(staffing.taskCount, 0);
    assert.equal(staffing.staffedTaskCount, 0);
    assert.ok(staffing.members.every(m => m.state === "idle"));
});

test("removing the last worker on a task reads idle and the task drops to unstaffed", () => {
    const tasks = [
        task({ id: "t1", assignments: [{ userId: "u1", status: "ACTIVATED", userRole: "FIELD_CREW" }] }),
    ];
    const crewDrafts = { t1: { addUserIds: [], removeUserIds: ["u1"] } };
    const staffing = getCardStaffing(project, tasks, crewDrafts, DAY);

    const byId = new Map(staffing.members.map(m => [m.id, m.state]));
    assert.equal(byId.get("u1"), "idle");
    assert.equal(staffing.staffedTaskCount, 0);
});

test("a non-crew user dragged onto a task appears as a drafted member, named from their assignment row", () => {
    const tasks = [
        task({
            id: "t1",
            assignments: [{ userId: "uX", status: "PENDING", userRole: "FIELD_CREW", name: "Xavier" }],
        }),
    ];
    const crewDrafts = { t1: { addUserIds: ["uX"], removeUserIds: [] } };
    const staffing = getCardStaffing(project, tasks, crewDrafts, DAY);

    const member = staffing.members.find(m => m.id === "uX");
    assert.ok(member, "non-crew drafted addition must appear in members");
    assert.equal(member?.state, "drafted");
    assert.equal(member?.name, "Xavier");
    // Still 4: the 3 activated field crew plus the drafted non-crew addition.
    assert.equal(staffing.members.length, 4);
});
