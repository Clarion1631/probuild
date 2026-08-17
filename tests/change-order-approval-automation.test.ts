import assert from "node:assert/strict";
import test from "node:test";
import type { FrozenNotification } from "../src/lib/email";
import {
    executeApprovalAutomationJob,
    isApprovalAutomationJobEligible,
    type ApprovalAutomationExecutionDependencies,
} from "../src/lib/change-order-approval-automation";

type Job = {
    id: string;
    changeOrderId: string;
    eventRevision: number;
    kind: string;
    approvalMode: string | null;
    status: string;
    payload: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    idempotencyKey: string;
    dedupeKey: string;
    attempts: number;
    maxAttempts: number;
    nextAttemptAt: Date | null;
    firstProviderAttemptAt: Date | null;
    processingStartedAt: Date | null;
    claimToken: string | null;
    providerMessageId: string | null;
    lastError: string | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};

const NOW = new Date("2026-08-16T18:00:00.000Z");
const EXACT_MILESTONE_STATES = [
    { id: "m-1", name: "Deposit", amount: 500, status: "Pending", qbInvoiceSentAt: null, qbInvoiceId: "qb-1", qbInvoiceLink: "https://qbo.test/1", qbSyncError: null },
    { id: "m-2", name: "Progress", amount: 750, status: "Pending", qbInvoiceSentAt: null, qbInvoiceId: "qb-2", qbInvoiceLink: "https://qbo.test/2", qbSyncError: null },
];
const EXACT_MILESTONE_FINGERPRINT = JSON.stringify({
    invoiceId: "invoice-1",
    milestones: EXACT_MILESTONE_STATES,
});

function job(kind: string, overrides: Partial<Job> = {}): Job {
    return {
        id: `job-${kind.toLowerCase()}`,
        changeOrderId: "co-1",
        eventRevision: 8,
        kind,
        approvalMode: "CLIENT",
        status: "PROCESSING",
        payload: { changeOrderId: "co-1", eventRevision: 8 },
        result: null,
        idempotencyKey: `co-job/job-${kind.toLowerCase()}`,
        dedupeKey: `dedupe-${kind.toLowerCase()}`,
        attempts: 1,
        maxAttempts: 8,
        nextAttemptAt: null,
        firstProviderAttemptAt: null,
        processingStartedAt: new Date(NOW.getTime() - 1_000),
        claimToken: `claim-${kind.toLowerCase()}`,
        providerMessageId: null,
        lastError: null,
        completedAt: null,
        createdAt: new Date(NOW.getTime() - 10_000),
        updatedAt: new Date(NOW.getTime() - 1_000),
        ...overrides,
    };
}

function matches(actual: unknown, expected: unknown): boolean {
    if (expected === undefined) return true;
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        return Object.entries(expected).every(([key, value]) => matches((actual as Record<string, unknown>)?.[key], value));
    }
    return actual === expected;
}

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in value) {
            target[key] = Number(target[key] ?? 0) + Number((value as { increment: number }).increment);
        } else {
            target[key] = value;
        }
    }
}

