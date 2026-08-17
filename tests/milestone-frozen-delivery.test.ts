import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { FrozenNotification } from "../src/lib/email";
import { mintPreviewToken, verifyPreviewToken } from "../src/lib/mcp-preview-token";
import { InvoiceEmailDeliveryInProgressError, lockMoneyParents } from "../src/lib/tx-retry";

type MilestoneRecipientSet = {
    to: string[];
    cc: string[];
};

type CompleteEmailRecipientSet = MilestoneRecipientSet & {
    bcc: string[];
    from: string;
    replyTo: string;
};

type MilestoneAttemptState = {
    id: string;
    name: string;
    amount: number;
    status: string;
    qbInvoiceSentAt: string | null;
    qbInvoiceId: string;
    qbInvoiceLink: string | null;
    qbSyncError: string | null;
};

type DeliveryContext = {
    invoiceId: string;
    scheduleIds: string[];
    recipient: string;
};

type AutomationDelivery = {
    idempotencyKey: string;
    frozenNotification?: FrozenNotification;
    persistFrozenNotification: (candidate: FrozenNotification) => Promise<FrozenNotification>;
    sendFrozenNotification?: (
        dispatch: FrozenNotification,
        idempotencyKey: string,
    ) => Promise<{ success: boolean; id?: string; ambiguous?: boolean }>;
    completeAfterDelivery: (input: DeliveryContext & {
        sentAt: Date;
        providerMessageId?: string;
    }) => Promise<void>;
};

type DeliveryResult = {
    delivered: boolean;
    recorded: boolean;
    deliveredButUnrecorded?: boolean;
    deliveryAmbiguous?: boolean;
    providerMessageId?: string;
    error?: string;
};

type BillingCoreContract = {
    canonicalMilestoneRecipients?: (
        primaryEmail: string | null | undefined,
        additionalEmail: string | null | undefined,
    ) => MilestoneRecipientSet;
    milestoneRecipientConflictError?: (input: {
        expected?: MilestoneRecipientSet;
        current: MilestoneRecipientSet;
    }) => string | null;
    completeFrozenRecipientSet?: (input: {
        to?: string[];
        cc?: string[];
        bcc?: string[];
        from?: string;
        fromName?: string;
        replyTo?: string;
    }) => CompleteEmailRecipientSet;
    completeFrozenRecipientConflictError?: (input: {
        expected: Pick<FrozenNotification, "to" | "cc" | "bcc" | "from" | "replyTo">;
        current: CompleteEmailRecipientSet;
    }) => string | null;
    lockInvoiceDeliveryRecipientSet?: (
        tx: { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> },
        input: { clientId: string; overrideEmail?: string | null },
    ) => Promise<{ visible: MilestoneRecipientSet; complete: CompleteEmailRecipientSet }>;
    findChangeOrderInvoiceUnderEstimateLock?: (
        tx: {
            $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
            invoice: { findFirst: (args: unknown) => Promise<{ id: string; code: string; status: string } | null> };
        },
        co: { estimateId: string; projectId: string },
    ) => Promise<{ id: string; code: string; status: string } | null>;
    buildMilestoneSendPreviewPayload?: (input: {
        invoiceId: string;
        ids: string[];
        recipients: MilestoneRecipientSet;
        amounts: Array<[string, number]>;
        sentAt: Array<[string, string | null]>;
        milestones: Array<[string, string, number, string, string | null]>;
        reconcile: Array<[string, number]>;
        allowResend: boolean;
    }) => string;
    milestoneSendFinancialFingerprint?: (input: {
        invoiceId: string;
        milestones: Array<[string, string, number, string, string | null]>;
    }) => string;
    milestoneFinancialConflictError?: (input: {
        expected?: string;
        invoiceId: string;
        milestones: Array<[string, string, number, string, string | null]>;
    }) => string | null;
    manualMilestoneAttemptAdoptionError?: (input: {
        requestedIds: readonly string[];
        requestedRecipients: MilestoneRecipientSet;
        frozenIds: readonly string[];
        frozenRecipients: MilestoneRecipientSet;
        providerStarted: boolean;
    }) => string | null;
    milestoneDeliveryFingerprint?: (invoiceId: string, milestones: MilestoneAttemptState[]) => string;
    milestoneDeliveryStateConflictError?: (input: {
        expectedFingerprint: string;
        invoiceId: string;
        current: MilestoneAttemptState[];
    }) => string | null;
    paymentScheduleHasProviderOrPaymentEvidence?: (row: {
        status?: string | null;
        qbCreateRequestId?: string | null;
        qbCreateFingerprint?: string | null;
        qbCreateStartedAt?: Date | null;
    }) => boolean;
    invoiceHasAuditEvidence?: (input: {
        status: string;
        sentAt?: Date | null;
        viewedAt?: Date | null;
        qbInvoiceId?: string | null;
        qbSyncedAt?: Date | null;
        hasEmailAttempt?: boolean;
        progressBillingCount?: number;
        payments: Array<{
            status?: string | null;
            qbCreateRequestId?: string | null;
            qbCreateFingerprint?: string | null;
            qbCreateStartedAt?: Date | null;
        }>;
    }) => boolean;
    invoiceCompensationSnapshotMatches?: (input: {
        estimateId: string;
        createdPaymentIds: readonly string[];
        invoice: {
            estimateId?: string | null;
            status: string;
            progressBillingCount?: number;
            payments: Array<{ id: string; status?: string | null; qbCreateRequestId?: string | null }>;
        };
    }) => boolean;
    matchExistingChangeOrderMilestones?: (
        plans: ReadonlyArray<{ sourceCoScheduleId: string | null; name: string; totalCents: number }>,
        existing: ReadonlyArray<{ id: string; sourceCoScheduleId: string | null; name: string; amount: number }>,
    ) => { ok: true; existingIds: Array<string | null> } | { ok: false; error: string };
    buildInvoiceResendPreviewPayload?: (input: {
        invoiceId: string;
        recipients: MilestoneRecipientSet;
        invoice: {
            code: string;
            status: string;
            total: number;
            balanceDue: number;
            sentAt: string | null;
        };
        milestones: Array<{
            id: string;
            name: string;
            amount: number;
            status: string;
            qbInvoiceId: string | null;
            qbInvoiceSentAt: string | null;
            qbSyncError: string | null;
        }>;
    }) => string;
    invoiceSendFinancialFingerprint?: (input: {
        invoiceId: string;
        code: string;
        status: string;
        totalAmount: number;
        balanceDue: number;
        payments: Array<{
            id: string;
            name: string;
            amount: number;
            status: string;
            dueDate: string | null;
            qbInvoiceSentAt: string | null;
        }>;
    }) => string;
    milestoneAutomationPreflightError?: (input: {
        requestedIds: readonly string[];
        expectedIds: readonly string[];
        milestones: Array<{ id: string; status: string; qbInvoiceSentAt: Date | null }>;
        recipient: string;
    }) => string | null;
    deliverMilestoneFrozenNotification?: (
        candidate: FrozenNotification,
        context: DeliveryContext,
        automation: AutomationDelivery,
    ) => Promise<DeliveryResult>;
    buildMilestoneFrozenNotification?: (input: {
        companyName: string;
        companyEmail?: string | null;
        notificationEmail?: string | null;
        clientName?: string | null;
        projectName?: string | null;
        invoiceCode: string;
        milestones: Array<{ name: string; amount: number }>;
        portalUrl: string;
        recipients: MilestoneRecipientSet;
    }) => FrozenNotification;
};

