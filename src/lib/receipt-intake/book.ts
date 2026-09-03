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
import { receiptUrlRef } from "./receipt-url";
import {
    phaseConfidenceMin,
    phaseSuggestionIsConfident,
    QBO_ATTACHMENT_MAX_BYTES,
} from "./intake-core";
import { dayKeyInTimeZone, startOfDateInTimeZone } from "@/lib/tz-date";
// The SAME per-Purchase advisory lock the QBO importer takes — shared, not
// copied, so the two writers of one Purchase id cannot drift apart.
import { lockQboExpense } from "@/lib/qbo-expense-sync";
import {
    QBTimeoutError,
    remainingBudgetMs,
    type QBTokens,
    type RouteDeadline,
} from "@/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
    // ONE vendor comparison for the whole pipeline — see normalizeVendorName.
    normalizeVendorName,
    type CreateQBReceiptPurchaseInput,
    type CreateQBReceiptPurchaseResult,
    type QboReceiptGroup,
} from "@/lib/qbo-receipt-push";
import type { AutomationEventInput } from "@/lib/automation-events";
import type { VerifiedBytes } from "./stored-object";
import { backoffMs, MAX_BOOK_ATTEMPTS, preservedTaxWarning } from "./route-state";

/** The intake columns booking actually reads. Kept narrow so tests can build one by hand. */
export interface BookableRow {
    id: string;
    source: string;
    sourceRef: string;
    dryRun: boolean;
    projectId: string | null;
    costCodeId: string | null;
    suggestedCostCodeId: string | null;
    /** The model's confidence in that phase suggestion, 0..1. */
    suggestedConfidence: number | null;
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
    /** What finalize recorded; every download of this row is checked against it. */
    fileSha256: string;
    /**
     * The token this pass claimed the row with. Every write is a CAS on it, so
     * a worker whose claim was superseded cannot act on stale state.
     */
    claimToken: string | null;
    attempts: number;
    /** Carries a previous attachment failure across a retry — see below. */
    lastError: string | null;
    /**
     * Whatever this row currently holds. It is not booking's to interpret in
     * general — but the BOOKED write needs it to know whether a
     * "tax-implausible" warning has to survive the transition (see
     * preservedTaxWarning in route-state.ts).
     */
    stateReason: string | null;
    /**
     * True once a QBO create has been ATTEMPTED for this row. It is the only
     * honest answer to "could a Purchase exist?", and it is what decides whether
     * a park may release the strong key.
     */
    sendAttempted: boolean;
}

/**
 * MIRRORS the private ATTACHABLE_CONTENT_TYPES / MAX_ATTACHMENT_BYTES in
 * qbo-receipt-push.ts (:236, :202), which are not exported and which this
 * branch must not modify.
 *
 * The duplication is deliberate and is the lesser evil: without a PREFLIGHT the
 * QBO core happily creates the Purchase and then reports `attachment:"skipped"`
 * for a file it cannot take, and `bookReceipt` marked that BOOKED. The result is
 * a Purchase in the real books with no receipt attached — the one failure a
 * bookkeeper cannot spot later, because the Purchase looks complete and nothing
 * flags it. Every accepted .txt receipt hit this, as did anything between the
 * old 15 MiB intake ceiling and QBO's 8 MiB attachment ceiling — which is why
 * the two are now ONE constant.
 *
 * If either constant changes over there, this must change with it; the test
 * asserts the two ceilings against each other so the gap cannot silently widen.
 *
 * The SIZE half is no longer a mirror at all: intake-core exports the one
 * ceiling and every layer (bucket policy, /start, inspectStoredObject, this
 * preflight) uses it, so a file that reaches here can always be attached.
 */
const QBO_ATTACHABLE_MIMES = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "image/heic", "image/heif", "application/pdf",
]);
const MAX_QBO_ATTACHMENT_BYTES = QBO_ATTACHMENT_MAX_BYTES;

/**
 * Can QuickBooks take this file at all? Deterministic, so it is answered BEFORE
 * the Purchase is created and no money moves on a document that would arrive
 * without its evidence.
 */
export function attachmentBlocker(mimeType: string, byteLength: number): string | null {
    const essence = mimeType.split(";")[0].trim().toLowerCase();
    if (!QBO_ATTACHABLE_MIMES.has(essence)) return `mime:${essence}`;
    if (byteLength > MAX_QBO_ATTACHMENT_BYTES) return `size:${byteLength}`;
    return null;
}

/**
 * A booking needs enough runway to finish what it starts. Two QuickBooks round
 * trips (token refresh + the Purchase create, each with its own 20s fetch
 * deadline) plus the attachment upload and the commit do not fit in a few
 * seconds — and a booking cut off mid-flight is the worst outcome available: the
 * Purchase may exist in the real books while the row never learns it did.
 * Better to not start.
 */
export const MIN_BOOKING_BUDGET_MS = 25_000;

export type BookResult =
    /** Purchase + Expense exist and the row is BOOKED. */
    | { outcome: "booked"; qbPurchaseId: string; expenseId: string; alreadyExisted: boolean }
    /** A switch is off: stay BOOKING, try again in an hour, spend NO attempt. */
    | { outcome: "deferred"; reason: "push-disabled" | "push-paused" | "out-of-budget" }
    /**
     * Terminal: a human must look at it. No further automatic attempt.
     *
     * `releaseStrongKey` mirrors the Apps Script v3.5 rule. A parked row keeps
     * holding `dedupStrongKey` (the partial unique index covers every state
     * except DUPLICATE/VOID), so if we park BEFORE ever reaching QuickBooks —
     * the job has no estimate, the date is unusable — the key is being held by
     * a document that never became a purchase. A corrected re-send of the same
     * receipt would then be quarantined against a row that represents nothing.
     * Release in exactly that case. Once a send was ATTEMPTED the key must be
     * held: QBO may have created the Purchase and lost the response.
     */
    | { outcome: "needs-review"; reason: string; releaseStrongKey: boolean }
    /**
     * This worker's claim was superseded. It wrote nothing and sent nothing;
     * the row belongs to whoever holds the current token.
     */
    | { outcome: "stale" }
    /** Transport-class failure: attempts+1 and a backoff. */
    | { outcome: "retry"; attempts: number; nextRetryAt: Date; reason: string };

/** Structural subset of PrismaClient this module uses. */
/**
 * The Expense a crash-gap retry can find already sitting under this Purchase
 * id — and every field the receipt has an opinion about. Selecting only `id`
 * (which is what this used to do) is what made the blind link possible.
 */
export interface ExistingExpense {
    id: string;
    estimateId: string;
    amount: unknown;
    vendor: string | null;
    date: Date | null;
    costCodeId: string | null;
    receiptUrl: string | null;
}

