/**
 * createChangeOrder (actions.ts) — Round 5 fix for a non-atomic create.
 *
 * Before this fix, the parent ChangeOrder was created and its code patched in one call, then
 * every selected item was inserted with a separate, unguarded `prisma.changeOrderItem.create`
 * loop OUTSIDE any transaction — a window where staff could observe a half-copied Draft, and
 * where an item insert queued behind manual-approval's row lock could add scope to an
 * already-Approved CO without bumping its revision. The fix wraps parent creation + code patch +
 * item creation in one `prisma.$transaction`, using a nested `items: { create: [...] } }` payload
 * on the `changeOrder.create` call so there is no window at all.
 *
 * This test proves the ATOMICITY shape, not just the end state a hand-rolled reimplementation
 * could fake: it asserts item rows arrive via the nested `items.create` field of the SAME
 * `changeOrder.create` call made inside `$transaction`, and that the old top-level
 * `prisma.changeOrderItem.create` path is never touched.
 *
 * Uses the same `Module.prototype.require` patch as
 * tests/change-order-manual-approval-scope.test.ts's Test 3 (see its header for the full
 * rationale) — scoped to the specifiers createChangeOrder's call path actually needs:
 * "./prisma" (the estimate lookup + the transaction itself), "./permissions" (the
 * assertChangeOrderPermission / assertEstimateScope auth chain), and "next/cache"
 * (revalidatePath — throws "static generation store missing" outside a real Next.js request,
 * so it must be stubbed to import and call createChangeOrder from a plain Node test at all).
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type EstimateItemRow = {
    id: string;
    parentId: string | null;
    name: string;
    description: string | null;
    type: string;
    quantity: number;
    baseCost: number;
    markupPercent: number | null;
    unitCost: number;
    total: number;
    order: number;
    costCodeId: string | null;
    costTypeId: string | null;
};

const calls = {
    /** Every `changeOrder.create` call made INSIDE $transaction, args as given. */
    txChangeOrderCreates: [] as Array<{ data: Record<string, unknown> }>,
    /** Every `changeOrder.update` call made INSIDE $transaction (the code patch). */
    txChangeOrderUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    /** The old, non-atomic per-item creation path — must NEVER be called by the fix. */
    topLevelChangeOrderItemCreates: [] as unknown[],
    /** How many times $transaction itself was invoked. */
    transactionCount: 0,
};

function resetFixture() {
    calls.txChangeOrderCreates.length = 0;
    calls.txChangeOrderUpdates.length = 0;
    calls.topLevelChangeOrderItemCreates.length = 0;
    calls.transactionCount = 0;
}

const estimateItems: EstimateItemRow[] = [
    {
        id: "item-1", parentId: null, name: "Extra tile", description: null, type: "Material",
        quantity: 10, baseCost: 5, markupPercent: 20, unitCost: 6.25, total: 62.5, order: 0,
        costCodeId: null, costTypeId: null,
    },
];

const fakePrisma = {
    estimate: {
        findUnique: async () => ({
            id: "estimate-1",
            title: "Kitchen remodel",
            projectId: "project-1",
            items: estimateItems,
        }),
    },
    // The old, buggy path (Round 4 and earlier): item rows created one at a time, outside any
    // transaction. Kept wired here purely so the test can assert it's never reached.
    changeOrderItem: {
        create: async (args: unknown) => {
            calls.topLevelChangeOrderItemCreates.push(args);
            throw new Error("prisma.changeOrderItem.create (top-level, non-atomic) must not be called");
        },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        calls.transactionCount += 1;
        let createdNumber = 42;
        const tx = {
            changeOrder: {
                create: async (args: { data: Record<string, unknown> }) => {
                    calls.txChangeOrderCreates.push(args);
                    return { id: "co-new-1", number: createdNumber, ...args.data };
                },
                update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                    calls.txChangeOrderUpdates.push(args);
                    return { id: args.where.id, number: createdNumber, ...args.data };
                },
            },
        };
        return fn(tx);
    },
};