async function billingContract(): Promise<Required<BillingCoreContract>> {
    const mod = await import("../src/lib/billing-core") as unknown as BillingCoreContract;
    assert.equal(
        typeof mod.deliverMilestoneFrozenNotification,
        "function",
        "billing-core must export the durable frozen-delivery helper",
    );
    assert.equal(
        typeof mod.buildMilestoneFrozenNotification,
        "function",
        "billing-core must export the complete milestone notification builder",
    );
    return mod as Required<BillingCoreContract>;
}

function frozen(subject: string): FrozenNotification {
    return {
        from: "GTR <notifications@goldentouchremodeling.com>",
        to: ["client@example.test"],
        replyTo: "office@example.test",
        subject,
        html: `<p>${subject}</p>`,
        text: subject,
        cc: ["backup@example.test"],
        bcc: ["audit@example.test"],
    };
}

test("the milestone builder freezes every provider-visible field", async () => {
    const { buildMilestoneFrozenNotification } = await billingContract();

    const dispatch = buildMilestoneFrozenNotification({
        companyName: "Golden Touch\r\nInjected",
        companyEmail: " office@example.test ",
        notificationEmail: " Audit@example.test, client@example.test ",
        clientName: "Jane Client",
        projectName: "Kitchen",
        invoiceCode: "INV-100",
        milestones: [{ name: "Deposit", amount: 1250 }],
        portalUrl: "https://app.example.test/portal/invoices/inv-1?milestone=ms-1",
        recipients: {
            to: ["client@example.test"],
            cc: ["backup@example.test"],
        },
    });

    assert.deepEqual(dispatch.to, ["client@example.test"]);
    assert.deepEqual(dispatch.cc, ["backup@example.test"]);
    assert.deepEqual(dispatch.bcc, ["Audit@example.test"]);
    assert.equal(dispatch.from, "Golden Touch Injected <notifications@goldentouchremodeling.com>");
    assert.equal(dispatch.replyTo, "office@example.test");
    assert.match(dispatch.subject, /\$1,250\.00/);
    assert.match(dispatch.html, /milestone=ms-1/);
    assert.match(dispatch.text, /Amount Due Now/);
});

test("milestone previews canonicalize and HMAC-bind the complete To and Client.additionalEmail CC set", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.canonicalMilestoneRecipients, "function");
    assert.equal(typeof contract.buildMilestoneSendPreviewPayload, "function");
    assert.equal(typeof contract.milestoneSendFinancialFingerprint, "function");

    const recipients = contract.canonicalMilestoneRecipients(
        " Override@Example.Test ",
        " Backup@Example.Test ",
    );
    assert.deepEqual(recipients, {
        to: ["override@example.test"],
        cc: ["backup@example.test"],
    });
    assert.deepEqual(
        contract.canonicalMilestoneRecipients("client@example.test", " CLIENT@example.test "),
        { to: ["client@example.test"], cc: [] },
    );

    const basePayload = {
        invoiceId: "inv-recipient-binding",
        ids: ["milestone-1"],
        recipients,
        amounts: [["milestone-1", 1250]] as Array<[string, number]>,
        sentAt: [["milestone-1", null]] as Array<[string, string | null]>,
        milestones: [["milestone-1", "Deposit", 1250, "Pending", null]] as Array<[string, string, number, string, string | null]>,
        reconcile: [] as Array<[string, number]>,
        allowResend: false,
    };
    const secret = "disposable-milestone-recipient-secret";
    const signedPayload = contract.buildMilestoneSendPreviewPayload(basePayload);
    const token = mintPreviewToken(signedPayload, secret);

    assert.equal(verifyPreviewToken(token, signedPayload, secret), true);
    const changedCcPayload = contract.buildMilestoneSendPreviewPayload({
        ...basePayload,
        recipients: { ...recipients, cc: ["changed@example.test"] },
    });
    assert.equal(verifyPreviewToken(token, changedCcPayload, secret), false);
    const changedNamePayload = contract.buildMilestoneSendPreviewPayload({
        ...basePayload,
        milestones: [["milestone-1", "Changed deposit", 1250, "Pending", null]],
    });
    assert.equal(verifyPreviewToken(token, changedNamePayload, secret), false);
    const changedStatusPayload = contract.buildMilestoneSendPreviewPayload({
        ...basePayload,
        milestones: [["milestone-1", "Deposit", 1250, "Paid", null]],
    });
    assert.equal(verifyPreviewToken(token, changedStatusPayload, secret), false);
});

test("a recipient mutation conflicts before the milestone send boundary can reach QuickBooks", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.milestoneRecipientConflictError, "function");

    const expected = { to: ["client@example.test"], cc: ["old-copy@example.test"] };
    assert.equal(contract.milestoneRecipientConflictError({ expected, current: expected }), null);
    assert.match(contract.milestoneRecipientConflictError({
        expected,
        current: { to: ["client@example.test"], cc: ["new-copy@example.test"] },
    }) || "", /recipients changed after the preview/i);

    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendCore = source.indexOf("export async function sendMilestoneInvoicesCore(");
    const recipientGuard = source.indexOf("milestoneRecipientConflictError({", sendCore);
    const qboLoad = source.indexOf('await import("./quickbooks-payments")', sendCore);
    assert.ok(
        recipientGuard >= 0 && qboLoad > recipientGuard,
        "recipient drift must abort before QuickBooks is loaded or called",
    );
});