export interface BookPrismaClient {
    project: {
        findUnique(args: any): Promise<{
            id: string;
            name: string;
            estimates: { id: string }[];
        } | null>;
    };
    expense: {
        findUnique(args: any): Promise<ExistingExpense | null>;
        create(args: any): Promise<{ id: string }>;
        update(args: any): Promise<unknown>;
    };
    /** For the shared per-qbPurchaseId advisory lock — see lockQboExpense. */
    $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
    receiptIntake: {
        update(args: any): Promise<unknown>;
        updateMany(args: any): Promise<{ count: number }>;
    };
    $transaction<T>(fn: (tx: BookPrismaClient) => Promise<T>): Promise<T>;
}

export interface BookDependencies {
    db: BookPrismaClient;
    /**
     * CAS on {id, state: BOOKING, claimToken} that persists sendAttempted.
     *
     * This is the LAST FENCE before QuickBooks, and the ONLY state check that
     * matters at this point: it returns false when the row has been re-claimed
     * or has moved on, and the booking then aborts having sent nothing — which
     * is the point, because a zombie worker resuming with a stale view must not
     * create a Purchase the live worker is about to create as well.
     *
     * Called from BOTH QBO-core hooks: immediately before the create, and when
     * the idempotency query finds a Purchase already there. The second is not
     * a send, but it is the same fact about the row (QuickBooks holds a
     * Purchase for it), written under the same fence.
     */
    markSendAttempted: (rowId: string, claimToken: string | null) => Promise<boolean>;
    /** The company's configured zone — Expense.date is a business calendar day. */
    companyTimeZone: () => Promise<string>;
    /**
     * Is this cost code a phase of THIS project? Re-asked at booking because the
     * project can change between READ and BOOKING.
     */
    isCostCodeAllowed: (projectId: string, costCodeId: string) => Promise<boolean>;
    /** env master switch — opt-IN, exactly like the qbo-receipts/create route. */
    isPushEnabled: () => boolean;
    /** Command Center pause switch (pause-only; fail-CLOSED on a read error). */
    isPushPaused: () => Promise<boolean>;
    /**
     * RECEIPT_INTAKE_DRYRUN, read FRESH at booking time — not the row's
     * persisted `dryRun` flag, which is snapshotted once at intake and never
     * rechecked. A row claimed while the switch was off keeps dryRun=false
     * forever, so it alone is not a kill switch: reverting the env var to stop
     * live QBO writes would not stop that row. Both must agree for a write.
     */
    isDryRunEnabled: () => boolean;
    getTokens: (deadline?: RouteDeadline) => Promise<QBTokens>;
    createPurchase: (
        tokens: QBTokens,
        input: CreateQBReceiptPurchaseInput,
        deadline: RouteDeadline | undefined,
        /** Invoked by the QBO core immediately before the create. */
        onBeforeCreate: () => Promise<void>,
        /**
         * Invoked by the QBO core when it finds this file's Purchase ALREADY in
         * QuickBooks — a path that never reaches the create, so `onBeforeCreate`
         * does not fire on it.
         */
        onExistingPurchase: () => Promise<void>,
    ) => Promise<CreateQBReceiptPurchaseResult>;
    /**
     * The invocation's ONE absolute deadline. Undefined = unbounded (tests).
     *
     * Deliberately the deadline OBJECT rather than a remaining-milliseconds
     * number: a number is measured once and then decays silently, so a booking
     * that spent 20s downloading its file still believed it had the budget it
     * was handed on entry. Every check below recomputes from this instead.
     */
    deadline?: RouteDeadline;
    /**
     * Reads the stored file back out of the private bucket. TAGGED, because a
     * confirmed 404 and a transient storage fault must not book the same way.
     */
    downloadBytes: (storagePath: string, expectedSha256: string) => Promise<VerifiedBytes>;
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

/**
 * `Expense.amount` is the GROSS total paid, tax included — Justin's call
 * (2026-09-01), overriding the plan's §4.5 "pre-tax" wording.
 *
 * The QBO Purchase still splits the tax onto its own reclaimable account; that
 * is a QuickBooks-side concern and it is unchanged. But ProBuild's `Expense`
 * has no tax column, and the expenses already imported from QBO
 * (lib/qbo-expense-sync.ts) record the gross line total. Booking the pre-tax
 * figure here would mean two intake paths writing the same table with two
 * different meanings of `amount`, so job-cost and variance reports would
 * silently under-count every receipt this pipeline touched.
 *
 * `ReceiptIntake.taxCents` keeps the split, so Phase 3 can add
 * `Expense.taxAmount` and derive the pre-tax number without re-reading a single
 * document.
 */
export function expenseAmountCents(_groups: QboReceiptGroup[], totalCents: number): number {
    return totalCents;
}

/**
 * The tax that was ACTUALLY applied, read back off the built groups — 0 when
 * `buildGroups` rejected the read (a check, or tax >= total). The audit row must
 * record what posted, not what the model asked for; otherwise the sales-tax
 * filing report reconciles against a number no Purchase ever carried.
 */
export function appliedTaxCents(groups: QboReceiptGroup[]): number {
    return groups
        .filter(g => g.tax === true)
        .reduce((sum, g) => sum + Math.round(g.amount * 100), 0);
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
    const timeZone = await deps.companyTimeZone();

    // Shadow mode is enforced by the WORKER, which never routes a dryRun row
    // here. This second check exists because "no QBO calls in dry run" is the
    // whole safety promise of the shadow week, and one guard in one caller is
    // not a promise. BOTH the row's persisted flag and the CURRENT global
    // switch gate the write — see isDryRunEnabled's doc comment for why the
    // row flag alone cannot serve as a kill switch.
    if (row.dryRun || deps.isDryRunEnabled()) {
        return { outcome: "deferred", reason: "push-disabled" };
    }

    // 1. The same two switches the qbo-receipts/create route checks. Off or
    //    paused is NOT a failure of this document: stay BOOKING, retry in an
    //    hour, spend no attempt.
    if (!deps.isPushEnabled()) return { outcome: "deferred", reason: "push-disabled" };
    if (await deps.isPushPaused()) return { outcome: "deferred", reason: "push-paused" };

    // Runway check BEFORE anything else that could touch QuickBooks. Deferred,
    // not retried: the document is fine and this costs it no attempt — the
    // invocation simply ran out of room, and the next pass has a full budget.
    const outOfRunway = () =>
        deps.deadline !== undefined && remainingBudgetMs(deps.deadline) < MIN_BOOKING_BUDGET_MS;
    if (outOfRunway()) return { outcome: "deferred", reason: "out-of-budget" };

    // Everything down to the QBO call is a PRE-SEND refusal for THIS attempt —
    // but row.sendAttempted (persisted when the row was claimed) can already be
    // true from an EARLIER attempt that reached QBO before a later re-read hit
    // one of these checks (e.g. the estimate was deleted between attempts).
    // parkedBeforeSend folds that in, so the strong key is handed back only
    // when no attempt, past or present, may have created a Purchase.
    if (!row.projectId) return parkedBeforeSend(row, "no-estimate");
    if (row.totalCents === null || row.totalCents <= 0) return parkedBeforeSend(row, "refund-or-zero");
    if (!row.txnDate) return parkedBeforeSend(row, "invalid-date");
    // Hoisted so the calendar day is computed ONCE and both the QBO TxnDate and
    // the Expense.date instant are derived from the same value.
    const calendarDay = toCalendarDate(row.txnDate);

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
    if (!project) return parkedBeforeSend(row, "no-estimate");
    const estimateId = project.estimates[0]?.id;
    if (!estimateId) return parkedBeforeSend(row, "no-estimate");

    // 3. Category groups (tax split).
    const groups = buildGroups(row.docType, row.totalCents, row.taxCents, row.refNumber);

    // 4. The one QBO write core. fileId = the Drive id when we have one, so a
    //    file v1 already booked keeps the SAME DocNumber and the create is a
    //    no-op rather than a second Purchase.
    const fileId = driveFileIdOf(row) ?? row.id;
    const isCheck = String(row.docType || "receipt").toLowerCase() === "check";

    // NEVER a Purchase without its receipt.
    //
    // This used to pass `fileBase64: undefined` when the bytes could not be
    // loaded and book anyway, which produces a QBO Purchase with no attachment
    // — the one thing the bookkeeper cannot fix later, because by then the
    // Purchase looks complete and nothing flags it. The receipt IS the evidence
    // for the expense; a booking without it is worse than no booking.
    //
    // A transient storage fault retries (the document is fine, Supabase was
    // not); an affirmative 404 is terminal and pre-send, so the strong key goes
    // back for a corrected re-upload.
    const download = await deps.downloadBytes(row.storagePath, row.fileSha256);
    if (!download.ok) {
        if (download.kind === "missing") return parkedBeforeSend(row, "receipt-bytes-missing");
        // The attachment about to ride along with a real Purchase is NOT the
        // document this row was verified as. Refuse — a Purchase carrying the
        // wrong receipt is worse than one carrying none.
        if (download.kind === "sha-mismatch") return parkedBeforeSend(row, "content-changed");
        return retry(row, deps, now, `storage:${download.message}`);
    }
    const bytes = download.bytes;

    // RE-CHECKED after the download, which is the slowest thing before the
    // send. An 8 MiB object over a slow link can eat the whole runway that the
    // entry check just approved.
    if (outOfRunway()) return { outcome: "deferred", reason: "out-of-budget" };

    // PREFLIGHT, before anything is created. A format or size QBO cannot accept
    // is a fact about this file, known now — so refuse now, rather than
    // discovering it from `attachment:"skipped"` after a Purchase already
    // exists in the real books without its receipt.
    const blocker = attachmentBlocker(row.mimeType, bytes.length);
    if (blocker) return parkedBeforeSend(row, `unsupported-attachment:${blocker}`);

    // Phase check ONE: immediately before the QBO create. The project can be
    // reassigned while this row sits in the queue, and a stale phase should be
    // caught before the books are touched, not only on the way to the Expense.
    const phaseBeforeSend = await resolvePhase(row, project.id, deps);

    // NOTE: a previous attachment failure deliberately does NOT short-circuit
    // here. createQBReceiptPurchase re-checks and re-uploads the file for an
    // EXISTING Purchase (ensureAttachmentOnExistingPurchase), so the retry is
    // the recovery — parking early would have made the stranded-receipt case
    // permanent, which is the opposite of the intent.

    const input: CreateQBReceiptPurchaseInput = {
        projectName: project.name,
        docType: isCheck ? "check" : "receipt",
        vendor: row.vendor ?? "",
        date: calendarDay,
        invoice: !isCheck && row.refNumber && row.refNumber !== "NoInv" ? row.refNumber : undefined,
        checkNumber: isCheck && row.refNumber ? row.refNumber.replace(/^Check/, "") : undefined,
        memo: row.memo ?? undefined,
        totalAmount: row.totalCents / 100,
        fileId,
        fileName: row.fileName ?? undefined,
        groups,
        fileBase64: bytes.toString("base64"),
        fileContentType: row.mimeType,
    };

    // TWO WAYS a Purchase can exist for this row by the time we are done:
    // this attempt posted one, or the idempotency query found one an earlier
    // attempt posted. Both mean the strong dedup key must be RETAINED when the
    // row parks — releasing it lets a resubmission book the same receipt twice.
    const sent = { attempted: false, purchaseKnownToExist: false };

    let result: CreateQBReceiptPurchaseResult;
    try {
        // The SAME absolute deadline for both round trips, so a slow token
        // refresh shortens the create rather than each helping itself to a
        // fresh 20s.
        const tokens = await deps.getTokens(deps.deadline);
        // Last gate before the books are touched: the refresh may have consumed
        // what was left.
        if (outOfRunway()) return { outcome: "deferred", reason: "out-of-budget" };

        // MARKED HERE — after the tokens and after the final budget check, and
        // IMMEDIATELY before the create.
        //
        // Earlier was wrong in the direction that costs money to undo: a token
        // refresh that threw, or a budget check that deferred, would have left
        // sendAttempted=true on a row that never reached QuickBooks, and its
        // strong key would then be held forever against a Purchase that does
        // not exist. Persisted rather than in-memory, because the case the flag
        // exists for is the process dying mid-create.
        // The mark happens INSIDE createQBReceiptPurchase, immediately before
        // the create — not here.
        //
        // Everything the QBO core does first can fail without any Purchase
        // existing: the DocNumber query, the project match, ensureVendor,
        // ensureCustomer, the account verification, the money validation.
        // Marking before all of that meant a vendor-duplicate or an
        // account-config fault left sendAttempted=true, and the row then held
        // its dedup key forever against a Purchase that was never created.
        //
        // The hook is also the last ownership fence: a CAS on the claim token
        // that THROWS when this worker has been superseded, which aborts the
        // create so a zombie cannot post a Purchase the live worker is about to
        // post as well.
        result = await deps.createPurchase(
            tokens,
            input,
            deps.deadline,
            async () => {
                const stillOurs = await deps.markSendAttempted(row.id, row.claimToken);
                if (!stillOurs) throw new StaleClaimError();
                sent.attempted = true;
            },
            // FENCED THE SAME WAY, for the same reason: the persisted flag is
            // what a later pass reads, and a superseded worker must not write it
            // (or carry on) at all.
            async () => {
                const stillOurs = await deps.markSendAttempted(row.id, row.claimToken);
                if (!stillOurs) throw new StaleClaimError();
                sent.purchaseKnownToExist = true;
            },
        );
    } catch (error) {
        // A lost CAS from inside the create hook: nothing was sent.
        if (error instanceof StaleClaimError) return { outcome: "stale" };
        const terminal = terminalReasonFor(error);
        // A send WAS attempted — by THIS call (`sent`) or by an earlier one
        // (row.sendAttempted, persisted at claim time) — QBO may hold a
        // Purchase whose response we lost, so the key stays claimed even
        // though the row is parked.
        if (terminal) {
            return { outcome: "needs-review", reason: terminal, releaseStrongKey: mayReleaseStrongKey(row, sent) };
        }
        // QBTimeoutError, QBNotConnectedError, network/fetch errors, QBO
        // 429/5xx and DB errors are all transport-class: try again later.
        return retry(row, deps, now, describe(error), purchaseMayExist(sent));
    }

    if (!result.ok) {
        // Every ok:false reason is a deterministic refusal, and — this is the
        // part that was wrong — EVERY one of them is decided BEFORE qbCreateFn
        // runs: project-not-matched, missing-vendor, invalid-date,
        // invalid-group-amount, amount-mismatch, duplicate-name,
        // overhead-*, and docnumber-conflict (which is the idempotency QUERY
        // finding somebody else's Purchase, not one of ours).
        //
        // So THIS attempt created no Purchase, and holding the strong key would
        // quarantine the corrected re-submission against a booking that never
        // happened. Release it — UNLESS an earlier attempt already reached QBO
        // (row.sendAttempted), in which case a Purchase may already exist and
        // the key stays claimed. A THROWN fault is different — it can come from
        // inside the create — and keeps the key.
        return {
            outcome: "needs-review",
            reason: `qbo-fault:${result.reason}`,
            releaseStrongKey: mayReleaseStrongKey(row, sent),
        };
    }

    // The Purchase exists. If the receipt is not ON it, that is not a success —
    // and this is checked on BOTH paths.
    //
    // The alreadyExists path was previously exempt, which is the path that
    // MATTERS: it is reached by every retry after a lost response, i.e. exactly
    // when a Purchase is most likely to be sitting there without its image. So
    // the one case the check existed for was the one case it skipped.
    //
    // "already-attached" is a success: the file was put on by an earlier
    // attempt. "failed:*" is an HTTP fault on the upload leg and is worth
    // another pass (the QBO core re-uploads for an existing Purchase, so the
    // retry genuinely recovers). "skipped" after a passing preflight means our
    // mirrored ceilings have drifted from QBO's and a human must look.
    if (result.attachment !== "attached" && result.attachment !== "already-attached") {
        if (result.attachment === "skipped") {
            return { outcome: "needs-review", reason: "unsupported-attachment:skipped", releaseStrongKey: false };
        }
        // A `failed:<4xx>` or `failed:fault` is QBO REFUSING this file — a
        // rejected format, an oversize body, a business-rule fault. Retrying it
        // twenty times changes nothing except how long the Purchase sits in the
        // books without its receipt, so it goes to a human on the first one.
        // Only a transient class (5xx, a thrown network/abort error) is worth
        // another pass. The key is retained either way: the Purchase EXISTS.
        if (isTerminalAttachmentFailure(result.attachment)) {
            return {
                outcome: "needs-review",
                reason: `attachment-refused:${result.attachment}`,
                releaseStrongKey: false,
            };
        }
        return retry(row, deps, now, `${ATTACHMENT_FAILED_PREFIX}${result.attachment}`, purchaseMayExist(sent));
    }

    // WHEN THE PURCHASE WAS ALREADY IN THE BOOKS, THE BOOKS DECIDE.
    //
    // `alreadyExists` is not only the lost-response retry. It is also every
    // v1-cutover document (the Apps Script posted the Purchase from its OWN
    // read of the file) and every Drive revision that kept its fileId — and in
    // both, QuickBooks may hold a total, a date, a vendor or a job that this
    // pipeline's OCR pass does not agree with. Writing the Expense from the OCR
    // read regardless left ProBuild's job cost carrying a number the books do
    // not have, under a `qbPurchaseId` that says the two are the same document.
    //
    // The split is deliberate (see ExistingPurchaseCheck in qbo-receipt-push):
    // amount/date/vendor are OCR noise on our side and QuickBooks is the booked
    // truth for them; project and tax are ATTRIBUTION, so a mismatch parks with
    // no Expense written at all. Nothing here rewrites QuickBooks either way —
    // the Purchase is left exactly as it is.
    //
    // TOLERANCE IS FOR IDENTITY, NOT FOR VALUES — and conflating the two is the
    // bug this block used to have.
    //
    // `compareExistingPurchase` allows a Purchase to differ by up to two cents
    // on the amount or the tax, and to spell the vendor with different case and
    // spacing, and still call it the SAME purchase. That tolerance exists so a
    // rounding split or a capitalisation difference does not send a perfectly
    // ordinary receipt to a human. It says nothing about which numbers to
    // STORE. Adopting only on `derive` meant a verdict of `match` wrote the OCR
    // total into job cost while QuickBooks held a figure one cent away, logged
    // the OCR tax to the audit register as "what posted", and — on the
    // importer-won crash gap — met the importer's QBO-sourced row at the exact
    // comparison in reconcileExistingExpense and parked a receipt that was
    // never wrong about anything.
    //
    // So: once the Purchase is IDENTIFIED, every value persisted or reported
    // comes from what QuickBooks actually posted. `match` and `derive` adopt
    // identically; only `differences` (the beyond-tolerance fields) is a
    // reporting distinction.
    let expenseTotalCents = row.totalCents;
    let expenseCalendarDay = calendarDay;
    let expenseVendor = row.vendor;
    /** QBO's posted tax, in cents. Null until a Purchase is identified. */
    let bookedTaxCents: number | null = null;
    let derivedNote = "";
    let derivedFields: string[] | undefined;
    if (result.alreadyExists) {
        const existing = result.existing;
        if (existing.verdict === "review") {
            // The key is RETAINED unconditionally: a Purchase provably exists.
            return {
                outcome: "needs-review",
                reason: `${QBO_PURCHASE_MISMATCH_PREFIX}${existing.differences.join(",")}`,
                releaseStrongKey: false,
            };
        }
        // Both surviving verdicts mean "this is the same purchase". A null here
        // is unreachable for `derive` (a field it names was readable by
        // definition) and possible for `match` only if QBO omitted the ref's
        // display name — in which case the OCR value is all there is.
        const booked = existing.booked;
        if (booked.totalAmount !== null) expenseTotalCents = Math.round(booked.totalAmount * 100);
        if (booked.txnDate !== null) expenseCalendarDay = booked.txnDate;
        if (booked.vendor !== null) expenseVendor = booked.vendor;
        // Never null: a tax reading QBO did not give would have been `review`.
        bookedTaxCents = Math.round(booked.taxAmount * 100);
        if (existing.differences.length > 0) {
            derivedFields = existing.differences;
            derivedNote = ` · ${existing.differences.join(", ")} taken from the existing QuickBooks Purchase`;
            console.warn(
                "[receipt-intake] expense derived from the existing QBO Purchase",
                JSON.stringify({ rowId: row.id, qbPurchaseId: result.qbPurchaseId, differences: existing.differences }),
            );
        }
    }

    // 5. One transaction: the Expense and the row's BOOKED state land together
    //    or not at all. alreadyExists:true books the same way — that is the
    //    lost-response retry, and QBO's idempotency has already guaranteed
    //    there is exactly one Purchase.
    const amountCents = expenseAmountCents(groups, expenseTotalCents);
    // WHAT POSTED, and for an already-existing Purchase that is QBO's figure,
    // not the one this pass built from the OCR read. `appliedTaxCents` reads
    // back the groups WE were about to send; on the alreadyExists path those
    // groups were never sent, so reporting them as "what posted" put a number
    // in the sales-tax filing register that no Purchase ever carried.
    const taxApplied = bookedTaxCents ?? appliedTaxCents(groups);
    // RE-VALIDATE THE PHASE AGAINST THE FINAL PROJECT.
    //
    // Both the captured code and the model's suggestion were resolved while the
    // row was being READ — and at that point the row may have had NO project at
    // all (NEEDS_JOB), or a different one that a human then corrected. A cost
    // code from the old project is not a phase of the new one, and posting an
    // Expense against it puts real money on a phase that job does not have,
    // which every variance report then reads as overspend on a line nobody
    // budgeted.
    //
    // "The cost code exists" is not a permission (project-phases.ts:125), so
    // this asks the same question the clock-in validation asks. A mismatch is
    // NOT a failure: the receipt is fine and its total is right, so it books
    // UNCODED and says why. A bookkeeper assigning a phase is routine; an
    // expense silently attached to the wrong one is not.
    // Phase check TWO: immediately before the Expense write, INSIDE the same
    // window as the row's own commit. The create above is a network round trip
    // that can take seconds, and the answer that matters is the one true when
    // the money is recorded — a project reassignment that lands in between must
    // not be written into job cost.
    // EVERYTHING FROM HERE IS POST-SEND, so it is all inside the try.
    //
    // The phase re-check is a database round trip, and it used to sit OUTSIDE
    // the protected block. A throw there — a pool timeout, a dropped
    // connection — escaped bookReceipt entirely, so the worker's generic error
    // handler parked the row from the snapshot it claimed with, and that
    // snapshot says `sendAttempted: false`. The key was then released for a row
    // that has a Purchase in the real books, and the next submission of the
    // same receipt books it a second time.
    try {
        const phaseCheck = await resolvePhase(row, project.id, deps);
        if (phaseCheck.costCodeId !== phaseBeforeSend.costCodeId) {
            console.warn(
                "[receipt-intake] phase changed across the QBO create",
                JSON.stringify({ rowId: row.id, before: phaseBeforeSend.costCodeId, after: phaseCheck.costCodeId }),
            );
        }
        const costCodeId = phaseCheck.costCodeId;
        const driveFileId = driveFileIdOf(row);
        const receiptUrl = driveFileId
            ? `https://drive.google.com/file/d/${driveFileId}/view`
            // A STABLE reference, not a signed URL: the column outlives any link
            // we could mint here (ten minutes later it is dead), and every reader
            // mints its own from this — see resolveReceiptUrl.
            : receiptUrlRef(row.storagePath);
        // Hoisted: the reconcile compares against exactly what the create would
        // have written, so the two must be the same expression.
        const expenseDate = startOfDateInTimeZone(expenseCalendarDay, timeZone);
        const docRef = isCheck
            ? `Check #${(row.refNumber ?? "").replace(/^Check/, "") || "?"}${row.memo ? ` — "${row.memo}"` : ""}`
            : (row.refNumber && row.refNumber !== "NoInv" ? `Invoice ${row.refNumber}` : "Receipt");

        // The attribution the Expense ACTUALLY ends up carrying. Decided inside
        // the transaction (only the reconcile knows whether the row already had
        // a phase) and carried out here, because the audit event has to report
        // what was persisted rather than what this pass proposed.
        let effective: EffectiveAttribution = costCodeId
            ? { costCodeId, costCodeSource: "receipt", preserved: false }
            : { costCodeId: null, costCodeSource: "none", preserved: false };
        const expenseId = await deps.db.$transaction(async tx => {
            // THE SAME LOCK THE QBO IMPORTER TAKES, before this Purchase id is
            // read at all.
            //
            // `qbo-expense-sync` serializes every writer of one Purchase id on
            // this key before it reads or writes the Expense. This path writes
            // an Expense under the same key and was not taking it, so the
            // importer could create the row in the gap between the lookup
            // below and the link — and the two ended up disagreeing about the
            // same money. Shared as a function, not a copied string.
            await lockQboExpense(tx, result.qbPurchaseId);
            // A retry after a crash between the Purchase and this commit finds
            // its own Expense here (qbPurchaseId is @unique) — create it twice
            // and the insert would fail on that constraint anyway. It is ALSO
            // where the importer's row turns up: QBO expense sync imports the
            // Purchase on its own schedule, so a worker retry after a crash
            // routinely finds an Expense that this receipt never wrote.
            const existing = await tx.expense.findUnique({
                where: { qbPurchaseId: result.qbPurchaseId },
                select: {
                    id: true, estimateId: true, amount: true, vendor: true,
                    date: true, costCodeId: true, receiptUrl: true,
                },
            });
            if (existing) {
                // NEVER a blind link. See reconcileExistingExpense.
                const verdict = reconcileExistingExpense(existing, {
                    estimateId,
                    amountCents,
                    vendor: expenseVendor || "Unknown",
                    date: expenseDate,
                    calendarDay: expenseCalendarDay,
                    timeZone,
                    costCodeId,
                    receiptUrl,
                });
                if (verdict.conflicts.length > 0) {
                    throw new ExpenseConflictError(verdict.conflicts);
                }
                effective = verdict.attribution;
                // Fill what the importer could not know. `costCodeId` and
                // `receiptUrl` are not in QboExpenseWrite at all, so a
                // non-null value on an imported row can only have been put
                // there by a person (or an earlier receipt) — which is why the
                // rule is fill-when-null and never overwrite.
                if (Object.keys(verdict.fill).length > 0) {
                    await tx.expense.update({ where: { id: existing.id }, data: verdict.fill });
                }
            }
            const expense = existing ?? await tx.expense.create({
                data: {
                    estimateId,
                    costCodeId,
                    amount: amountCents / 100,
                    vendor: expenseVendor || "Unknown",
                    // RE-ANCHORED at write time. `txnDate` is a @db.Date column
                    // and round-trips as UTC midnight, so writing it straight
                    // into Expense.date (a full timestamp) records 5pm the
                    // PREVIOUS day in Pacific — and every job-cost and variance
                    // report that bounds by local midnight then counts the
                    // expense in the wrong period. The intake row keeps the
                    // calendar day; this makes the instant match it.
                    date: expenseDate,
                    // Booked with a qbPurchaseId already set — the Purchase is
                    // live in QuickBooks by the time this row commits, so this
                    // Expense is QBO-managed from birth, exactly like a QBO
                    // import. `assertExpenseMutableOutsideQbo` (qbo-expense-guard.ts)
                    // rejects approve/edit/delete on anything carrying a
                    // qbPurchaseId, and the bookkeeper queue (manager/receipts/page.tsx)
                    // only lists `status: "Pending"` rows as actionable. Leaving
                    // this "Pending" would put a QBO-managed row in that
                    // actionable queue with no route able to act on it — and
                    // a later QBO sync flipping it to "Reviewed" would look
                    // like human review that never happened. "Reviewed" keeps
                    // it out of the actionable queue and matches every other
                    // QBO-linked Expense.
                    status: "Reviewed",
                    receiptUrl,
                    qbPurchaseId: result.qbPurchaseId,
                    description:
                        `[Receipt intake] ${docRef}` +
                        phaseCheck.note +
                        (taxApplied > 0 ? ` · incl. $${(taxApplied / 100).toFixed(2)} sales tax` : "") +
                        derivedNote +
                        ` · booked to QuickBooks`,
                },
                select: { id: true },
            });
            // CAS again inside the commit. If the row was re-claimed between
            // the create and here, this transaction rolls back — including the
            // Expense — and the successor retries: QBO's DocNumber idempotency
            // returns the SAME Purchase, so it books once, under one owner.
            // Completing a BOOKED write from a stale worker would leave two
            // owners disagreeing about the row.
            const claimed = await tx.receiptIntake.updateMany({
                where: { id: row.id, state: "BOOKING", claimToken: row.claimToken },
                data: {
                    state: "BOOKED",
                    // Every OTHER value this column carries at BOOKING (a
                    // defer reason like "push-paused", a retry note) is
                    // transient and must not survive into BOOKED — but a
                    // dropped-tax-reading warning is a fact about the
                    // DOCUMENT, not about why booking was delayed, and must.
                    stateReason: preservedTaxWarning(row.stateReason),
                    qbPurchaseId: result.qbPurchaseId,
                    expenseId: expense.id,
                    bookedAt: now,
                    lastError: null,
                    nextRetryAt: null,
                    // Ownership is released by the write that completes the
                    // transition — a booked row is nobody's to hold.
                    claimToken: null,
                    claimedAt: null,
                },
            });
            if (claimed.count === 0) throw new StaleClaimError();
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
            // What POSTED, not what was requested — buildGroups rejects a tax
            // read on a check or when tax >= total, and the filing report has
            // to reconcile against the Purchase.
            taxCents: taxApplied,
            detail: {
                // `fileId` means a DRIVE file id — logAutomationEvent copies it
                // into the typed `driveFileId` column, which the cutover reads
                // to decide whether v1 already booked a document. Emitting an
                // intake cuid there filled that column with ids no Drive query
                // can ever match, and quietly widened what "v1 booked this"
                // could mean. Non-Drive rows carry their id in `intakeId`,
                // which every row has anyway.
                ...(driveFileId ? { fileId: driveFileId } : {}),
                qbPurchaseId: result.qbPurchaseId,
                intakeId: row.id,
                expenseId,
                sourceRef: row.sourceRef,
                // THE PERSISTED value, not the one this pass picked. When a
                // human's phase was already on the row it stands, and an audit
                // row naming the worker's choice would assert a cost code that
                // was never applied to anything.
                costCodeId: effective.costCodeId,
                costCodeSource: effective.costCodeSource,
                // Explicit, so "the worker's pick lost" is greppable rather
                // than something a reader has to infer from two ids.
                phasePreserved: effective.preserved || undefined,
                // Which fields (if any) this Expense took from the books rather
                // than from the read. Absent on the normal path.
                qboDerivedFields: derivedFields,
                // Carried through so the Command Center can show HOW confident
                // the phase pick was, and so a low-confidence run is auditable
                // after the fact rather than only at review time. Against the
                // EFFECTIVE code: a confidence score attached to a suggestion
                // that was not the one persisted describes nothing.
                suggestedConfidence: effective.costCodeId && effective.costCodeId === row.suggestedCostCodeId
                    ? row.suggestedConfidence
                    : undefined,
                phaseRejected: phaseCheck.rejected || undefined,
            },
        }).catch(() => { /* audit only */ });

        return {
            outcome: "booked",
            qbPurchaseId: result.qbPurchaseId,
            expenseId,
            alreadyExisted: result.alreadyExists,
        };
    } catch (error) {
        // A lost CAS is not a fault: the successor owns this row and will book
        // it. Say so rather than spending an attempt on it.
        if (error instanceof StaleClaimError) return { outcome: "stale" };
        // The Expense already under this Purchase id says something different
        // about the money. Retrying cannot resolve that — the next pass finds
        // the same row and the same disagreement — so it goes to a person.
        //
        // The key is RETAINED: the Purchase provably exists (we either created
        // it or the idempotency query found it), and releasing it would let a
        // resubmission of the same receipt book a second one.
        if (error instanceof ExpenseConflictError) {
            return {
                outcome: "needs-review",
                reason: `${EXPENSE_CONFLICT_PREFIX}${error.fields.join(",")}`,
                releaseStrongKey: false,
            };
        }
        // The Purchase EXISTS at this point. Retrying is correct and safe: the
        // DocNumber lookup will find it and return alreadyExists:true — and the
        // key must be RETAINED, which is why this attempt's send flag is passed
        // rather than the row's stale copy.
        return retry(row, deps, now, describe(error), purchaseMayExist(sent));
    }
}

/**
 * Does QuickBooks (possibly) hold a Purchase for this row after this attempt?
 *
 * `attempted` covers a create we issued — including one whose response we lost.
 * `purchaseKnownToExist` covers the idempotency query finding one an earlier
 * attempt posted, which is the path that never reaches the create at all.
 */
function purchaseMayExist(sent: { attempted: boolean; purchaseKnownToExist: boolean }): boolean {
    return sent.attempted || sent.purchaseKnownToExist;
}

/**
 * Centralized strong-key release decision for every needs-review path.
 *
 * A Purchase may exist for this row because of THIS attempt's send (`sent`)
 * or because of an EARLIER attempt's send — `row.sendAttempted`, persisted
 * when the row was claimed, so it survives even when this attempt never
 * reaches QBO at all (a re-read hitting a deleted estimate, a missing
 * object, or any other pre-send/ok:false refusal on a retry). The strong key
 * may only be released when neither is true.
 */
function mayReleaseStrongKey(
    row: BookableRow,
    sent: { attempted: boolean; purchaseKnownToExist: boolean } = { attempted: false, purchaseKnownToExist: false },
): boolean {
    return !(row.sendAttempted || purchaseMayExist(sent));
}

function describe(error: unknown): string {
    if (error instanceof QBTimeoutError) return "QBTimeoutError";
    if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 400);
    return "UnknownError";
}

