/**
 * deleteInvoice must keep reporting success when the delete committed but the
 * post-commit revalidatePath() threw; "Nothing was deleted" would be a lie.
 * Real billing-core against a fake prisma (globalThis.prisma), with the
 * Module.prototype.require patch the other action tests use for next/* and
 * permissions (no mock.module: CI is Node 20).
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

let revalidateThrows = false;
let coreThrows: unknown = null;
let coreCalls = 0;

const invoiceRow = {
    id: "inv-1", code: "INV-1", status: "Sent", totalAmount: 1000, balanceDue: 1000,
    qbInvoiceId: null, qbSyncMarker: null, projectId: "proj-1", payments: [], progressBillings: [],
};
const tx = {
    $queryRaw: async () => [],
    invoice: {
        findUnique: async () => invoiceRow,
        delete: async () => { coreCalls++; if (coreThrows) throw coreThrows; return invoiceRow; },
    },
    paymentSchedule: { findFirst: async () => null },
};
(globalThis as any).prisma = { $transaction: async (fn: any) => fn(tx) };

const originalRequire = Module.prototype.require;
let deleteInvoice: (id: string) => Promise<any>;

before(async () => {
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/permissions" || id === "./permissions") {
            return {
                getCurrentUserWithPermissions: async () => ({ id: "staff-1", role: "ADMIN" }),
                hasPermission: () => true,
                canAccessProject: () => true,
                canAccessEstimate: () => true,
                canCreateContractFor: () => true,
                canAccessContract: () => true,
                contractScopeWhere: () => ({}),
                estimateScopeWhere: () => ({}),
                estimateTotalsAreComplete: () => true,
                canWriteDocumentTemplateType: () => true,
                canUseDevAuthFallback: () => false,
                currentStaffUserOrNull: async () => ({ id: "staff-1", role: "ADMIN" }),
                getUserWithPermissionsByEmail: async () => null,
                isAdminOrManager: () => true,
                PortalAuthError: class extends Error {},
            };
        }
        if (id === "next/cache") {
            return {
                revalidatePath: () => { if (revalidateThrows) throw new Error("revalidate boom"); },
                revalidateTag: () => {},
                unstable_cache: (fn: any) => fn,
            };
        }
        if (id === "next/server") return { after: (fn: any) => fn() };
        if (id === "next-auth") return { getServerSession: async () => null };
        if (id === "next-auth/next") return { getServerSession: async () => null };
        if (id === "next/headers") return { headers: () => new Map() };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const mod: any = await import("../src/lib/actions");
    if (typeof mod.deleteInvoice !== "function") throw new Error("delete-invoice-revalidate: mocks did not apply");
    deleteInvoice = mod.deleteInvoice;
});

after(() => {
    Module.prototype.require = originalRequire;
});

beforeEach(() => {
    revalidateThrows = false;
    coreThrows = null;
    coreCalls = 0;
});

test("delete committed, revalidation throws: still reports success", async () => {
    revalidateThrows = true;
    const result = await deleteInvoice("inv-1");
    assert.equal(coreCalls, 1);
    assert.deepEqual(result, { success: true, projectId: "proj-1" });
});

test("delete fails: returns the failure message", async () => {
    coreThrows = new Error("db down");
    const result = await deleteInvoice("inv-1");
    assert.deepEqual(result, { success: false, error: "Could not delete this invoice. Nothing was deleted. Try again, and tell support if it keeps failing." });
});

test("happy path unchanged", async () => {
    assert.deepEqual(await deleteInvoice("inv-1"), { success: true, projectId: "proj-1" });
});
