import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import {
    ChangeOrderReviewDeliveryUnresolvedError,
    checkpointChangeOrderAutomationProviderDispatch,
    claimChangeOrderAutomationJob,
    enqueueApprovalAutomationJobs,
    enqueueReviewEmailAutomationJob,
    releaseChangeOrderAutomationJob,
    seedLegacyApprovedChangeOrderAutomationJobs,
} from "../src/lib/change-order-automation-jobs";
import { drainChangeOrderAutomationJobs } from "../src/lib/change-order-automation";
import { executeApprovalAutomationJob } from "../src/lib/change-order-approval-automation";
import {
    executeReviewEmailAutomationJob,
    reviewEmailSettingsExpectation,
} from "../src/lib/change-order-review-automation";
import { buildFrozenNotification, CLIENT_DOC_COPY_EMAIL } from "../src/lib/email";
import {
    billChangeOrderCore,
    milestoneDeliveryFingerprint,
    sendMilestoneInvoicesCore,
    type MilestoneAttemptState,
} from "../src/lib/billing-core";
import {
    ChangeOrderRevisionConflictError,
    deleteChangeOrderCore,
    manuallyApproveChangeOrderCore,
    updateChangeOrderCore,
} from "../src/lib/change-order-core";
import { coTaxFingerprint } from "../src/lib/co-tax";

const prisma = new PrismaClient();
const run = `co-outbox-${process.pid}-${Date.now()}`;
const ids = {
    client: `${run}-client`,
    project: `${run}-project`,
    estimate: `${run}-estimate`,
    claimRace: `${run}-claim-race`,
    manualApproval: `${run}-manual-approval`,
    attemptedReview: `${run}-attempted-review`,
    safeReview: `${run}-safe-review`,
    billCrash: `${run}-bill-crash`,
    billDuplicateNames: `${run}-bill-duplicate-names`,
    providerRetry: `${run}-provider-retry`,
    reviewLock: `${run}-review-lock`,
    legacyRecovery: `${run}-legacy-recovery`,
    billInvoice: `${run}-bill-invoice`,
    newerBillInvoice: `${run}-bill-invoice-newer`,
    providerInvoice: `${run}-provider-invoice`,
} as const;

const allChangeOrderIds = [
    ids.claimRace,
    ids.manualApproval,
    ids.attemptedReview,
    ids.safeReview,
    ids.billCrash,
    ids.billDuplicateNames,
    ids.providerRetry,
    ids.reviewLock,
    ids.legacyRecovery,
];

const INSERT_BLOCK_SUFFIX = `${process.pid}_${Date.now()}`;
const INSERT_BLOCK_FUNCTION = `co_outbox_block_fn_${INSERT_BLOCK_SUFFIX}`;
const INSERT_BLOCK_TRIGGER = `co_outbox_block_tr_${INSERT_BLOCK_SUFFIX}`;
const INSERT_BLOCK_LOCK_KEY = BigInt(Date.now()) * 100_000n + BigInt(process.pid);
const COMPLETION_FAILURE_FUNCTION = `co_outbox_fail_completion_fn_${INSERT_BLOCK_SUFFIX}`;
const COMPLETION_FAILURE_TRIGGER = `co_outbox_fail_completion_tr_${INSERT_BLOCK_SUFFIX}`;

const REVIEW_TAX_FINGERPRINT = '[false,8.875,"Outbox exact rate"]';
const LEGACY_APPROVED_AT = new Date("2099-08-17T12:00:00.000Z");

function frozenReviewDispatch(subject: string) {
    return {
        from: "Golden Touch Remodeling <notifications@goldentouchremodeling.com>",
        to: [`${run}@example.test`],
        replyTo: "jadkins@goldentouchremodeling.com",
        subject,
        html: `<p>${subject}</p>`,
        text: subject,
    };
}