/**
 * RECONCILE A RECEIPT AGAINST AN EXPENSE THAT IS ALREADY THERE.
 *
 * The row under this `qbPurchaseId` is not necessarily one we wrote. The
 * expected case is a crash-gap race: the worker creates the QBO Purchase, dies
 * before its commit, and QBO expense sync imports that Purchase before the
 * retry comes round. The imported row is correct about the money (it came from
 * the same Purchase) and knows nothing about this receipt — no cost code, no
 * receiptUrl, because `QboExpenseWrite` carries neither column. Legacy rows,
 * and rows a person has edited, can disagree about more.
 *
 * Blindly linking it — which is what selecting `{ id: true }` and taking the
 * `existing ?? create` branch amounted to — marked the intake row BOOKED
 * against a job-cost row that might name a different job, a different amount,
 * or no phase at all, under an id that asserts the two are the same document.
 *
 * So the fields split by what a disagreement MEANS:
 *
 *   MONEY AND IDENTITY (estimate, amount, vendor, date) — the receipt and the
 *   Expense are supposed to be two views of one Purchase, and by the time this
 *   runs the receipt's own values have already been derived FROM QuickBooks
 *   whenever the Purchase pre-existed (see the `alreadyExists` block above).
 *   A populated field that still disagrees is a real contradiction about real
 *   money, and nothing here can safely pick a winner: it parks for a human.
 *   A NULL one (vendor and date are nullable) is missing attribution and is
 *   filled from the receipt.
 *
 *   ATTRIBUTION (costCodeId, receiptUrl) — filled when null, never overwritten.
 *   The importer cannot write either column, so a value there came from a
 *   person or from an earlier receipt, and theirs is the answer that stands.
 *   That IS the human-source predicate for this schema; there is no provenance
 *   column to consult and no `notHumanCodedExpenseWhere` helper in this
 *   codebase (checked: the name appears nowhere), so "the importer could not
 *   have written this" is the honest test.
 *
 * Pure, so the whole truth table is a unit test rather than a race.
 */
