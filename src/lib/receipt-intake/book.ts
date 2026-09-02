/**
 * Booking step — turn a READ intake row into a QuickBooks Purchase and a
 * ProBuild Expense (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §4, book.ts).
 *
 * This writes REAL BOOKS. Two rules shape everything below:
 *
 *  1. There is exactly ONE QBO write core, `createQBReceiptPurchase`
 *     (src/lib/qbo-receipt-push.ts). It is imported and called directly — never
 *     re-implemented, and never reached by HTTP from this worker. Its
 *     idempotency (DocNumber = fileId.slice(0,21) + the [gtr-file:...]
 *     PrivateNote marker + a QBO requestid) is what makes a retry safe.
 *  2. A 4xx-class business rejection is TERMINAL. Retrying a document QBO has
 *     already refused just burns the row's attempts and hides the problem; it
 *     goes to a human instead. Only transport-class failures retry.
 *
 * Every external effect is injected (`BookDependencies`), so the whole decision
 * tree is testable without QuickBooks, Supabase, or a database
 * (tests/receipt-intake-book.test.ts). No module mocking — CI is Node 20.
 */
import { matchCostCode } from "@/lib/project-match";
import { toSecureRef } from "@/lib/secure-storage";
import { QBTimeoutError, type QBTokens } from "@/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
    type CreateQBReceiptPurchaseInput,
    type CreateQBReceiptPurchaseResult,
    type QboReceiptGroup,
} from "@/lib/qbo-receipt-push";
import type { AutomationEventInput } from "@/lib/automation-events";
import { backoffMs, MAX_BOOK_ATTEMPTS } from "./route-state";

/** The intake columns booking actually reads. Kept narrow so tests can build one by hand. */
export interface BookableRow {
    id: string;
    source: string;
    sourceRef: string;
    dryRun: boolean;
    projectId: string | null;
    costCodeId: string | null;
    suggestedCostCodeId: string | null;
    storagePath: string;
    fileName: string | null;
    mimeType: string;
    vendor: string | null;
    txnDate: Date | null;
    totalCents: number | null;
    taxCents: number | null;
    docType: string | null;
    refNumber: string | null;
    memo: string | null;
    attempts: number;
}

export type BookResult =
    /** Purchase + Expense exist and the row is BOOKED. */
    | { outcome: "booked"; qbPurchaseId: string; expenseId: string; alreadyExisted: boolean }
    /** A switch is off: stay BOOKING, try again in an hour, spend NO attempt. */
    | { outcome: "deferred"; reason: "push-disabled" | "push-paused" }
    /** Terminal: a human must look at it. No further automatic attempt. */
    | { outcome: "needs-review"; reason: string }
    /** Transport-class failure: attempts+1 and a backoff. */
    | { outcome: "retry"; attempts: number; nextRetryAt: Date; reason: string };

/** Structural subset of PrismaClient this module uses. */
export interface BookPrismaClient {
    project: {
        findUnique(args: any): Promise<{
            id: string;
            name: string;
            estimates: { id: string }[];
        } | null>;
    };
    expense: {
        findUnique(args: any): Promise<{ id: string } | null>;
        create(args: any): Promise<{ id: string }>;
    };
    receiptIntake: {
        update(args: any): Promise<unknown>;
    };
    $transaction<T>(fn: (tx: BookPrismaClient) => Promise<T>): Promise<T>;
}

export interface BookDependencies {
    db: BookPrismaClient;
    /** env master switch — opt-IN, exactly like the qbo-receipts/create route. */
    isPushEnabled: () => boolean;
    /** Command Center pause switch (pause-only; fail-CLOSED on a read error). */
    isPushPaused: () => Promise<boolean>;
    getTokens: () => Promise<QBTokens>;
    createPurchase: (tokens: QBTokens, input: CreateQBReceiptPurchaseInput) => Promise<CreateQBReceiptPurchaseResult>;
    /** Reads the stored file back out of the private bucket for the QBO attachment. */
    downloadBytes: (secureRef: string) => Promise<Buffer | null>;
    logEvent: (event: AutomationEventInput) => Promise<void>;
    now: () => Date;
}

/** "drive:<fileId>" carries the Drive id; everything else books under the intake cuid. */
export function driveFileIdOf(row: Pick<BookableRow, "source" | "sourceRef">): string | null {
    if (row.source !== "drive") return null;
    const id = row.sourceRef.startsWith("drive:") ? row.sourceRef.slice("drive:".length) : "";
    return id || null;
}

/**
 * Port of sendToQBOviaAPI.js:129–178. GTR holds a reseller's permit, so sales
 * tax paid to vendors without the certificate on file is recoverable via a
 * state filing — when the read produced a tax line it becomes its own group so
 * ProBuild posts it to "Reimbursable Sales Tax Paid" and the filing total is a
 * one-click account report.
 *
 * Checks NEVER split tax (:148). An absent/unreadable tax (0) or a nonsense one
 * (tax >= total) falls back to the single-line shape — a bad tax read must
 * never block a booking. All math in integer cents; the two lines reconstruct
 * the total EXACTLY.
 */