async function frozenInvoiceDispatch(invoiceId: string, subject: string) {
    const [invoice, settings] = await Promise.all([
        prisma.invoice.findUniqueOrThrow({
            where: { id: invoiceId },
            select: {
                client: {
                    select: { email: true, additionalEmail: true },
                },
            },
        }),
        prisma.companySettings.findUnique({
            where: { id: "singleton" },
            select: { notificationEmail: true, email: true, companyName: true },
        }),
    ]);
    const primary = (invoice.client.email ?? "").trim().toLowerCase();
    if (!primary) throw new Error("Invoice client email is required for the provider retry fixture");
    const additional = (invoice.client.additionalEmail ?? "").trim().toLowerCase();
    const internalCopies = (settings?.notificationEmail?.trim() || CLIENT_DOC_COPY_EMAIL)
        .split(",")
        .map(email => email.trim())
        .filter(Boolean);
    return buildFrozenNotification({
        to: [primary],
        cc: additional && additional !== primary ? [additional] : [],
        bcc: internalCopies,
        fromName: settings?.companyName || "Your Contractor",
        replyTo: settings?.email || undefined,
        subject,
        html: `<p>${subject}</p>`,
    });
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

function settledFlag<T>(promise: Promise<T>) {
    let settled = false;
    void promise.then(
        () => { settled = true; },
        () => { settled = true; },
    );
    return () => settled;
}

function assertDisposableDatabase() {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the automation outbox regression");
    if (["supabase.co", "supabase.com", "ghzdbzdnwjxazvmcefbh"].some(marker => databaseUrl.includes(marker))) {
        throw new Error("REFUSING TO RUN the automation outbox regression against a Supabase/live database");
    }
}

async function createFixedChangeOrder(id: string, title: string) {
    return prisma.changeOrder.create({
        data: {
            id,
            projectId: ids.project,
            estimateId: ids.estimate,
            code: `CO-${id.slice(-20)}`,
            title,
            status: "Draft",
            pricingType: "FIXED",
            totalAmount: 10,
            balanceDue: 10,
            items: {
                create: {
                    name: "Outbox regression work",
                    type: "Labor",
                    quantity: 1,
                    unitCost: 10,
                    total: 10,
                },
            },
        },
    });
}

async function createApprovedFixedChangeOrder(
    id: string,
    title: string,
    options: { revision?: number; clientSignatureUrl?: string | null; approvedAt?: Date } = {},
) {
    return prisma.changeOrder.create({
        data: {
            id,
            projectId: ids.project,
            estimateId: ids.estimate,
            code: `CO-${id.slice(-20)}`,
            title,
            status: "Approved",
            pricingType: "FIXED",
            totalAmount: 10,
            balanceDue: 10,
            revision: options.revision ?? 1,
            approvedBy: "Outbox regression",
            approvedAt: options.approvedAt ?? new Date("2026-08-17T12:00:00.000Z"),
            clientSignatureUrl: options.clientSignatureUrl ?? "test://client-signature",
            termsTaxExempt: false,
            termsTaxRatePercent: 8.875,
            termsTaxRateName: "Outbox exact rate",
            items: {
                create: {
                    name: "Outbox approved work",
                    type: "Labor",
                    quantity: 1,
                    unitCost: 10,
                    total: 10,
                },
            },
        },
    });
}

async function enqueueClientApprovalGraph(changeOrderId: string, eventRevision: number) {
    const frozenEvent = { changeOrderId, eventRevision, approvalMode: "CLIENT" };
    return prisma.$transaction(tx => enqueueApprovalAutomationJobs(tx, {
        changeOrderId,
        eventRevision,
        pricingType: "FIXED",
        approvalMode: "CLIENT",
        payloads: {
            APPROVAL_BILL: { ...frozenEvent },
            APPROVAL_CLIENT_EMAIL: { ...frozenEvent },
            APPROVAL_SCHEDULE: { ...frozenEvent },
            APPROVAL_TEAM_EMAIL: { ...frozenEvent },
        },
    }));
}

async function enqueueExecutableReview(changeOrderId: string, generation: string) {
    const [row, settings] = await Promise.all([
        prisma.changeOrder.findUniqueOrThrow({
            where: { id: changeOrderId },
            select: { revision: true },
        }),
        prisma.companySettings.findUnique({ where: { id: "singleton" } }),
    ]);
    const recipients = { primary: `${run}@example.test`, additional: [] };
    const expectedSettings = reviewEmailSettingsExpectation({
        recipients,
        notificationEmail: settings?.notificationEmail,
        email: settings?.email,
        companyName: settings?.companyName,
    });
    const subject = `Review ${generation}`;
    const dispatch = buildFrozenNotification({
        to: [recipients.primary],
        subject,
        html: `<p>${subject}</p>`,
        fromName: expectedSettings.companyName,
        replyTo: expectedSettings.replyTo,
        bcc: expectedSettings.bcc,
    });
    return prisma.$transaction(tx => enqueueReviewEmailAutomationJob(tx, {
        changeOrderId,
        eventRevision: row.revision,
        generationKey: `${run}-${generation}`,
        dispatch,
        payload: {
            expectedRevision: row.revision,
            expectedTaxFingerprint: REVIEW_TAX_FINGERPRINT,
            expectedTaxTerms: { taxExempt: false, taxRatePercent: 8.875, taxRateName: "Outbox exact rate" },
            expectedRecipients: recipients,
            expectedSubtotalCents: 1_000,
            companyName: expectedSettings.companyName,
            expectedSettings,
        },
    }));
}

async function enqueueReview(changeOrderId: string, generation: string) {
    const row = await prisma.changeOrder.findUniqueOrThrow({
        where: { id: changeOrderId },
        select: { revision: true },
    });
    return prisma.$transaction(tx => enqueueReviewEmailAutomationJob(tx, {
        changeOrderId,
        eventRevision: row.revision,
        generationKey: `${run}-${generation}`,
        dispatch: frozenReviewDispatch(`Review ${generation}`),
        payload: { expectedRevision: row.revision },
    }));
}

async function dropInsertBlockTrigger() {
    await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${INSERT_BLOCK_TRIGGER}" ON "ChangeOrderAutomationJob"`,
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${INSERT_BLOCK_FUNCTION}"()`);
}

async function dropCompletionFailureTrigger() {
    await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${COMPLETION_FAILURE_TRIGGER}" ON "ChangeOrderAutomationJob"`,
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${COMPLETION_FAILURE_FUNCTION}"()`);
}

async function installCompletionFailureTrigger(jobId: string) {
    await dropCompletionFailureTrigger();
    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${COMPLETION_FAILURE_FUNCTION}"() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW."id" = '${jobId.replaceAll("'", "''")}'
               AND NEW."status" = 'SUCCEEDED' THEN
                RAISE EXCEPTION 'fixture-scoped completion failure for %', NEW."id";
            END IF;
            RETURN NEW;
        END;
        $$
    `);
    await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${COMPLETION_FAILURE_TRIGGER}"
        BEFORE UPDATE ON "ChangeOrderAutomationJob"
        FOR EACH ROW EXECUTE FUNCTION "${COMPLETION_FAILURE_FUNCTION}"()
    `);
}