export interface ReceiptExpenseValues {
    estimateId: string;
    amountCents: number;
    vendor: string;
    date: Date;
    /** The company calendar day the receipt is filed under, e.g. "2026-09-01". */
    calendarDay: string;
    timeZone: string;
    costCodeId: string | null;
    receiptUrl: string;
}

/**
 * What the Expense will ACTUALLY carry once this reconcile is applied.
 *
 * Returned rather than re-derived at the audit site, because the caller cannot
 * work it out: the reconcile is the only thing that knows whether the row
 * already had a phase. The booking event used to log the value the WORKER
 * picked whatever happened, so a receipt whose phase was preserved from a
 * human's earlier choice produced an audit row asserting a cost code that was
 * never applied to anything.
 */
export interface EffectiveAttribution {
    costCodeId: string | null;
    /** Where the persisted value came from. */
    costCodeSource: "receipt" | "existing" | "none";
    /** True when a value already on the row displaced the one this pass chose. */
    preserved: boolean;
}

export interface ExpenseReconcile {
    conflicts: string[];
    fill: Record<string, unknown>;
    attribution: EffectiveAttribution;
}

export function reconcileExistingExpense(
    existing: ExistingExpense,
    receipt: ReceiptExpenseValues,
): ExpenseReconcile {
    const conflicts: string[] = [];
    const fill: Record<string, unknown> = {};

    if (existing.estimateId !== receipt.estimateId) conflicts.push("estimate");
    if (Math.round(Number(existing.amount) * 100) !== receipt.amountCents) conflicts.push("amount");

    // Nullable, so an absence is missing attribution rather than a contradiction.
    //
    // THE SAME NORMALIZER the identity check uses. Comparing byte-for-byte here
    // while `compareExistingPurchase` compared case- and whitespace-insensitively
    // meant QBO's canonical "Home Depot" and the receipt's "  home   depot "
    // were one vendor to the check that decided these are the same purchase and
    // two vendors to the check that decided whether to link them — so the
    // importer-won crash gap parked a receipt nothing was wrong with. (The
    // receipt's own vendor is now QBO's display name on that path anyway; this
    // is what keeps the two answers consistent for every other path, and for a
    // legacy row the importer never touched.)
    if (!existing.vendor) fill.vendor = receipt.vendor;
    else if (normalizeVendorName(existing.vendor) !== normalizeVendorName(receipt.vendor)) {
        conflicts.push("vendor");
    }

    if (!existing.date) fill.date = receipt.date;
    else if (!sameCalendarDay(existing.date, receipt)) conflicts.push("date");

    // FILL-ONLY. Never a conflict: a phase somebody chose is an answer, not a
    // contradiction about money, and overwriting it is the one outcome that
    // loses information nobody can recover.
    if (!existing.costCodeId && receipt.costCodeId) fill.costCodeId = receipt.costCodeId;
    if (!existing.receiptUrl) fill.receiptUrl = receipt.receiptUrl;

    return { conflicts, fill, attribution: effectiveAttribution(existing, receipt) };
}

