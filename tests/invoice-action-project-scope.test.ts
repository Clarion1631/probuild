/**
 * Project-object authorization for invoice-family Server Actions.
 *
 * These actions are remotely invokable. The `invoices` permission answers what
 * a staff member may do, while `canAccessProject` answers which job they may do
 * it to. A FINANCE user commonly has the former without company-wide access.
 * The behavioral tests below execute the real exported actions with only slow
 * or external boundaries replaced, and prove denial happens before an email,
 * QuickBooks, payment-core, or database mutation boundary is crossed.
 */

import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";

const actionUser = {
    id: "finance-1",
    role: "FINANCE",
    status: "ACTIVE",
    email: "finance@example.test",
    name: "Scoped Finance",
    permissions: { invoices: true },
    projectAccess: [{ projectId: "project-allowed" }],
    assignedProjects: [{ id: "project-assigned" }],
};

const calls = {
    billingSend: 0,
    qboPush: 0,
    recordPaymentCore: 0,
    invoiceRead: 0,
    invoiceWrite: 0,
    projectRead: 0,
    retainerWrite: 0,
};

let lastInvoiceFindManyArgs: Record<string, unknown> | undefined;

function resetFixture() {
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
    lastInvoiceFindManyArgs = undefined;
}

function projectForInvoice(id: string): string {
    return id === "invoice-allowed" ? "project-allowed" : "project-denied";
}

function paymentFixture(id: string) {
    const invoiceId = id === "payment-allowed" ? "invoice-allowed" : "invoice-denied";
    return {
        id,
        invoiceId,
        status: "Pending",
        qbInvoiceId: "qbo-1",
        qbPaymentId: null,
        invoice: { projectId: projectForInvoice(invoiceId) },
    };
}

const fakePrisma = {
    invoice: {
        findUnique: async ({ where }: { where: { id: string } }) => {
            calls.invoiceRead += 1;
            return {
                id: where.id,
                projectId: projectForInvoice(where.id),
                code: "INV-00001",
            };
        },
        findMany: async (args: Record<string, unknown>) => {
            lastInvoiceFindManyArgs = args;
            return [];
        },
        create: async () => {
            calls.invoiceWrite += 1;
            return { id: "created-invoice", number: 1, projectId: "project-denied" };
        },
        update: async () => {
            calls.invoiceWrite += 1;
            return { id: "invoice-denied", projectId: "project-denied" };
        },
        delete: async () => {
            calls.invoiceWrite += 1;
            return {};
        },
    },
    paymentSchedule: {
        findUnique: async ({ where }: { where: { id: string } }) => paymentFixture(where.id),
        findMany: async ({ where }: { where: { id?: { in?: string[] } } }) =>
            (where.id?.in ?? []).map(paymentFixture),
    },
    project: {
        findUnique: async ({ where }: { where: { id: string } }) => {
            calls.projectRead += 1;
            return { id: where.id, clientId: "client-1" };
        },
    },
    retainer: {
        findUnique: async () => ({ id: "retainer-denied", projectId: "project-denied", amountPaid: 0 }),
        count: async () => 0,
        create: async () => {
            calls.retainerWrite += 1;
            return { id: "retainer-created", projectId: "project-denied" };
        },
        update: async () => {
            calls.retainerWrite += 1;
            return { id: "retainer-denied", projectId: "project-denied" };
        },
        delete: async () => {
            calls.retainerWrite += 1;
            return {};
        },
    },
};

const fakeBillingCore = {
    sendInvoiceToClientCore: async () => {
        calls.billingSend += 1;
        return { success: true };
    },
    sendMilestoneInvoicesCore: async () => {
        calls.billingSend += 1;
        return { success: true };
    },
    splitInvoiceMilestonesCore: async () => {
        calls.billingSend += 1;
        return "project-denied";
    },
    updatePendingMilestoneAmountsCore: async () => {
        calls.billingSend += 1;
        return { success: true };
    },
    deleteInvoiceMilestoneCore: async () => {
        calls.billingSend += 1;
        return { projectId: "project-denied", invoiceId: "invoice-denied" };
    },
};

const fakeQuickBooksPayments = {
    pushMilestoneToQuickBooks: async () => {
        calls.qboPush += 1;
        return { payLink: "https://example.test/pay", qbInvoiceId: "qbo-1" };
    },
};