function memoryDatabase(seed: Job[]) {
    const jobs = seed;
    const activities: Array<Record<string, unknown>> = [];
    const scheduleEffects: string[] = [];
    const stampedSchedules = new Map<string, Date>();
    const invoice = {
        id: "invoice-1",
        estimateId: "estimate-1",
        projectId: "project-1",
        clientId: "client-1",
        status: "Draft",
        issueDate: null as Date | null,
        client: { email: "client@example.com", additionalEmail: null as string | null },
        project: {
            id: "project-1",
            clientId: null as string | null,
            client: null as { email: string | null; additionalEmail: string | null } | null,
        },
    };
    const milestoneRows = new Map([
        ["m-1", { id: "m-1", invoiceId: invoice.id, name: "Deposit", amount: 500, status: "Pending", qbInvoiceSentAt: null as Date | null, qbInvoiceId: "qb-1", qbInvoiceLink: "https://qbo.test/1", qbSyncError: null as string | null }],
        ["m-2", { id: "m-2", invoiceId: invoice.id, name: "Progress", amount: 750, status: "Pending", qbInvoiceSentAt: null as Date | null, qbInvoiceId: "qb-2", qbInvoiceLink: "https://qbo.test/2", qbSyncError: null as string | null }],
    ]);
    let invoiceEmailAttempt: Record<string, unknown> | null = null;
    const settings = {
        companyName: "Golden Touch",
        notificationEmail: "ops@example.com, owner@example.com" as string | null,
        email: "office@example.com" as string | null,
    };
    const raceHooks: {
        afterInvoiceRoutingRead: (() => void) | null;
        afterSettingsRead: (() => void) | null;
    } = {
        afterInvoiceRoutingRead: null,
        afterSettingsRead: null,
    };
    const changeOrder = {
        id: "co-1",
        code: "CO-00088",
        title: "Patio cover",
        status: "Approved",
        pricingType: "FIXED",
        projectId: "project-1",
        project: { name: "Adkins Residence" },
    };

    const jobModel = {
        findUnique: async ({ where }: { where: { id: string } }) => jobs.find(row => row.id === where.id) ?? null,
        findFirst: async ({ where }: { where: Record<string, unknown> }) => jobs.find(row => matches(row, where)) ?? null,
        findMany: async ({ where }: { where: Record<string, unknown> }) => jobs.filter(row => {
            if (where.changeOrderId !== undefined && row.changeOrderId !== where.changeOrderId) return false;
            if (where.eventRevision !== undefined && row.eventRevision !== where.eventRevision) return false;
            if (where.kind && typeof where.kind === "object") {
                const filter = where.kind as { not?: string; in?: string[] };
                if (filter.not !== undefined && row.kind === filter.not) return false;
                if (filter.in && !filter.in.includes(row.kind)) return false;
            } else if (where.kind !== undefined && row.kind !== where.kind) return false;
            return true;
        }),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            const selected = jobs.filter(row => matches(row, where));
            for (const row of selected) applyData(row as unknown as Record<string, unknown>, data);
            return { count: selected.length };
        },
    };

    const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            if (sql.includes('FROM "ChangeOrderAutomationJob"')) {
                const row = jobs.find(candidate => candidate.id === values[0]);
                return row ? [{ id: row.id }] : [];
            }
            if (sql.includes('FROM "ChangeOrder"')) return [{ id: changeOrder.id, projectId: changeOrder.projectId }];
            if (sql.includes('FROM "Estimate"')) return [{ id: invoice.estimateId }];
            if (sql.includes('FROM "InvoiceEmailAttempt"')) return invoiceEmailAttempt ? [invoiceEmailAttempt] : [];
            if (sql.includes('FROM "Invoice"')) return [{ id: invoice.id }];
            if (sql.includes('FROM "Project"')) {
                return [{ id: invoice.project.id, clientId: invoice.project.clientId }];
            }
            if (sql.includes('FROM "Client"')) {
                if (values[0] === invoice.clientId) return [{ id: invoice.clientId, ...invoice.client }];
                if (values[0] === invoice.project.clientId && invoice.project.client) {
                    return [{ id: invoice.project.clientId, ...invoice.project.client }];
                }
                return [];
            }
            if (sql.includes('FROM "CompanySettings"')) return [{ id: "singleton", ...settings }];
            return [];
        },
        changeOrderAutomationJob: jobModel,
        changeOrder: {
            findUnique: async () => changeOrder,
        },
        companySettings: {
            findUnique: async () => {
                const snapshot = { ...settings };
                const hook = raceHooks.afterSettingsRead;
                raceHooks.afterSettingsRead = null;
                hook?.();
                return snapshot;
            },
        },
        activityLog: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                activities.push(data);
                return data;
            },
        },
        paymentSchedule: {
            findMany: async ({ where }: { where: { invoiceId: string; id: { in: string[] } } }) => (
                where.id.in
                    .map(id => milestoneRows.get(id))
                    .filter((row): row is NonNullable<typeof row> => Boolean(row && row.invoiceId === where.invoiceId))
            ),
            updateMany: async ({ where, data }: { where: { id: string | { in: string[] }; invoiceId: string; name?: string; amount?: number; status?: string; qbInvoiceSentAt?: Date | null; qbInvoiceId?: string; qbInvoiceLink?: string | null; qbSyncError?: string | null }; data: { qbInvoiceSentAt: Date } }) => {
                if (where.invoiceId !== invoice.id) return { count: 0 };
                const ids = typeof where.id === "string" ? [where.id] : where.id.in;
                let count = 0;
                for (const id of ids) {
                    const row = milestoneRows.get(id);
                    if (!row) continue;
                    if (where.name !== undefined && row.name !== where.name) continue;
                    if (where.amount !== undefined && row.amount !== where.amount) continue;
                    if (where.status !== undefined && row.status !== where.status) continue;
                    if (where.qbInvoiceSentAt !== undefined
                        && row.qbInvoiceSentAt?.getTime() !== where.qbInvoiceSentAt?.getTime()) continue;
                    if (where.qbInvoiceId !== undefined && row.qbInvoiceId !== where.qbInvoiceId) continue;
                    if (where.qbInvoiceLink !== undefined && row.qbInvoiceLink !== where.qbInvoiceLink) continue;
                    if (where.qbSyncError !== undefined && row.qbSyncError !== where.qbSyncError) continue;
                    row.qbInvoiceSentAt = data.qbInvoiceSentAt;
                    stampedSchedules.set(id, data.qbInvoiceSentAt);
                    count += 1;
                }
                return { count };
            },
        },
        invoice: {
            findUnique: async () => {
                const snapshot = {
                    ...invoice,
                    client: { ...invoice.client },
                    project: {
                        ...invoice.project,
                        client: invoice.project.client ? { ...invoice.project.client } : null,
                    },
                };
                const hook = raceHooks.afterInvoiceRoutingRead;
                raceHooks.afterInvoiceRoutingRead = null;
                hook?.();
                return snapshot;
            },
            updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
                if (where.id !== invoice.id || (where.status && where.status !== invoice.status)) return { count: 0 };
                applyData(invoice as unknown as Record<string, unknown>, data);
                return { count: 1 };
            },
        },
        invoiceEmailAttempt: {
            findUnique: async () => invoiceEmailAttempt,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                invoiceEmailAttempt = { ...data };
                return invoiceEmailAttempt;
            },
            delete: async () => {
                const deleted = invoiceEmailAttempt;
                invoiceEmailAttempt = null;
                return deleted;
            },
        },
        scheduleEffects,
    };
    const db = {
        ...tx,
        $transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>) => fn(tx),
    };
    return {
        db,
        jobs,
        activities,
        scheduleEffects,
        stampedSchedules,
        milestoneRows,
        invoice,
        changeOrder,
        settings,
        raceHooks,
        getInvoiceEmailAttempt: () => invoiceEmailAttempt,
    };
}