function effectiveAttribution(
    existing: ExistingExpense,
    receipt: ReceiptExpenseValues,
): EffectiveAttribution {
    if (existing.costCodeId) {
        return {
            costCodeId: existing.costCodeId,
            costCodeSource: "existing",
            // Only a CONTEST counts as preserved: a receipt with no phase to
            // offer, or one offering the same phase, displaced nothing.
            preserved: !!receipt.costCodeId && receipt.costCodeId !== existing.costCodeId,
        };
    }
    return receipt.costCodeId
        ? { costCodeId: receipt.costCodeId, costCodeSource: "receipt", preserved: false }
        : { costCodeId: null, costCodeSource: "none", preserved: false };
}

/**
 * THE TWO WRITERS ANCHOR A CALENDAR DAY DIFFERENTLY, and comparing instants
 * would call every imported row a conflict.
 *
 * `qbo-expense-sync` writes `new Date(`${txnDate}T00:00:00.000Z`)` — UTC
 * midnight, a bare marker for the QBO calendar day. This file writes
 * `startOfDateInTimeZone(day, timeZone)` — the company's local midnight, which
 * is 07:00 or 08:00Z for Pacific. Both mean "the 3rd"; their `getTime()`s
 * differ by hours.
 *
 * So the ANCHOR IS DETECTED rather than guessed at, and accepting "either
 * reading matches" would be wrong: UTC midnight on the 4th reads as the 3rd in
 * Pacific, so an off-by-one-day row would sail through. A value that is
 * exactly UTC midnight is the importer's marker and means that UTC date;
 * anything else is a real instant and means the day it falls on locally.
 * (In a UTC company both readings coincide anyway.)
 */
