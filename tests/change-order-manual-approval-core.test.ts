/**
 * manuallyApproveChangeOrderCore — staff-side approval without a client signature — and
 * updateChangeOrderCore's revision bump on its parent update.
 *
 * change-order-core.ts talks to Postgres directly via `import { prisma } from "./prisma"` inside a
 * `prisma.$transaction` callback, so exercising the real function (not a hand-rolled reimplementation
 * of its logic) requires faking that specifier. This uses the same `Module.prototype.require` patch
 * as tests/takeoff-convert-tax.test.ts (see that file's header comment for the full Node-20-vs-22
 * rationale for a manual require() patch over `node:test`'s own `mock.module()`) — scoped to the
 * literal "./prisma" specifier change-order-core.ts's own `import` transpiles to, applied once at
 * module load in `before()`, then restored so nothing downstream depends on the patch staying live.
 *
 * The same fakePrisma also backs updateChangeOrderCore's own tests below — it calls
 * resolveCompanyTimeZone() (company-timezone.ts), which imports the identical "./prisma" specifier
 * and reads `prisma.companySettings.findUnique` directly (not through the transaction client), so
 * the root-level fakePrisma object needs that method too.
 */

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type ChangeOrderRow = {
    id: string;
    code: string;
    status: string;
    title: string;
    description: string | null;
    pricingType: string;
    totalAmount: number;
    markupPercent: number | null;
    approvedBy: string | null;
    approvedAt: Date | null;
    clientSignatureUrl: string | null;
    companySignedBy: string | null;
    companySignedAt: Date | null;
    companySignatureUrl: string | null;
    estimateId: string;
    revision: number;
};

type ItemRow = { name: string; type: string; quantity: number; unitCost: number };

const calls = {
    /** SELECT ... FOR UPDATE row locks taken, in order. */
    rowLocks: [] as string[],
    changeOrderUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
};

const state: {
    changeOrder: ChangeOrderRow | null;
    estimateTax: { taxExempt: boolean; taxRateName: string | null; taxRatePercent: number | null };
    items: ItemRow[];
    schedules: Array<{ id: string; name: string; amount: number; dueDate: Date | null; order: number }>;
} = {
    changeOrder: null,
    estimateTax: { taxExempt: false, taxRateName: "Approval rate", taxRatePercent: 8.9 },
    items: [],
    schedules: [],
};

function resetFixture() {
    calls.rowLocks.length = 0;
    calls.changeOrderUpdates.length = 0;
    state.changeOrder = null;
    state.estimateTax = { taxExempt: false, taxRateName: "Approval rate", taxRatePercent: 8.9 };
    state.items = [];
    state.schedules = [];
}

function applyUpdateData(row: ChangeOrderRow, data: Record<string, unknown>): ChangeOrderRow {
    // Mirror Prisma's `{ increment: N }` semantics against the fixture's stored
    // revision so the returned row reflects the post-write value, the same
    // shape the real database would return.
    const { revision, ...rest } = data;
    const nextRevision = revision && typeof revision === "object" && "increment" in (revision as any)
        ? row.revision + (revision as any).increment
        : ((revision as number | undefined) ?? row.revision);
    return { ...row, ...rest, revision: nextRevision };
}

const fakePrisma = {
    // resolveCompanyTimeZone() (company-timezone.ts) reads this directly off the
    // root client, not through a transaction — updateChangeOrderCore calls it
    // before opening its transaction.
    companySettings: {
        findUnique: async () => ({ timeZone: null }),
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
        const tx = {
            $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
                calls.rowLocks.push(strings.join("?").trim() + ` [${values.join(",")}]`);
                if (!state.changeOrder || state.changeOrder.id !== values[0]) return [];
                return [{ ...state.changeOrder }];
            },
            changeOrderPaymentSchedule: {
                count: async () => 0,
                findMany: async () => state.schedules,
                deleteMany: async () => ({ count: 0 }),
                update: async () => { throw new Error("unexpected changeOrderPaymentSchedule.update in this fixture"); },
                create: async () => { throw new Error("unexpected changeOrderPaymentSchedule.create in this fixture"); },
            },
            changeOrderItem: {
                findMany: async () => state.items,
                deleteMany: async () => ({ count: 0 }),
                update: async () => { throw new Error("unexpected changeOrderItem.update in this fixture"); },
                create: async () => { throw new Error("unexpected changeOrderItem.create in this fixture"); },
            },
            estimate: {
                findUnique: async () => ({ ...state.estimateTax }),
            },
            changeOrder: {
                update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                    calls.changeOrderUpdates.push(args);
                    return applyUpdateData(state.changeOrder!, args.data);
                },
            },
        };
        return fn(tx);
    },
};

