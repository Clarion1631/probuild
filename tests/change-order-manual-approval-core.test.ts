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
import { coTaxFingerprint } from "../src/lib/co-tax";

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
    termsTaxExempt: boolean | null;
    termsTaxRateName: string | null;
    termsTaxRatePercent: number | null;
    projectId: string;
    estimateId: string;
    revision: number;
};

type ItemRow = { name: string; type: string; quantity: number; unitCost: number };

const calls = {
    /** SELECT ... FOR UPDATE row locks taken, in order. */
    rowLocks: [] as string[],
    changeOrderUpdates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
    automationJobUpserts: [] as Array<Record<string, any>>,
    automationJobUpdates: [] as Array<Record<string, any>>,
    estimateTaxReads: 0,
};

const state: {
    changeOrder: ChangeOrderRow | null;
    project: { id: string; clientId: string | null } | null;
    reassignClientBeforeProjectLock: string | null;
    estimateTax: { taxExempt: boolean; taxRateName: string | null; taxRatePercent: number | null };
    items: ItemRow[];
    schedules: Array<{ id: string; name: string; amount: number; dueDate: Date | null; order: number }>;
} = {
    changeOrder: null,
    project: { id: "project-1", clientId: "client-1" },
    reassignClientBeforeProjectLock: null,
    estimateTax: { taxExempt: false, taxRateName: "Approval rate", taxRatePercent: 8.9 },
    items: [],
    schedules: [],
};

function resetFixture() {
    calls.rowLocks.length = 0;
    calls.changeOrderUpdates.length = 0;
    calls.automationJobUpserts.length = 0;
    calls.automationJobUpdates.length = 0;
    calls.estimateTaxReads = 0;
    state.changeOrder = null;
    state.project = { id: "project-1", clientId: "client-1" };
    state.reassignClientBeforeProjectLock = null;
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
                const sql = strings.join("?").trim();
                calls.rowLocks.push(sql + ` [${values.join(",")}]`);
                if (sql.includes('FROM "Project"')) {
                    if (state.reassignClientBeforeProjectLock) {
                        state.project = state.project
                            ? { ...state.project, clientId: state.reassignClientBeforeProjectLock }
                            : null;
                        state.reassignClientBeforeProjectLock = null;
                    }
                    return state.project && state.project.id === values[0] ? [{ ...state.project }] : [];
                }
                if (sql.includes('FROM "Estimate"')) {
                    calls.estimateTaxReads++;
                    return values[0] === state.changeOrder?.estimateId ? [{ ...state.estimateTax }] : [];
                }
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
                findUnique: async () => {
                    calls.estimateTaxReads++;
                    return { ...state.estimateTax };
                },
            },
            changeOrder: {
                findUnique: async (args: { where: { id: string } }) =>
                    state.changeOrder?.id === args.where.id
                        ? { id: state.changeOrder.id, projectId: state.changeOrder.projectId }
                        : null,
                update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                    calls.changeOrderUpdates.push(args);
                    return applyUpdateData(state.changeOrder!, args.data);
                },
            },
            changeOrderAutomationJob: {
                findMany: async () => [],
                upsert: async (args: Record<string, any>) => {
                    calls.automationJobUpserts.push(args);
                    return {
                        attempts: 0,
                        maxAttempts: 8,
                        nextAttemptAt: null,
                        firstProviderAttemptAt: null,
                        processingStartedAt: null,
                        claimToken: null,
                        providerMessageId: null,
                        lastError: null,
                        completedAt: null,
                        result: null,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        ...args.create,
                    };
                },
                updateMany: async (args: Record<string, any>) => {
                    calls.automationJobUpdates.push(args);
                    return { count: 0 };
                },
            },
        };
        return fn(tx);
    },
};