function sameCalendarDay(stored: Date, receipt: ReceiptExpenseValues): boolean {
    const isUtcMidnightMarker = stored.getTime() % 86_400_000 === 0;
    const storedDay = isUtcMidnightMarker
        ? stored.toISOString().slice(0, 10)
        : dayKeyInTimeZone(stored, receipt.timeZone);
    return storedDay === receipt.calendarDay;
}

/**
 * The existing Expense contradicts this receipt about money or attribution.
 *
 * Terminal for the pass and the strong key is RETAINED: a Purchase provably
 * exists in QuickBooks, so releasing the key would let a resubmission book it
 * a second time. A person compares the two and decides.
 */
/**
 * The park reason a reviewer sees, and the prefix the queue filters on.
 * Distinct from QBO_PURCHASE_MISMATCH_PREFIX: that one is "QuickBooks and the
 * read disagree", this one is "our own job-cost row and the read disagree".
 */
export const EXPENSE_CONFLICT_PREFIX = "expense-conflict:";

class ExpenseConflictError extends Error {
    constructor(readonly fields: string[]) {
        super(`existing expense disagrees on ${fields.join(",")}`);
        this.name = "ExpenseConflictError";
    }
}

/** Thrown inside the commit transaction when the claim token no longer matches. */
class StaleClaimError extends Error {
    constructor() {
        super("the claim was superseded");
        this.name = "StaleClaimError";
    }
}

