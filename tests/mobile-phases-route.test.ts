/**
 * Route-level tests for GET /api/mobile/projects/[id]/phases, using the same
 * dependency-injection pattern as tests/pay-period-summary-route.test.ts — no
 * database required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createPhasesHandlers,
    type PhasesDependencies,
    type PhaseOption,
} from "../src/app/api/mobile/projects/[id]/phases/route";

function createDeps(overrides: {
    authOk?: boolean;
    canAccess?: boolean;
    project?: { id: string; status: string } | null;
    phases?: PhaseOption[];
} = {}) {
    const dependencies: PhasesDependencies = {
        authenticate: async () =>
            overrides.authOk === false
                ? { ok: false, status: 401, error: "Unauthorized" }
                : { ok: true, user: { id: "u1", role: "FIELD_CREW" } },
        canAccessProject: async () => overrides.canAccess ?? true,
        getProject: async () =>
            overrides.project !== undefined ? overrides.project : { id: "p1", status: "In Progress" },
        getPhases: async () => overrides.phases ?? [],
    };
    return dependencies;
}

function req() {
    return new Request("https://example.test/api/mobile/projects/p1/phases");
}

test("propagates the authenticate() failure status/error unchanged", async () => {
    const { GET } = createPhasesHandlers(createDeps({ authOk: false }));
    const res = await GET(req(), "p1");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("403 when the caller cannot access the project", async () => {
    const { GET } = createPhasesHandlers(createDeps({ canAccess: false }));
    const res = await GET(req(), "p1");
    assert.equal(res.status, 403);
});

test("404 when the project does not exist", async () => {
    const { GET } = createPhasesHandlers(createDeps({ project: null }));
    const res = await GET(req(), "p1");
    assert.equal(res.status, 404);
});

test("409 with PROJECT_NOT_IN_PROGRESS when the project isn't In Progress", async () => {
    const { GET } = createPhasesHandlers(createDeps({ project: { id: "p1", status: "Waiting to Start" } }));
    const res = await GET(req(), "p1");
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "PROJECT_NOT_IN_PROGRESS");
});

test("empty phases array is a valid 200 response (no approved estimate)", async () => {
    const { GET } = createPhasesHandlers(createDeps({ phases: [] }));
    const res = await GET(req(), "p1");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { phases: [] });
});

test("200 returns the phases from an approved estimate, sorted by code", async () => {
    const phases: PhaseOption[] = [
        { costCodeId: "cc2", code: "02-FRAME", name: "Framing", estimateItemId: "item2" },
        { costCodeId: "cc1", code: "01-DEMO", name: "Demolition", estimateItemId: "item1" },
    ];
    const { GET } = createPhasesHandlers(createDeps({ phases }));
    const res = await GET(req(), "p1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.phases, phases);
});