let sendInvoiceToClient: (invoiceId: string) => Promise<unknown>;
let createQBPaymentLink: (paymentId: string) => Promise<unknown>;
let recordPayment: (
    paymentId: string,
    invoiceId: string,
    input: { paymentDate: string; method: string },
) => Promise<unknown>;
let createRetainer: (projectId: string, data: { totalAmount: number }) => Promise<unknown>;
let updateRetainer: (id: string, data: { notes?: string }) => Promise<unknown>;
let getInvoice: (invoiceId: string) => Promise<unknown>;
let getAllInvoices: () => Promise<unknown>;

before(async () => {
    const originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "./prisma") return { prisma: fakePrisma };
        if (id === "next/cache") {
            return {
                revalidatePath: () => undefined,
                revalidateTag: () => undefined,
                unstable_cache: (fn: unknown) => fn,
            };
        }
        if (id === "./permissions") {
            const actual = originalRequire.call(this, id) as Record<string, unknown>;
            return {
                ...actual,
                currentStaffUserOrNull: async () => actionUser,
                getCurrentUserWithPermissions: async () => actionUser,
            };
        }
        if (id === "./billing-core") return fakeBillingCore;
        if (id === "./quickbooks-payments") return fakeQuickBooksPayments;
        if (id === "./payment-record-core") {
            return {
                recordPaymentCore: async () => {
                    calls.recordPaymentCore += 1;
                    return { success: true, projectId: "project-denied" };
                },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const loaded = await import("../src/lib/actions");
    const exports = (loaded as any).sendInvoiceToClient ? loaded : (loaded as any).default;
    sendInvoiceToClient = exports.sendInvoiceToClient;
    createQBPaymentLink = exports.createQBPaymentLink;
    recordPayment = exports.recordPayment;
    createRetainer = exports.createRetainer;
    updateRetainer = exports.updateRetainer;
    getInvoice = exports.getInvoice;
    getAllInvoices = exports.getAllInvoices;

    for (const [name, fn] of Object.entries({
        sendInvoiceToClient,
        createQBPaymentLink,
        recordPayment,
        createRetainer,
        updateRetainer,
        getInvoice,
        getAllInvoices,
    })) {
        assert.equal(typeof fn, "function", `${name} must load as a real Server Action`);
    }
});

beforeEach(resetFixture);

test("an invoices-enabled FINANCE user cannot send an invoice from an inaccessible project", async () => {
    await assert.rejects(() => sendInvoiceToClient("invoice-denied"), /Forbidden/);
    assert.equal(calls.billingSend, 0, "the customer-email core must not run before object authorization");
});

test("a PaymentSchedule id is authorized through its real invoice before QuickBooks is called", async () => {
    await assert.rejects(() => createQBPaymentLink("payment-denied"), /Forbidden/);
    assert.equal(calls.qboPush, 0, "the QuickBooks provider boundary must not run before child ownership is authorized");
});

test("an accessible caller-supplied invoice id cannot authorize another project's payment child", async () => {
    await assert.rejects(
        () => recordPayment("payment-denied", "invoice-allowed", { paymentDate: "2026-08-17", method: "cash" }),
        /Forbidden/,
    );
    assert.equal(calls.recordPaymentCore, 0, "recordPaymentCore must not receive a mismatched, inaccessible child id");
});

test("project-id and retainer-id actions deny before database mutations", async () => {
    await assert.rejects(() => createRetainer("project-denied", { totalAmount: 500 }), /Forbidden/);
    await assert.rejects(() => updateRetainer("retainer-denied", { notes: "unauthorized" }), /Forbidden/);

    assert.equal(calls.projectRead, 0, "project-id creators must scope before loading mutable business data");
    assert.equal(calls.retainerWrite, 0, "retainer mutations must not run before owner-project authorization");
});

test("invoice detail is denied before the data-bearing query is returned", async () => {
    await assert.rejects(() => getInvoice("invoice-denied"), /Forbidden/);
    assert.equal(calls.invoiceWrite, 0);
});

test("getAllInvoices uses the exact accessibleProjectIds set for a scoped FINANCE user", async () => {
    await getAllInvoices();

    assert.deepEqual(lastInvoiceFindManyArgs, {
        where: { projectId: { in: ["project-allowed", "project-assigned"] } },
        orderBy: { createdAt: "desc" },
        include: {
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
        },
    });
});

function actionSource(name: string): string {
    const source = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
    const start = source.indexOf(`export async function ${name}(`);
    assert.notEqual(start, -1, `${name} export must exist`);
    const tail = source.slice(start);
    const closingBrace = /^}\r?$/m.exec(tail);
    assert.ok(closingBrace, `${name} must have a top-level closing brace`);
    return tail.slice(0, closingBrace.index + 1);
}