/** Marks a retry as "the Purchase exists but its receipt did not attach". */
export const ATTACHMENT_FAILED_PREFIX = "attachment-failed:";

/**
 * Marks a park as "QuickBooks already holds this Purchase and it does not say
 * what this document says". Its own reason, not folded into `qbo-fault:`,
 * because nothing is wrong with QuickBooks: the books and the read disagree
 * about the job or the tax split, and only a human may choose between them.
 *
 * Deliberately NOT in RECOVERABLE_PARK_REASONS — a re-upload of the same bytes
 * changes nothing, and dragging the row back would re-read it into the same
 * disagreement.
 */
export const QBO_PURCHASE_MISMATCH_PREFIX = "qbo-purchase-mismatch:";

/**
 * Is this attachment failure QBO refusing the file, rather than a blip?
 *
 * `failed:<status>` carries the HTTP status; `failed:fault` is an Intuit
 * business-rule rejection; `failed:<ErrorName>` comes from a thrown error and
 * is transient by nature (AbortError, TypeError from fetch, ...).
 */
export function isTerminalAttachmentFailure(attachment: string): boolean {
    const detail = attachment.slice("failed:".length);
    if (detail === "fault") return true;
    const status = Number(detail);
    return Number.isFinite(status) && status >= 400 && status < 500;
}