export function buildGroups(
    docType: string | null,
    totalCents: number,
    taxCents: number | null,
    refNumber: string | null,
): QboReceiptGroup[] {
    const isCheck = String(docType || "receipt").toLowerCase() === "check";
    const tax = isCheck ? 0 : (taxCents ?? 0);
    if (tax > 0 && tax < totalCents) {
        return [
            { category: "Receipt (pre-tax)", amount: (totalCents - tax) / 100, lines: [] },
            { category: "Sales tax", amount: tax / 100, tax: true, lines: [] },
        ];
    }
    return [{
        category: isCheck ? (refNumber ? `Check #${refNumber.replace(/^Check/, "")}` : "Check #?") : "Receipt",
        amount: totalCents / 100,
        lines: [],
    }];
}

/** The Expense amount mirrors the QBO COGS line: pre-tax when the tax was split. */
export function expenseAmountCents(groups: QboReceiptGroup[], totalCents: number): number {
    const nonTax = groups.filter(g => g.tax !== true);
    if (nonTax.length === 0) return totalCents;
    return Math.round(nonTax.reduce((sum, g) => sum + g.amount, 0) * 100);
}

/** @db.Date round-trips as UTC midnight; QBO wants a bare calendar day. */
function toCalendarDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/**
 * A 4xx-class business rejection from QuickBooks. Retrying it cannot succeed —
 * the document must go to a human, not back on the queue.
 */
function terminalReasonFor(error: unknown): string | null {
    if (error instanceof QboPurchaseFaultError) {
        return `qbo-fault:${error.faultCode ?? error.status}`;
    }
    if (error instanceof QboAccountConfigError) return "qbo-fault:account-config";
    if (error instanceof QboVendorDuplicateError) return "qbo-fault:vendor-duplicate";
    return null;
}

/**
 * Book one row. Never throws for an expected failure mode: every outcome is a
 * BookResult the worker can persist, because a throw here would leave the row
 * in BOOKING with no reason recorded.
 */