test("the final first-attempt recipient fence locks live Client/settings and detects post-read To/CC/BCC drift", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.lockInvoiceDeliveryRecipientSet, "function");
    assert.equal(typeof contract.completeFrozenRecipientSet, "function");
    assert.equal(typeof contract.completeFrozenRecipientConflictError, "function");
    const sqlEvents: string[] = [];
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join("?");
            sqlEvents.push(sql);
            if (sql.includes('FROM "Client"')) {
                // Simulates updateClient committing after the initial invoice
                // routing read but before this final provider fence.
                return [{ id: "client-1", email: "new@example.test", additionalEmail: "new-copy@example.test" }];
            }
            if (sql.includes('FROM "CompanySettings"')) {
                return [{
                    notificationEmail: "new-audit@example.test",
                    email: "new-office@example.test",
                    companyName: "New Contractor",
                }];
            }
            return [];
        },
    };
    const live = await contract.lockInvoiceDeliveryRecipientSet(tx, { clientId: "client-1" });
    assert.deepEqual(live.visible, { to: ["new@example.test"], cc: ["new-copy@example.test"] });
    assert.match(sqlEvents[0], /FROM "Client"[\s\S]*FOR SHARE/);
    assert.match(sqlEvents[1], /SELECT "notificationEmail", "email", "companyName"[\s\S]*FROM "CompanySettings"[\s\S]*FOR SHARE/);
    assert.equal(live.complete.replyTo, "new-office@example.test");
    assert.equal(live.complete.from, "New Contractor <notifications@goldentouchremodeling.com>");

    const frozenDispatch = {
        from: "Old Contractor <notifications@goldentouchremodeling.com>",
        to: ["old@example.test"],
        replyTo: "old-office@example.test",
        cc: ["old-copy@example.test"],
        bcc: ["old-audit@example.test"],
    };
    assert.match(contract.completeFrozenRecipientConflictError({
        expected: frozenDispatch,
        current: live.complete,
    }) || "", /recipients or internal notification copies changed/i);

    const originallyFrozen = contract.completeFrozenRecipientSet({
        to: ["client@example.test"],
        cc: ["copy@example.test"],
        bcc: ["audit@example.test"],
        fromName: "Golden Contractor",
        replyTo: "office@example.test",
    });
    const notificationRemoved = contract.completeFrozenRecipientSet({
        to: ["client@example.test"],
        cc: ["copy@example.test"],
        bcc: ["notifications@goldentouchremodeling.com"],
        fromName: "Golden Contractor",
        replyTo: "office@example.test",
    });
    assert.match(contract.completeFrozenRecipientConflictError({
        expected: originallyFrozen,
        current: notificationRemoved,
    }) || "", /internal notification copies changed/i);

    const replyToChanged = contract.completeFrozenRecipientSet({
        to: originallyFrozen.to,
        cc: originallyFrozen.cc,
        bcc: originallyFrozen.bcc,
        fromName: "Golden Contractor",
        replyTo: "billing@example.test",
    });
    assert.match(contract.completeFrozenRecipientConflictError({
        expected: originallyFrozen,
        current: replyToChanged,
    }) || "", /reply-to|sender settings/i);

    const companyNameChanged = contract.completeFrozenRecipientSet({
        to: originallyFrozen.to,
        cc: originallyFrozen.cc,
        bcc: originallyFrozen.bcc,
        fromName: "Renamed Contractor",
        replyTo: originallyFrozen.replyTo,
    });
    assert.match(contract.completeFrozenRecipientConflictError({
        expected: originallyFrozen,
        current: companyNameChanged,
    }) || "", /reply-to|sender settings/i);

    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const wholeStart = source.indexOf("export async function sendInvoiceToClientCore(");
    const wholeEnd = source.indexOf("export async function resendInvoiceCore(", wholeStart);
    const whole = source.slice(wholeStart, wholeEnd);
    const wholeResume = whole.lastIndexOf("if (attemptRow.providerStartedAt)", whole.indexOf("data: { providerStartedAt: new Date() }"));
    const wholeLiveLock = whole.indexOf("lockInvoiceDeliveryRecipientSet(tx", wholeResume);
    const wholeCheckpoint = whole.indexOf("data: { providerStartedAt: new Date() }", wholeLiveLock);
    assert.ok(wholeResume >= 0 && wholeLiveLock > wholeResume && wholeCheckpoint > wholeLiveLock,
        "whole-invoice first attempt must lock live destinations after the frozen-retry fast path and before providerStarted");

    const manualStart = source.indexOf("async function deliverManualMilestoneAttempt(");
    const manual = source.slice(manualStart);
    const manualFirstAttempt = manual.indexOf("if (!row.providerStartedAt)");
    const manualLiveLock = manual.indexOf("lockInvoiceDeliveryRecipientSet(tx", manualFirstAttempt);
    const manualCheckpoint = manual.indexOf("data: { providerStartedAt: new Date() }", manualLiveLock);
    assert.ok(manualFirstAttempt >= 0 && manualLiveLock > manualFirstAttempt && manualCheckpoint > manualLiveLock,
        "manual milestone first attempt must lock live destinations only before providerStarted");
});

test("the confirmed milestone fingerprint rejects name, amount, status, and prior-send drift before QuickBooks", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.milestoneFinancialConflictError, "function");
    const base: Array<[string, string, number, string, string | null]> = [
        ["milestone-1", "Deposit", 1250, "Pending", null],
    ];
    const expected = contract.milestoneSendFinancialFingerprint({ invoiceId: "invoice-1", milestones: base });
    assert.equal(contract.milestoneFinancialConflictError({
        expected,
        invoiceId: "invoice-1",
        milestones: base,
    }), null);
    for (const changed of [
        [["milestone-1", "Changed deposit", 1250, "Pending", null]],
        [["milestone-1", "Deposit", 1300, "Pending", null]],
        [["milestone-1", "Deposit", 1250, "Paid", null]],
        [["milestone-1", "Deposit", 1250, "Pending", "2026-08-17T12:00:00.000Z"]],
    ] as Array<Array<[string, string, number, string, string | null]>>) {
        assert.match(contract.milestoneFinancialConflictError({
            expected,
            invoiceId: "invoice-1",
            milestones: changed,
        }) || "", /milestones changed after the preview/i);
    }

    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendCore = source.indexOf("export async function sendMilestoneInvoicesCore(");
    const fingerprintGuard = source.indexOf("milestoneFinancialConflictError({", sendCore);
    const qboLoad = source.indexOf('await import("./quickbooks-payments")', sendCore);
    assert.ok(
        fingerprintGuard >= 0 && qboLoad > fingerprintGuard,
        "milestone financial drift must abort before QuickBooks is loaded or called",
    );
});