/**
 * Which phase (if any) this Expense may carry, checked against the project the
 * row will ACTUALLY book to.
 */
async function resolvePhase(
    row: BookableRow,
    projectId: string,
    deps: BookDependencies,
): Promise<{ costCodeId: string | null; note: string; rejected: string | null }> {
    // A human's explicit pick outranks the model's suggestion, but neither is
    // trusted without the project check.
    const explicit = row.costCodeId ?? null;
    const candidate = explicit ?? row.suggestedCostCodeId ?? null;
    if (!candidate) return { costCodeId: null, note: "", rejected: null };

    // THE CONFIDENCE THE PROMPT ASKS FOR IS NOW THE CONFIDENCE THAT DECIDES.
    //
    // read.ts tells the model a low number "sends the receipt to a human"; this
    // is where that becomes true. Below the threshold (or with no number at
    // all) the Expense books UNCODED and the suggestion is recorded as
    // REJECTED — the same signal the wrong-job branch below raises, so it
    // reaches the queue and the audit event through one path rather than two.
    // Checked before the project round trip: a suggestion we will not apply is
    // not worth a database call.
    if (!explicit && !phaseSuggestionIsConfident(row.suggestedConfidence)) {
        const stated = typeof row.suggestedConfidence === "number"
            ? row.suggestedConfidence.toFixed(2)
            : "none stated";
        return {
            costCodeId: null,
            note: ` · phase suggestion withheld (confidence ${stated} < ${phaseConfidenceMin()}) — assign one`,
            rejected: candidate,
        };
    }

    const allowed = await deps.isCostCodeAllowed(projectId, candidate);
    if (allowed) {
        const fromSuggestion = !row.costCodeId && candidate === row.suggestedCostCodeId;
        const confidence = row.suggestedConfidence;
        const note =
            fromSuggestion && typeof confidence === "number"
                ? ` · phase suggested (confidence ${confidence.toFixed(2)})`
                : "";
        return { costCodeId: candidate, note, rejected: null };
    }

    return {
        costCodeId: null,
        note: " · phase cleared (not a phase of this job) — assign one",
        rejected: candidate,
    };
}

/**
 * A refusal reached WITHOUT any QBO call in THIS attempt — the strong key goes
 * back, UNLESS row.sendAttempted (persisted at claim time) means an EARLIER
 * attempt may already hold a Purchase for this row.
 *
 * The rule is about the SEND, not about the reason: any terminal park that
 * provably created no Purchase — this attempt or any prior one — releases the
 * key, whatever the reason string says. Holding it makes a corrected
 * resubmission collide with a row that never became a purchase, and the
 * reviewer then has two stuck rows instead of one.
 */
function parkedBeforeSend(row: BookableRow, reason: string): BookResult {
    return { outcome: "needs-review", reason, releaseStrongKey: mayReleaseStrongKey(row) };
}

function retry(
    row: BookableRow,
    deps: BookDependencies,
    now: Date,
    reason: string,
    /**
     * Whether THIS attempt learned that a Purchase may exist — either because it
     * reached the create, or because the idempotency query found one already
     * there. `row.sendAttempted` is the value read when the row was CLAIMED, so
     * it is stale the moment the fenced mark runs, and a failure after that
     * point (the attachment leg, the Expense commit) judged on it alone would
     * wrongly release the key of a row that really does have a Purchase.
     */
    purchaseMayExistNow = false,
): BookResult {
    const sendAttempted = row.sendAttempted || purchaseMayExistNow;
    const attempts = row.attempts + 1;
    // `>=`, so MAX_BOOK_ATTEMPTS reads as "20 attempts in total" rather than 21.
    if (attempts >= MAX_BOOK_ATTEMPTS) {
        // Keyed on whether a send ever happened, not on the assumption that
        // reaching the retry limit implies one. A row can exhaust its attempts
        // entirely on storage faults, having never touched QuickBooks — and
        // holding its key then quarantines the corrected resend against nothing.
        return { outcome: "needs-review", reason: "max-retries", releaseStrongKey: !sendAttempted };
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
