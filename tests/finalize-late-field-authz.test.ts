/**
 * A late `projectId` at /finalize cannot name a job the caller cannot see
 * (Codex round 11, items 1 and 2 — confirming Phase 1's authorization holds on
 * this branch, from the Phase 3 side).
 *
 * The two-step upload lets a client supply the job AFTER the bytes land. That
 * is the point of the late-field path, and it is also the reason it needs its
 * own access check: the project on the row was authorized at /start, and a
 * different one arriving at /finalize was never checked by anything else.
 *
 * Phase 3 cares because a receipt filed against a job the caller cannot reach
 * lands in that job's costs, its variance, and — once flagged — its tax
 * deduction.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

let accessibleProjects: string[];
let projectPhases: Record<string, string[]>;

let authorizeFinalization: (
    auth: unknown,
    rowProjectId: string | null,
    lateFields: Record<string, unknown>,
) => Promise<Response | null>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let hit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/prisma") { hit = true; return { prisma: {} }; }
        if (id === "@/lib/mobile-auth") {
            return {
                userCanAccessProject: async (_user: unknown, projectId: string) =>
                    accessibleProjects.includes(projectId),
            };
        }
        if (id === "@/lib/project-phases") {
            return {
                isCostCodeAllowedForProject: async (_ds: unknown, projectId: string, costCodeId: string) =>
                    (projectPhases[projectId] ?? []).includes(costCodeId),
            };
        }
        if (id === "@/lib/project-phases-db") return { prismaPhaseDataSource: {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: any;
    try {
        mod = await import("../src/app/api/receipts/intake/[id]/finalize/route");
    } finally {
        Module.prototype.require = originalRequire;
    }
    if (typeof mod.authorizeFinalization !== "function") {
        throw new Error(`finalize-late-field-authz: mocks did not apply (patch ${hit ? "WAS" : "was NOT"} hit)`);
    }
    authorizeFinalization = mod.authorizeFinalization;
});

beforeEach(() => {
    accessibleProjects = ["job-mine"];
    projectPhases = { "job-mine": ["cc-plumb"], "job-theirs": ["cc-frame"] };
});

const session = { ok: true, via: "session", user: { id: "u1", role: "MANAGER" } };
const secret = { ok: true, via: "secret" };

test("a session caller cannot file a receipt against a job they cannot see", async () => {
    const denied = await authorizeFinalization(session, null, { projectId: "job-theirs" });
    assert.ok(denied, "it must be refused");
    assert.equal(denied!.status, 403);
    assert.equal((await denied!.json()).reason, "forbidden");
});

test("a session caller CAN file against a job they can see", async () => {
    assert.equal(await authorizeFinalization(session, null, { projectId: "job-mine" }), null);
});

test("the check is on the LATE project, not the one the row already had", async () => {
    // The row was started against an accessible job; the late field tries to
    // move it to one that is not. Authorizing the row's existing project would
    // wave this through.
    const denied = await authorizeFinalization(session, "job-mine", { projectId: "job-theirs" });
    assert.ok(denied);
    assert.equal(denied!.status, 403);
});

test("a late phase must belong to the EFFECTIVE project", async () => {
    // cc-frame is a phase of job-theirs, not of job-mine.
    const denied = await authorizeFinalization(session, "job-mine", { costCodeId: "cc-frame" });
    assert.ok(denied);
    assert.equal(denied!.status, 400);
    assert.equal((await denied!.json()).error, "cost-code-not-a-phase");
});

test("the effective project is the LATE one when both are supplied", async () => {
    accessibleProjects = ["job-mine", "job-theirs"];
    // cc-frame is not on job-mine but IS on job-theirs, which is where the row
    // is being moved to — so it must be accepted.
    assert.equal(
        await authorizeFinalization(session, "job-mine", { projectId: "job-theirs", costCodeId: "cc-frame" }),
        null,
    );
    // ...and the reverse is refused.
    const denied = await authorizeFinalization(session, "job-theirs", { projectId: "job-mine", costCodeId: "cc-frame" });
    assert.ok(denied);
    assert.equal(denied!.status, 400);
});

test("a phase with no job to check it against is refused", async () => {
    const denied = await authorizeFinalization(session, null, { costCodeId: "cc-plumb" });
    assert.ok(denied);
    assert.equal(denied!.status, 400);
    assert.equal((await denied!.json()).error, "cost-code-without-project");
});

test("a secret forwarder skips the per-user check but NOT the phase check", async () => {
    // A shared-secret forwarder has no user to scope by — it resolves the job
    // from the Drive folder — so project access does not apply to it. The phase
    // still has to belong to the job.
    assert.equal(await authorizeFinalization(secret, null, { projectId: "job-theirs" }), null);
    const denied = await authorizeFinalization(secret, "job-mine", { costCodeId: "cc-frame" });
    assert.ok(denied, "the phase rule is not a per-user rule");
    assert.equal(denied!.status, 400);
});

test("no late fields is nothing to authorize", async () => {
    assert.equal(await authorizeFinalization(session, "job-mine", {}), null);
});
