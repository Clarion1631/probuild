/**
 * Request-level auth tests for POST /api/quickbooks/sync.
 *
 * Codex gate (PR #438, round 33): the route trusted the reverse proxy's own
 * auth and never checked, in-handler, whether the caller held the
 * estimates/invoices permission or could reach the target record's project.
 * Any authenticated staff member — FIELD_CREW included — could sync ANY
 * estimate or invoice to QuickBooks by id alone.
 *
 * Same require()-patch technique as tests/takeoff-convert-tax.test.ts (see
 * that file's header comment for why: tsx transpiles both this test and the
 * route to CommonJS, and on Node 20 `node:test`'s own `mock.module()`
 * corrupts the require chain for every OTHER module in the file, including a
 * plain require() patch for a different specifier — so no other file in this
 * suite may call `mock.module()` either). Scoped to the two specifiers
 * route.ts imports that this test needs to control: "@/lib/permissions" (who
 * is calling) and "@/lib/prisma" (does the record exist / what project does
 * it belong to). Everything else — @/lib/quickbooks, @/lib/quickbooks-payments,
 * @/lib/integration-store — loads for real; none of the scenarios below reach
 * a QuickBooks call, so nothing there needs mocking.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { hasPermission, canAccessProject, canAccessEstimate } from "../src/lib/access-rules";

const state: {
    user: any | null;
    estimates: Record<string, any>;
    invoices: Record<string, any>;
} = { user: null, estimates: {}, invoices: {} };

function resetState() {
    state.user = null;
    state.estimates = {};
    state.invoices = {};
}

const fakePermissions = {
    currentStaffUserOrNull: async () => state.user,
    hasPermission,
    canAccessProject,
    canAccessEstimate,
};

const fakePrisma = {
    estimate: {
        findUnique: async (args: { where: { id: string } }) => state.estimates[args.where.id] ?? null,
    },
    invoice: {
        findUnique: async (args: { where: { id: string } }) => state.invoices[args.where.id] ?? null,
    },
};

const PERMISSIONS_SPECIFIER = "@/lib/permissions";
const PRISMA_SPECIFIER = "@/lib/prisma";

let POST: (req: Request) => Promise<Response>;

before(async () => {
    const originalRequire = Module.prototype.require;
    let permissionsPatchHit = false;
    let prismaPatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PERMISSIONS_SPECIFIER) {
            permissionsPatchHit = true;
            return fakePermissions;
        }
        if (id === PRISMA_SPECIFIER) {
            prismaPatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let routeModule: { POST?: unknown };
    try {
        routeModule = await import("../src/app/api/quickbooks/sync/route");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof routeModule.POST !== "function") {
        throw new Error(
            `qbo-sync-route-auth.test.ts: mock did not apply — route module's POST export is ` +
                `${typeof routeModule.POST}, not a function. "${PERMISSIONS_SPECIFIER}" patch ` +
                `${permissionsPatchHit ? "WAS" : "was NOT"} hit; "${PRISMA_SPECIFIER}" patch ` +
                `${prismaPatchHit ? "WAS" : "was NOT"} hit.`,
        );
    }
    POST = routeModule.POST as any;
});

beforeEach(() => {
    resetState();
});

function postRequest(body: unknown) {
    return new Request("http://localhost/api/quickbooks/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }) as any;
}

test("no session: 401, before any record lookup or QuickBooks call", async () => {
    state.user = null;
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 401);
});

test("FIELD_CREW session syncing an estimate: 403 — proxy auth is not enough", async () => {
    // FIELD_CREW's role defaults (access-rules.ts) do not include "estimates".
    state.user = { id: "u1", role: "FIELD_CREW", permissions: null };
    state.estimates["est-1"] = { id: "est-1", projectId: "proj-1", leadId: null };
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 403);
});

test("FIELD_CREW session syncing an invoice: 403", async () => {
    state.user = { id: "u1", role: "FIELD_CREW", permissions: null };
    state.invoices["inv-1"] = { id: "inv-1", projectId: "proj-1" };
    const res = await POST(postRequest({ type: "invoice", id: "inv-1" }));
    assert.equal(res.status, 403);
});

test("ADMIN session, bogus estimate id: 404", async () => {
    state.user = { id: "u1", role: "ADMIN", permissions: null };
    const res = await POST(postRequest({ type: "estimate", id: "does-not-exist" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Estimate not found" });
});

test("ADMIN session, bogus invoice id: 404", async () => {
    state.user = { id: "u1", role: "ADMIN", permissions: null };
    const res = await POST(postRequest({ type: "invoice", id: "does-not-exist" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Invoice not found" });
});

test("a staff member holding the permission but with no access to THIS project: 403", async () => {
    // FINANCE's role defaults include "estimates" — the permission check alone
    // would let this through. Only the horizontal project-scope check catches it.
    state.user = { id: "u1", role: "FINANCE", permissions: null, projectAccess: [], assignedProjects: [] };
    state.estimates["est-1"] = { id: "est-1", projectId: "proj-not-theirs", leadId: null };
    const res = await POST(postRequest({ type: "estimate", id: "est-1" }));
    assert.equal(res.status, 403);
});

test("unknown type: 400, before any auth check spends a session lookup", async () => {
    // type validation is cheap and happens first — no need to touch state.user.
    const res = await POST(postRequest({ type: "widget", id: "x" }));
    assert.equal(res.status, 400);
});
