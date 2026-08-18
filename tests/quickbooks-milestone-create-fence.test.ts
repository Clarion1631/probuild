import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    createQBAutomationSideEffectFence,
    createQBMilestoneInvoice,
    ensureQBCustomer,
    ensureQBServiceItem,
    findQBInvoiceByDocNumber,
    getQBInvoicePaymentLink,
    getQBInvoiceStatus,
    refreshQBToken,
    startQBAutomationSideEffectDeadline,
    type QBTokens,
} from "../src/lib/quickbooks";
import {
    buildMilestoneInvoiceRequestId,
    buildMilestoneInvoiceDocNumber,
    claimQBInvoiceUnlink,
    classifyMilestoneQboCreateRetry,
    classifyMilestoneInvoiceLink,
    freezeMilestoneQboCreatePayload,
    getMilestoneQboCreateFingerprintMismatch,
    getMilestoneQboAmountMismatch,
    linkMilestoneQboCreateResult,
    pushMilestoneToQuickBooks,
    recordMilestoneQbSyncIssueUnderInvoiceLock,
    refreshExistingMilestoneQboStateUnderInvoiceLock,
    reserveMilestoneQboCreateAttempt,
    unlinkQBInvoiceAfterProviderConfirmation,
} from "../src/lib/quickbooks-payments";

const tokens: QBTokens = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    realmId: "test-realm",
};

const invoiceInput = {
    docNumber: "INV-TEST-1",
    customerId: "customer-1",
    itemId: "item-1",
    description: "Deadline test milestone",
    amount: 1250,
    tax: null,
    billEmail: "client@example.com",
    privateNote: "ProBuild deadline regression",
};

test("sync health flags lock the canonical Invoice parent, re-read, and exact-CAS before mutating a milestone", async () => {
    const events: string[] = [];
    const schedule = {
        id: "schedule-sync-race",
        invoiceId: "invoice-sync-race",
        status: "Pending",
        qbInvoiceId: "qb-sync-race",
        qbSyncError: null as string | null,
    };
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join("?");
            if (sql.includes('FROM "Invoice"')) events.push("invoice-lock");
            if (sql.includes('FROM "InvoiceEmailAttempt"')) events.push("attempt-lock");
            return [];
        },
        paymentSchedule: {
            findUnique: async () => {
                events.push("schedule-reread");
                return { ...schedule };
            },
            updateMany: async ({ where, data }: {
                where: Record<string, unknown>;
                data: { qbSyncError: string };
            }) => {
                events.push("schedule-cas");
                assert.deepEqual(where, {
                    id: schedule.id,
                    invoiceId: schedule.invoiceId,
                    status: schedule.status,
                    qbInvoiceId: schedule.qbInvoiceId,
                    qbSyncError: null,
                });
                schedule.qbSyncError = data.qbSyncError;
                return { count: 1 };
            },
        },
    };

    const outcome = await recordMilestoneQbSyncIssueUnderInvoiceLock(tx as never, {
        scheduleId: schedule.id,
        invoiceId: schedule.invoiceId,
        qbInvoiceId: schedule.qbInvoiceId,
        state: "voided",
    });

    assert.equal(outcome, "newly-flagged");
    assert.deepEqual(events, ["invoice-lock", "attempt-lock", "schedule-reread", "schedule-cas"]);
    assert.equal(schedule.qbSyncError, "voided");

    const source = readFileSync("src/lib/quickbooks-payments.ts", "utf8");
    const syncStart = source.indexOf("export async function syncQuickBooksPayments(");
    const milestoneLoop = source.indexOf("for (const schedule of pending)", syncStart);
    const progressLoop = source.indexOf("for (const billing of pendingBillings)", milestoneLoop);
    const syncMilestones = source.slice(milestoneLoop, progressLoop);
    assert.match(syncMilestones, /prisma\.\$transaction[\s\S]*recordMilestoneQbSyncIssueUnderInvoiceLock/);
    assert.doesNotMatch(
        syncMilestones,
        /prisma\.paymentSchedule\.updateMany\([\s\S]*qbSyncError:\s*probe\.state/,
        "sync must not update QBO health outside the canonical Invoice transaction",
    );
});