test("every invoice-family Server Action applies the owner-derived scope helper before its core or mutation", () => {
    const projectIdActions = [
        "createOneOffInvoice",
        "createInvoiceFromTimeEntries",
        "getProjectInvoices",
        "createRetainer",
    ];
    for (const name of projectIdActions) {
        assert.match(actionSource(name), /await assertInvoiceProjectAccess\(projectId, invoiceUser\)/, `${name} must scope its project id`);
    }

    const invoiceIdActions = [
        "deleteInvoice",
        "updateInvoiceNotes",
        "sendInvoiceToClient",
        "emailInvoiceCopyToMe",
        "getInvoice",
        "refreshQBPayments",
        "addInvoiceMilestone",
        "splitInvoiceMilestones",
        "issueInvoice",
    ];
    for (const name of invoiceIdActions) {
        assert.match(
            actionSource(name),
            /assertInvoiceAccess\(invoiceId, (?:invoiceUser|user)|assertInvoiceAccess\(id, invoiceUser/,
            `${name} must resolve its invoice owner`,
        );
    }

    const paymentIdActions = [
        "createQBPaymentLink",
        "breakQBInvoiceLink",
        "sendPaymentReceipt",
        "deleteInvoiceMilestone",
    ];
    for (const name of paymentIdActions) {
        assert.match(actionSource(name), /assertInvoicePaymentAccess\(/, `${name} must resolve the PaymentSchedule owner`);
    }

    for (const name of ["recordPayment", "unrecordPayment"]) {
        assert.match(
            actionSource(name),
            /assertInvoicePaymentAccess\(paymentId, invoiceUser, invoiceId\)/,
            `${name} must bind its child id to the caller-supplied invoice id`,
        );
    }

    for (const name of ["sendMilestoneInvoices", "updatePendingMilestoneAmounts"]) {
        assert.match(actionSource(name), /assertInvoicePaymentsAccess\(/, `${name} must validate every child row through its real invoice`);
    }

    for (const name of ["updateRetainer", "deleteRetainer"]) {
        assert.match(actionSource(name), /assertRetainerAccess\(id, invoiceUser\)/, `${name} must resolve its retainer owner`);
    }

    const createFromEstimate = actionSource("createInvoiceFromEstimate");
    assert.match(createFromEstimate, /assertInvoicePermission\(\)/);
    assert.match(createFromEstimate, /assertEstimateScope\(user, await estimateOwnerOrThrow\(estimateId\)\)/);

    const unrecordEstimate = actionSource("unrecordEstimatePayment");
    assert.match(unrecordEstimate, /assertEstimateAccess\(estimateId\)/);
    assert.match(unrecordEstimate, /assertPaymentBelongsToEstimate\(paymentId, estimateId\)/);

    const getAll = actionSource("getAllInvoices");
    assert.match(getAll, /accessibleProjectIds\(user\)/);
    assert.match(getAll, /projectId: \{ in: projectIds \}/);

    // Completeness tripwire: every direct invoices-permission caller is in the
    // inventory above. The two exceptions immediately add a different owner
    // rule: estimate ownership for creation, project-set filtering for a list.
    const source = readFileSync(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
    const exportNames = Array.from(source.matchAll(/^export async function (\w+)\(/gm), (match) => match[1]);
    const rawPermissionCallers = exportNames.filter((name) => /await assertInvoicePermission\(\)/.test(actionSource(name)));
    const expectedRawPermissionCallers = Array.from(new Set([
        ...projectIdActions,
        ...invoiceIdActions,
        ...paymentIdActions,
        "recordPayment",
        "unrecordPayment",
        "sendMilestoneInvoices",
        "updatePendingMilestoneAmounts",
        "updateRetainer",
        "deleteRetainer",
        "createInvoiceFromEstimate",
        "getAllInvoices",
    ])).sort();
    assert.deepEqual(rawPermissionCallers.sort(), expectedRawPermissionCallers);
});