async function installInsertBlockTrigger() {
    await dropInsertBlockTrigger();
    await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${INSERT_BLOCK_FUNCTION}"() RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW."changeOrderId" = '${ids.manualApproval.replaceAll("'", "''")}' THEN
                PERFORM pg_advisory_xact_lock(${INSERT_BLOCK_LOCK_KEY.toString()}::bigint);
            END IF;
            RETURN NEW;
        END;
        $$
    `);
    await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${INSERT_BLOCK_TRIGGER}"
        BEFORE INSERT ON "ChangeOrderAutomationJob"
        FOR EACH ROW EXECUTE FUNCTION "${INSERT_BLOCK_FUNCTION}"()
    `);
}

async function waitForBlockedAutomationInsert(isSettled: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isSettled()) throw new Error("Manual approval settled before its durable job insert was blocked");
        const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT COUNT(*)::int AS waiting
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%INSERT%ChangeOrderAutomationJob%'
        `;
        if (Number(row?.waiting ?? 0) > 0) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the approval transaction to block inside the job insert trigger");
}

async function waitForBlockedChangeOrderUpdate(isSettled: () => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isSettled()) throw new Error("Scope update settled before the review delivery released its row lock");
        const [row] = await prisma.$queryRaw<Array<{ waiting: number }>>`
            SELECT COUNT(*)::int AS waiting
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%ChangeOrder%FOR UPDATE%'
              AND query NOT ILIKE '%pg_stat_activity%'
        `;
        if (Number(row?.waiting ?? 0) > 0) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for the scope update to block on the review delivery row lock");
}

function injectedMilestonePreflight(dispatch: ReturnType<typeof buildFrozenNotification>): typeof sendMilestoneInvoicesCore {
    return async (invoiceId, scheduleIds, _overrideEmail, _opts, _actorName, automation) => {
        if (!automation) throw new Error("Automation delivery callbacks are required");
        const milestoneRows = await prisma.paymentSchedule.findMany({
            where: { invoiceId, id: { in: [...scheduleIds] } },
            select: {
                id: true,
                name: true,
                amount: true,
                status: true,
                qbInvoiceSentAt: true,
                qbInvoiceId: true,
                qbInvoiceLink: true,
                qbSyncError: true,
            },
        });
        const milestones = milestoneRows.map((row): MilestoneAttemptState => ({
            id: row.id,
            name: row.name,
            amount: Number(row.amount),
            status: row.status,
            qbInvoiceSentAt: row.qbInvoiceSentAt?.toISOString() ?? null,
            qbInvoiceId: row.qbInvoiceId ?? "",
            qbInvoiceLink: row.qbInvoiceLink,
            qbSyncError: row.qbSyncError,
        }));
        const persistedDispatch = await automation.persistFrozenNotification(dispatch);
        const staged = await automation.sendFrozenNotification?.(persistedDispatch, automation.idempotencyKey);
        if (!staged?.success) throw new Error("Injected milestone preflight was rejected");
        try {
            await automation.completeAfterDelivery({
                invoiceId,
                scheduleIds: [...scheduleIds],
                recipient: persistedDispatch.to[0],
                sentAt: new Date("2026-08-17T15:00:00.000Z"),
                providerMessageId: staged.id,
                milestoneFingerprint: milestoneDeliveryFingerprint(invoiceId, milestones),
                milestones,
            });
        } catch (error) {
            return {
                success: true,
                sent: scheduleIds.length,
                failed: 0,
                skipped: 0,
                deliveredButUnrecorded: true,
                results: scheduleIds.map(id => ({
                    id,
                    name: id,
                    status: "sent" as const,
                    sentTo: persistedDispatch.to[0],
                    error: (error as Error).message,
                })),
            };
        }
        return {
            success: true,
            sent: scheduleIds.length,
            failed: 0,
            skipped: 0,
            results: scheduleIds.map(id => ({
                id,
                name: id,
                status: "sent" as const,
                sentTo: persistedDispatch.to[0],
            })),
        };
    };
}

test.describe.serial("change-order durable automation outbox", () => {
    test.beforeAll(async () => {
        assertDisposableDatabase();
        await prisma.client.create({
            data: {
                id: ids.client,
                name: "CO Outbox Disposable Client",
                initials: "CO",
                email: `${run}@example.test`,
            },
        });
        await prisma.project.create({
            data: {
                id: ids.project,
                clientId: ids.client,
                name: "CO Outbox Disposable Project",
                status: "In Progress",
            },
        });
        await prisma.estimate.create({
            data: {
                id: ids.estimate,
                projectId: ids.project,
                code: `${run}-EST`,
                title: "CO Outbox Base Estimate",
                status: "Approved",
                totalAmount: 100,
                balanceDue: 100,
                taxExempt: false,
                taxRatePercent: 8.875,
                taxRateName: "Outbox exact rate",
            },
        });
        await Promise.all([
            createFixedChangeOrder(ids.claimRace, "Concurrent claim fixture"),
            createFixedChangeOrder(ids.manualApproval, "Transactional approval fixture"),
            createFixedChangeOrder(ids.attemptedReview, "Attempted review fixture"),
            createFixedChangeOrder(ids.safeReview, "Safe review fixture"),
            createApprovedFixedChangeOrder(ids.billCrash, "Billing crash fixture"),
            createApprovedFixedChangeOrder(ids.billDuplicateNames, "Duplicate schedule names fixture"),
            createApprovedFixedChangeOrder(ids.providerRetry, "Provider retry fixture"),
            createFixedChangeOrder(ids.reviewLock, "Live review lock fixture"),
            createApprovedFixedChangeOrder(ids.legacyRecovery, "Legacy recovery fixture", {
                revision: 7,
                approvedAt: LEGACY_APPROVED_AT,
            }),
            prisma.invoice.create({
                data: {
                    id: ids.billInvoice,
                    code: `${run}-INV-BILL`,
                    projectId: ids.project,
                    clientId: ids.client,
                    estimateId: ids.estimate,
                    status: "Draft",
                    subtotal: 100,
                    taxAmount: 0,
                    totalAmount: 100,
                    balanceDue: 100,
                },
            }),
            prisma.invoice.create({
                data: {
                    id: ids.providerInvoice,
                    code: `${run}-INV-PROVIDER`,
                    projectId: ids.project,
                    clientId: ids.client,
                    status: "Draft",
                    subtotal: 10,
                    taxAmount: 0.89,
                    totalAmount: 10.89,
                    balanceDue: 10.89,
                },
            }),
        ]);
        await prisma.changeOrderPaymentSchedule.createMany({
            data: [
                { id: `${run}-duplicate-plan-1`, changeOrderId: ids.billDuplicateNames, name: "Progress", amount: 5, order: 0 },
                { id: `${run}-duplicate-plan-2`, changeOrderId: ids.billDuplicateNames, name: "Progress", amount: 5, order: 1 },
            ],
        });
    });

    test.afterAll(async () => {
        try {
            await dropInsertBlockTrigger();
            await dropCompletionFailureTrigger();
            await prisma.changeOrderAutomationJob.deleteMany({
                where: { changeOrderId: { in: allChangeOrderIds } },
            });
            await prisma.invoiceEmailAttempt.deleteMany({
                where: { invoice: { projectId: ids.project } },
            });
            await prisma.changeOrder.deleteMany({ where: { id: { in: allChangeOrderIds } } });
            await prisma.estimate.deleteMany({ where: { id: ids.estimate } });
            await prisma.project.deleteMany({ where: { id: ids.project } });
            await prisma.client.deleteMany({ where: { id: ids.client } });
        } finally {
            await prisma.$disconnect();
        }
    });

    test("concurrent inline and cron drains execute one real fenced claim", async () => {
        const job = await enqueueReview(ids.claimRace, "claim-race");
        const providerEntered = deferred();
        const releaseProvider = deferred();
        let executions = 0;
        const executeJob = async () => {
            executions++;
            providerEntered.resolve();
            await releaseProvider.promise;
            return { kind: "success" as const, result: { source: "injected-no-network" } };
        };

        const inline = drainChangeOrderAutomationJobs({ jobId: job.id }, { executeJob });
        const cron = drainChangeOrderAutomationJobs({ jobId: job.id }, { executeJob });
        await providerEntered.promise;

        const loser = await Promise.race([
            inline.then(result => ({ worker: "inline", result })),
            cron.then(result => ({ worker: "cron", result })),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error("Second drainer did not lose the claim while the winner held its lease")), 5_000);
            }),
        ]);
        expect(loser.result.processed, `${loser.worker} should be the fenced-out drainer`).toBe(0);

        const processing = await prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(processing).toMatchObject({ status: "PROCESSING", attempts: 1 });
        expect(processing.claimToken).toBeTruthy();

        releaseProvider.resolve();
        const [inlineResult, cronResult] = await Promise.all([inline, cron]);
        const stored = await prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: job.id } });

        expect(executions).toBe(1);
        expect(inlineResult.processed + cronResult.processed).toBe(1);
        expect(stored).toMatchObject({
            status: "SUCCEEDED",
            attempts: 1,
            claimToken: null,
            result: { source: "injected-no-network" },
        });
    });

    test("manual FIXED approval and its complete non-client graph become visible in one commit", async () => {
        await installInsertBlockTrigger();
        const advisoryLockReady = deferred();
        const releaseAdvisoryLock = deferred();
        const blocker = prisma.$transaction(async tx => {
            await tx.$queryRawUnsafe(
                `SELECT 1 AS acquired FROM pg_advisory_xact_lock(${INSERT_BLOCK_LOCK_KEY.toString()}::bigint)`,
            );
            advisoryLockReady.resolve();
            await releaseAdvisoryLock.promise;
        }, { timeout: 15_000 });

        let approvalSettled = false;
        let approvalPromise: ReturnType<typeof manuallyApproveChangeOrderCore> | undefined;
        try {
            await advisoryLockReady.promise;
            const estimate = await prisma.estimate.findUniqueOrThrow({
                where: { id: ids.estimate },
                select: { taxExempt: true, taxRatePercent: true, taxRateName: true },
            });
            approvalPromise = manuallyApproveChangeOrderCore(ids.manualApproval, {
                staffName: "Integration Reviewer",
                approvedAt: new Date("2026-08-17T12:00:00.000Z"),
                expectedRevision: 0,
                expectedTaxFingerprint: coTaxFingerprint(estimate),
            });
            void approvalPromise.then(
                () => { approvalSettled = true; },
                () => { approvalSettled = true; },
            );

            await waitForBlockedAutomationInsert(() => approvalSettled);
            const [beforeCommit, jobsBeforeCommit] = await prisma.$transaction([
                prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.manualApproval } }),
                prisma.changeOrderAutomationJob.count({ where: { changeOrderId: ids.manualApproval } }),
            ]);
            expect(beforeCommit).toMatchObject({ status: "Draft", revision: 0 });
            expect(jobsBeforeCommit).toBe(0);

            releaseAdvisoryLock.resolve();
            await blocker;
            const approval = await approvalPromise;
            expect(approval?.transitioned).toBe(true);

            const [afterCommit, jobs] = await prisma.$transaction([
                prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.manualApproval } }),
                prisma.changeOrderAutomationJob.findMany({
                    where: { changeOrderId: ids.manualApproval },
                    orderBy: { kind: "asc" },
                }),
            ]);
            expect(afterCommit).toMatchObject({ status: "Approved", revision: 1 });
            expect(jobs.map(row => row.kind)).toEqual([
                "APPROVAL_BILL",
                "APPROVAL_SCHEDULE",
                "APPROVAL_TEAM_EMAIL",
            ]);
            expect(jobs.every(row => row.status === "PENDING" && row.approvalMode === "MANUAL")).toBe(true);
            expect(jobs.every(row => row.eventRevision === afterCommit.revision)).toBe(true);
            expect(jobs.filter(row => row.kind === "APPROVAL_CLIENT_EMAIL")).toHaveLength(0);
        } finally {
            releaseAdvisoryLock.resolve();
            await blocker.catch(() => undefined);
            await approvalPromise?.catch(() => undefined);
            await dropInsertBlockTrigger();
        }
    });

    test("a provider-attempted REVIEW job blocks both scope mutation and Draft deletion", async () => {
        const job = await enqueueReview(ids.attemptedReview, "attempted-review");
        const claimed = await claimChangeOrderAutomationJob(prisma, {
            jobId: job.id,
            claimToken: `${run}-attempt-owner`,
            now: new Date("2026-08-17T13:00:00.000Z"),
        });
        expect(claimed?.claimToken).toBe(`${run}-attempt-owner`);

        const checkpointed = await checkpointChangeOrderAutomationProviderDispatch(prisma, {
            jobId: job.id,
            claimToken: `${run}-attempt-owner`,
            dispatch: frozenReviewDispatch("Attempted review"),
            now: new Date("2026-08-17T13:00:01.000Z"),
        });
        expect(checkpointed?.firstProviderAttemptAt).toEqual(new Date("2026-08-17T13:00:01.000Z"));
        expect(await releaseChangeOrderAutomationJob(prisma, {
            jobId: job.id,
            claimToken: `${run}-attempt-owner`,
            error: "Injected ambiguous provider result",
            nextAttemptAt: new Date("2026-08-17T13:05:00.000Z"),
        })).toBe("PENDING");

        await expect(updateChangeOrderCore(ids.attemptedReview, {
            title: "Must stay unchanged",
            expectedRevision: 0,
        })).rejects.toBeInstanceOf(ChangeOrderReviewDeliveryUnresolvedError);
        await expect(deleteChangeOrderCore(ids.attemptedReview)).rejects.toThrow(/automation audit history/i);

        const [changeOrder, retainedJob] = await prisma.$transaction([
            prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.attemptedReview } }),
            prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: job.id } }),
        ]);
        expect(changeOrder).toMatchObject({ title: "Attempted review fixture", status: "Draft", revision: 0 });
        expect(retainedJob).toMatchObject({ status: "PENDING", attempts: 1 });
        expect(retainedJob.firstProviderAttemptAt).not.toBeNull();
    });

    test("a never-attempted pending REVIEW job is canceled by scope mutation and removed by Draft deletion", async () => {
        const job = await enqueueReview(ids.safeReview, "safe-review");
        const updated = await updateChangeOrderCore(ids.safeReview, {
            title: "Safely revised scope",
            expectedRevision: 0,
        });
        expect(updated).toMatchObject({ title: "Safely revised scope", status: "Draft", revision: 1 });

        const canceled = await prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: job.id } });
        expect(canceled).toMatchObject({
            status: "CANCELED",
            firstProviderAttemptAt: null,
            providerMessageId: null,
        });

        await expect(deleteChangeOrderCore(ids.safeReview)).resolves.toMatchObject({ id: ids.safeReview });
        expect(await prisma.changeOrder.findUnique({ where: { id: ids.safeReview } })).toBeNull();
        expect(await prisma.changeOrderAutomationJob.findUnique({ where: { id: job.id } })).toBeNull();
    });

    test("BILL crash retry returns two unique exact rows for duplicate signed schedule names without another write", async () => {
        const dependencies = {
            logActivity: async () => undefined as never,
            revalidatePath: () => undefined,
        };
        const first = await billChangeOrderCore(ids.billDuplicateNames, dependencies);
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error(first.error);
        expect(first.alreadyBilled).toBe(false);
        expect(first.milestones).toHaveLength(2);
        expect(new Set(first.milestones.map(row => row.id)).size).toBe(2);
        expect(new Set(first.milestones.map(row => row.name)).size).toBe(1);

        const before = await prisma.invoice.findUniqueOrThrow({
            where: { id: first.invoiceId },
            select: { subtotal: true, taxAmount: true, totalAmount: true, balanceDue: true, status: true },
        });
        const beforeRows = await prisma.paymentSchedule.findMany({
            where: { sourceChangeOrderId: ids.billDuplicateNames, status: { not: "Canceled" } },
            orderBy: { sourceCoScheduleId: "asc" },
        });

        const retry = await billChangeOrderCore(ids.billDuplicateNames, dependencies);
        expect(retry.ok).toBe(true);
        if (!retry.ok) throw new Error(retry.error);
        expect(retry.alreadyBilled).toBe(true);
        expect(retry.milestones.map(row => row.id)).toEqual(first.milestones.map(row => row.id));
        expect(new Set(retry.milestones.map(row => row.id)).size).toBe(2);

        const [after, afterRows] = await prisma.$transaction([
            prisma.invoice.findUniqueOrThrow({
                where: { id: first.invoiceId },
                select: { subtotal: true, taxAmount: true, totalAmount: true, balanceDue: true, status: true },
            }),
            prisma.paymentSchedule.findMany({
                where: { sourceChangeOrderId: ids.billDuplicateNames, status: { not: "Canceled" } },
                orderBy: { sourceCoScheduleId: "asc" },
            }),
        ]);
        expect(after).toEqual(before);
        expect(afterRows).toEqual(beforeRows);
    });

    test("a stale BILL retry converges after billing committed before the job terminal stamp", async () => {
        const graph = await enqueueClientApprovalGraph(ids.billCrash, 1);
        const billJob = graph.find(job => job.kind === "APPROVAL_BILL");
        expect(billJob).toBeTruthy();
        const invoiceBefore = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.billInvoice } });
        const firstClaimAt = new Date("2026-08-17T14:00:00.000Z");
        const firstClaim = await claimChangeOrderAutomationJob(prisma, {
            jobId: billJob!.id,
            claimToken: `${run}-bill-crashed-worker`,
            now: firstClaimAt,
        });
        expect(firstClaim?.attempts).toBe(1);

        const firstBill = await billChangeOrderCore(ids.billCrash, {
            logActivity: async () => undefined,
            revalidatePath: () => undefined,
        });
        expect(firstBill.ok).toBe(true);
        if (!firstBill.ok) throw new Error(firstBill.error);
        const firstMilestoneId = firstBill.milestones[0].id;

        const crashed = await prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: billJob!.id } });
        expect(crashed).toMatchObject({ status: "PROCESSING", attempts: 1, result: null });
        expect(await prisma.paymentSchedule.count({
            where: { sourceChangeOrderId: ids.billCrash, status: { not: "Canceled" } },
        })).toBe(1);

        // A new project invoice can appear between the committed BILL money
        // write and the stale job retry. The retry must keep the original
        // invoiceId that owns the existing source-CO milestone.
        await prisma.invoice.create({
            data: {
                id: ids.newerBillInvoice,
                code: `${run}-INV-BILL-NEWER`,
                projectId: ids.project,
                clientId: ids.client,
                estimateId: ids.estimate,
                status: "Draft",
                totalAmount: 0,
                balanceDue: 0,
            },
        });

        const reclaimed = await claimChangeOrderAutomationJob(prisma, {
            jobId: billJob!.id,
            claimToken: `${run}-bill-recovery-worker`,
            now: new Date(firstClaimAt.getTime() + 2_000),
            staleAfterMs: 1_000,
        });
        expect(reclaimed?.attempts).toBe(2);
        const outcome = await executeApprovalAutomationJob(reclaimed!);
        expect(outcome).toEqual({ kind: "completed" });

        const [storedJob, milestones, invoiceAfter] = await prisma.$transaction([
            prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: billJob!.id } }),
            prisma.paymentSchedule.findMany({
                where: { sourceChangeOrderId: ids.billCrash, status: { not: "Canceled" } },
                orderBy: { id: "asc" },
            }),
            prisma.invoice.findUniqueOrThrow({ where: { id: ids.billInvoice } }),
        ]);
        expect(milestones).toHaveLength(1);
        expect(milestones[0].id).toBe(firstMilestoneId);
        expect(storedJob).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
        expect(storedJob.result).toMatchObject({
            invoiceId: ids.billInvoice,
            milestoneIds: [firstMilestoneId],
            alreadyBilled: true,
        });
        expect(Number(invoiceAfter.totalAmount) - Number(invoiceBefore.totalAmount)).toBeCloseTo(10.89, 2);
        expect(Number(invoiceAfter.balanceDue) - Number(invoiceBefore.balanceDue)).toBeCloseTo(10.89, 2);
    });

    test("CLIENT retry reuses one frozen provider key after accepted delivery bookkeeping rolls back", async () => {
        const milestone = await prisma.paymentSchedule.create({
            data: {
                invoiceId: ids.providerInvoice,
                name: "Provider retry milestone",
                amount: 10.89,
                pretaxAmount: 10,
                taxAmount: 0.89,
                status: "Pending",
                sourceChangeOrderId: ids.providerRetry,
                qbInvoiceId: `${run}-qb-provider-invoice`,
                qbInvoiceLink: "https://qbo.example.test/provider-invoice",
            },
        });
        const graph = await enqueueClientApprovalGraph(ids.providerRetry, 1);
        const billJob = graph.find(job => job.kind === "APPROVAL_BILL")!;
        const clientJob = graph.find(job => job.kind === "APPROVAL_CLIENT_EMAIL")!;
        await prisma.changeOrderAutomationJob.update({
            where: { id: billJob.id },
            data: {
                status: "SUCCEEDED",
                completedAt: new Date("2026-08-17T14:30:00.000Z"),
                result: {
                    invoiceId: ids.providerInvoice,
                    invoiceCode: `${run}-INV-PROVIDER`,
                    milestoneIds: [milestone.id],
                },
            },
        });
        const expectedDispatch = await frozenInvoiceDispatch(
            ids.providerInvoice,
            "Frozen client payment request",
        );

        const providerCalls: Array<{ key: string; dispatch: unknown }> = [];
        const logicalProviderDeliveries = new Map<string, string>();
        const sendFrozenNotification = async (dispatch: ReturnType<typeof frozenReviewDispatch>, key: string) => {
            providerCalls.push({ key, dispatch });
            let providerId = logicalProviderDeliveries.get(key);
            if (!providerId) {
                providerId = `${run}-provider-message`;
                logicalProviderDeliveries.set(key, providerId);
            }
            return { success: true as const, id: providerId };
        };

        const firstClaim = await claimChangeOrderAutomationJob(prisma, {
            jobId: clientJob.id,
            claimToken: `${run}-client-first`,
            now: new Date("2026-08-17T15:00:00.000Z"),
        });
        expect(firstClaim).toBeTruthy();
        await installCompletionFailureTrigger(clientJob.id);
        const firstOutcome = await executeApprovalAutomationJob(firstClaim!, {
            now: () => new Date("2026-08-17T15:00:00.000Z"),
            sendMilestoneInvoices: injectedMilestonePreflight(expectedDispatch),
            sendFrozenNotification,
        });
        expect(firstOutcome.kind).toBe("retry");
        expect("error" in firstOutcome ? firstOutcome.error : "").toMatch(/bookkeeping did not commit|fixture-scoped completion failure/i);

        const afterRollback = await prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: clientJob.id } });
        expect(afterRollback).toMatchObject({ status: "PROCESSING", attempts: 1, providerMessageId: null });
        expect(afterRollback.firstProviderAttemptAt).not.toBeNull();
        expect(afterRollback.payload).toMatchObject({
            invoiceId: ids.providerInvoice,
            milestoneIds: [milestone.id],
            dispatch: expectedDispatch,
        });
        expect((await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: milestone.id } })).qbInvoiceSentAt).toBeNull();
        expect((await prisma.invoice.findUniqueOrThrow({ where: { id: ids.providerInvoice } })).status).toBe("Draft");

        await dropCompletionFailureTrigger();
        expect(await releaseChangeOrderAutomationJob(prisma, {
            jobId: clientJob.id,
            claimToken: firstClaim!.claimToken!,
            error: "Injected post-provider transaction rollback",
            nextAttemptAt: new Date("2026-08-17T15:00:01.000Z"),
            now: new Date("2026-08-17T15:00:00.500Z"),
        })).toBe("PENDING");
        const retryClaim = await claimChangeOrderAutomationJob(prisma, {
            jobId: clientJob.id,
            claimToken: `${run}-client-retry`,
            now: new Date("2026-08-17T15:00:02.000Z"),
        });
        expect(retryClaim?.attempts).toBe(2);
        const retryOutcome = await executeApprovalAutomationJob(retryClaim!, {
            now: () => new Date("2026-08-17T15:00:02.000Z"),
            sendMilestoneInvoices: async () => {
                throw new Error("A checkpointed retry must not rerun mutable QBO preflight");
            },
            sendFrozenNotification,
        });
        expect(retryOutcome).toEqual({ kind: "completed" });

        const [completed, stamped, issued, activities] = await prisma.$transaction([
            prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: clientJob.id } }),
            prisma.paymentSchedule.findUniqueOrThrow({ where: { id: milestone.id } }),
            prisma.invoice.findUniqueOrThrow({ where: { id: ids.providerInvoice } }),
            prisma.activityLog.findMany({
                where: { entityId: ids.providerInvoice, action: "sent_invoice" },
            }),
        ]);
        expect(providerCalls).toHaveLength(2);
        expect(providerCalls[1]).toEqual(providerCalls[0]);
        expect(logicalProviderDeliveries.size).toBe(1);
        expect(completed).toMatchObject({
            status: "SUCCEEDED",
            attempts: 2,
            idempotencyKey: providerCalls[0].key,
            providerMessageId: `${run}-provider-message`,
        });
        expect(stamped.qbInvoiceSentAt).toEqual(new Date("2026-08-17T15:00:02.000Z"));
        expect(issued.status).toBe("Issued");
        expect(activities).toHaveLength(1);

        const duplicateManualSend = await sendMilestoneInvoicesCore(
            ids.providerInvoice,
            [milestone.id],
            undefined,
            undefined,
            "Outbox duplicate-guard test",
        );
        expect(duplicateManualSend).toMatchObject({
            success: false,
            sent: 0,
            error: expect.stringMatching(/automatic change-order approval delivery is succeeded/i),
        });
    });

    test("REVIEW delivery keeps its scope lock through the provider and defeats a stale concurrent edit", async () => {
        const job = await enqueueExecutableReview(ids.reviewLock, "live-lock");
        const claimed = await claimChangeOrderAutomationJob(prisma, {
            jobId: job.id,
            claimToken: `${run}-review-live-worker`,
            now: new Date("2026-08-17T16:00:00.000Z"),
        });
        expect(claimed).toBeTruthy();
        const providerEntered = deferred();
        const releaseProvider = deferred();
        let reviewProviderKey: string | null = null;
        const deliveryPromise = executeReviewEmailAutomationJob(claimed!, {
            now: () => new Date("2026-08-17T16:00:01.000Z"),
            sendFrozenNotification: async (_dispatch, key) => {
                reviewProviderKey = key;
                providerEntered.resolve();
                await releaseProvider.promise;
                return { success: true, id: `${run}-review-provider-message` };
            },
        });
        await providerEntered.promise;

        const updatePromise = updateChangeOrderCore(ids.reviewLock, {
            title: "Concurrent stale scope must not land",
            expectedRevision: 0,
        });
        const updateIsSettled = settledFlag(updatePromise);
        try {
            await waitForBlockedChangeOrderUpdate(updateIsSettled);
            expect(updateIsSettled()).toBe(false);
        } finally {
            releaseProvider.resolve();
        }

        expect(await deliveryPromise).toEqual({ kind: "completed" });
        expect(reviewProviderKey).toBe(job.idempotencyKey);
        await expect(updatePromise).rejects.toBeInstanceOf(ChangeOrderRevisionConflictError);

        const [changeOrder, completedJob] = await prisma.$transaction([
            prisma.changeOrder.findUniqueOrThrow({ where: { id: ids.reviewLock } }),
            prisma.changeOrderAutomationJob.findUniqueOrThrow({ where: { id: job.id } }),
        ]);
        expect(changeOrder).toMatchObject({
            title: "Live review lock fixture",
            status: "Sent",
            revision: 1,
            sentAt: new Date("2026-08-17T16:00:01.000Z"),
        });
        expect(completedJob).toMatchObject({
            status: "SUCCEEDED",
            attempts: 1,
            providerMessageId: `${run}-review-provider-message`,
        });
    });

    test("legacy Approved recovery seeds durable work while terminally suppressing historic email", async () => {
        const seeded = await seedLegacyApprovedChangeOrderAutomationJobs(
            { cutoverAt: LEGACY_APPROVED_AT, limit: 10 },
            { db: prisma, now: () => new Date("2099-08-17T12:01:00.000Z") },
        );
        expect(seeded).toEqual({ seeded: 1, changeOrderIds: [ids.legacyRecovery] });
        const jobs = await prisma.changeOrderAutomationJob.findMany({
            where: { changeOrderId: ids.legacyRecovery },
            orderBy: { kind: "asc" },
        });
        expect(jobs.map(job => [job.kind, job.status])).toEqual([
            ["APPROVAL_BILL", "PENDING"],
            ["APPROVAL_CLIENT_EMAIL", "SKIPPED"],
            ["APPROVAL_SCHEDULE", "PENDING"],
            ["APPROVAL_TEAM_EMAIL", "SKIPPED"],
        ]);
        expect(jobs.filter(job => job.kind.endsWith("EMAIL")).every(job => job.completedAt !== null)).toBe(true);
        expect(await seedLegacyApprovedChangeOrderAutomationJobs(
            { cutoverAt: LEGACY_APPROVED_AT, limit: 10 },
            { db: prisma },
        )).toEqual({ seeded: 0, changeOrderIds: [] });
    });
});