const fakePermissions = {
    canUseDevAuthFallback: () => false,
    currentStaffUserOrNull: async () => ({
        role: "MANAGER",
        email: "manager@example.com",
        name: "Staff Manager",
        projectAccess: [],
        assignedProjects: [],
    }),
    getCurrentUserWithPermissions: async () => null,
    getUserWithPermissionsByEmail: async () => null,
    hasPermission: () => true,
    canAccessProject: () => true,
    canAccessEstimate: () => true,
    canCreateContractFor: () => false,
    canAccessContract: () => false,
    contractScopeWhere: () => ({}),
    estimateScopeWhere: () => ({}),
    estimateTotalsAreComplete: () => false,
    canWriteDocumentTemplateType: () => false,
    PortalAuthError: class extends Error {},
};

const fakeNextCache = {
    // revalidatePath throws "Invariant: static generation store missing" outside a real
    // Next.js request; createChangeOrder calls it after the transaction commits, so a plain
    // Node test needs this stubbed to reach `return { id: ... }` at all.
    revalidatePath: () => {},
    revalidateTag: () => {},
    unstable_cache: (fn: unknown) => fn,
};

let createChangeOrder: (projectId: string, estimateId: string, itemIds?: string[]) => Promise<{ id: string }>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "./prisma") return { prisma: fakePrisma };
        if (id === "./permissions") return fakePermissions;
        if (id === "next/cache") return fakeNextCache;
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const mod: { createChangeOrder?: unknown } = await import("../src/lib/actions");
    if (typeof mod.createChangeOrder !== "function") {
        throw new Error(
            `create-change-order-atomicity.test.ts: mock of "./prisma"/"./permissions"/"next/cache" did not apply — ` +
                `createChangeOrder export is ${typeof mod.createChangeOrder}.`,
        );
    }
    createChangeOrder = mod.createChangeOrder as typeof createChangeOrder;
});

test("createChangeOrder creates the parent and its items atomically inside one $transaction, via a nested items.create payload", async () => {
    resetFixture();

    const result = await createChangeOrder("project-1", "estimate-1", ["item-1"]);

    assert.equal(result.id, "co-new-1");
    assert.equal(calls.transactionCount, 1, "the whole create must happen inside exactly one $transaction call");
    assert.equal(calls.topLevelChangeOrderItemCreates.length, 0, "no item may ever be created via the old top-level changeOrderItem.create path");

    // Exactly one changeOrder.create call, and it carries the items nested — proving the item
    // rows are created in the SAME database round-trip as the parent, not a separate step that
    // could observe a half-copied Draft or race a concurrent approval.
    assert.equal(calls.txChangeOrderCreates.length, 1);
    const createArgs = calls.txChangeOrderCreates[0].data;
    assert.equal(createArgs.status, "Draft");
    assert.equal(createArgs.projectId, "project-1");
    assert.equal(createArgs.estimateId, "estimate-1");
    const nestedItems = (createArgs.items as { create: Array<Record<string, unknown>> } | undefined)?.create;
    assert.ok(Array.isArray(nestedItems), "changeOrder.create's data.items.create must be an array");
    assert.equal(nestedItems!.length, 1);
    assert.equal(nestedItems![0].name, "Extra tile");
    assert.equal(nestedItems![0].unitCost, 6.25);

    // The code patch (CO-TEMP -> CO-00042) is the only other write, and it too runs inside the
    // same $transaction — calls.transactionCount stayed at 1 above proves that.
    assert.equal(calls.txChangeOrderUpdates.length, 1);
    assert.equal(calls.txChangeOrderUpdates[0].data.code, "CO-00042");
});

test("createChangeOrder with no itemIds creates the parent atomically with no items payload at all", async () => {
    resetFixture();

    const result = await createChangeOrder("project-1", "estimate-1");

    assert.equal(result.id, "co-new-1");
    assert.equal(calls.transactionCount, 1);
    assert.equal(calls.topLevelChangeOrderItemCreates.length, 0);
    assert.equal(calls.txChangeOrderCreates.length, 1);
    assert.equal(calls.txChangeOrderCreates[0].data.items, undefined);
});