function frozen(subject = "Payment request"): FrozenNotification {
    return {
        from: "Golden Touch <notifications@goldentouchremodeling.com>",
        to: ["client@example.com"],
        replyTo: "office@example.com",
        subject,
        html: `<p>${subject}</p>`,
        text: subject,
        bcc: ["ops@example.com", "owner@example.com"],
    };
}

test("eligibility holds client work behind billing and team work behind every non-team sibling", async () => {
    const bill = job("APPROVAL_BILL", { status: "PENDING", claimToken: null });
    const client = job("APPROVAL_CLIENT_EMAIL", { status: "PENDING", claimToken: null });
    const schedule = job("APPROVAL_SCHEDULE", { status: "SUCCEEDED", claimToken: null });
    const team = job("APPROVAL_TEAM_EMAIL", { status: "PENDING", claimToken: null });
    const state = memoryDatabase([bill, client, schedule, team]);

    assert.equal(await isApprovalAutomationJobEligible(client as never, { db: state.db as never }), false);
    assert.equal(await isApprovalAutomationJobEligible(team as never, { db: state.db as never }), false);

    bill.status = "SUCCEEDED";
    bill.result = { invoiceId: "invoice-1", milestoneIds: ["m-1", "m-2"] };
    assert.equal(await isApprovalAutomationJobEligible(client as never, { db: state.db as never }), true);
    assert.equal(await isApprovalAutomationJobEligible(team as never, { db: state.db as never }), false);

    client.status = "SUCCEEDED";
    assert.equal(await isApprovalAutomationJobEligible(team as never, { db: state.db as never }), true);
});

test("fixed-price schedule work waits for billing and refuses a failed billing prerequisite", async () => {
    const bill = job("APPROVAL_BILL", { status: "PENDING", claimToken: null });
    const schedule = job("APPROVAL_SCHEDULE", { status: "PENDING", claimToken: null });
    const state = memoryDatabase([bill, schedule]);

    assert.equal(await isApprovalAutomationJobEligible(schedule as never, { db: state.db as never }), false);
    bill.status = "SUCCEEDED";
    assert.equal(await isApprovalAutomationJobEligible(schedule as never, { db: state.db as never }), true);

    bill.status = "NEEDS_ATTENTION";
    let applyCalls = 0;
    const result = await executeApprovalAutomationJob({ ...schedule, status: "PROCESSING", claimToken: "claim-1" } as never, {
        db: state.db as never,
        applySchedule: async () => {
            applyCalls += 1;
            throw new Error("must not apply");
        },
        isSchedulePreconditionError: () => false,
    });
    assert.deepEqual(result, {
        kind: "needs-attention",
        error: "Schedule automation blocked because billing ended NEEDS_ATTENTION",
    });
    assert.equal(applyCalls, 0);

    const costPlusState = memoryDatabase([schedule]);
    assert.equal(await isApprovalAutomationJobEligible(schedule as never, { db: costPlusState.db as never }), true);
});

