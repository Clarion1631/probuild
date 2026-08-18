/**
 * manuallyApproveChangeOrder's project-scope guard (actions.ts).
 *
 * The action now resolves the change order's projectId and checks
 * `canAccessProject(user, projectId)` before calling manuallyApproveChangeOrderCore — the same
 * shared-loader + shared-helper pattern assertProjectMemberStaff uses for
 * updateProjectTags/updateProjectType (the "tag/type/code" actions). canAccessProject and
 * accessibleProjectIds are pure functions in access-rules.ts already covered generally by
 * e2e/estimate-scope-rules.spec.ts; this file exists to pin the ONE fact specific to this guard
 * that a generic access-rules test wouldn't surface:
 *
 * IMPORTANT CAVEAT, not a passing/failing distinction to hide: accessibleProjectIds returns
 * "ALL" unconditionally for ADMIN_ROLES = ["ADMIN", "MANAGER"] (access-rules.ts), and
 * manuallyApproveChangeOrder's role gate ALREADY restricts callers to exactly those two roles
 * (mirroring countersignChangeOrderAsCompany, narrower than the general "changeOrders"
 * permission, since this bypasses the client's own signature). So today, no request that passes
 * the role gate can ever fail canAccessProject — there is no live scenario in which the new
 * guard actually rejects a call. It is still correct and worth having: it is structurally
 * consistent with every other project-scoped action in the file, it hardens
 * manuallyApproveChangeOrder against a future loosening of ADMIN_ROLES or a future
 * project-scoped MANAGER variant, and — unlike the raw `prisma.user.findUnique({ select: {
 * role: true } })` lookup this action used before — the shared loader (assertActiveStaff ->
 * getCurrentUserWithPermissions -> getUserWithPermissionsByEmail) also now rejects a DISABLED
 * user, which the old lookup never checked at all.
 *
 * Test 1 below reproduces the exact fact that makes the guard currently unreachable. Test 2
 * proves the guard mechanism itself is sound for the role set it would need to protect the
 * moment ADMIN_ROLES or the action's own role check ever changes.
 *
 * Test 3 goes further and calls the REAL server action (manuallyApproveChangeOrder in
 * actions.ts), not just the access-rules helpers it's built from — the first two tests would
 * still pass even if the action never actually wired canAccessProject into its call path. This
 * uses the same `Module.prototype.require` patch as
 * tests/change-order-manual-approval-core.test.ts and
 * tests/change-order-approved-suppress-emails.test.ts (see either file's header for the full
 * rationale), scoped to the three specifiers actions.ts's own top-level imports transpile to:
 * "./prisma" (change-order lookup), "./permissions" (assertActiveStaff's user loader +
 * canAccessProject itself — faked here to deny, independent of the real access-rules logic
 * Tests 1–2 already cover), and "./change-order-core" (manuallyApproveChangeOrderCore, faked to
 * throw if ever reached — the assertion that matters).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { canAccessProject, accessibleProjectIds, ADMIN_ROLES } from "../src/lib/access-rules";

test("ADMIN and MANAGER — the only roles manuallyApproveChangeOrder's role gate admits — always resolve to ALL project access", () => {
    assert.deepEqual(ADMIN_ROLES, ["ADMIN", "MANAGER"]);
    for (const role of ADMIN_ROLES) {
        const user = { role, projectAccess: [], assignedProjects: [] };
        assert.equal(accessibleProjectIds(user), "ALL");
        assert.equal(canAccessProject(user, "some-other-teams-project"), true);
    }
});

test("the canAccessProject mechanism itself correctly rejects an out-of-scope role with no assignment to the project", () => {
    // Not a role manuallyApproveChangeOrder currently admits — this documents that if its role
    // gate were ever loosened (e.g. to match assertChangeOrderPermission's broader "changeOrders"
    // permission, which FINANCE also holds by default), the canAccessProject guard already wired
    // in would correctly protect it, rather than silently passing everyone through.
    const user = { role: "FINANCE", projectAccess: [{ projectId: "project-a" }], assignedProjects: [] };
    assert.equal(canAccessProject(user, "project-a"), true);
    assert.equal(canAccessProject(user, "project-b"), false);
});

const actionUser = {
    role: "MANAGER",
    email: "manager@example.com",
    name: "Off-Project Manager",
    projectAccess: [],
    assignedProjects: [],
};
let projectAccessAllowed = false;
let changeOrderPermissionAllowed = true;
let coreOutcome: "unexpected" | "conflict" | "generic" = "unexpected";
const coreCalls = { update: 0, manualApprove: 0 };

class FakeChangeOrderRevisionConflictError extends Error {
    constructor() {
        super("Change order CO-001 was modified after this page loaded — refresh and try again.");
        this.name = "ChangeOrderRevisionConflictError";
    }
}

class FakeChangeOrderTaxTermsConflictError extends Error {
    constructor() {
        super("Change order CO-001 tax terms changed after this page loaded — reload and try again.");
        this.name = "ChangeOrderTaxTermsConflictError";
    }
}

function throwConfiguredCoreOutcome(operation: "update" | "manualApprove"): never {
    coreCalls[operation] += 1;
    if (coreOutcome === "conflict") throw new FakeChangeOrderRevisionConflictError();
    if (coreOutcome === "generic") throw new Error(`${operation} validation failed`);
    throw new Error(`${operation} core must not be reached in this test`);
}

const fakePrisma = {
    changeOrder: {
        findUnique: async () => ({ projectId: "project-out-of-scope" }),
    },
};
const fakePermissions = {
    canUseDevAuthFallback: () => false,
    // The user the shared loader (assertActiveStaff -> currentStaffUserOrNull) resolves to:
    // a MANAGER, which passes manuallyApproveChangeOrder's own role gate, so the request
    // reaches the canAccessProject check this test exists to prove is wired in.
    currentStaffUserOrNull: async () => actionUser,
    getCurrentUserWithPermissions: async () => actionUser,
    getUserWithPermissionsByEmail: async () => null,
    hasPermission: () => changeOrderPermissionAllowed,
    // Controllable at the action boundary — the real canAccessProject/
    // accessibleProjectIds logic is already covered by Tests 1-2 above.
    canAccessProject: () => projectAccessAllowed,
    canAccessEstimate: () => false,
    canCreateContractFor: () => false,
    canAccessContract: () => false,
    contractScopeWhere: () => ({}),
    estimateScopeWhere: () => ({}),
    estimateTotalsAreComplete: () => false,
    canWriteDocumentTemplateType: () => false,
    PortalAuthError: class extends Error {},
};
const fakeChangeOrderCore = {
    ChangeOrderRevisionConflictError: FakeChangeOrderRevisionConflictError,
    ChangeOrderTaxTermsConflictError: FakeChangeOrderTaxTermsConflictError,
    deleteChangeOrderCore: async () => { throw new Error("deleteChangeOrderCore should not be called by this test"); },
    updateChangeOrderCore: async () => throwConfiguredCoreOutcome("update"),
    manuallyApproveChangeOrderCore: async () => throwConfiguredCoreOutcome("manualApprove"),
};

let manuallyApproveChangeOrder: (id: string, expectedRevision: number, expectedTaxFingerprint: string) => Promise<unknown>;
let updateChangeOrder: (id: string, data: Record<string, unknown>) => Promise<unknown>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "./prisma") return { prisma: fakePrisma };
        if (id === "./permissions") return fakePermissions;
        if (id === "./change-order-core") return fakeChangeOrderCore;
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const mod: { manuallyApproveChangeOrder?: unknown; updateChangeOrder?: unknown } = await import("../src/lib/actions");
    if (typeof mod.manuallyApproveChangeOrder !== "function" || typeof mod.updateChangeOrder !== "function") {
        throw new Error(
            `change-order-manual-approval-scope.test.ts: mock of "./permissions"/"./prisma"/"./change-order-core" did not apply — ` +
                `action exports are manual=${typeof mod.manuallyApproveChangeOrder}, update=${typeof mod.updateChangeOrder}.`,
        );
    }
    manuallyApproveChangeOrder = mod.manuallyApproveChangeOrder as typeof manuallyApproveChangeOrder;
    updateChangeOrder = mod.updateChangeOrder as typeof updateChangeOrder;
});

test("manuallyApproveChangeOrder throws Forbidden and never reaches the core when the resolved user cannot access the change order's project", async () => {
    projectAccessAllowed = false;
    changeOrderPermissionAllowed = true;
    coreOutcome = "unexpected";
    coreCalls.manualApprove = 0;
    await assert.rejects(
        () => manuallyApproveChangeOrder("co-1", 0, "[]"),
        /Forbidden/,
    );
    assert.equal(coreCalls.manualApprove, 0, "manuallyApproveChangeOrderCore must not be invoked before the project-scope check passes");
});

test("updateChangeOrder returns only the explicit conflict code for a typed core revision conflict", async () => {
    projectAccessAllowed = true;
    changeOrderPermissionAllowed = true;
    coreOutcome = "conflict";
    coreCalls.update = 0;

    const result = await updateChangeOrder("co-1", { title: "Stale update", expectedRevision: 0 });

    assert.deepEqual(result, { success: false, code: "REVISION_CONFLICT" });
    assert.equal(coreCalls.update, 1);
});

test("manuallyApproveChangeOrder returns only the explicit conflict code for a typed core revision conflict", async () => {
    projectAccessAllowed = true;
    coreOutcome = "conflict";
    coreCalls.manualApprove = 0;

    const result = await manuallyApproveChangeOrder("co-1", 0, "[]");

    assert.deepEqual(result, { success: false, code: "REVISION_CONFLICT" });
    assert.equal(coreCalls.manualApprove, 1);
});

test("updateChangeOrder preserves thrown validation and unexpected core failures", async () => {
    projectAccessAllowed = true;
    changeOrderPermissionAllowed = true;
    coreOutcome = "generic";

    await assert.rejects(
        () => updateChangeOrder("co-1", { title: "Invalid update" }),
        /update validation failed/,
    );
});

test("manuallyApproveChangeOrder preserves thrown validation and unexpected core failures", async () => {
    projectAccessAllowed = true;
    coreOutcome = "generic";

    await assert.rejects(
        () => manuallyApproveChangeOrder("co-1", 0, "[]"),
        /manualApprove validation failed/,
    );
});

test("manuallyApproveChangeOrder keeps invalid revision input on the thrown validation path", async () => {
    projectAccessAllowed = true;
    coreOutcome = "unexpected";
    coreCalls.manualApprove = 0;

    await assert.rejects(
        () => manuallyApproveChangeOrder("co-1", -1, "[]"),
        /modified after this page loaded/,
    );
    assert.equal(coreCalls.manualApprove, 0);
});