test("manual milestone delivery checkpoints one frozen stable-key attempt before provider and clears it only with exact stamps", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendCore = source.indexOf("export async function sendMilestoneInvoicesCore(");
    const sendEnd = source.indexOf("// ─────────────────────────────────────────────────────────────────────────────", sendCore + 80);
    const body = source.slice(sendCore, sendEnd);
    const createAttempt = body.indexOf("tx.invoiceEmailAttempt.create(");
    assert.ok(createAttempt >= 0, "manual milestone delivery must durably freeze its first payload");
    const deliveryStart = source.indexOf("async function deliverManualMilestoneAttempt(");
    const deliveryEnd = source.indexOf("// ─────────────────────────────────────────────────────────────────────────────", deliveryStart);
    const delivery = source.slice(deliveryStart, deliveryEnd);
    const providerCheckpoint = delivery.indexOf("providerStartedAt");
    const provider = delivery.indexOf("defaultSendFrozenNotification(", providerCheckpoint);
    const exactStamp = delivery.indexOf("tx.paymentSchedule.updateMany(", provider);
    const clearAttempt = delivery.indexOf("tx.invoiceEmailAttempt.delete(", exactStamp);
    const providerRejected = delivery.indexOf("if (!provider.success)", provider);
    const definiteRejectClear = delivery.indexOf(
        "if (!provider.ambiguous) await tx.invoiceEmailAttempt.delete",
        providerRejected,
    );
    const ambiguousRetention = delivery.indexOf(
        "provider.ambiguous ? { deliveryAmbiguous: true }",
        definiteRejectClear,
    );
    assert.ok(providerCheckpoint >= 0, "the provider-attempt fence must commit before delivery");
    assert.ok(provider > providerCheckpoint, "the provider must receive only the persisted frozen dispatch");
    assert.ok(exactStamp > provider, "milestones must be stamped under the same final Invoice lock");
    assert.ok(clearAttempt > exactStamp, "the attempt must survive until exact bookkeeping succeeds");
    assert.ok(providerRejected > provider && definiteRejectClear > providerRejected,
        "a definite provider rejection must durably release the never-accepted attempt");
    assert.ok(ambiguousRetention > definiteRejectClear,
        "an ambiguous provider outcome must retain the frozen payload/key for byte-identical recovery");
    assert.match(delivery, /if \(providerAccepted\)[\s\S]*deliveredButUnrecorded:[\s\S]*Keep this frozen attempt/,
        "provider acceptance followed by rollback must retain the attempt for reconciliation");
    assert.match(body, /kind:\s*"MILESTONE"/);
    assert.match(delivery, /allowInvoiceEmailAttemptKey/);
    assert.match(delivery, /canRetryProviderAttempt/);
    assert.match(delivery, /milestoneRecipientConflictError/);
    assert.match(delivery, /qbInvoiceId/);
    assert.match(delivery, /qbInvoiceLink/);
    assert.match(delivery, /qbSyncError/);
    assert.match(body, /requestedIds/);
    assert.match(body, /frozenIds/);
});

test("manual attempt adoption binds the exact set and pre-provider recipients but resumes frozen after providerStarted", async () => {
    const contract = await billingContract();
    const frozenRecipients = { to: ["old@example.test"], cc: ["copy@example.test"] };
    assert.equal(contract.manualMilestoneAttemptAdoptionError({
        requestedIds: ["m-2", "m-1"],
        requestedRecipients: frozenRecipients,
        frozenIds: ["m-1", "m-2"],
        frozenRecipients,
        providerStarted: false,
    }), null);
    assert.match(contract.manualMilestoneAttemptAdoptionError({
        requestedIds: ["m-1"],
        requestedRecipients: frozenRecipients,
        frozenIds: ["m-1", "m-2"],
        frozenRecipients,
        providerStarted: true,
    }) || "", /different frozen milestone request/i);
    assert.match(contract.manualMilestoneAttemptAdoptionError({
        requestedIds: ["m-1", "m-2"],
        requestedRecipients: { to: ["new@example.test"], cc: [] },
        frozenIds: ["m-1", "m-2"],
        frozenRecipients,
        providerStarted: false,
    }) || "", /recipients changed before the provider/i);
    assert.equal(contract.manualMilestoneAttemptAdoptionError({
        requestedIds: ["m-1", "m-2"],
        requestedRecipients: { to: ["new@example.test"], cc: [] },
        frozenIds: ["m-1", "m-2"],
        frozenRecipients,
        providerStarted: true,
    }), null, "after providerStarted the exact IDs must resume the byte-identical frozen recipients");
});

test("manual final-state fingerprint includes money, status, and collectible QBO identity/health", async () => {
    const contract = await billingContract();
    const base: MilestoneAttemptState[] = [{
        id: "m-1",
        name: "Deposit",
        amount: 500,
        status: "Pending",
        qbInvoiceSentAt: null,
        qbInvoiceId: "qb-1",
        qbInvoiceLink: "https://qbo.test/pay/1",
        qbSyncError: null,
    }];
    const expectedFingerprint = contract.milestoneDeliveryFingerprint("invoice-1", base);
    assert.equal(contract.milestoneDeliveryStateConflictError({ expectedFingerprint, invoiceId: "invoice-1", current: base }), null);
    for (const current of [
        [{ ...base[0], amount: 501 }],
        [{ ...base[0], status: "Paid" }],
        [{ ...base[0], qbInvoiceId: "qb-swapped" }],
        [{ ...base[0], qbInvoiceLink: null }],
        [{ ...base[0], qbSyncError: "voided" }],
    ]) {
        assert.match(contract.milestoneDeliveryStateConflictError({
            expectedFingerprint,
            invoiceId: "invoice-1",
            current,
        }) || "", /money, status, or QuickBooks identity changed/i);
    }
});

test("every selected milestone validates its durable QBO create payload before QBO reads or provider delivery", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendCore = source.indexOf("export async function sendMilestoneInvoicesCore(");
    const sendEnd = source.indexOf("// ─────────────────────────────────────────────────────────────────────────────", sendCore + 80);
    const body = source.slice(sendCore, sendEnd);
    const mismatchGuard = body.indexOf("getMilestoneQboCreatePayloadMismatch(schedule.id)");
    const tokenRead = body.indexOf("tokens = await getFreshQBTokens()");
    const qboStatusRead = body.indexOf("await getQBInvoiceStatus(");
    const automationDelivery = body.indexOf("deliverMilestoneFrozenNotification(");
    const manualDelivery = body.lastIndexOf("deliverManualMilestoneAttempt(");
    assert.ok(mismatchGuard >= 0, "the durable create-payload health helper must run for each selected milestone");
    assert.ok(tokenRead > mismatchGuard, "payload drift must stop before acquiring QBO tokens");
    assert.ok(qboStatusRead > mismatchGuard, "payload drift must stop before reading an already-linked QBO invoice");
    assert.ok(automationDelivery > mismatchGuard, "payload drift must stop before automated client delivery");
    assert.ok(manualDelivery > mismatchGuard, "payload drift must stop before manual client delivery");
});