test("BILL suppresses bill-core logging and atomically records one fenced activity with every milestone id", async () => {
    const billJob = job("APPROVAL_BILL");
    const state = memoryDatabase([billJob]);
    let suppressedLoggerCalls = 0;
    const result = await executeApprovalAutomationJob(billJob as never, {
        db: state.db as never,
        now: () => NOW,
        billChangeOrder: async (_changeOrderId, dependencies) => {
            await dependencies?.logActivity?.({} as never);
            suppressedLoggerCalls++;
            dependencies?.revalidatePath?.("/must-not-revalidate");
            return {
                ok: true,
                alreadyBilled: false,
                invoiceId: "invoice-1",
                invoiceCode: "INV-1",
                milestones: [
                    { id: "m-1", name: "Deposit", amount: 600, pretaxAmount: 550, taxAmount: 50, status: "Pending", created: true },
                    { id: "m-2", name: "Final", amount: 400, pretaxAmount: 365, taxAmount: 35, status: "Pending", created: true },
                ],
                amount: 1_000,
                subtotal: 915,
                taxAmount: 85,
                taxLabel: "Sales tax",
                milestoneId: "m-1",
                milestoneName: "Deposit",
                milestoneStatus: "Pending",
                note: "billed",
            };
        },
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.equal(suppressedLoggerCalls, 1, "the fake bill path ran, including its injected no-op logger");
    assert.equal(billJob.status, "SUCCEEDED");
    assert.deepEqual((billJob.result as Record<string, unknown>).milestoneIds, ["m-1", "m-2"]);
    assert.equal(state.activities.length, 1);
    assert.equal(state.activities[0].action, "billed_change_order");
    assert.equal(state.activities[0].projectId, "project-1", "the durable activity remains attached to the CO project");

    let staleBillCalls = 0;
    const staleReplay = await executeApprovalAutomationJob({ ...billJob, status: "PROCESSING", claimToken: "old-claim" } as never, {
        db: state.db as never,
        now: () => NOW,
        billChangeOrder: async () => {
            staleBillCalls++;
            return {
                ok: true,
                alreadyBilled: true,
                invoiceId: "invoice-1",
                invoiceCode: "INV-1",
                milestones: [
                    { id: "m-1", name: "Deposit", amount: 600, pretaxAmount: 550, taxAmount: 50, status: "Pending", created: false },
                    { id: "m-2", name: "Final", amount: 400, pretaxAmount: 365, taxAmount: 35, status: "Pending", created: false },
                ],
                amount: 1_000,
                subtotal: 915,
                taxAmount: 85,
                taxLabel: "Sales tax",
                milestoneId: "m-1",
                milestoneName: "Deposit",
                milestoneStatus: "Pending",
                note: "already billed",
            };
        },
    });
    assert.equal(staleReplay.kind, "retry");
    assert.equal(staleBillCalls, 0, "a stale lease is rejected before the billing mutation starts");
    assert.equal(state.activities.length, 1, "a stale lease cannot create a duplicate activity");
});

test("SCHEDULE commits its apply activity and job completion together", async () => {
    const scheduleJob = job("APPROVAL_SCHEDULE");
    const state = memoryDatabase([scheduleJob]);
    const result = await executeApprovalAutomationJob(scheduleJob as never, {
        db: state.db as never,
        now: () => NOW,
        applySchedule: async (tx, input) => {
            assert.equal(input.changeOrderId, "co-1");
            (tx as unknown as { scheduleEffects: string[] }).scheduleEffects.push("task-created");
            await (tx as unknown as { activityLog: { create(args: unknown): Promise<unknown> } }).activityLog.create({
                data: { action: "applied_change_order_schedule" },
            });
            return {
                changeOrderCode: "CO-00088",
                projectId: "project-1",
                created: [{
                    id: "task-1",
                    name: "Patio cover",
                    startDate: "2026-08-17",
                    endDate: "2026-08-18",
                    type: "task",
                    color: "#000000",
                    order: 1,
                    status: "Not Started",
                    progress: 0,
                    estimatedHours: null,
                    estimateItemId: null,
                    parentId: null,
                }],
                skipped: 0,
                milestonesLinked: 2,
                notes: [],
            };
        },
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.equal(scheduleJob.status, "SUCCEEDED");
    assert.deepEqual(state.scheduleEffects, ["task-created"]);
    assert.deepEqual(state.activities.map(row => row.action), ["applied_change_order_schedule"]);
});

test("SCHEDULE turns a domain precondition into a durable SKIPPED terminal state", async () => {
    class PreconditionError extends Error {}
    const scheduleJob = job("APPROVAL_SCHEDULE");
    const state = memoryDatabase([scheduleJob]);
    const result = await executeApprovalAutomationJob(scheduleJob as never, {
        db: state.db as never,
        now: () => NOW,
        applySchedule: async () => { throw new PreconditionError("No signed baseline schedule"); },
        isSchedulePreconditionError: error => error instanceof PreconditionError,
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.equal(scheduleJob.status, "SKIPPED");
    assert.match(JSON.stringify(scheduleJob.result), /No signed baseline schedule/);
});

test("CLIENT checkpoints one frozen payload, uses the stable key, and atomically records exact milestone delivery", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL");
    const state = memoryDatabase([bill, client]);
    const providerCalls: Array<{ dispatch: FrozenNotification; key: string }> = [];

    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async (invoiceId, scheduleIds, _override, _opts, _actor, automation) => {
            assert.equal(invoiceId, "invoice-1");
            assert.deepEqual(scheduleIds, ["m-1", "m-2"]);
            assert.ok(automation);
            const dispatch = await automation!.persistFrozenNotification(frozen());
            const provider = await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
            assert.equal(provider.success, true);
            await automation!.completeAfterDelivery({
                invoiceId,
                scheduleIds: [...scheduleIds],
                recipient: dispatch.to[0],
                sentAt: NOW,
                providerMessageId: provider.id,
                milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
                milestones: EXACT_MILESTONE_STATES,
            });
            return { success: true, sent: 2, failed: 0, skipped: 0, results: scheduleIds.map(id => ({ id, name: id, status: "sent" as const, sentTo: dispatch.to[0] })) };
        },
        sendFrozenNotification: async (dispatch, key) => {
            providerCalls.push({ dispatch, key });
            return { success: true, id: "resend-123" };
        },
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.equal(client.status, "SUCCEEDED");
    assert.equal(client.firstProviderAttemptAt?.toISOString(), NOW.toISOString());
    assert.equal((client.payload as Record<string, unknown>).dispatch, undefined,
        "terminal success must redact the frozen body after delivery no longer needs recovery");
    assert.deepEqual(
        ((client.payload as Record<string, unknown>).dispatchAudit as Record<string, unknown>).to,
        frozen().to,
    );
    assert.deepEqual(providerCalls, [{ dispatch: frozen(), key: client.idempotencyKey }]);
    assert.deepEqual([...state.stampedSchedules.keys()], ["m-1", "m-2"]);
    assert.equal(state.invoice.status, "Issued");
    assert.equal(state.activities.length, 1);
    assert.equal(state.activities[0].action, "sent_invoice");
    assert.equal(client.providerMessageId, "resend-123");
});

test("CLIENT fails closed before the provider when billing preflight reduces the exact milestone set", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL");
    const state = memoryDatabase([bill, client]);
    let providerCalls = 0;

    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async (invoiceId, _scheduleIds, _override, _opts, _actor, automation) => {
            const dispatch = await automation!.persistFrozenNotification(frozen("Only one sendable milestone"));
            const provider = await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
            assert.equal(provider.success, true);
            try {
                await automation!.completeAfterDelivery({
                    invoiceId,
                    scheduleIds: ["m-1"],
                    recipient: dispatch.to[0],
                    sentAt: NOW,
                    providerMessageId: provider.id,
                    milestoneFingerprint: JSON.stringify({ invoiceId, milestones: [EXACT_MILESTONE_STATES[0]] }),
                    milestones: [EXACT_MILESTONE_STATES[0]],
                });
            } catch (error) {
                return {
                    success: true,
                    sent: 1,
                    failed: 1,
                    skipped: 0,
                    deliveredButUnrecorded: true,
                    results: [{ id: "m-1", name: "m-1", status: "sent" as const, sentTo: dispatch.to[0], error: (error as Error).message }],
                };
            }
            throw new Error("partial set must not complete");
        },
        sendFrozenNotification: async () => {
            providerCalls++;
            return { success: true, id: "must-not-send" };
        },
    });

    assert.equal(result.kind, "retry");
    assert.equal(providerCalls, 0, "no customer email may leave for a partial billed milestone set");
    assert.equal(client.firstProviderAttemptAt, null, "a rejected preflight is not a provider attempt");
    assert.equal(client.status, "PROCESSING");
});

test("CLIENT rechecks money, status, and QBO identity under Estimate and Invoice locks before provider delivery", async () => {
    const mutations: Array<[string, (row: ReturnType<typeof memoryDatabase>["milestoneRows"] extends Map<string, infer R> ? R : never) => void]> = [
        ["amount", row => { row.amount = 501; }],
        ["status", row => { row.status = "Paid"; }],
        ["QBO identity", row => { row.qbInvoiceId = "qb-swapped"; }],
    ];
    for (const [label, mutate] of mutations) {
        const bill = job("APPROVAL_BILL", {
            status: "SUCCEEDED",
            claimToken: null,
            result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
        });
        const client = job("APPROVAL_CLIENT_EMAIL");
        const state = memoryDatabase([bill, client]);
        let providerCalls = 0;
        const result = await executeApprovalAutomationJob(client as never, {
            db: state.db as never,
            now: () => NOW,
            sendMilestoneInvoices: async (invoiceId, scheduleIds, _override, _opts, _actor, automation) => {
                const dispatch = frozen();
                await automation!.persistFrozenNotification(dispatch);
                await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
                mutate(state.milestoneRows.get("m-2")!);
                await assert.rejects(automation!.completeAfterDelivery({
                    invoiceId,
                    scheduleIds,
                    recipient: dispatch.to[0],
                    sentAt: NOW,
                    providerMessageId: `preflight-only/${client.id}`,
                    milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
                    milestones: EXACT_MILESTONE_STATES,
                }));
                return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: `${label} state changed` };
            },
            sendFrozenNotification: async () => {
                providerCalls += 1;
                return { success: true, id: "must-not-send" };
            },
        });
        assert.equal(providerCalls, 0, `${label} drift must stop before the provider`);
        assert.equal(client.firstProviderAttemptAt, null, "a rejected state fence is not a provider attempt");
        assert.equal(result.kind, "retry");
        assert.match("error" in result ? result.error : "", /state changed/i);
    }
});

test("CLIENT re-reads and locks recipients after an update commits between routing read and checkpoint", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL");
    const state = memoryDatabase([bill, client]);
    let providerCalls = 0;
    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async (invoiceId, scheduleIds, _override, _opts, _actor, automation) => {
            const dispatch = frozen();
            await automation!.persistFrozenNotification(dispatch);
            await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
            state.raceHooks.afterInvoiceRoutingRead = () => {
                state.invoice.client.email = "changed@example.com";
            };
            await assert.rejects(automation!.completeAfterDelivery({
                invoiceId,
                scheduleIds,
                recipient: dispatch.to[0],
                sentAt: NOW,
                milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
                milestones: EXACT_MILESTONE_STATES,
            }));
            return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: "recipient state changed" };
        },
        sendFrozenNotification: async () => {
            providerCalls += 1;
            return { success: true, id: "must-not-send" };
        },
    });
    assert.equal(providerCalls, 0);
    assert.equal(client.firstProviderAttemptAt, null);
    assert.equal(result.kind, "retry");
});

