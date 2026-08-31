import test from "node:test";
import assert from "node:assert/strict";
import { applyManagerRouteForm, normalizeClockInAttribution, routeTargetFromManagerForm } from "../src/lib/logistics-clock-flow";
import type { ClockInDependencies } from "../src/app/api/time-entries/route";

process.env.NEXTAUTH_SECRET ??= "test-secret-for-logistics-clock-contract";
const routeModulePromise = import("../src/app/api/time-entries/route");

function postReq(body: unknown) {
    return new Request("https://example.test/api/time-entries", {
        method: "POST",
        body: JSON.stringify(body),
    });
}

function createClockInDeps(overrides: {
    accessResponse?: Response | null;
    project?: { isLogistics: boolean } | null;
    allowedPhase?: boolean;
    estimateItem?: { id: string; costCodeId: string | null } | null;
} = {}) {
    const creates: Array<Record<string, unknown>> = [];
    const dependencies: ClockInDependencies = {
        authenticate: async () => ({ ok: true, user: { id: "crew-1", role: "FIELD_CREW" } }),
        assertProjectAccess: async () => overrides.accessResponse ?? null,
        findLatestClosed: async () => null,
        flagStaleDeferred: async () => {},
        settleDay: async () => 0,
        findProject: async () => overrides.project === undefined ? { isLogistics: false } : overrides.project,
        findEstimateItem: async () => overrides.estimateItem ?? null,
        isCostCodeAllowedForProject: async () => overrides.allowedPhase ?? true,
        resolveScheduleTaskId: async () => null,
        createTimeEntry: async (data) => {
            creates.push(data);
            return { id: "time-entry-1", ...data };
        },
    };
    return { dependencies, creates };
}

test("Logistics clock-in discards every client phase/item attribution", () => {
    assert.deepEqual(
        normalizeClockInAttribution({ isLogistics: true, costCodeId: "safety", estimateItemId: "item-1" }),
        { costCodeId: null, estimateItemId: null },
    );
    assert.deepEqual(
        normalizeClockInAttribution({ isLogistics: false, costCodeId: "phase-1", estimateItemId: "item-1" }),
        { costCodeId: "phase-1", estimateItemId: "item-1" },
    );
});

test("a disabled closed-job option does not invoke the reroute action", async () => {
    assert.equal(routeTargetFromManagerForm(null), undefined);
    assert.equal(routeTargetFromManagerForm(""), null);
    assert.equal(routeTargetFromManagerForm("active-job"), "active-job");

    const calls: Array<string | null> = [];
    const reroute = async (projectId: string | null) => { calls.push(projectId); };
    // FormData omits a disabled selected option. Preserve its closed-job route;
    // do not hand its ID to the action, which rightly rejects closed jobs.
    await applyManagerRouteForm(null, reroute);
    assert.deepEqual(calls, []);

    // A real selected value is still a deliberate re-route, including the
    // explicit overhead choice (the empty option).
    await applyManagerRouteForm("", reroute);
    await applyManagerRouteForm("active-job", reroute);
    assert.deepEqual(calls, [null, "active-job"]);
});

test("POST stores no job attribution for Logistics even when a client supplies foreign IDs", async () => {
    const { dependencies, creates } = createClockInDeps({ project: { isLogistics: true } });
    const { createClockInHandler } = await routeModulePromise;

    const res = await createClockInHandler(dependencies).POST(postReq({
        projectId: "logistics",
        costCodeId: "foreign-phase",
        estimateItemId: "foreign-item",
    }));

    assert.equal(res.status, 200);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].costCodeId, null);
    assert.equal(creates[0].estimateItemId, null);
});

test("POST retains its normal-project 403 access gate and 400 stale-phase response", async () => {
    const denied = createClockInDeps({ accessResponse: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) });
    const { createClockInHandler } = await routeModulePromise;
    const deniedRes = await createClockInHandler(denied.dependencies).POST(postReq({ projectId: "job-1", costCodeId: "phase-1" }));
    assert.equal(deniedRes.status, 403);
    assert.equal(denied.creates.length, 0);

    const stale = createClockInDeps({ project: { isLogistics: false }, allowedPhase: false });
    const staleRes = await createClockInHandler(stale.dependencies).POST(postReq({ projectId: "job-1", costCodeId: "foreign-phase" }));
    assert.equal(staleRes.status, 400);
    assert.equal((await staleRes.json()).code, "PHASE_NOT_ON_PROJECT");
    assert.equal(stale.creates.length, 0);
});