export async function bookReceipt(row: BookableRow, deps: BookDependencies): Promise<BookResult> {
    const now = deps.now();

    // Shadow mode is enforced by the WORKER, which never routes a dryRun row
    // here. This second check exists because "no QBO calls in dry run" is the
    // whole safety promise of the shadow week, and one guard in one caller is
    // not a promise.
    if (row.dryRun) {
        return { outcome: "deferred", reason: "push-disabled" };
    }

    // 1. The same two switches the qbo-receipts/create route checks. Off or
    //    paused is NOT a failure of this document: stay BOOKING, retry in an
    //    hour, spend no attempt.
    if (!deps.isPushEnabled()) return { outcome: "deferred", reason: "push-disabled" };
    if (await deps.isPushPaused()) return { outcome: "deferred", reason: "push-paused" };

    if (!row.projectId) return { outcome: "needs-review", reason: "no-estimate" };
    if (row.totalCents === null || row.totalCents <= 0) {
        return { outcome: "needs-review", reason: "zero-total" };
    }
    if (!row.txnDate) return { outcome: "needs-review", reason: "invalid-date" };

    // 2. The project's LATEST estimate — the same "primary estimate" rule the
    //    v1 receipt-ingest endpoint uses (route.ts:69). Expense.estimateId is
    //    required, so a project with no estimate cannot be job-costed at all;
    //    that is terminal and costs no attempt.
    const project = await deps.db.project.findUnique({
        where: { id: row.projectId },
        select: {
            id: true,
            name: true,
            estimates: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
        },
    });
    if (!project) return { outcome: "needs-review", reason: "no-estimate" };
    const estimateId = project.estimates[0]?.id;
    if (!estimateId) return { outcome: "needs-review", reason: "no-estimate" };

    // 3. Category groups (tax split).
    const groups = buildGroups(row.docType, row.totalCents, row.taxCents, row.refNumber);

    // 4. The one QBO write core. fileId = the Drive id when we have one, so a
    //    file v1 already booked keeps the SAME DocNumber and the create is a
    //    no-op rather than a second Purchase.
    const fileId = driveFileIdOf(row) ?? row.id;
    const isCheck = String(row.docType || "receipt").toLowerCase() === "check";
    const bytes = await deps.downloadBytes(toSecureRef(row.storagePath));

    const input: CreateQBReceiptPurchaseInput = {
        projectName: project.name,
        docType: isCheck ? "check" : "receipt",
        vendor: row.vendor ?? "",
        date: toCalendarDate(row.txnDate),
        invoice: !isCheck && row.refNumber && row.refNumber !== "NoInv" ? row.refNumber : undefined,
        checkNumber: isCheck && row.refNumber ? row.refNumber.replace(/^Check/, "") : undefined,
        memo: row.memo ?? undefined,
        totalAmount: row.totalCents / 100,
        fileId,
        fileName: row.fileName ?? undefined,
        groups,
        fileBase64: bytes ? bytes.toString("base64") : undefined,
        fileContentType: bytes ? row.mimeType : undefined,
    };

    let result: CreateQBReceiptPurchaseResult;
    try {
        const tokens = await deps.getTokens();
        result = await deps.createPurchase(tokens, input);
    } catch (error) {
        const terminal = terminalReasonFor(error);
        if (terminal) return { outcome: "needs-review", reason: terminal };
        // QBTimeoutError, QBNotConnectedError, network/fetch errors, QBO
        // 429/5xx and DB errors are all transport-class: try again later.
        return retry(row, deps, now, describe(error));
    }

    if (!result.ok) {
        // Every ok:false reason from createQBReceiptPurchase is a deterministic
        // refusal (project-not-matched, docnumber-conflict, amount-mismatch,
        // missing-vendor, invalid-date, duplicate-name, ...). None becomes true
        // by waiting.
        return { outcome: "needs-review", reason: `qbo-fault:${result.reason}` };
    }

    // 5. One transaction: the Expense and the row's BOOKED state land together
    //    or not at all. alreadyExists:true books the same way — that is the
    //    lost-response retry, and QBO's idempotency has already guaranteed
    //    there is exactly one Purchase.
    const amountCents = expenseAmountCents(groups, row.totalCents);
    const costCodeId = row.costCodeId ?? row.suggestedCostCodeId ?? null;
    const driveFileId = driveFileIdOf(row);
    const receiptUrl = driveFileId
        ? `https://drive.google.com/file/d/${driveFileId}/view`
        : toSecureRef(row.storagePath);
    const docRef = isCheck
        ? `Check #${(row.refNumber ?? "").replace(/^Check/, "") || "?"}${row.memo ? ` — "${row.memo}"` : ""}`
        : (row.refNumber && row.refNumber !== "NoInv" ? `Invoice ${row.refNumber}` : "Receipt");

    try {
        const expenseId = await deps.db.$transaction(async tx => {
            // A retry after a crash between the Purchase and this commit finds
            // its own Expense here (qbPurchaseId is @unique) — create it twice
            // and the insert would fail on that constraint anyway.
            const existing = await tx.expense.findUnique({
                where: { qbPurchaseId: result.qbPurchaseId },
                select: { id: true },
            });
            const expense = existing ?? await tx.expense.create({
                data: {
                    estimateId,
                    costCodeId,
                    amount: amountCents / 100,
                    vendor: row.vendor || "Unknown",
                    date: row.txnDate,
                    status: "Pending",
                    receiptUrl,
                    qbPurchaseId: result.qbPurchaseId,
                    description:
                        `[Receipt intake] ${docRef}` +
                        (groups.length > 1 ? " · pre-tax (sales tax posted separately)" : "") +
                        ` · pending bookkeeper review`,
                },
                select: { id: true },
            });
            await tx.receiptIntake.update({
                where: { id: row.id },
                data: {
                    state: "BOOKED",
                    stateReason: null,
                    qbPurchaseId: result.qbPurchaseId,
                    expenseId: expense.id,
                    bookedAt: now,
                    lastError: null,
                    nextRetryAt: null,
                },
            });
            return expense.id;
        });

        // Audit row so the /automation register keeps seeing v2 bookings
        // alongside the bot's. Fire-and-forget by contract — never fails a
        // booking that already happened.
        await deps.logEvent({
            kind: "receipt-push",
            status: result.alreadyExists ? "already-exists" : "created",
            source: "intake-worker",
            vendor: row.vendor ?? undefined,
            projectName: project.name,
            docNumber: result.docNumber,
            fileName: row.fileName ?? undefined,
            amountCents,
            taxCents: row.taxCents ?? undefined,
            detail: {
                fileId,
                qbPurchaseId: result.qbPurchaseId,
                intakeId: row.id,
                expenseId,
                sourceRef: row.sourceRef,
            },
        }).catch(() => { /* audit only */ });

        return {
            outcome: "booked",
            qbPurchaseId: result.qbPurchaseId,
            expenseId,
            alreadyExisted: result.alreadyExists,
        };
    } catch (error) {
        // The Purchase EXISTS at this point. Retrying is correct and safe: the
        // DocNumber lookup will find it and return alreadyExists:true.
        return retry(row, deps, now, describe(error));
    }
}

function describe(error: unknown): string {
    if (error instanceof QBTimeoutError) return "QBTimeoutError";
    if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 400);
    return "UnknownError";
}

function retry(row: BookableRow, deps: BookDependencies, now: Date, reason: string): BookResult {
    const attempts = row.attempts + 1;
    if (attempts > MAX_BOOK_ATTEMPTS) {
        return { outcome: "needs-review", reason: "max-retries" };
    }
    return {
        outcome: "retry",
        attempts,
        nextRetryAt: new Date(now.getTime() + backoffMs(attempts)),
        reason,
    };
}

/**
 * Resolve the model's phase suggestion to a cost-code id, using the same
 * matcher the v1 ingest uses. Called by the READ step so booking stays
 * database-light and the suggestion is visible in the queue before it books.
 */
export function resolveSuggestedCostCodeId(
    suggestedPhaseCode: string,
    costCodes: { id: string; code: string; name: string }[],
): string | null {
    if (!suggestedPhaseCode) return null;
    return matchCostCode(suggestedPhaseCode, costCodes)?.id ?? null;
}
