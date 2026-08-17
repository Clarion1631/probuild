import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

let sessionRole: string | undefined = "ADMIN";
let internalUserRole: string | null = "ADMIN";
let liveStaffRole: string | null = "ADMIN";
let resolvedClientId: string | null = "client-1";
let ownedChangeOrder = true;
let resolveClientCalls = 0;
let ownershipCalls = 0;
let approvalCalls = 0;
let coreApprovalClientIds: Array<string | undefined> = [];
let approveChangeOrder: (
    id: string,
    signatureName: string,
    userAgent: string,
    signatureDataUrl: string | undefined,
    expectedRevision: number,
    expectedTaxFingerprint: string,
) => Promise<unknown>;
let getChangeOrderForPortal: (id: string) => Promise<unknown>;
let originalRequire: typeof Module.prototype.require;

class FakeChangeOrderRevisionConflictError extends Error {}
class FakeChangeOrderTaxTermsConflictError extends Error {}

const fakeApproveChangeOrderCore = async (
    _id: string,
    approval: {
        signatureName: unknown;
        clientSignatureUrl: string | null;
        approvedAt: unknown;
        expectedRevision: unknown;
        expectedTaxFingerprint: unknown;
        expectedClientId?: string;
    },
) => {
    coreApprovalClientIds.push(approval.expectedClientId);
    return {
        transitioned: false,
        co: {
            id: "co-1",
            projectId: "project-1",
            status: "Approved",
            revision: 2,
        },
    };
};

const fakePrisma = {
    user: {
        findUnique: async () => internalUserRole ? { role: internalUserRole } : null,
        findFirst: async () => internalUserRole ? { id: "internal-user-1", role: internalUserRole } : null,
    },
    changeOrder: {
        findFirst: async () => {
            ownershipCalls += 1;
            return ownedChangeOrder ? { id: "co-1" } : null;
        },
    },
};