let manuallyApproveChangeOrderCore: (
    id: string,
    approval: { staffName: string; approvedAt: Date; expectedRevision: number },
) => Promise<{ co: any; transitioned: boolean } | null>;
let approveChangeOrderCore: (
    id: string,
    approval: { signatureName: string; clientSignatureUrl: string | null; approvedAt: Date },
) => Promise<{ co: any; transitioned: boolean } | null>;
let updateChangeOrderCore: (id: string, data: Record<string, unknown>) => Promise<any>;
let revisionConflictErrorConstructor: unknown;

function assertTypedRevisionConflict(error: unknown): boolean {
    assert.equal(
        typeof revisionConflictErrorConstructor,
        "function",
        "change-order-core must export a dedicated ChangeOrderRevisionConflictError class",
    );
    const ConflictError = revisionConflictErrorConstructor as new (...args: never[]) => Error;
    assert.ok(error instanceof ConflictError, "revision mismatch must throw ChangeOrderRevisionConflictError");
    assert.match((error as Error).message, /modified after this page loaded — refresh and try again/);
    return true;
}

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

    let mod: {
        approveChangeOrderCore?: unknown;
        manuallyApproveChangeOrderCore?: unknown;
        updateChangeOrderCore?: unknown;
        ChangeOrderRevisionConflictError?: unknown;
    };
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
    approveChangeOrderCore = mod.approveChangeOrderCore as typeof approveChangeOrderCore;
    updateChangeOrderCore = mod.updateChangeOrderCore as typeof updateChangeOrderCore;
    revisionConflictErrorConstructor = mod.ChangeOrderRevisionConflictError;
});

beforeEach(() => {
    resetFixture();
});

const FIXTURE_REVISION = 3;

function draftChangeOrder(overrides: Partial<ChangeOrderRow> = {}): ChangeOrderRow {
    return {
        id: "co-1",
        code: "CO-001",
        status: "Draft",
        title: "Old Title",
        description: null,
        pricingType: "FIXED",
        totalAmount: 1000,
        markupPercent: null,
        approvedBy: null,
        approvedAt: null,
        clientSignatureUrl: null,
        companySignedBy: null,
        companySignedAt: null,
        companySignatureUrl: null,
        estimateId: "estimate-1",
        revision: FIXTURE_REVISION,
        ...overrides,
    };
}

const oneItem: ItemRow[] = [{ name: "Extra tile", type: "Labor", quantity: 1, unitCost: 1000 }];

test("manual approve from Draft: sets status Approved, stamps approvedBy with the staff suffix, never writes a client signature, bumps revision", async () => {
    state.changeOrder = draftChangeOrder();
    state.items = oneItem;

    const approvedAt = new Date("2026-08-14T12:00:00.000Z");
    const result = await manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt, expectedRevision: FIXTURE_REVISION });

    assert.ok(result, "expected a transition result");
    assert.equal(result!.transitioned, true);
    assert.equal(calls.changeOrderUpdates.length, 1);
    const write = calls.changeOrderUpdates[0];
    assert.equal(write.where.id, "co-1");
    assert.equal(write.data.status, "Approved");
    assert.equal(write.data.approvedBy, "Jane Doe (manual approval — staff)");
    assert.equal(write.data.approvedAt, approvedAt);
    assert.equal(write.data.approvedTaxExempt, false);
    assert.equal(write.data.approvedTaxRateName, "Approval rate");
    assert.equal(write.data.approvedTaxRatePercent, 8.9);
    assert.deepEqual(write.data.revision, { increment: 1 });
    // Manual approval must never write a client signature — that field simply
    // isn't in the update payload at all.
    assert.equal(Object.prototype.hasOwnProperty.call(write.data, "clientSignatureUrl"), false);
});