test("provider-fetched QBO links persist only through the Invoice-locked exact-CAS helper", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const resendStart = source.indexOf("export async function resendInvoiceCore(");
    const resendEnd = source.indexOf("// ─────────────────────────────────────────────────────────────────────────────", resendStart);
    const resendBody = source.slice(resendStart, resendEnd);
    assert.doesNotMatch(resendBody, /prisma\.paymentSchedule\.update\s*\(/);
    assert.match(resendBody, /refreshExistingMilestoneQboStateUnderInvoiceLock/);
    assert.match(resendBody, /write\s*===\s*["']stale["'][\s\S]*linkRefreshConflict[\s\S]*INVOICE_STATE_CONFLICT/);

    const sendStart = source.indexOf("export async function sendMilestoneInvoicesCore(");
    const refreshStart = source.indexOf("Refresh each milestone's live QBO pay link", sendStart);
    const refreshEnd = source.indexOf("const emailMilestones", refreshStart);
    const refreshBody = source.slice(refreshStart, refreshEnd);
    assert.doesNotMatch(refreshBody, /prisma\.paymentSchedule\.update\s*\(/);
    assert.match(refreshBody, /refreshExistingMilestoneQboStateUnderInvoiceLock/);
    assert.match(refreshBody, /write\s*===\s*["']stale["'][\s\S]*qboLinkRefreshConflict[\s\S]*MILESTONE_STATE_CONFLICT/);
});

test("destructive invoice paths recognize ambiguous QBO creates and every progress-billing allocation as audit evidence", async () => {
    const contract = await billingContract();
    for (const evidence of [
        { qbCreateRequestId: "request-1" },
        { qbCreateFingerprint: "opaque-fingerprint" },
        { qbCreateStartedAt: new Date("2026-08-17T12:00:00.000Z") },
    ]) {
        assert.equal(contract.paymentScheduleHasProviderOrPaymentEvidence({
            status: "Pending",
            ...evidence,
        }), true);
    }
    assert.equal(contract.paymentScheduleHasProviderOrPaymentEvidence({ status: "Pending" }), false);
    assert.equal(contract.invoiceHasAuditEvidence({
        status: "Draft",
        progressBillingCount: 1,
        payments: [{ status: "Pending" }],
    }), true, "a Draft progress billing still owns allocated milestone history");
    assert.equal(contract.invoiceHasAuditEvidence({
        status: "Draft",
        payments: [{ status: "Pending", qbCreateRequestId: "ambiguous-provider-create" }],
    }), true);
    assert.equal(contract.invoiceHasAuditEvidence({
        status: "Draft",
        payments: [{ status: "Pending" }],
    }), false);

    const source = readFileSync("src/lib/actions.ts", "utf8");
    const deleteInvoiceStart = source.indexOf("export async function deleteInvoice(");
    const deleteInvoiceEnd = source.indexOf("export async function updateInvoiceNotes", deleteInvoiceStart);
    assert.match(source.slice(deleteInvoiceStart, deleteInvoiceEnd), /invoiceHasAuditEvidence/);
    const deleteProjectsStart = source.indexOf("export async function deleteProjects(");
    const deleteProjectsEnd = source.indexOf("export async function updateCompanyProjectStatuses", deleteProjectsStart);
    assert.match(
        source.slice(deleteProjectsStart, deleteProjectsEnd),
        /(?:progressBillings|invoices):\s*\{\s*some:\s*\{\}\s*\}/,
        "project deletion must retain progress billings either directly or by rejecting every invoice-owning project",
    );
});

test("duplicate-invoice compensation requires the exact untouched child set", async () => {
    const contract = await billingContract();
    const base = {
        estimateId: "estimate-1",
        createdPaymentIds: ["payment-2", "payment-1"],
        invoice: {
            estimateId: "estimate-1",
            status: "Draft",
            progressBillingCount: 0,
            payments: [
                { id: "payment-1", status: "Pending" },
                { id: "payment-2", status: "Pending" },
            ],
        },
    };
    assert.equal(contract.invoiceCompensationSnapshotMatches(base), true);
    assert.equal(contract.invoiceCompensationSnapshotMatches({
        ...base,
        invoice: {
            ...base.invoice,
            payments: [...base.invoice.payments, { id: "concurrent-child", status: "Pending" }],
        },
    }), false);
    assert.equal(contract.invoiceCompensationSnapshotMatches({
        ...base,
        invoice: { ...base.invoice, progressBillingCount: 1 },
    }), false);
    assert.equal(contract.invoiceCompensationSnapshotMatches({
        ...base,
        invoice: {
            ...base.invoice,
            payments: [
                { id: "payment-1", status: "Pending", qbCreateRequestId: "provider-started" },
                { id: "payment-2", status: "Pending" },
            ],
        },
    }), false);
});

test("milestone delete and re-split preserve every progress-billing allocation under the Invoice lock", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const deleteStart = source.indexOf("export async function deleteInvoiceMilestoneCore(");
    const deleteEnd = source.indexOf("export function paymentScheduleHasProviderOrPaymentEvidence", deleteStart);
    const deleteBody = source.slice(deleteStart, deleteEnd);
    const deleteLock = deleteBody.indexOf("await lockMoneyParents(tx, { invoiceId: row.invoiceId })");
    const deleteAllocationGuard = deleteBody.indexOf("tx.progressBillingLine.findFirst(");
    const deleteMutation = deleteBody.indexOf("tx.paymentSchedule.delete(");
    assert.ok(deleteLock >= 0 && deleteAllocationGuard > deleteLock && deleteMutation > deleteAllocationGuard,
        "single-milestone deletion must reject progress-billing references after locking and before deletion");

    const splitStart = source.indexOf("export async function splitInvoiceMilestonesCore(");
    const splitBody = source.slice(splitStart);
    const splitLock = splitBody.indexOf("await lockMoneyParents(tx, { invoiceId })");
    const splitAllocationGuard = splitBody.indexOf("tx.progressBillingLine.findFirst(");
    const splitMutation = splitBody.indexOf("tx.paymentSchedule.deleteMany(");
    assert.ok(splitLock >= 0 && splitAllocationGuard > splitLock && splitMutation > splitAllocationGuard,
        "re-splitting must reject references to every schedule it will delete after locking and before deletion");
    assert.match(splitBody.slice(splitAllocationGuard, splitMutation), /scheduleId:\s*\{\s*in:\s*destructiveScheduleIds\s*\}/);
});

test("change-order BILL retry matches duplicate names by exact source id and consumes rows once", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.matchExistingChangeOrderMilestones, "function");
    const plans = [
        { sourceCoScheduleId: "signed-plan-1", name: "CO-7 — Progress", totalCents: 5000 },
        { sourceCoScheduleId: "signed-plan-2", name: "CO-7 — Progress", totalCents: 5000 },
    ];
    const exactRows = [
        { id: "milestone-2", sourceCoScheduleId: "signed-plan-2", name: "CO-7 — Progress", amount: 50 },
        { id: "milestone-1", sourceCoScheduleId: "signed-plan-1", name: "CO-7 — Progress", amount: 50 },
    ];
    const matched = contract.matchExistingChangeOrderMilestones(plans, exactRows);
    assert.deepEqual(matched, { ok: true, existingIds: ["milestone-1", "milestone-2"] });
    assert.equal(new Set(matched.ok ? matched.existingIds : []).size, 2);

    const ambiguousLegacy = contract.matchExistingChangeOrderMilestones(plans, exactRows.map((row) => ({
        ...row,
        sourceCoScheduleId: null,
    })));
    assert.equal(ambiguousLegacy.ok, false, "same-name/same-amount legacy rows cannot be assigned honestly");

    const unexpectedExtra = contract.matchExistingChangeOrderMilestones(plans, [
        ...exactRows,
        { id: "unexpected", sourceCoScheduleId: null, name: "CO-7 — old split", amount: 5 },
    ]);
    assert.equal(unexpectedExtra.ok, false, "an old or extra split set must block retry before any write");

    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const billStart = source.indexOf("export async function billChangeOrderCore(");
    const billEnd = source.indexOf("export async function handleChangeOrderApproved(", billStart);
    const body = source.slice(billStart, billEnd);
    const matcher = body.indexOf("matchExistingChangeOrderMilestones(plans, existing)");
    const create = body.indexOf("tx.paymentSchedule.create(");
    assert.ok(matcher >= 0 && create > matcher, "the complete existing set must be matched before any missing row is created");
    assert.doesNotMatch(body, /sourceCoScheduleId === plan\.sourceCoScheduleId \|\| row\.name === plan\.name/);
});

test("fixed and cost-plus CO billing select the newest estimate invoice only after the shared Estimate mutex", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.findChangeOrderInvoiceUnderEstimateLock, "function");
    const events: string[] = [];
    let newest = { id: "invoice-a", code: "INV-A", status: "Draft" };
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join("?");
            if (sql.includes('FROM "Estimate"')) {
                events.push("estimate-lock");
                // Deterministic interleaving: createInvoiceFromEstimateCore's B
                // committed immediately before this lock was granted.
                newest = { id: "invoice-b", code: "INV-B", status: "Draft" };
            }
            return [];
        },
        invoice: {
            findFirst: async () => {
                events.push("invoice-select");
                return newest;
            },
        },
    };
    const selected = await contract.findChangeOrderInvoiceUnderEstimateLock(tx, {
        estimateId: "estimate-1",
        projectId: "project-1",
    });
    assert.equal(selected?.id, "invoice-b");
    assert.deepEqual(events, ["estimate-lock", "invoice-select"]);

    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const createStart = source.indexOf("export async function createInvoiceFromEstimateCore(");
    const createEnd = source.indexOf("export function invoiceCompensationSnapshotMatches(", createStart);
    const createBody = source.slice(createStart, createEnd);
    const createTx = createBody.indexOf("prisma.$transaction(async (tx)");
    // Estimate FIRST (lockMoneyParents' canonical order), then Project —
    // restoreEstimateItemAssociations holds Estimate before Project, so the
    // reverse order here would deadlock against it (see the comment in
    // createInvoiceFromEstimateCore, ported from main's Codex round 2).
    const estimateLock = createBody.indexOf("lockMoneyParents(tx, { estimateId })", createTx);
    const projectLock = createBody.indexOf('FROM "Project"', estimateLock);
    const invoiceCreate = createBody.indexOf("tx.invoice.create", projectLock);
    const milestoneCreate = createBody.indexOf("tx.paymentSchedule.create", invoiceCreate);
    assert.ok(createTx >= 0 && estimateLock > createTx && projectLock > estimateLock
        && invoiceCreate > projectLock && milestoneCreate > invoiceCreate,
    "invoice and cloned milestones must be created while Estimate→Project locks are held");
    assert.doesNotMatch(createBody, /prisma\.invoice\.(?:create|update)/,
        "invoice creation must not escape the shared parent transaction");

    const fixedStart = source.indexOf("export async function billChangeOrderCore(");
    const fixedEnd = source.indexOf("export async function handleChangeOrderApproved(", fixedStart);
    const fixedBody = source.slice(fixedStart, fixedEnd);
    assert.ok(fixedBody.indexOf("findChangeOrderInvoiceUnderEstimateLock(tx, co)")
        < fixedBody.indexOf("const existingRefs"),
    "fixed billing must lock/select its estimate target before reading retry rows");

    const costStart = source.indexOf("export async function billCostPlusChangeOrderCore(");
    const costEnd = source.indexOf("type LegacyBillChangeOrderOutcome", costStart);
    const costBody = source.slice(costStart, costEnd);
    assert.ok(costBody.indexOf("findChangeOrderInvoiceUnderEstimateLock(tx, co)")
        < costBody.indexOf("loadCostPlusActuals"),
    "cost-plus billing must select its invoice under the same Estimate mutex");
});