test("CLIENT rejects first-attempt CompanySettings BCC drift before the provider checkpoint", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL");
    const state = memoryDatabase([bill, client]);
    let providerCalls = 0;
    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async (invoiceId, scheduleIds, _override, _opts, _actor, automation) => {
            const dispatch = frozen();
            await automation!.persistFrozenNotification(dispatch);
            await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
            state.raceHooks.afterInvoiceRoutingRead = () => {
                state.settings.notificationEmail = null;
            };
            await assert.rejects(automation!.completeAfterDelivery({
                invoiceId,
                scheduleIds,
                recipient: dispatch.to[0],
                sentAt: NOW,
                milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
                milestones: EXACT_MILESTONE_STATES,
            }));
            return { success: false, sent: 0, failed: 0, skipped: 0, results: [], error: "BCC state changed" };
        },
        sendFrozenNotification: async () => {
            providerCalls += 1;
            return { success: true, id: "must-not-send" };
        },
    });
    assert.equal(providerCalls, 0);
    assert.equal(client.firstProviderAttemptAt, null);
    assert.equal(state.getInvoiceEmailAttempt(), null);
    assert.equal(result.kind, "retry");
});

test("CLIENT rejects first-attempt CompanySettings reply-to and sender-name drift before the provider checkpoint", async () => {
    for (const scenario of [
        {
            label: "reply-to",
            mutate: (settings: { email: string | null; companyName: string }) => {
                settings.email = "changed-office@example.com";
            },
        },
        {
            label: "sender name",
            mutate: (settings: { email: string | null; companyName: string }) => {
                settings.companyName = "Renamed Contractor";
            },
        },
    ]) {
        const bill = job("APPROVAL_BILL", {
            status: "SUCCEEDED",
            claimToken: null,
            result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
        });
        const client = job("APPROVAL_CLIENT_EMAIL");
        const state = memoryDatabase([bill, client]);
        let providerCalls = 0;
        const result = await executeApprovalAutomationJob(client as never, {
            db: state.db as never,
            now: () => NOW,
            sendMilestoneInvoices: async (invoiceId, scheduleIds, _override, _opts, _actor, automation) => {
                const dispatch = frozen();
                await automation!.persistFrozenNotification(dispatch);
                await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
                state.raceHooks.afterInvoiceRoutingRead = () => {
                    scenario.mutate(state.settings);
                };
                await assert.rejects(automation!.completeAfterDelivery({
                    invoiceId,
                    scheduleIds,
                    recipient: dispatch.to[0],
                    sentAt: NOW,
                    milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
                    milestones: EXACT_MILESTONE_STATES,
                }), new RegExp("recipients|reply-to|sender settings", "i"), scenario.label);
                return {
                    success: false,
                    sent: 0,
                    failed: 0,
                    skipped: 0,
                    results: [],
                    error: `${scenario.label} state changed`,
                };
            },
            sendFrozenNotification: async () => {
                providerCalls += 1;
                return { success: true, id: "must-not-send" };
            },
        });
        assert.equal(providerCalls, 0, `${scenario.label} drift must stop before the provider`);
        assert.equal(client.firstProviderAttemptAt, null);
        assert.equal(state.getInvoiceEmailAttempt(), null);
        assert.equal(result.kind, "retry");
    }
});

