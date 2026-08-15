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

let coreCallCount = 0;
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
    currentStaffUserOrNull: async () => ({
        role: "MANAGER",
        email: "manager@example.com",
        name: "Off-Project Manager",
        projectAccess: [],
        assignedProjects: [],
    }),
    getCurrentUserWithPermissions: async () => null,
    getUserWithPermissionsByEmail: async () => null,
    hasPermission: () => false,
    // Faked to deny outright — the real canAccessProject/accessibleProjectIds logic is
    // already covered by Tests 1-2 above; this test only needs to prove the ACTION calls it
    // and respects a "no" before touching the core.
    canAccessProject: () => false,
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
    deleteChangeOrderCore: async () => { throw new Error("deleteChangeOrderCore should not be called by this test"); },
    updateChangeOrderCore: async () => { throw new Error("updateChangeOrderCore should not be called by this test"); },
    manuallyApproveChangeOrderCore: async () => {
        coreCallCount += 1;
        throw new Error("manuallyApproveChangeOrderCore must not be reached when canAccessProject denies");
    },
};

let manuallyApproveChangeOrder: (id: string, expectedRevision: number) => Promise<unknown>;

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

    const mod: { manuallyApproveChangeOrder?: unknown } = await import("../src/lib/actions");
    if (typeof mod.manuallyApproveChangeOrder !== "function") {
        throw new Error(
            `change-order-manual-approval-scope.test.ts: mock of "./permissions"/"./prisma"/"./change-order-core" did not apply — ` +
                `manuallyApproveChangeOrder export is ${typeof mod.manuallyApproveChangeOrder}.`,
        );
    }
    manuallyApproveChangeOrder = mod.manuallyApproveChangeOrder as typeof manuallyApproveChangeOrder;
});

test("manuallyApproveChangeOrder throws Forbidden and never reaches the core when the resolved user cannot access the change order's project", async () => {
    coreCallCount = 0;
    await assert.rejects(
        () => manuallyApproveChangeOrder("co-1", 0),
        /Forbidden/,
    );
    assert.equal(coreCallCount, 0, "manuallyApproveChangeOrderCore must not be invoked before the project-scope check passes");
});