let manuallyApproveChangeOrderCore: (
    id: string,
    approval: { staffName: string; approvedAt: Date; expectedRevision: number; expectedTaxFingerprint: string },
) => Promise<{ co: any; transitioned: boolean } | null>;
let approveChangeOrderCore: (
    id: string,
    approval: {
        signatureName: string;
        clientSignatureUrl: string | null;
        approvedAt: Date;
        expectedRevision: number;
        expectedTaxFingerprint: string;
        expectedClientId: string;
    },
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
        termsTaxExempt: null,
        termsTaxRateName: null,
        termsTaxRatePercent: null,
        projectId: "project-1",
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
    const result = await manuallyApproveChangeOrderCore("co-1", {
        staffName: "Jane Doe",
        approvedAt,
        expectedRevision: FIXTURE_REVISION,
        expectedTaxFingerprint: coTaxFingerprint(state.estimateTax),
    });

    assert.ok(result, "expected a transition result");
    assert.equal(result!.transitioned, true);
    assert.equal(calls.changeOrderUpdates.length, 1);
    const write = calls.changeOrderUpdates[0];
    assert.equal(write.where.id, "co-1");
    assert.equal(write.data.status, "Approved");
    assert.equal(write.data.approvedBy, "Jane Doe (manual approval — staff)");
    assert.equal(write.data.approvedAt, approvedAt);
    assert.equal(write.data.termsTaxExempt, false);
    assert.equal(write.data.termsTaxRateName, "Approval rate");
    assert.equal(write.data.termsTaxRatePercent, 8.9);
    assert.deepEqual(write.data.revision, { increment: 1 });
    // Manual approval must never write a client signature — that field simply
    // isn't in the update payload at all.
    assert.equal(Object.prototype.hasOwnProperty.call(write.data, "clientSignatureUrl"), false);
    assert.deepEqual(
        calls.automationJobUpserts.map(call => call.create.kind),
        ["APPROVAL_BILL", "APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"],
    );
    assert.ok(calls.automationJobUpserts.every(call => call.create.approvalMode === "MANUAL"));
    assert.ok(calls.automationJobUpserts.every(call => call.create.eventRevision === FIXTURE_REVISION + 1));
    assert.equal(calls.automationJobUpserts.some(call => call.create.kind === "APPROVAL_CLIENT_EMAIL"), false);
});

