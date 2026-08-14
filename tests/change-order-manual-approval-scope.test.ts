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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
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
