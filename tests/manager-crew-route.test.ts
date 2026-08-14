/**
 * Route-level tests for GET/POST /api/manager/jobs/[id]/crew, using the same
 * dependency-injection pattern as tests/pay-period-summary-route.test.ts — no
 * database required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createCrewRouteHandlers,
    type CrewRouteDependencies,
    type CrewMember,
} from "../src/app/api/manager/jobs/[id]/crew/route";

function createDeps(overrides: {
    role?: string;
    authOk?: boolean;
    project?: { id: string } | null;
    currentCrew?: CrewMember[];
    assignableUsers?: CrewMember[];
    applyCrewImpl?: CrewRouteDependencies["applyCrew"];
} = {}) {
    const applyCalls: Array<{ projectId: string; userIds: string[]; actorName: string }> = [];
    const dependencies: CrewRouteDependencies = {
        authenticate: async () =>
            overrides.authOk === false
                ? { ok: false, status: 401, error: "Unauthorized" }
                : { ok: true, user: { id: "u1", role: overrides.role ?? "MANAGER", name: "Mgr One", email: "mgr@example.test" } },
        getProject: async () => (overrides.project !== undefined ? overrides.project : { id: "p1" }),
        getCurrentCrew: async () => overrides.currentCrew ?? [],
        getAssignableUsers: async (ids) =>
            overrides.assignableUsers ?? ids.map((id) => ({ id, name: id, email: `${id}@example.test`, role: "FIELD_CREW" })),
        applyCrew: async (input) => {
            applyCalls.push(input);
            if (overrides.applyCrewImpl) return overrides.applyCrewImpl(input);
            return input.userIds.map((id) => ({ id, name: id, email: `${id}@example.test`, role: "FIELD_CREW" }));
        },
    };
    return { dependencies, applyCalls };
}

function getReq() {
    return new Request("https://example.test/api/manager/jobs/p1/crew");
}

function postReq(body: unknown) {
    return new Request("https://example.test/api/manager/jobs/p1/crew", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

// ── GET ─────────────────────────────────────────────────────────────────

test("GET propagates authenticate() failure unchanged", async () => {
    const { dependencies } = createDeps({ authOk: false });
    const { GET } = createCrewRouteHandlers(dependencies);
    const res = await GET(getReq(), "p1");
    assert.equal(res.status, 401);
});

test("GET 403 for a non-manager/admin role", async () => {
    const { dependencies } = createDeps({ role: "FIELD_CREW" });
    const { GET } = createCrewRouteHandlers(dependencies);
    const res = await GET(getReq(), "p1");
    assert.equal(res.status, 403);
});

test("GET 404 when the project does not exist", async () => {
    const { dependencies } = createDeps({ project: null });
    const { GET } = createCrewRouteHandlers(dependencies);
    const res = await GET(getReq(), "p1");
    assert.equal(res.status, 404);
});

test("GET 200 returns the current crew for MANAGER and ADMIN", async () => {
    const crew: CrewMember[] = [{ id: "c1", name: "Crew One", email: "c1@example.test", role: "FIELD_CREW" }];
    for (const role of ["MANAGER", "ADMIN"]) {
        const { dependencies } = createDeps({ role, currentCrew: crew });
        const { GET } = createCrewRouteHandlers(dependencies);
        const res = await GET(getReq(), "p1");
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { crew });
    }
});

// ── POST ────────────────────────────────────────────────────────────────

test("POST 403 for a non-manager/admin role, without touching applyCrew", async () => {
    const { dependencies, applyCalls } = createDeps({ role: "FIELD_CREW" });
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["c1"] }), "p1");
    assert.equal(res.status, 403);
    assert.equal(applyCalls.length, 0);
});

test("POST 400 when crewUserIds is missing or not an array of strings", async () => {
    const { dependencies } = createDeps();
    const { POST } = createCrewRouteHandlers(dependencies);
    const res1 = await POST(postReq({}), "p1");
    assert.equal(res1.status, 400);
    const res2 = await POST(postReq({ crewUserIds: [1, 2] }), "p1");
    assert.equal(res2.status, 400);
});

test("POST 404 when the project does not exist", async () => {
    const { dependencies } = createDeps({ project: null });
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["c1"] }), "p1");
    assert.equal(res.status, 404);
});

test("POST 400 when a submitted user id is not assignable (not returned by getAssignableUsers)", async () => {
    const { dependencies, applyCalls } = createDeps({ assignableUsers: [] });
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["bogus"] }), "p1");
    assert.equal(res.status, 400);
    assert.equal(applyCalls.length, 0);
});

// FIELD_CREW and MANAGER are assignable as job crew; ADMIN is not (Justin's
// call — managers can be put on crew, admins never show up as options).

test("POST accepts a MANAGER as assignable crew", async () => {
    const managerUser: CrewMember = { id: "m1", name: "Site Manager", email: "m1@example.test", role: "MANAGER" };
    const { dependencies, applyCalls } = createDeps({ assignableUsers: [managerUser] });
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["m1"] }), "p1");
    assert.equal(res.status, 200);
    assert.deepEqual(applyCalls[0].userIds, ["m1"]);
});

test("POST still rejects an ADMIN as assignable crew", async () => {
    // getAssignableUsers mirrors the real query (FIELD_CREW/MANAGER only) — an
    // ADMIN id is simply never returned as assignable.
    const { dependencies, applyCalls } = createDeps({ assignableUsers: [] });
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["admin1"] }), "p1");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Not assignable as crew/);
    assert.equal(applyCalls.length, 0);
});

test("POST applies the crew via applyCrew() and returns the updated list", async () => {
    const { dependencies, applyCalls } = createDeps();
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["c1", "c2"] }), "p1");
    assert.equal(res.status, 200);
    assert.equal(applyCalls.length, 1);
    assert.deepEqual(applyCalls[0].userIds, ["c1", "c2"]);
    assert.equal(applyCalls[0].projectId, "p1");
    assert.equal(applyCalls[0].actorName, "Mgr One");
    const body = await res.json();
    assert.equal(body.crew.length, 2);
});

test("POST dedupes repeated ids before applying", async () => {
    const { dependencies, applyCalls } = createDeps();
    const { POST } = createCrewRouteHandlers(dependencies);
    await POST(postReq({ crewUserIds: ["c1", "c1", "c2"] }), "p1");
    assert.deepEqual(applyCalls[0].userIds, ["c1", "c2"]);
});

test("POST empty crewUserIds clears the crew", async () => {
    const { dependencies, applyCalls } = createDeps();
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: [] }), "p1");
    assert.equal(res.status, 200);
    assert.deepEqual(applyCalls[0].userIds, []);
});

test("POST 400 when applyCrew() throws (e.g. setProjectCrew validation failure)", async () => {
    const { dependencies } = createDeps({
        applyCrewImpl: async () => {
            throw new Error("Crew members must be ACTIVATED users: Jane Doe");
        },
    });
    const { POST } = createCrewRouteHandlers(dependencies);
    const res = await POST(postReq({ crewUserIds: ["c1"] }), "p1");
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /ACTIVATED/);
});