test("whole-invoice resend previews HMAC-bind the complete recipients and live money state", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.buildInvoiceResendPreviewPayload, "function");
    assert.equal(typeof contract.invoiceSendFinancialFingerprint, "function");

    const base = {
        invoiceId: "invoice-resend-binding",
        recipients: {
            to: ["client@example.test"],
            cc: ["copy@example.test"],
        },
        invoice: {
            code: "INV-101",
            status: "Issued",
            total: 1250,
            balanceDue: 750,
            sentAt: "2026-08-17T12:00:00.000Z",
        },
        milestones: [{
            id: "milestone-1",
            name: "Deposit",
            amount: 750,
            status: "Pending",
            qbInvoiceId: "qb-1",
            qbInvoiceSentAt: "2026-08-17T12:00:00.000Z",
            qbSyncError: "link stale",
        }],
    };
    const secret = "disposable-invoice-resend-secret";
    const payload = contract.buildInvoiceResendPreviewPayload(base);
    const token = mintPreviewToken(payload, secret);

    assert.equal(verifyPreviewToken(token, payload, secret), true);
    assert.equal(verifyPreviewToken(token, contract.buildInvoiceResendPreviewPayload({
        ...base,
        recipients: { ...base.recipients, cc: ["changed@example.test"] },
    }), secret), false);
    assert.equal(verifyPreviewToken(token, contract.buildInvoiceResendPreviewPayload({
        ...base,
        invoice: { ...base.invoice, balanceDue: 700 },
    }), secret), false);
    assert.equal(verifyPreviewToken(token, contract.buildInvoiceResendPreviewPayload({
        ...base,
        milestones: [{ ...base.milestones[0], status: "Paid" }],
    }), secret), false);
});

