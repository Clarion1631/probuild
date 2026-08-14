/**
 * manuallyApproveChangeOrderCore — staff-side approval without a client signature.
 *
 * change-order-core.ts talks to Postgres directly via `import { prisma } from "./prisma"` inside a
 * `prisma.$transaction` callback, so exercising the real function (not a hand-rolled reimplementation
 * of its logic) requires faking that specifier. This uses the same `Module.prototype.require` patch
 * as tests/takeoff-convert-tax.test.ts (see that file's header comment for the full Node-20-vs-22
 * rationale for a manual require() patch over `node:test`'s own `mock.module()`) — scoped to the
 * literal "./prisma" specifier change-order-core.ts's own `import` transpiles to, applied once at
 * module load in `before()`, then restored so nothing downstream depends on the patch staying live.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type ChangeOrderRow = {
    id: string;
    code: string;
    status: string;
    pricingType: string;
    totalAmount: number;
    clientSignatureUrl: string | null;
    updatedAt: Date;
};

type ItemRow = { name: string; type: string; quantity: number; unitCost: number };

const calls = {
    /** SELECT ... FOR UPDATE row locks taken, in order. */
    rowLocks: [] as string[],
    changeOrderUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
};

const state: {
    changeOrder: ChangeOrderRow | null;
    items: ItemRow[];
} = { changeOrder: null, items: [] };

function resetFixture() {
    calls.rowLocks.length = 0;
    calls.changeOrderUpdates.length = 0;
    state.changeOrder = null;
    state.items = [];
}

const fakePrisma = {
    $transaction: async (fn: (tx: any) => Promise<any>) => {
        const tx = {
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
                calls.rowLocks.push(strings.join("?").trim() + ` [${values.join(",")}]`);
                if (!state.changeOrder || state.changeOrder.id !== values[0]) return [];
                return [{ ...state.changeOrder }];
            },
            changeOrderPaymentSchedule: {
                count: async () => 0,
            },
            changeOrderItem: {
                findMany: async () => state.items,
            },
            changeOrder: {
                update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                    calls.changeOrderUpdates.push(args);
                    return { ...state.changeOrder, ...args.data };
                },
            },
        };
        return fn(tx);
    },
};

let manuallyApproveChangeOrderCore: (
    id: string,
    approval: { staffName: string; approvedAt: Date; expectedUpdatedAt: Date },
) => Promise<{ co: any; transitioned: boolean } | null>;

const PRISMA_SPECIFIER = "./prisma";

before(async () => {
    const originalRequire = Module.prototype.require;
    let requirePatchHit = false;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === PRISMA_SPECIFIER) {
            requirePatchHit = true;
            return { prisma: fakePrisma };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    let mod: { manuallyApproveChangeOrderCore?: unknown };
    try {
        mod = await import("../src/lib/change-order-core");
    } finally {
        Module.prototype.require = originalRequire;
    }

    if (typeof mod.manuallyApproveChangeOrderCore !== "function") {
        throw new Error(
            `change-order-manual-approval-core.test.ts: mock of "${PRISMA_SPECIFIER}" did not apply — ` +
                `manuallyApproveChangeOrderCore export is ${typeof mod.manuallyApproveChangeOrderCore}. ` +
                `require() patch ${requirePatchHit ? "WAS" : "was NOT"} hit while importing change-order-core.`,
        );
    }
    manuallyApproveChangeOrderCore = mod.manuallyApproveChangeOrderCore as typeof manuallyApproveChangeOrderCore;
});

beforeEach(() => {
    resetFixture();
});

const FIXTURE_UPDATED_AT = new Date("2026-08-01T00:00:00.000Z");

function draftChangeOrder(overrides: Partial<ChangeOrderRow> = {}): ChangeOrderRow {
    return {
        id: "co-1",
        code: "CO-001",
        status: "Draft",
        pricingType: "FIXED",
        totalAmount: 1000,
        clientSignatureUrl: null,
        updatedAt: FIXTURE_UPDATED_AT,
        ...overrides,
    };
}

const oneItem: ItemRow[] = [{ name: "Extra tile", type: "Labor", quantity: 1, unitCost: 1000 }];

test("manual approve from Draft: sets status Approved, stamps approvedBy with the staff suffix, never writes a client signature", async () => {
    state.changeOrder = draftChangeOrder();
    state.items = oneItem;

    const approvedAt = new Date("2026-08-14T12:00:00.000Z");
    const result = await manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt, expectedUpdatedAt: FIXTURE_UPDATED_AT });

    assert.ok(result, "expected a transition result");
    assert.equal(result!.transitioned, true);
    assert.equal(calls.changeOrderUpdates.length, 1);
    const write = calls.changeOrderUpdates[0];
    assert.equal(write.where.id, "co-1");
    assert.equal(write.data.status, "Approved");
    assert.equal(write.data.approvedBy, "Jane Doe (manual approval — staff)");
    assert.equal(write.data.approvedAt, approvedAt);
    // Manual approval must never write a client signature — that field simply
    // isn't in the update payload at all.
    assert.equal(Object.prototype.hasOwnProperty.call(write.data, "clientSignatureUrl"), false);
});

test("manual approve from Sent also succeeds", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.items = oneItem;

    const result = await manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedUpdatedAt: FIXTURE_UPDATED_AT });
    assert.ok(result);
    assert.equal(result!.co.status, "Approved");
});

test("manual approve is rejected when the change order is already Approved", async () => {
    state.changeOrder = draftChangeOrder({ status: "Approved" });
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedUpdatedAt: FIXTURE_UPDATED_AT }),
        /must be Draft or Sent/,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual approve is rejected when a client signature already exists", async () => {
    // Draft/Sent with a clientSignatureUrl already on the row shouldn't happen in
    // practice, but the guard exists precisely so a stray signed row can never be
    // silently re-approved as if it were staff-only.
    state.changeOrder = draftChangeOrder({ status: "Sent", clientSignatureUrl: "https://example.com/sig.png" });
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedUpdatedAt: FIXTURE_UPDATED_AT }),
        /already has a client signature/,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual approve is rejected when expectedUpdatedAt doesn't match the locked row's updatedAt (CAS guard)", async () => {
    // Simulates the save/approve two-request race: the row was modified after
    // the page loaded (e.g. a concurrent edit), so the stale revision token
    // the client still holds must be refused rather than billed.
    state.changeOrder = draftChangeOrder({ updatedAt: new Date("2026-08-02T00:00:00.000Z") });
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", {
            staffName: "Jane Doe",
            approvedAt: new Date(),
            expectedUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
        }),
        /modified after this page loaded — refresh and try again/,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual approve succeeds when expectedUpdatedAt matches the locked row's updatedAt", async () => {
    const rowUpdatedAt = new Date("2026-08-05T09:30:00.000Z");
    state.changeOrder = draftChangeOrder({ updatedAt: rowUpdatedAt });
    state.items = oneItem;

    const result = await manuallyApproveChangeOrderCore("co-1", {
        staffName: "Jane Doe",
        approvedAt: new Date(),
        expectedUpdatedAt: rowUpdatedAt,
    });
    assert.ok(result);
    assert.equal(result!.transitioned, true);
});