test("manual approve from Sent also succeeds", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.items = oneItem;

    const result = await manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedRevision: FIXTURE_REVISION });
    assert.ok(result);
    assert.equal(result!.co.status, "Approved");
});

test("portal approval snapshots the estimate tax fields in the approval update", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.estimateTax = { taxExempt: true, taxRateName: "Exempt certificate", taxRatePercent: null };
    state.items = oneItem;

    const result = await approveChangeOrderCore("co-1", {
        signatureName: "Client Signer",
        clientSignatureUrl: "secure-doc://client-signature.png",
        approvedAt: new Date("2026-08-15T12:00:00.000Z"),
    });

    assert.ok(result);
    const write = calls.changeOrderUpdates[0];
    assert.equal(write.data.status, "Approved");
    assert.equal(write.data.approvedTaxExempt, true);
    assert.equal(write.data.approvedTaxRateName, "Exempt certificate");
    assert.equal(write.data.approvedTaxRatePercent, null);
});

test("manual approve is rejected when the change order is already Approved", async () => {
    state.changeOrder = draftChangeOrder({ status: "Approved" });
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedRevision: FIXTURE_REVISION }),
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
        () => manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedRevision: FIXTURE_REVISION }),
        /already has a client signature/,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual approve is rejected when expectedRevision doesn't match the locked row's revision (CAS guard)", async () => {
    // Simulates the save/approve two-request race: the row was modified after
    // the page loaded (e.g. a concurrent edit bumped revision), so the stale
    // revision token the client still holds must be refused rather than billed.
    state.changeOrder = draftChangeOrder({ revision: FIXTURE_REVISION + 1 });
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", {
            staffName: "Jane Doe",
            approvedAt: new Date(),
            expectedRevision: FIXTURE_REVISION,
        }),
        assertTypedRevisionConflict,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual approve succeeds when expectedRevision matches the locked row's revision, and the update payload bumps revision", async () => {
    const rowRevision = 7;
    state.changeOrder = draftChangeOrder({ revision: rowRevision });
    state.items = oneItem;

    const result = await manuallyApproveChangeOrderCore("co-1", {
        staffName: "Jane Doe",
        approvedAt: new Date(),
        expectedRevision: rowRevision,
    });
    assert.ok(result);
    assert.equal(result!.transitioned, true);
    assert.equal(calls.changeOrderUpdates.length, 1);
    assert.deepEqual(calls.changeOrderUpdates[0].data.revision, { increment: 1 });
});

test("updateChangeOrderCore's parent update includes revision: { increment: 1 }", async () => {
    state.changeOrder = draftChangeOrder({ title: "Old Title" });
    state.items = [];
    state.schedules = [];

    const updated = await updateChangeOrderCore("co-1", { title: "New Title" });

    assert.equal(updated.title, "New Title");
    assert.equal(calls.changeOrderUpdates.length, 1);
    const write = calls.changeOrderUpdates[0];
    assert.equal(write.where.id, "co-1");
    assert.equal(write.data.title, "New Title");
    assert.deepEqual(write.data.revision, { increment: 1 });
    // Post-save revision is what the CAS on manual approval must match — prove
    // the fixture's increment semantics actually moved the number, not just
    // that the write payload shape looks right.
    assert.equal(updated.revision, FIXTURE_REVISION + 1);
});

test("updateChangeOrderCore rejects a stale expectedRevision before any write", async () => {
    state.changeOrder = draftChangeOrder({ revision: FIXTURE_REVISION + 1 });

    await assert.rejects(
        () => updateChangeOrderCore("co-1", { title: "Stale overwrite", expectedRevision: FIXTURE_REVISION }),
        assertTypedRevisionConflict,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("updateChangeOrderCore preserves existing caller behavior when expectedRevision is omitted", async () => {
    state.changeOrder = draftChangeOrder({ revision: FIXTURE_REVISION + 5 });

    const updated = await updateChangeOrderCore("co-1", { title: "MCP-compatible update" });

    assert.equal(updated.title, "MCP-compatible update");
    assert.equal(updated.revision, FIXTURE_REVISION + 6);
    assert.equal(calls.changeOrderUpdates.length, 1);
});