test("the persisted first dispatch wins and is checkpointed before every stable-key provider attempt", async () => {
    const { deliverMilestoneFrozenNotification } = await billingContract();
    const firstCandidate = frozen("fresh candidate one");
    const retryCandidate = frozen("fresh candidate two that must never be sent");
    const immutableWinner = frozen("persisted first payload");
    const events: string[] = [];
    const sent: Array<{ dispatch: FrozenNotification; key: string }> = [];
    const completions: Array<DeliveryContext & { sentAt: Date; providerMessageId?: string }> = [];

    const automation: AutomationDelivery = {
        idempotencyKey: "co-job/client-email-1",
        persistFrozenNotification: async (candidate) => {
            events.push(`persist:${candidate.subject}`);
            return immutableWinner;
        },
        sendFrozenNotification: async (dispatch, key) => {
            events.push(`send:${dispatch.subject}`);
            sent.push({ dispatch, key });
            return { success: true, id: "provider-message-1" };
        },
        completeAfterDelivery: async (input) => {
            events.push(`complete:${input.scheduleIds.join(",")}`);
            completions.push(input);
        },
    };
    const context = {
        invoiceId: "inv-1",
        scheduleIds: ["ms-existing", "ms-new"],
        recipient: "client@example.test",
    };

    const first = await deliverMilestoneFrozenNotification(firstCandidate, context, automation);
    const retry = await deliverMilestoneFrozenNotification(retryCandidate, context, {
        ...automation,
        frozenNotification: immutableWinner,
    });

    assert.deepEqual(first, {
        delivered: true,
        recorded: true,
        providerMessageId: "provider-message-1",
    });
    assert.deepEqual(retry, first);
    assert.deepEqual(events, [
        "persist:fresh candidate one",
        "send:persisted first payload",
        "complete:ms-existing,ms-new",
        "persist:persisted first payload",
        "send:persisted first payload",
        "complete:ms-existing,ms-new",
    ]);
    assert.equal(sent.length, 2);
    assert.strictEqual(sent[0].dispatch, immutableWinner);
    assert.strictEqual(sent[1].dispatch, immutableWinner);
    assert.deepEqual(sent.map(call => call.key), [
        "co-job/client-email-1",
        "co-job/client-email-1",
    ]);
    assert.deepEqual(completions.map(call => call.scheduleIds), [
        ["ms-existing", "ms-new"],
        ["ms-existing", "ms-new"],
    ]);
    assert.ok(completions.every(call => call.sentAt instanceof Date));
    assert.ok(completions.every(call => call.providerMessageId === "provider-message-1"));
});

test("provider success plus completion failure is delivered-but-unrecorded and explicitly forbids an ordinary resend", async () => {
    const { deliverMilestoneFrozenNotification } = await billingContract();
    const dispatch = frozen("persisted payload");

    const result = await deliverMilestoneFrozenNotification(
        frozen("candidate"),
        { invoiceId: "inv-1", scheduleIds: ["ms-1"], recipient: "client@example.test" },
        {
            idempotencyKey: "co-job/client-email-2",
            persistFrozenNotification: async () => dispatch,
            sendFrozenNotification: async () => ({ success: true }),
            completeAfterDelivery: async () => {
                throw new Error("commit lost");
            },
        },
    );

    assert.equal(result.delivered, true);
    assert.equal(result.recorded, false);
    assert.equal(result.deliveredButUnrecorded, true);
    assert.match(result.error || "", /commit lost/);
    assert.match(result.error || "", /do not resend/i);
});

test("a provider failure never runs the atomic completion callback", async () => {
    const { deliverMilestoneFrozenNotification } = await billingContract();
    let completionCalls = 0;

    const result = await deliverMilestoneFrozenNotification(
        frozen("candidate"),
        { invoiceId: "inv-1", scheduleIds: ["ms-1"], recipient: "client@example.test" },
        {
            idempotencyKey: "co-job/client-email-3",
            persistFrozenNotification: async candidate => candidate,
            sendFrozenNotification: async () => ({ success: false }),
            completeAfterDelivery: async () => {
                completionCalls += 1;
            },
        },
    );

    assert.equal(result.delivered, false);
    assert.equal(result.recorded, false);
    assert.match(result.error || "", /provider failed/i);
    assert.equal(completionCalls, 0);
});

test("an ambiguous provider outcome forbids an ordinary resend and does not run completion", async () => {
    const { deliverMilestoneFrozenNotification } = await billingContract();
    let completionCalls = 0;

    const result = await deliverMilestoneFrozenNotification(
        frozen("candidate"),
        { invoiceId: "inv-1", scheduleIds: ["ms-1"], recipient: "client@example.test" },
        {
            idempotencyKey: "co-job/client-email-4",
            persistFrozenNotification: async candidate => candidate,
            sendFrozenNotification: async () => ({ success: false, ambiguous: true }),
            completeAfterDelivery: async () => {
                completionCalls += 1;
            },
        },
    );

    assert.equal(result.delivered, false);
    assert.equal(result.recorded, false);
    assert.equal(result.deliveryAmbiguous, true);
    assert.match(result.error || "", /ambiguous/i);
    assert.match(result.error || "", /do not resend/i);
    assert.equal(completionCalls, 0);
});

test("automation rejects a reduced, ineligible, or already-sent milestone set before QuickBooks", async () => {
    const contract = await billingContract();
    assert.equal(typeof contract.milestoneAutomationPreflightError, "function");
    const preflight = contract.milestoneAutomationPreflightError;
    const exact = [
        { id: "m-1", status: "Pending", qbInvoiceSentAt: null },
        { id: "m-2", status: "Pending", qbInvoiceSentAt: null },
    ];
    assert.equal(preflight({
        requestedIds: ["m-1", "m-2"],
        expectedIds: ["m-1", "m-2"],
        milestones: exact,
        recipient: "client@example.test",
    }), null);
    assert.match(preflight({
        requestedIds: ["m-1", "missing"],
        expectedIds: ["m-1", "missing"],
        milestones: exact.slice(0, 1),
        recipient: "client@example.test",
    }) || "", /exact billed milestone set/i);
    assert.match(preflight({
        requestedIds: ["m-1", "m-2"],
        expectedIds: ["m-1", "m-2"],
        milestones: [{ ...exact[0], status: "Paid" }, exact[1]],
        recipient: "client@example.test",
    }) || "", /paid or canceled/i);
    assert.match(preflight({
        requestedIds: ["m-1", "m-2"],
        expectedIds: ["m-1", "m-2"],
        milestones: [exact[0], { ...exact[1], qbInvoiceSentAt: new Date("2026-08-17T12:00:00Z") }],
        recipient: "client@example.test",
    }) || "", /already sent/i);

    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendCore = source.indexOf("export async function sendMilestoneInvoicesCore(");
    const guard = source.indexOf("milestoneAutomationPreflightError({", sendCore);
    const qboLoad = source.indexOf('await import("./quickbooks-payments")', sendCore);
    assert.ok(guard >= 0 && qboLoad > guard, "the exact-set guard must run before QuickBooks is loaded or called");
    const loop = source.indexOf("for (const schedule of selectedPayments)", qboLoad);
    const heartbeat = source.indexOf("renewBeforeSideEffect", loop);
    assert.ok(loop >= 0 && heartbeat > loop, "the QBO loop must renew its durable claim before side effects");
});