test("CLIENT recovery sends the frozen dispatch directly without mutable invoice/QBO preflight", async () => {
    const persisted = frozen("Previously attempted exact request");
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1", "m-2"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL", {
        payload: {
            invoiceId: "invoice-1",
            milestoneIds: ["m-1", "m-2"],
            milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
            milestones: EXACT_MILESTONE_STATES,
            dispatch: persisted,
        },
        firstProviderAttemptAt: new Date(NOW.getTime() - 60_000),
    });
    const state = memoryDatabase([bill, client]);
    state.invoice.client.email = "changed-after-provider-start@example.com";
    state.settings.notificationEmail = null;
    state.settings.email = "changed-after-provider-start@example.com";
    state.settings.companyName = "Renamed After Provider Start";
    let mutablePreflights = 0;
    const sends: Array<{ dispatch: FrozenNotification; key: string }> = [];

    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async () => {
            mutablePreflights++;
            throw new Error("a frozen recovery must not rerun mutable preflight");
        },
        sendFrozenNotification: async (dispatch, key) => {
            sends.push({ dispatch, key });
            return { success: true, id: "resend-recovered" };
        },
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.equal(mutablePreflights, 0);
    assert.deepEqual(sends, [{ dispatch: persisted, key: client.idempotencyKey }]);
    assert.deepEqual([...state.stampedSchedules.keys()], ["m-1", "m-2"]);
    assert.equal(client.providerMessageId, "resend-recovered");
});