test("manual approve from Sent preserves the sent terms tuple instead of re-reading live estimate tax", async () => {
    state.changeOrder = draftChangeOrder({
        status: "Sent",
        termsTaxExempt: false,
        termsTaxRateName: "Sent terms",
        termsTaxRatePercent: 7.25,
    });
    state.estimateTax = { taxExempt: false, taxRateName: "Changed live estimate", taxRatePercent: 12.5 };
    state.items = oneItem;

    const result = await manuallyApproveChangeOrderCore("co-1", {
        staffName: "Jane Doe",
        approvedAt: new Date(),
        expectedRevision: FIXTURE_REVISION,
        expectedTaxFingerprint: coTaxFingerprint({ taxExempt: false, taxRateName: "Sent terms", taxRatePercent: 7.25 }),
    });
    assert.ok(result);
    assert.equal(result!.co.status, "Approved");
    assert.equal(result!.co.termsTaxRatePercent, 7.25);
    assert.equal(calls.estimateTaxReads, 0);
    const write = calls.changeOrderUpdates[0].data;
    assert.equal(Object.prototype.hasOwnProperty.call(write, "termsTaxExempt"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(write, "termsTaxRatePercent"), false);
});

test("portal approval requires the loaded revision and preserves the exact sent terms tuple", async () => {
    state.changeOrder = draftChangeOrder({
        status: "Sent",
        termsTaxExempt: false,
        termsTaxRateName: "Sent exact rate",
        termsTaxRatePercent: 8.875,
    });
    state.estimateTax = { taxExempt: true, taxRateName: "Changed after send", taxRatePercent: null };
    state.items = oneItem;

    const result = await approveChangeOrderCore("co-1", {
        signatureName: "Client Signer",
        clientSignatureUrl: "secure-doc://client-signature.png",
        approvedAt: new Date("2026-08-15T12:00:00.000Z"),
        expectedRevision: FIXTURE_REVISION,
        expectedTaxFingerprint: coTaxFingerprint({ taxExempt: false, taxRateName: "Sent exact rate", taxRatePercent: 8.875 }),
        expectedClientId: "client-1",
    });

    assert.ok(result);
    const write = calls.changeOrderUpdates[0];
    assert.equal(write.data.status, "Approved");
    assert.equal(Object.prototype.hasOwnProperty.call(write.data, "termsTaxExempt"), false);
    assert.equal(result!.co.termsTaxRatePercent, 8.875);
    assert.equal(calls.estimateTaxReads, 0);
    assert.deepEqual(
        calls.automationJobUpserts.map(call => call.create.kind),
        ["APPROVAL_BILL", "APPROVAL_CLIENT_EMAIL", "APPROVAL_SCHEDULE", "APPROVAL_TEAM_EMAIL"],
    );
    assert.ok(calls.automationJobUpserts.every(call => call.create.approvalMode === "CLIENT"));
    assert.ok(calls.automationJobUpserts.every(call => call.create.eventRevision === FIXTURE_REVISION + 1));
});

test("portal approval rejects a stale revision before writing the uploaded signature URL", async () => {
    state.changeOrder = draftChangeOrder({
        status: "Sent",
        revision: FIXTURE_REVISION + 1,
        termsTaxExempt: true,
        termsTaxRateName: "Exempt",
        termsTaxRatePercent: 0,
    });
    state.items = oneItem;

    await assert.rejects(
        () => approveChangeOrderCore("co-1", {
            signatureName: "Stale Client",
            clientSignatureUrl: "secure-doc://owned-stale-signature.png",
            approvedAt: new Date(),
            expectedRevision: FIXTURE_REVISION,
            expectedTaxFingerprint: coTaxFingerprint({ taxExempt: true, taxRateName: "Exempt", taxRatePercent: 0 }),
            expectedClientId: "client-1",
        }),
        assertTypedRevisionConflict,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("legacy Sent portal approval bootstraps live terms atomically when the displayed fingerprint still matches", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.estimateTax = { taxExempt: false, taxRateName: "Legacy displayed terms", taxRatePercent: 9.125 };
    state.items = oneItem;

    const result = await approveChangeOrderCore("co-1", {
        signatureName: "Legacy Portal Client",
        clientSignatureUrl: "secure-doc://legacy-client-signature.png",
        approvedAt: new Date(),
        expectedRevision: FIXTURE_REVISION,
        expectedTaxFingerprint: coTaxFingerprint(state.estimateTax),
        expectedClientId: "client-1",
    });

    assert.ok(result);
    assert.equal(calls.estimateTaxReads, 1);
    assert.equal(calls.changeOrderUpdates[0].data.status, "Approved");
    assert.equal(calls.changeOrderUpdates[0].data.termsTaxExempt, false);
    assert.equal(calls.changeOrderUpdates[0].data.termsTaxRateName, "Legacy displayed terms");
    assert.equal(calls.changeOrderUpdates[0].data.termsTaxRatePercent, 9.125);
    const projectLock = calls.rowLocks.findIndex(sql => sql.includes('FROM "Project"'));
    const changeOrderLock = calls.rowLocks.findIndex(sql => sql.includes('FROM "ChangeOrder"'));
    const estimateLock = calls.rowLocks.findIndex(sql => sql.includes('FROM "Estimate"'));
    assert.ok(projectLock >= 0 && changeOrderLock > projectLock && estimateLock > changeOrderLock);
});

test("portal approval fails closed when Project ownership changes after the action precheck", async () => {
    state.changeOrder = draftChangeOrder({
        status: "Sent",
        termsTaxExempt: false,
        termsTaxRateName: "Sent terms",
        termsTaxRatePercent: 8.875,
    });
    state.items = oneItem;
    state.reassignClientBeforeProjectLock = "client-2";

    await assert.rejects(
        () => approveChangeOrderCore("co-1", {
            signatureName: "Stale Portal Client",
            clientSignatureUrl: "secure-doc://must-be-discarded.png",
            approvedAt: new Date("2026-08-16T12:00:00.000Z"),
            expectedRevision: FIXTURE_REVISION,
            expectedTaxFingerprint: coTaxFingerprint({ taxExempt: false, taxRateName: "Sent terms", taxRatePercent: 8.875 }),
            expectedClientId: "client-1",
        }),
        /no longer belongs to the authenticated portal client/i,
    );

    const projectLock = calls.rowLocks.findIndex(sql => sql.includes('FROM "Project"'));
    const changeOrderLock = calls.rowLocks.findIndex(sql => sql.includes('FROM "ChangeOrder"'));
    assert.ok(projectLock >= 0 && changeOrderLock > projectLock, "approval must lock Project before ChangeOrder");
    assert.equal(calls.changeOrderUpdates.length, 0, "ownership drift must not approve or write signature fields");
    assert.equal(calls.automationJobUpserts.length, 0, "ownership drift must not enqueue approval jobs");
    assert.equal(calls.automationJobUpdates.length, 0, "ownership drift must not mutate review jobs");
});

test("legacy Sent portal approval rejects a changed live tax fingerprint before storing the signature", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.estimateTax = { taxExempt: false, taxRateName: "Changed live terms", taxRatePercent: 9.2 };
    state.items = oneItem;

    await assert.rejects(
        () => approveChangeOrderCore("co-1", {
            signatureName: "Legacy Portal Client",
            clientSignatureUrl: "secure-doc://must-be-discarded.png",
            approvedAt: new Date(),
            expectedRevision: FIXTURE_REVISION,
            expectedTaxFingerprint: coTaxFingerprint({ taxExempt: false, taxRateName: "Old displayed terms", taxRatePercent: 8.875 }),
            expectedClientId: "client-1",
        }),
        /tax terms changed/i,
    );
    assert.equal(calls.estimateTaxReads, 1);
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("legacy Sent manual approval bootstraps live terms atomically when the displayed fingerprint still matches", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.estimateTax = { taxExempt: true, taxRateName: "Legacy exemption", taxRatePercent: 12.5 };
    state.items = oneItem;

    const result = await manuallyApproveChangeOrderCore("co-1", {
        staffName: "Jane Doe",
        approvedAt: new Date(),
        expectedRevision: FIXTURE_REVISION,
        expectedTaxFingerprint: coTaxFingerprint(state.estimateTax),
    });

    assert.ok(result);
    assert.equal(calls.estimateTaxReads, 1);
    assert.equal(calls.changeOrderUpdates[0].data.status, "Approved");
    assert.equal(calls.changeOrderUpdates[0].data.termsTaxExempt, true);
    assert.equal(calls.changeOrderUpdates[0].data.termsTaxRateName, "Legacy exemption");
    assert.equal(calls.changeOrderUpdates[0].data.termsTaxRatePercent, 0);
});

test("legacy Sent manual approval rejects a changed live tax fingerprint without mutating status", async () => {
    state.changeOrder = draftChangeOrder({ status: "Sent" });
    state.estimateTax = { taxExempt: false, taxRateName: "Changed live terms", taxRatePercent: 10.25 };
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", {
            staffName: "Jane Doe",
            approvedAt: new Date(),
            expectedRevision: FIXTURE_REVISION,
            expectedTaxFingerprint: coTaxFingerprint({ taxExempt: false, taxRateName: "Old displayed terms", taxRatePercent: 8.875 }),
        }),
        /tax terms changed/i,
    );
    assert.equal(calls.estimateTaxReads, 1);
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual Draft approval rejects a stale displayed tax fingerprint without mutating status", async () => {
    state.changeOrder = draftChangeOrder();
    state.items = oneItem;
    state.estimateTax = { taxExempt: false, taxRateName: "New live rate", taxRatePercent: 9.2 };

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", {
            staffName: "Jane Doe",
            approvedAt: new Date(),
            expectedRevision: FIXTURE_REVISION,
            expectedTaxFingerprint: coTaxFingerprint({ taxExempt: false, taxRateName: "Old displayed rate", taxRatePercent: 8.875 }),
        }),
        /tax terms changed/i,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("manual approve is rejected when the change order is already Approved", async () => {
    state.changeOrder = draftChangeOrder({ status: "Approved" });
    state.items = oneItem;

    await assert.rejects(
        () => manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedRevision: FIXTURE_REVISION, expectedTaxFingerprint: coTaxFingerprint(state.estimateTax) }),
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
        () => manuallyApproveChangeOrderCore("co-1", { staffName: "Jane Doe", approvedAt: new Date(), expectedRevision: FIXTURE_REVISION, expectedTaxFingerprint: coTaxFingerprint(state.estimateTax) }),
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
            expectedTaxFingerprint: coTaxFingerprint(state.estimateTax),
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
        expectedTaxFingerprint: coTaxFingerprint(state.estimateTax),
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

    const updated = await updateChangeOrderCore("co-1", { title: "New Title", expectedRevision: FIXTURE_REVISION });

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

test("a Sent scope edit returns to Draft and atomically clears the sent terms tuple", async () => {
    state.changeOrder = draftChangeOrder({
        status: "Sent",
        termsTaxExempt: false,
        termsTaxRateName: "Sent terms",
        termsTaxRatePercent: 8.875,
    });

    const updated = await updateChangeOrderCore("co-1", { title: "Changed sent scope", expectedRevision: FIXTURE_REVISION });

    assert.equal(updated.status, "Draft");
    assert.equal(updated.termsTaxExempt, null);
    assert.equal(updated.termsTaxRateName, null);
    assert.equal(updated.termsTaxRatePercent, null);
    const write = calls.changeOrderUpdates[0].data;
    assert.equal(write.status, "Draft");
    assert.equal(write.termsTaxExempt, null);
    assert.equal(write.termsTaxRateName, null);
    assert.equal(write.termsTaxRatePercent, null);
});

test("updateChangeOrderCore rejects a stale expectedRevision before any write", async () => {
    state.changeOrder = draftChangeOrder({ revision: FIXTURE_REVISION + 1 });

    await assert.rejects(
        () => updateChangeOrderCore("co-1", { title: "Stale overwrite", expectedRevision: FIXTURE_REVISION }),
        assertTypedRevisionConflict,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});

test("updateChangeOrderCore rejects a missing expectedRevision before any write", async () => {
    state.changeOrder = draftChangeOrder({ revision: FIXTURE_REVISION + 5 });

    await assert.rejects(
        () => updateChangeOrderCore("co-1", { title: "unguarded update" } as any),
        assertTypedRevisionConflict,
    );
    assert.equal(calls.changeOrderUpdates.length, 0);
});