test("existing-link refresh locks Invoice and exact-CASes QBO id, generation, link, and health", async () => {
    const events: string[] = [];
    const schedule = {
        id: "schedule-refresh-race",
        invoiceId: "invoice-refresh-race",
        status: "Pending",
        qbInvoiceId: "qb-refresh-race",
        qbCreateGeneration: 4,
        qbInvoiceLink: null as string | null,
        qbSyncError: "voided" as string | null,
    };
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join("?");
            if (sql.includes('FROM "Invoice"')) events.push("invoice-lock");
            if (sql.includes('FROM "InvoiceEmailAttempt"')) events.push("attempt-lock");
            return [];
        },
        paymentSchedule: {
            findUnique: async () => {
                events.push("schedule-reread");
                return { ...schedule };
            },
            updateMany: async ({ where, data }: {
                where: Record<string, unknown>;
                data: { qbInvoiceLink?: string; qbSyncError?: null };
            }) => {
                events.push("schedule-cas");
                assert.deepEqual(where, {
                    id: schedule.id,
                    invoiceId: schedule.invoiceId,
                    status: schedule.status,
                    qbInvoiceId: schedule.qbInvoiceId,
                    qbCreateGeneration: schedule.qbCreateGeneration,
                    qbInvoiceLink: schedule.qbInvoiceLink,
                    qbSyncError: schedule.qbSyncError,
                });
                Object.assign(schedule, data);
                return { count: 1 };
            },
        },
    };

    const outcome = await refreshExistingMilestoneQboStateUnderInvoiceLock(tx as never, {
        scheduleId: schedule.id,
        invoiceId: schedule.invoiceId,
        expectedQbInvoiceId: schedule.qbInvoiceId,
        expectedGeneration: schedule.qbCreateGeneration,
        expectedQbInvoiceLink: schedule.qbInvoiceLink,
        expectedQbSyncError: schedule.qbSyncError,
        payLink: "https://payments.example/refreshed",
        providerReachable: true,
    });

    assert.equal(outcome, "updated");
    assert.deepEqual(events, ["invoice-lock", "attempt-lock", "schedule-reread", "schedule-cas"]);
    assert.equal(schedule.qbInvoiceLink, "https://payments.example/refreshed");
    assert.equal(schedule.qbSyncError, null);
});