test("CLIENT frozen recovery rejects drift between its checkpoint metadata and the billing result", async () => {
    const persisted = frozen("Previously attempted exact request");
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", invoiceCode: "INV-1", milestoneIds: ["m-1"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL", {
        payload: {
            invoiceId: "invoice-1",
            milestoneIds: ["m-1", "m-2"],
            milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
            milestones: EXACT_MILESTONE_STATES,
            dispatch: persisted,
        },
        firstProviderAttemptAt: new Date(NOW.getTime() - 60_000),
    });
    const state = memoryDatabase([bill, client]);
    let sends = 0;

    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendFrozenNotification: async () => {
            sends++;
            return { success: true, id: "must-not-send" };
        },
    });

    assert.equal(result.kind, "needs-attention");
    assert.equal(sends, 0);
    assert.match("error" in result ? result.error : "", /checkpoint.*billing result/i);
});

test("CLIENT preserves its checkpoint and key after an ambiguous provider outcome", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", milestoneIds: ["m-1"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL");
    const state = memoryDatabase([bill, client]);
    const sends: Array<{ dispatch: FrozenNotification; key: string }> = [];
    const candidate = frozen("Frozen once");

    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async (invoiceId, ids, _override, _opts, _actor, automation) => {
            const dispatch = await automation!.persistFrozenNotification(candidate);
            const provider = await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
            assert.equal(provider.success, true, "the executor defers the real provider call until exact IDs are exposed");
            try {
                await automation!.completeAfterDelivery({
                    invoiceId,
                    scheduleIds: [...ids],
                    recipient: dispatch.to[0],
                    sentAt: NOW,
                    providerMessageId: provider.id,
                    milestoneFingerprint: JSON.stringify({ invoiceId, milestones: [EXACT_MILESTONE_STATES[0]] }),
                    milestones: [EXACT_MILESTONE_STATES[0]],
                });
            } catch (error) {
                return {
                    success: true,
                    sent: 1,
                    failed: 0,
                    skipped: 0,
                    deliveredButUnrecorded: true,
                    results: [{ id: ids[0], name: ids[0], status: "sent" as const, sentTo: dispatch.to[0], error: (error as Error).message }],
                };
            }
            throw new Error("ambiguous provider result must not complete");
        },
        sendFrozenNotification: async (dispatch, key) => {
            sends.push({ dispatch, key });
            return { success: false, ambiguous: true };
        },
    });

    assert.equal(result.kind, "retry");
    assert.equal(client.status, "PROCESSING");
    assert.equal(client.firstProviderAttemptAt?.toISOString(), NOW.toISOString());
    assert.deepEqual((client.payload as Record<string, unknown>).dispatch, candidate);
    assert.deepEqual(sends, [{ dispatch: candidate, key: client.idempotencyKey }]);
    assert.equal(state.activities.length, 0);
});

test("CLIENT commits removal of the invoice fence after a definite provider rejection", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", milestoneIds: ["m-1", "m-2"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL");
    const state = memoryDatabase([bill, client]);

    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async (invoiceId, ids, _override, _opts, _actor, automation) => {
            const dispatch = await automation!.persistFrozenNotification(frozen("Rejected once"));
            await automation!.sendFrozenNotification!(dispatch, automation!.idempotencyKey);
            await assert.rejects(automation!.completeAfterDelivery({
                invoiceId,
                scheduleIds: ids,
                recipient: dispatch.to[0],
                sentAt: NOW,
                milestoneFingerprint: EXACT_MILESTONE_FINGERPRINT,
                milestones: EXACT_MILESTONE_STATES,
            }));
            return { success: false, sent: 0, failed: 2, skipped: 0, results: [], error: "provider rejected" };
        },
        sendFrozenNotification: async () => ({ success: false, ambiguous: false }),
    });

    assert.equal(result.kind, "retry");
    assert.equal(
        "retainFrozenPayloadForReconciliation" in result
            ? result.retainFrozenPayloadForReconciliation
            : undefined,
        false,
        "a conclusive rejection tells terminal exhaustion to redact the frozen bearer",
    );
    assert.equal(state.getInvoiceEmailAttempt(), null, "a definitive no-send must release the global invoice fence");
    assert.equal(state.stampedSchedules.size, 0);
});