before(async () => {
    originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "next-auth") {
            return {
                getServerSession: async () => ({
                    user: { email: "viewer@example.com", role: sessionRole },
                }),
            };
        }
        if (id === "./prisma") return { prisma: fakePrisma };
        if (id === "./permissions") {
            // eslint-disable-next-line prefer-rest-params
            const actual = originalRequire.apply(this, arguments as unknown as [string]) as Record<string, unknown>;
            return {
                ...actual,
                currentStaffUserOrNull: async () => liveStaffRole ? { role: liveStaffRole } : null,
            };
        }
        if (id === "./portal-auth") {
            return {
                resolveSessionClientId: async () => {
                    resolveClientCalls += 1;
                    return resolvedClientId;
                },
            };
        }
        if (id === "./change-order-core") {
            return {
                ChangeOrderRevisionConflictError: FakeChangeOrderRevisionConflictError,
                ChangeOrderTaxTermsConflictError: FakeChangeOrderTaxTermsConflictError,
                deleteChangeOrderCore: async () => null,
                updateChangeOrderCore: async () => null,
                manuallyApproveChangeOrderCore: async () => null,
                approveChangeOrderCore: fakeApproveChangeOrderCore,
            };
        }
        if (id === "./change-order-approval") {
            return {
                approveChangeOrderWithSignature: async (
                    approvalId: string,
                    input: Record<string, unknown>,
                    overrides?: { approveCore?: typeof fakeApproveChangeOrderCore },
                ) => {
                    approvalCalls += 1;
                    if (overrides?.approveCore) {
                        return overrides.approveCore(approvalId, {
                            signatureName: input.signatureName,
                            clientSignatureUrl: "secure-doc://change-orders/co-1/client/signature.png",
                            approvedAt: input.approvedAt,
                            expectedRevision: input.expectedRevision,
                            expectedTaxFingerprint: input.expectedTaxFingerprint,
                        });
                    }
                    return {
                        transitioned: false,
                        co: {
                            id: "co-1",
                            projectId: "project-1",
                            status: "Approved",
                            revision: 2,
                        },
                    };
                },
            };
        }
        if (id === "next/cache") {
            return {
                revalidatePath: () => undefined,
                revalidateTag: () => undefined,
                unstable_cache: (fn: unknown) => fn,
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const mod: { approveChangeOrder?: unknown; getChangeOrderForPortal?: unknown } = await import("../src/lib/actions");
    if (typeof mod.approveChangeOrder !== "function") {
        throw new Error(`approveChangeOrder export unavailable: ${typeof mod.approveChangeOrder}`);
    }
    approveChangeOrder = mod.approveChangeOrder as typeof approveChangeOrder;
    getChangeOrderForPortal = mod.getChangeOrderForPortal as typeof getChangeOrderForPortal;
});

after(() => {
    Module.prototype.require = originalRequire;
});

function resetCounters() {
    resolveClientCalls = 0;
    ownershipCalls = 0;
    approvalCalls = 0;
    coreApprovalClientIds = [];
}

for (const role of ["ADMIN", "MANAGER", "FIELD_CREW", "FINANCE"]) {
    test(`${role} cannot use the client-signature action even when the staff email maps to the owning Client`, async () => {
        sessionRole = role;
        internalUserRole = role;
        resolvedClientId = "client-1";
        ownedChangeOrder = true;
        resetCounters();

        const result = await approveChangeOrder(
            "co-1",
            "Staff Signer",
            "test-agent",
            "data:image/png;base64,AA==",
            1,
            "[]",
        );

        assert.equal(result, null);
        assert.equal(resolveClientCalls, 0, "staff must be rejected before portal-client resolution");
        assert.equal(ownershipCalls, 0, "staff must not enter the client ownership branch");
        assert.equal(approvalCalls, 0, "staff must use manuallyApproveChangeOrder instead");
    });
}

test("a disabled or stale internal identity cannot fall through to client-by-email signing", async () => {
    sessionRole = undefined;
    internalUserRole = "FIELD_CREW";
    liveStaffRole = null;
    resolvedClientId = "client-1";
    ownedChangeOrder = true;
    resetCounters();

    const result = await approveChangeOrder(
        "co-1",
        "Internal Signer",
        "test-agent",
        "data:image/png;base64,AA==",
        1,
        "[]",
    );

    assert.equal(result, null);
    assert.equal(resolveClientCalls, 0, "an internal User row must fail closed before client resolution");
    assert.equal(ownershipCalls, 0);
    assert.equal(approvalCalls, 0);
});

test("a non-staff portal client must own the change order before client-signature approval runs", async () => {
    sessionRole = undefined;
    internalUserRole = null;
    resolvedClientId = "client-1";
    ownedChangeOrder = false;
    resetCounters();

    const denied = await approveChangeOrder(
        "co-other-client",
        "Client Signer",
        "test-agent",
        "data:image/png;base64,AA==",
        1,
        "[]",
    );

    assert.equal(denied, null);
    assert.equal(resolveClientCalls, 1);
    assert.equal(ownershipCalls, 1);
    assert.equal(approvalCalls, 0);

    ownedChangeOrder = true;
    resetCounters();
    const approved = await approveChangeOrder(
        "co-1",
        "Client Signer",
        "test-agent",
        "data:image/png;base64,AA==",
        1,
        "[]",
    );

    assert.ok(approved);
    assert.equal(resolveClientCalls, 1);
    assert.equal(ownershipCalls, 1);
    assert.equal(approvalCalls, 1);
    assert.deepEqual(coreApprovalClientIds, ["client-1"], "the action must carry its authenticated Client id into the serialized core");
});

test("a stale disabled staff session does not retain the staff portal-preview bypass", async () => {
    sessionRole = "ADMIN";
    internalUserRole = "ADMIN";
    liveStaffRole = null;
    resolvedClientId = null;
    ownedChangeOrder = true;
    resetCounters();

    assert.equal(await getChangeOrderForPortal("co-1"), null);
    assert.equal(resolveClientCalls, 0, "disabled staff must fail closed before portal-client resolution");
    assert.equal(ownershipCalls, 0, "no unscoped change-order query may run without a live staff row");

    liveStaffRole = "ADMIN";
    resetCounters();
    assert.ok(await getChangeOrderForPortal("co-1"));
    assert.equal(resolveClientCalls, 0, "active staff preview remains available");
});

for (const role of ["FIELD_CREW", "FINANCE"]) {
    test(`${role} cannot turn an internal identity into a portal-client read`, async () => {
        sessionRole = role;
        internalUserRole = role;
        liveStaffRole = role;
        resolvedClientId = "client-1";
        ownedChangeOrder = true;
        resetCounters();

        assert.equal(await getChangeOrderForPortal("co-1"), null);
        assert.equal(resolveClientCalls, 0, "internal identities must fail closed before client-by-email resolution");
        assert.equal(ownershipCalls, 0);
    });
}