test("an expired operation fence prevents the milestone invoice POST from starting", async () => {
    const originalFetch = globalThis.fetch;
    const operation = new AbortController();
    operation.abort(new Error("automation QBO deadline expired"));
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ Invoice: { Id: "qb-invoice-1", TotalAmt: 1250 } });
    };

    try {
        await assert.rejects(
            createQBMilestoneInvoice(tokens, invoiceInput, {
                signal: operation.signal,
            }),
            /automation QBO deadline expired/,
        );
        assert.equal(fetchCalls, 0, "an expired lease fence must block the irreversible QBO create");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a retried milestone create sends the same QBO requestid", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
        urls.push(String(input));
        return Response.json({ Invoice: { Id: "qb-invoice-1", TotalAmt: 1250 } });
    };

    try {
        const options = { requestId: "milestone-request/1" };
        const first = await createQBMilestoneInvoice(tokens, invoiceInput, options);
        const retry = await createQBMilestoneInvoice(tokens, invoiceInput, options);

        assert.equal(first.qbId, "qb-invoice-1");
        assert.equal(retry.qbId, "qb-invoice-1");
        assert.deepEqual(urls, [
            "https://quickbooks.api.intuit.com/v3/company/test-realm/invoice?requestid=milestone-request%2F1&minorversion=73",
            "https://quickbooks.api.intuit.com/v3/company/test-realm/invoice?requestid=milestone-request%2F1&minorversion=73",
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("milestone requestids stay stable within a generation and rotate after an explicit reset", () => {
    const firstAttempt = buildMilestoneInvoiceRequestId("schedule-1", 0);
    const retry = buildMilestoneInvoiceRequestId("schedule-1", 0);
    const resetAttempt = buildMilestoneInvoiceRequestId("schedule-1", 1);
    const differentSchedule = buildMilestoneInvoiceRequestId("schedule-2", 0);

    assert.equal(retry, firstAttempt, "a retry of the same logical create must reuse its key");
    assert.notEqual(resetAttempt, firstAttempt, "an authoritative reset must get a fresh QBO create key");
    assert.notEqual(differentSchedule, firstAttempt);
    assert.match(firstAttempt, /^[a-f0-9]{50}$/, "QBO requestids are capped at 50 characters");
});

test("milestone DocNumbers are opaque, stable within a generation, and rotate on reset", () => {
    const first = buildMilestoneInvoiceDocNumber("schedule-1", 0);
    assert.equal(buildMilestoneInvoiceDocNumber("schedule-1", 0), first);
    assert.notEqual(buildMilestoneInvoiceDocNumber("schedule-1", 1), first);
    assert.notEqual(buildMilestoneInvoiceDocNumber("schedule-2", 0), first);
    assert.match(first, /^PB-[A-F0-9]{18}$/);
    assert.equal(first.length, 21);
});

test("the frozen create fingerprint covers money and every non-money QBO payload input", () => {
    const base = {
        ...invoiceInput,
        amount: 100,
        tax: { preTaxAmount: 90, taxAmount: 10 },
        txnDate: "2026-08-17",
        dueDate: new Date("2026-09-01T00:00:00.000Z"),
    };
    const snapshot = freezeMilestoneQboCreatePayload(base);
    const same = freezeMilestoneQboCreatePayload({ ...base, dueDate: new Date(base.dueDate) });
    assert.deepEqual(same, snapshot);

    const variants = [
        { ...base, amount: 101 },
        { ...base, name: "ignored", description: "Renamed milestone" },
        { ...base, dueDate: new Date("2026-09-02T00:00:00.000Z") },
        { ...base, customerId: "customer-2" },
        { ...base, itemId: "item-2" },
        { ...base, tax: { preTaxAmount: 89, taxAmount: 11 } },
        { ...base, billEmail: "changed@example.com" },
    ];
    for (const variant of variants) {
        const changed = freezeMilestoneQboCreatePayload(variant);
        assert.notEqual(changed.fingerprint, snapshot.fingerprint);
    }
    assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(typeof snapshot.payload, "string");
});

type AttemptRow = {
    id: string;
    invoiceId: string;
    status: string;
    qbPaymentId: string | null;
    qbInvoiceId: string | null;
    qbInvoiceLink: string | null;
    qbSyncedAt: Date | null;
    qbSyncError: string | null;
    qbCreateGeneration: number;
    qbCreateRequestId: string | null;
    qbCreateFingerprint: string | null;
    qbCreateStartedAt: Date | null;
};

function fakeAttemptClient(initial: AttemptRow) {
    const row = { ...initial };
    let updates = 0;
    const lockEvents: string[] = [];
    let lastUpdateWhere: Record<string, unknown> | null = null;
    const paymentSchedule = {
            findUnique: async () => ({ ...row }),
            updateMany: async ({ where, data }: {
                where: Partial<AttemptRow>;
                data: Partial<AttemptRow> & { qbCreateGeneration?: number | { increment: number } };
            }) => {
                for (const [key, expected] of Object.entries(where)) {
                    if (key === "status" && typeof expected === "object") continue;
                    if (row[key as keyof AttemptRow] !== expected) return { count: 0 };
                }
                updates += 1;
                lockEvents.push("local-cas");
                lastUpdateWhere = { ...where };
                for (const [key, value] of Object.entries(data)) {
                    if (
                        key === "qbCreateGeneration"
                        && typeof value === "object"
                        && value !== null
                        && "increment" in value
                        && typeof value.increment === "number"
                    ) {
                        row.qbCreateGeneration += value.increment;
                    } else {
                        Object.assign(row, { [key]: value });
                    }
                }
                return { count: 1 };
            },
        };
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join("?");
            if (sql.includes('FROM "Invoice"')) lockEvents.push("invoice-lock");
            if (sql.includes('FROM "InvoiceEmailAttempt"')) lockEvents.push("attempt-lock");
            return [];
        },
        paymentSchedule,
    };
    const client = {
        ...tx,
        $transaction: async <T>(fn: (transaction: typeof tx) => Promise<T>) => {
            lockEvents.push("transaction");
            return fn(tx);
        },
    };
    return {
        client: client as unknown as Parameters<typeof reserveMilestoneQboCreateAttempt>[0]
            & Parameters<typeof unlinkQBInvoiceAfterProviderConfirmation>[0],
        row,
        updateCount: () => updates,
        lockEvents,
        lastUpdateWhere: () => lastUpdateWhere,
    };
}

function freshAttemptRow(id: string): AttemptRow {
    return {
        id,
        invoiceId: `invoice-${id}`,
        status: "Pending",
        qbPaymentId: null,
        qbInvoiceId: null,
        qbInvoiceLink: null,
        qbSyncedAt: null,
        qbSyncError: null,
        qbCreateGeneration: 0,
        qbCreateRequestId: null,
        qbCreateFingerprint: null,
        qbCreateStartedAt: null,
    };
}

test("a durable create reservation keeps its $100 lifecycle identity after a local $200 edit", async () => {
    const db = fakeAttemptClient(freshAttemptRow("schedule-durable"));
    const original = freezeMilestoneQboCreatePayload({
        ...invoiceInput,
        amount: 100,
        txnDate: "2026-08-17",
    });
    const edited = freezeMilestoneQboCreatePayload({
        ...invoiceInput,
        amount: 200,
        txnDate: "2026-08-17",
    });

    const first = await reserveMilestoneQboCreateAttempt(db.client, "schedule-durable", original);
    const retry = await reserveMilestoneQboCreateAttempt(db.client, "schedule-durable", edited);

    assert.equal(db.updateCount(), 1, "only the first attempt may write the durable create identity");
    assert.equal(retry.requestId, first.requestId);
    assert.equal(retry.fingerprint, first.fingerprint);
    assert.equal(retry.mismatch?.frozenFingerprint, original.fingerprint);
    assert.equal(retry.mismatch?.currentFingerprint, edited.fingerprint);
    assert.equal(retry.mismatch?.code, "QBO_CREATE_FINGERPRINT_MISMATCH");
    assert.equal(retry.mismatch?.requiresAttention, true);
});

test("same-total non-money drift keeps the original request identity and requires attention", async () => {
    const db = fakeAttemptClient(freshAttemptRow("schedule-non-money"));
    const original = freezeMilestoneQboCreatePayload({
        ...invoiceInput,
        amount: 100,
        txnDate: "2026-08-17",
        dueDate: new Date("2026-09-01T00:00:00.000Z"),
    });
    const renamedAndRetargeted = freezeMilestoneQboCreatePayload({
        ...invoiceInput,
        amount: 100,
        description: "Renamed milestone",
        customerId: "customer-2",
        itemId: "item-2",
        txnDate: "2026-08-17",
        dueDate: new Date("2026-09-02T00:00:00.000Z"),
    });

    const first = await reserveMilestoneQboCreateAttempt(db.client, "schedule-non-money", original);
    const retry = await reserveMilestoneQboCreateAttempt(db.client, "schedule-non-money", renamedAndRetargeted);

    assert.equal(retry.requestId, first.requestId);
    assert.deepEqual(
        getMilestoneQboCreateFingerprintMismatch(original, renamedAndRetargeted)?.changedFields,
        ["customerId", "description", "dueDate", "itemId"],
    );
    assert.equal(retry.mismatch?.requiresAttention, true);
});

test("breaking a durable QBO link clears the frozen lifecycle and rotates its next requestid", async () => {
    const oldRequestId = buildMilestoneInvoiceRequestId("schedule-reset", 0);
    const original = freezeMilestoneQboCreatePayload({
        ...invoiceInput,
        amount: 100,
        txnDate: "2026-08-17",
    });
    const db = fakeAttemptClient({
        ...freshAttemptRow("schedule-reset"),
        qbInvoiceId: "qb-invoice-old",
        qbInvoiceLink: "https://payments.example/old",
        qbSyncedAt: new Date("2026-08-17T12:00:00.000Z"),
        qbSyncError: "voided",
        qbCreateRequestId: oldRequestId,
        qbCreateFingerprint: original.fingerprint,
        qbCreateStartedAt: new Date("2026-08-17T11:00:00.000Z"),
    });

    const cleared = await claimQBInvoiceUnlink(
        db.client as unknown as Parameters<typeof claimQBInvoiceUnlink>[0],
        "schedule-reset",
        "qb-invoice-old",
    );

    assert.equal(cleared, true);
    assert.equal(db.row.qbInvoiceId, null);
    assert.equal(db.row.qbCreateGeneration, 1);
    assert.equal(db.row.qbCreateRequestId, null);
    assert.equal(db.row.qbCreateFingerprint, null);
    assert.equal(db.row.qbCreateStartedAt, null);
    assert.notEqual(buildMilestoneInvoiceRequestId("schedule-reset", db.row.qbCreateGeneration), oldRequestId);
    assert.deepEqual(db.lockEvents, ["transaction", "invoice-lock", "attempt-lock", "local-cas"]);
    assert.equal(db.lastUpdateWhere()?.invoiceId, db.row.invoiceId);
    assert.equal(db.lastUpdateWhere()?.qbCreateGeneration, 0);
});

function linkedAttemptRow(id: string): AttemptRow {
    const snapshot = freezeMilestoneQboCreatePayload({
        ...invoiceInput,
        docNumber: buildMilestoneInvoiceDocNumber(id, 0),
        txnDate: "2026-08-17",
    });
    return {
        ...freshAttemptRow(id),
        qbInvoiceId: "qb-invoice-live",
        qbInvoiceLink: "https://payments.example/live",
        qbCreateRequestId: buildMilestoneInvoiceRequestId(id, 0),
        qbCreateFingerprint: snapshot.fingerprint,
        qbCreateStartedAt: new Date("2026-08-17T11:00:00.000Z"),
    };
}

test("unlink with provider deletion disabled keeps a live QBO link and generation fenced", async () => {
    const db = fakeAttemptClient(linkedAttemptRow("schedule-live-no-delete"));
    let deleteCalls = 0;
    const result = await unlinkQBInvoiceAfterProviderConfirmation(
        db.client,
        tokens,
        {
            paymentScheduleId: db.row.id,
            qbInvoiceId: "qb-invoice-live",
            deleteInQBO: false,
        },
        {
            probe: async () => ({ state: "ok", balance: 100, total: 100, paymentTxnIds: [] }),
            remove: async () => {
                deleteCalls += 1;
                return true;
            },
        },
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "live-invoice");
    assert.equal(deleteCalls, 0);
    assert.equal(db.updateCount(), 0);
    assert.equal(db.row.qbInvoiceId, "qb-invoice-live");
    assert.equal(db.row.qbCreateGeneration, 0);
    assert.ok(db.row.qbCreateRequestId);
});

test("failed provider deletion leaves the link and durable generation untouched", async () => {
    const db = fakeAttemptClient(linkedAttemptRow("schedule-delete-failed"));
    let probeCalls = 0;
    const result = await unlinkQBInvoiceAfterProviderConfirmation(
        db.client,
        tokens,
        {
            paymentScheduleId: db.row.id,
            qbInvoiceId: "qb-invoice-live",
            deleteInQBO: true,
        },
        {
            probe: async () => {
                probeCalls += 1;
                return { state: "ok", balance: 100, total: 100, paymentTxnIds: [] };
            },
            remove: async () => false,
        },
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "delete-failed");
    assert.equal(probeCalls, 2, "a failed delete must be re-probed before deciding it is still live");
    assert.equal(db.updateCount(), 0);
    assert.equal(db.row.qbInvoiceId, "qb-invoice-live");
    assert.equal(db.row.qbCreateGeneration, 0);
    assert.ok(db.row.qbCreateRequestId);
});

test("an authoritative void permits one atomic local clear and generation rotation", async () => {
    const db = fakeAttemptClient(linkedAttemptRow("schedule-already-voided"));
    let deleteCalls = 0;
    const result = await unlinkQBInvoiceAfterProviderConfirmation(
        db.client,
        tokens,
        {
            paymentScheduleId: db.row.id,
            qbInvoiceId: "qb-invoice-live",
            deleteInQBO: false,
        },
        {
            probe: async () => {
                db.lockEvents.push("provider-probe");
                return { state: "voided" };
            },
            remove: async () => {
                deleteCalls += 1;
                return true;
            },
        },
    );

    assert.deepEqual(result, { ok: true, providerState: "already-gone" });
    assert.equal(deleteCalls, 0);
    assert.equal(db.row.qbInvoiceId, null);
    assert.equal(db.row.qbCreateGeneration, 1);
    assert.equal(db.row.qbCreateRequestId, null);
    assert.deepEqual(db.lockEvents, [
        "transaction",
        "invoice-lock",
        "attempt-lock",
        "provider-probe",
        "local-cas",
    ], "the Invoice fence must be acquired before the destructive provider decision and held through rotation");
});

test("an accepted $100 create is query-recovered after a local $200 edit without a second invoice", async () => {
    const originalFetch = globalThis.fetch;
    const providerInvoices = new Map<string, { Id: string; TotalAmt: number; DocNumber: string; requestBody: string }>();
    let providerCreates = 0;
    let providerQueries = 0;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/query")) {
            providerQueries += 1;
            const query = url.searchParams.get("query") ?? "";
            const docNumber = /DocNumber\s*=\s*'([^']+)'/.exec(query)?.[1];
            const invoice = [...providerInvoices.values()].find(candidate => candidate.DocNumber === docNumber);
            return Response.json({ QueryResponse: { Invoice: invoice ? [invoice] : [] } });
        }
        const requestId = url.searchParams.get("requestid");
        assert.ok(requestId, "invoice creates must carry a requestid");
        let invoice = providerInvoices.get(requestId);
        const requestBody = String(init?.body);
        if (!invoice) {
            const body = JSON.parse(requestBody);
            providerCreates += 1;
            invoice = {
                Id: `qb-invoice-${providerCreates}`,
                TotalAmt: Number(body.Line[0].Amount),
                DocNumber: String(body.DocNumber),
                requestBody,
            };
            providerInvoices.set(requestId, invoice);
        } else if (invoice.requestBody !== requestBody) {
            return Response.json(
                { Fault: { Error: [{ code: "600", Message: "Duplicate Request ID" }] } },
                { status: 400 },
            );
        }
        return Response.json({ Invoice: invoice });
    };

    try {
        const db = fakeAttemptClient(freshAttemptRow("schedule-ambiguous"));
        const docNumber = buildMilestoneInvoiceDocNumber("schedule-ambiguous", 0);
        const initial = { ...invoiceInput, docNumber, amount: 100, txnDate: "2026-08-17" };
        const edited = { ...initial, amount: 200 };
        const initialSnapshot = freezeMilestoneQboCreatePayload(initial);
        const editedSnapshot = freezeMilestoneQboCreatePayload(edited);
        const firstAttempt = await reserveMilestoneQboCreateAttempt(
            db.client,
            "schedule-ambiguous",
            initialSnapshot,
        );

        const acceptedButUnlinked = await createQBMilestoneInvoice(tokens, initial, {
            requestId: firstAttempt.requestId,
        });
        const retryAttempt = await reserveMilestoneQboCreateAttempt(
            db.client,
            "schedule-ambiguous",
            editedSnapshot,
        );
        await assert.rejects(
            createQBMilestoneInvoice(tokens, edited, { requestId: retryAttempt.requestId }),
            /Duplicate Request ID|code.*600/i,
            "the fake provider must reject the unsafe changed-body replay",
        );
        const retryDecision = classifyMilestoneQboCreateRetry(retryAttempt, null);
        assert.equal(retryDecision.action, "needs-attention");
        const recoveredAfterEdit = await findQBInvoiceByDocNumber(tokens, docNumber);
        assert.ok(recoveredAfterEdit);
        const recoveredDecision = classifyMilestoneQboCreateRetry(retryAttempt, recoveredAfterEdit);
        assert.equal(recoveredDecision.action, "link");
        const linked = await linkMilestoneQboCreateResult(db.client, {
            paymentScheduleId: "schedule-ambiguous",
            attempt: retryAttempt,
            qbInvoiceId: recoveredAfterEdit.qbId,
            qbInvoiceLink: "https://payments.example/original",
            current: editedSnapshot,
            claimedByProgressBilling: false,
        });

        assert.equal(firstAttempt.requestId, retryAttempt.requestId);
        assert.equal(acceptedButUnlinked.qbId, "qb-invoice-1");
        assert.equal(recoveredAfterEdit.qbId, "qb-invoice-1");
        assert.equal(recoveredAfterEdit.total, 100, "the query must recover QBO's original total");
        assert.equal(linked.decision, "claim");
        assert.equal(linked.mismatch?.code, "QBO_CREATE_FINGERPRINT_MISMATCH");
        assert.equal(db.row.qbInvoiceId, "qb-invoice-1", "the recovered original must be durably linked");
        assert.equal(db.row.qbInvoiceLink, null, "a stale payment link must stay hidden until review");
        assert.equal(providerCreates, 1, "the edited retry must not create a second collectible invoice");
        assert.equal(providerQueries, 1, "recovery must query the stable DocNumber before retrying");
        assert.equal(providerInvoices.size, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("a changed attempt with no stable-DocNumber match fails needs-attention without a POST", () => {
    const original = freezeMilestoneQboCreatePayload({ ...invoiceInput, amount: 100, txnDate: "2026-08-17" });
    const edited = freezeMilestoneQboCreatePayload({ ...invoiceInput, amount: 200, txnDate: "2026-08-17" });
    const attempt = {
        generation: 0,
        requestId: buildMilestoneInvoiceRequestId("schedule-no-match", 0),
        fingerprint: original.fingerprint,
        startedAt: new Date("2026-08-17T00:00:00.000Z"),
        qbInvoiceId: null,
        isNew: false,
        mismatch: getMilestoneQboCreateFingerprintMismatch(original, edited),
    };
    let providerPosts = 0;
    const decision = classifyMilestoneQboCreateRetry(attempt, null);
    if (decision.action === "create") providerPosts += 1;

    assert.equal(decision.action, "needs-attention");
    assert.equal(decision.mismatch?.requiresAttention, true);
    assert.equal(providerPosts, 0);
});

test("a replayed original total produces a typed needs-attention mismatch", () => {
    const mismatch = getMilestoneQboAmountMismatch(200, 100);
    assert.deepEqual(mismatch, {
        code: "QBO_TOTAL_MISMATCH",
        expectedAmount: 200,
        qbTotal: 100,
        requiresAttention: true,
    });
    assert.equal(getMilestoneQboAmountMismatch(200, 200.04), undefined);
});

test("the idempotent milestone create sends its frozen transaction date", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ Invoice: { Id: "qb-invoice-1", TotalAmt: 1250 } });
    };

    try {
        await createQBMilestoneInvoice(
            tokens,
            { ...invoiceInput, txnDate: "2026-08-01" },
            { requestId: "milestone-request-1" },
        );
        assert.equal((requestBody as Record<string, unknown> | null)?.TxnDate, "2026-08-01");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("an aggregate QBO deadline aborts an in-flight milestone create", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async (_input, init) => {
        fetchCalls += 1;
        const signal = init?.signal;
        assert.ok(signal, "the aggregate deadline must reach the network request");
        return new Promise<Response>((_resolve, reject) => {
            const rejectFromAbort = () => reject(signal.reason);
            if (signal.aborted) rejectFromAbort();
            else signal.addEventListener("abort", rejectFromAbort, { once: true });
        });
    };

    // AbortSignal.timeout()'s internal timer is UNREF'D in Node: when the
    // mocked never-resolving fetch is the only pending work, the event loop
    // drains before the 20ms abort fires and node:test kills the run with
    // "Promise resolution is still pending" (flaked twice on CI). A ref'd
    // timer keeps the loop alive until the deadline can actually fire.
    const keepEventLoopAlive = setTimeout(() => {}, 10_000);
    try {
        const signal = startQBAutomationSideEffectDeadline(20);
        await assert.rejects(
            createQBMilestoneInvoice(
                tokens,
                { ...invoiceInput, txnDate: "2026-08-01" },
                { signal, requestId: "milestone-request-1" },
            ),
            (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
        );
        assert.equal(fetchCalls, 1);
    } finally {
        clearTimeout(keepEventLoopAlive);
        globalThis.fetch = originalFetch;
    }
});

test("the aggregate fence rejects a create after wall-clock expiry even before its timer fires", () => {
    let now = 1_000;
    const fence = createQBAutomationSideEffectFence({ timeoutMs: 100, now: () => now });
    fence.throwIfExpired();
    now = 1_100;
    assert.throws(
        () => fence.throwIfExpired(),
        (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
    );
});

test("a milestone push checks its operation fence before any database or QBO work", async () => {
    const operation = new AbortController();
    operation.abort(new Error("milestone push aggregate deadline expired"));

    await assert.rejects(
        pushMilestoneToQuickBooks("not-a-real-schedule", tokens, { signal: operation.signal }),
        /milestone push aggregate deadline expired/,
    );
});

test("the aggregate fence also stops prerequisite QBO customer resolution", async () => {
    const originalFetch = globalThis.fetch;
    const operation = new AbortController();
    operation.abort(new Error("customer resolution aggregate deadline expired"));
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ QueryResponse: {} });
    };

    try {
        await assert.rejects(
            ensureQBCustomer(
                tokens,
                { name: "Deadline Test Client", email: "client@example.com", qbCustomerId: null },
                { signal: operation.signal },
            ),
            /customer resolution aggregate deadline expired/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("the aggregate fence also stops prerequisite QBO service-item resolution", async () => {
    const originalFetch = globalThis.fetch;
    const operation = new AbortController();
    operation.abort(new Error("service item aggregate deadline expired"));
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ QueryResponse: {} });
    };

    try {
        await assert.rejects(
            ensureQBServiceItem(tokens, { signal: operation.signal }),
            /service item aggregate deadline expired/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("the aggregate fence stops milestone invoice readbacks", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ Invoice: { Id: "qb-invoice-1", TotalAmt: 1250, Balance: 1250 } });
    };

    try {
        for (const readback of [getQBInvoicePaymentLink, getQBInvoiceStatus]) {
            const operation = new AbortController();
            operation.abort(new Error("invoice readback aggregate deadline expired"));
            await assert.rejects(
                readback(tokens, "qb-invoice-1", { signal: operation.signal }),
                /invoice readback aggregate deadline expired/,
            );
        }
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("the aggregate fence stops token refresh before its network request", async () => {
    const originalFetch = globalThis.fetch;
    const operation = new AbortController();
    operation.abort(new Error("token refresh aggregate deadline expired"));
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return Response.json({ access_token: "fresh", refresh_token: "rotated" });
    };

    try {
        await assert.rejects(
            refreshQBToken("old-refresh-token", { signal: operation.signal }),
            /token refresh aggregate deadline expired/,
        );
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("concurrent idempotent invoice replays preserve the QBO invoice another worker linked", () => {
    const expected = {
        amount: 1250,
        name: "Deposit",
        dueDate: new Date("2026-09-01T00:00:00.000Z"),
        qbInvoiceId: "qb-invoice-1",
    };
    const pending = {
        status: "Pending",
        qbPaymentId: null,
        qbInvoiceId: null,
        amount: 1250,
        name: "Deposit",
        dueDate: new Date(expected.dueDate),
    };

    assert.equal(classifyMilestoneInvoiceLink({ current: pending, expected, claimedByProgressBilling: false }), "claim");
    assert.equal(
        classifyMilestoneInvoiceLink({
            current: { ...pending, qbInvoiceId: "qb-invoice-1" },
            expected,
            claimedByProgressBilling: false,
        }),
        "reuse",
        "the losing worker must reuse, not compensate-delete, the same requestid result",
    );
    assert.equal(
        classifyMilestoneInvoiceLink({
            current: { ...pending, status: "Paid", qbPaymentId: "qb-payment-1", qbInvoiceId: "qb-invoice-1" },
            expected,
            claimedByProgressBilling: false,
        }),
        "preserve-conflict",
        "a settled invoice is owned and must never be compensation-deleted",
    );
    assert.equal(
        classifyMilestoneInvoiceLink({ current: pending, expected, claimedByProgressBilling: true }),
        "compensate-conflict",
    );
});