test("email jobs stop automatically at the 24-hour provider-idempotency horizon", async () => {
    const bill = job("APPROVAL_BILL", {
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", milestoneIds: ["m-1"] },
    });
    const client = job("APPROVAL_CLIENT_EMAIL", {
        firstProviderAttemptAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
        payload: { dispatch: frozen("Old dispatch") },
    });
    const state = memoryDatabase([bill, client]);
    let sends = 0;
    const result = await executeApprovalAutomationJob(client as never, {
        db: state.db as never,
        now: () => NOW,
        sendMilestoneInvoices: async () => {
            sends++;
            throw new Error("must not call provider path");
        },
    });

    assert.equal(result.kind, "needs-attention");
    assert.equal(sends, 0);
});

test("TEAM freezes an honest manual-approval summary and completes with one stable provider key", async () => {
    const bill = job("APPROVAL_BILL", {
        approvalMode: "MANUAL",
        status: "SUCCEEDED",
        claimToken: null,
        result: { invoiceId: "invoice-1", milestoneIds: ["m-1"] },
    });
    const schedule = job("APPROVAL_SCHEDULE", {
        approvalMode: "MANUAL",
        status: "SKIPPED",
        claimToken: null,
        result: { reason: "No baseline schedule" },
    });
    const team = job("APPROVAL_TEAM_EMAIL", { approvalMode: "MANUAL" });
    const state = memoryDatabase([bill, schedule, team]);
    const sends: Array<{ dispatch: FrozenNotification; key: string }> = [];

    const result = await executeApprovalAutomationJob(team as never, {
        db: state.db as never,
        now: () => NOW,
        sendFrozenNotification: async (dispatch, key) => {
            sends.push({ dispatch, key });
            return { success: true, id: "team-resend-1" };
        },
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.equal(team.status, "SUCCEEDED");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].key, team.idempotencyKey);
    assert.deepEqual(sends[0].dispatch.to, ["ops@example.com", "owner@example.com"]);
    assert.match(sends[0].dispatch.text, /Billing: completed/i);
    assert.match(sends[0].dispatch.text, /Client payment request: suppressed.*manual/i);
    assert.match(sends[0].dispatch.text, /Schedule: skipped/i);
    assert.equal(team.providerMessageId, "team-resend-1");
    assert.equal(state.activities.filter(row => row.action === "notified_change_order_approval_team").length, 1);
});

test("TEAM rebuilds first-attempt recipients from locked settings after an unlocked-read race", async () => {
    const schedule = job("APPROVAL_SCHEDULE", { status: "SUCCEEDED", claimToken: null });
    const team = job("APPROVAL_TEAM_EMAIL", { approvalMode: "MANUAL" });
    const state = memoryDatabase([schedule, team]);
    const sends: FrozenNotification[] = [];
    state.raceHooks.afterSettingsRead = () => {
        state.settings.notificationEmail = "fresh-ops@example.com";
    };

    const result = await executeApprovalAutomationJob(team as never, {
        db: state.db as never,
        now: () => NOW,
        sendFrozenNotification: async dispatch => {
            sends.push(dispatch);
            return { success: true, id: "team-live-settings" };
        },
    });

    assert.deepEqual(result, { kind: "completed" });
    assert.deepEqual(sends.map(dispatch => dispatch.to), [["fresh-ops@example.com"]]);
    assert.deepEqual(
        ((team.payload as Record<string, unknown>).dispatchAudit as Record<string, unknown>).to,
        ["fresh-ops@example.com"],
    );
});

test("TEAM retries a checkpointed ambiguous dispatch even after notification settings are cleared", async () => {
    const schedule = job("APPROVAL_SCHEDULE", { status: "SUCCEEDED", claimToken: null });
    const team = job("APPROVAL_TEAM_EMAIL", { approvalMode: "MANUAL" });
    const state = memoryDatabase([schedule, team]);
    const sends: Array<{ dispatch: FrozenNotification; key: string }> = [];

    const first = await executeApprovalAutomationJob(team as never, {
        db: state.db as never,
        now: () => NOW,
        sendFrozenNotification: async (dispatch, key) => {
            sends.push({ dispatch, key });
            return { success: false, ambiguous: true };
        },
    });
    assert.equal(first.kind, "retry");
    const checkpointed = frozenDispatchForTest(team.payload);
    assert.ok(checkpointed);

    state.settings.notificationEmail = null;
    state.settings.email = null;
    const second = await executeApprovalAutomationJob(team as never, {
        db: state.db as never,
        now: () => new Date(NOW.getTime() + 60_000),
        sendFrozenNotification: async (dispatch, key) => {
            sends.push({ dispatch, key });
            return { success: true, id: "team-recovered" };
        },
    });

    assert.deepEqual(second, { kind: "completed" });
    assert.equal(team.status, "SUCCEEDED");
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[1], sends[0], "retry reuses the original recipients, bytes, and key");
    assert.equal(team.providerMessageId, "team-recovered");
});

function frozenDispatchForTest(payload: Record<string, unknown> | null): FrozenNotification | null {
    const value = payload?.dispatch;
    return value && typeof value === "object" ? value as FrozenNotification : null;
}

// Compile-time check: the seam remains injectable without weakening the public job API.
const _dependencyShape: ApprovalAutomationExecutionDependencies = {};
void _dependencyShape;