test("whole-invoice send and resend stop before provider or QuickBooks while approval delivery is active", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const helper = source.indexOf("async function activeApprovalClientDeliveryForInvoice(");
    assert.ok(helper >= 0, "whole-invoice paths need the same durable approval-delivery fence");

    const sendStart = source.indexOf("export async function sendInvoiceToClientCore(");
    const sendEnd = source.indexOf("export async function resendInvoiceCore(", sendStart);
    const sendBody = source.slice(sendStart, sendEnd);
    const sendFence = sendBody.indexOf("activeApprovalClientDeliveryForInvoice(");
    const provider = sendBody.indexOf("defaultSendFrozenNotification(");
    assert.ok(sendFence >= 0 && provider > sendFence, "invoice send must fence before provider delivery");

    const resendStart = sendEnd;
    const resendEnd = source.indexOf("export ", resendStart + 20);
    const resendBody = source.slice(resendStart, resendEnd);
    const resendFence = resendBody.indexOf("activeApprovalClientDeliveryForInvoice(");
    const qbo = resendBody.indexOf('await import("./quickbooks-payments")');
    assert.ok(resendFence >= 0 && qbo > resendFence, "invoice resend must fence before QBO side effects");
});

test("whole-invoice resend rechecks the previewed To/CC set before QuickBooks and delivery", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendStart = source.indexOf("export async function sendInvoiceToClientCore(");
    const sendEnd = source.indexOf("export async function resendInvoiceCore(", sendStart);
    const sendBody = source.slice(sendStart, sendEnd);
    const sendRecipientGuard = sendBody.indexOf("milestoneRecipientConflictError({");
    const sendFinancialGuard = sendBody.indexOf("invoiceSendFinancialFingerprint({");
    const provider = sendBody.indexOf("defaultSendFrozenNotification(");
    assert.ok(
        sendRecipientGuard >= 0 && provider > sendRecipientGuard,
        "whole-invoice delivery must reject recipient drift before the provider call",
    );
    assert.ok(
        sendFinancialGuard >= 0 && provider > sendFinancialGuard,
        "whole-invoice delivery must reject money-state drift before the provider call",
    );

    const resendStart = sendEnd;
    const resendEnd = source.indexOf("// ─────────────────────────────────────────────────────────────────────────────", resendStart + 20);
    const resendBody = source.slice(resendStart, resendEnd);
    const resendRecipientGuard = resendBody.indexOf("milestoneRecipientConflictError({");
    const resendFinancialGuard = resendBody.indexOf("invoiceSendFinancialFingerprint({");
    const qbo = resendBody.indexOf('await import("./quickbooks-payments")');
    assert.ok(
        resendRecipientGuard >= 0 && qbo > resendRecipientGuard,
        "whole-invoice resend must reject recipient drift before QuickBooks",
    );
    assert.ok(
        resendFinancialGuard >= 0 && qbo > resendFinancialGuard,
        "whole-invoice resend must reject money-state drift before QuickBooks",
    );

    const route = readFileSync("src/app/api/mcp/[transport]/route.ts", "utf8");
    const toolStart = route.indexOf('title: "Resend an invoice');
    const toolEnd = route.indexOf('"create_change_order"', toolStart);
    const toolBody = route.slice(toolStart, toolEnd);
    assert.match(toolBody, /additionalEmail/);
    assert.match(toolBody, /buildInvoiceResendPreviewPayload/);
    assert.match(toolBody, /recipients/);
    assert.match(toolBody, /expectedRecipients/);
});

test("whole-invoice delivery validates before providerStarted then resumes frozen under the canonical lock", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendStart = source.indexOf("export async function sendInvoiceToClientCore(");
    const sendEnd = source.indexOf("export async function resendInvoiceCore(", sendStart);
    const sendBody = source.slice(sendStart, sendEnd);
    const provider = sendBody.indexOf("defaultSendFrozenNotification(");
    const lock = sendBody.lastIndexOf("lockMoneyParents(tx", provider);
    const transaction = sendBody.lastIndexOf("prisma.$transaction(async (tx)", lock);
    const providerStartedCheckpoint = sendBody.lastIndexOf("data: { providerStartedAt: new Date() }", provider);
    const automaticFence = sendBody.lastIndexOf("activeApprovalClientDeliveryForInvoice(", providerStartedCheckpoint);
    const stamp = sendBody.indexOf("tx.paymentSchedule.updateMany(", provider);
    assert.ok(transaction >= 0, "whole-invoice delivery must serialize through an interactive transaction");
    assert.ok(lock > transaction, "the canonical Invoice parent lock must be acquired first");
    assert.ok(automaticFence >= 0 && providerStartedCheckpoint > automaticFence, "the approval-job fence must be checked before committing providerStarted");
    assert.ok(provider > providerStartedCheckpoint, "provider delivery must resume only after its checkpoint commits");
    assert.equal(
        sendBody.slice(transaction, provider).includes("activeApprovalClientDeliveryForInvoice("),
        false,
        "a provider-started frozen retry must not be vetoed by later live job/contact changes",
    );
    assert.ok(stamp > provider, "the request-marker stamp must occur before releasing the Invoice lock");
});

test("whole-invoice delivery freezes a durable payload and stable provider key across ambiguous retries", () => {
    const source = readFileSync("src/lib/billing-core.ts", "utf8");
    const sendStart = source.indexOf("export async function sendInvoiceToClientCore(");
    const sendEnd = source.indexOf("export async function resendInvoiceCore(", sendStart);
    const sendBody = source.slice(sendStart, sendEnd);
    const checkpoint = sendBody.indexOf("tx.invoiceEmailAttempt.create(");
    const provider = sendBody.indexOf("defaultSendFrozenNotification(", checkpoint);
    const clearAttempt = sendBody.indexOf("tx.invoiceEmailAttempt.delete(", provider);
    assert.ok(checkpoint >= 0, "the exact first payload must be durably checkpointed before delivery");
    assert.ok(provider > checkpoint, "delivery must use the frozen checkpoint rather than rebuilding the email");
    assert.ok(clearAttempt > provider, "the checkpoint must clear only with successful send bookkeeping");
    assert.match(sendBody, /providerStartedAt/);
    assert.match(sendBody, /canRetryProviderAttempt/);

    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /model InvoiceEmailAttempt/);
    assert.match(schema, /payload\s+Json/);
    assert.match(schema, /providerStartedAt\s+DateTime\?/);
    const migration = readFileSync("prisma/migrations/20260817000001_add_change_order_automation_jobs/migration.sql", "utf8");
    assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE "InvoiceEmailAttempt" FROM PUBLIC/);
});

test("canonical Invoice locks fence every money writer behind a provider-started email attempt", async () => {
    const tx = {
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join("?");
            if (sql.includes('FROM "InvoiceEmailAttempt"')) {
                return [{ attemptKey: "attempt-1", providerStartedAt: new Date() }];
            }
            return sql.includes('FROM "Invoice"') ? [{ id: "invoice-1" }] : [];
        },
    };
    await assert.rejects(
        lockMoneyParents(tx as never, { invoiceId: "invoice-1" }),
        error => error instanceof InvoiceEmailDeliveryInProgressError,
    );
    await lockMoneyParents(tx as never, {
        invoiceId: "invoice-1",
        allowInvoiceEmailAttemptKey: "attempt-1",
    });
});
