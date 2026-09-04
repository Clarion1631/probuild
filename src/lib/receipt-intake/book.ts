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
import {
    HUMAN_COST_CODE_SOURCES,
    HUMAN_TAX_SOURCES,
    isPlausibleReceiptTax,
    lockEstimateAttribution,
    notHumanCodedExpenseWhere,
    taxNotHumanDecidedWhere,
} from "@/lib/expense-attribution";
import { lockExpense } from "@/lib/expense-lock";
import { assertPhaseOfProjectTx, lockAttributionParents } from "@/lib/phase-invariant";
import { dayKeyInTimeZone, startOfDateInTimeZone } from "@/lib/tz-date";
// The SAME per-Purchase advisory lock the QBO importer takes — shared, not
// copied, so the two writers of one Purchase id cannot drift apart.
import { lockQboExpense } from "@/lib/qbo-expense-sync";
import {
    isQBTimeoutError,
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
import { backoffMs, MAX_BOOK_ATTEMPTS, NO_ARTIFACT_PARK_REASONS, preservedTaxWarning } from "./route-state";
import { bumpReceiptEvidenceEpoch, lockReceiptEvidence } from "@/lib/receipt-evidence-lock";

/** The intake columns booking actually reads. Kept narrow so tests can build one by hand. */
export interface BookableRow {
    id: string;
    source: string;
    sourceRef: string;
    dryRun: boolean;
    projectId: string | null;
    costCodeId: string | null;
    /**
     * WHO supplied `costCodeId`: "user" (a signed-in person) or "machine" (a
     * shared-secret forwarder). Null on rows captured before this existed, and
     * treated as a machine guess — the safe direction, since it leaves the
     * phase correctable rather than freezing an unattributed guess in place.
     */
    costCodeSource: string | null;
    suggestedCostCodeId: string | null;
    /** The model's confidence in that phase suggestion, 0..1. */
    suggestedConfidence: number | null;
    /** Phase 3: the read found sales tax paid at the register. */
    taxAtSource: boolean;
    /** Phase 3: installed at a customer job (deductible) — null = unknown. */
    installedAtCustomer: boolean | null;
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
     * The durable dropped-tax-reading marker, written once by routing.
     * `stateReason` cannot carry it: every deferred booking overwrites that
     * column with its own reason. See preservedTaxWarning.
     */
    taxWarning?: string | null;
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
    /** A human changed the row (void, re-classify) between the claim and the
     * send. Nothing was sent and nothing is written back — the row is already
     * whatever they made it. */
    | { outcome: "aborted"; reason: string }
    /** The send WENT OUT and QuickBooks created a Purchase, but the row was
     * voided before the booked write landed. The money exists in QBO and only a
     * human can remove it; the id is parked on the row as
     * `postVoidQbPurchaseId` with stateReason "booked-after-void". */
    | { outcome: "booked-after-void"; qbPurchaseId: string }
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
    /**
     * NULLABLE on this schema (round 42, item 4b made the FK `SetNull`), so an
     * absent estimate is missing attribution rather than a contradiction — the
     * same reading `vendor` and `date` already get.
     */
    estimateId: string | null;
    amount: unknown;
    vendor: string | null;
    date: Date | null;
    costCodeId: string | null;
    receiptUrl: string | null;
    /**
     * THE PHASE 3 COLUMNS, all OPTIONAL.
     *
     * A caller that selects the narrow Phase 1 shape (the DB reconcile test,
     * and any reader that only cares about money and identity) gets exactly
     * the Phase 1 answers; `undefined` means "not read", which is deliberately
     * NOT the same as `null` ("read, and empty"). Every Phase 3 rule below is
     * therefore reached only by a caller that actually supplied the column.
     */
    projectId?: string | null;
    /** Provenance of `costCodeId` — see HUMAN_COST_CODE_SOURCES. */
    costCodeSource?: string | null;
    taxAmount?: unknown;
    taxAtSource?: boolean | null;
    /** Provenance of `taxAmount` ONLY — see HUMAN_TAX_SOURCES. */
    taxSource?: string | null;
    taxDeductibleBase?: unknown;
    installedAtCustomer?: boolean | null;
    /** The fallback half of the attribution, for a row with no `projectId`. */
    estimate?: { projectId: string | null } | null;
}

export interface BookPrismaClient {
    /**
     * The receipt-evidence lock runs through here (round-42 gate, finding 1):
     * this transaction changes what the sweep reads, so it queues behind it.
     */
    $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
    /**
     * And the evidence EPOCH is bumped through here (round-43 gate, finding 4),
     * so a sweep certifying a whole cycle can tell that evidence moved under it.
     */
    $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
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
        /** Guarded per-field fill — the predicate IS the guarantee. */
        updateMany(args: any): Promise<{ count: number }>;
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
        if (download.kind === "missing") return parkedBeforeSend(row, NO_ARTIFACT_PARK_REASONS.bytesMissing);
        // The attachment about to ride along with a real Purchase is NOT the
        // document this row was verified as. Refuse — a Purchase carrying the
        // wrong receipt is worse than one carrying none.
        if (download.kind === "sha-mismatch") return parkedBeforeSend(row, NO_ARTIFACT_PARK_REASONS.contentChanged);
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

    // AN IMPLAUSIBLE OCR TAX IS NOT A TAX FIGURE.
    //
    // `buildGroups` rejects a tax read on a check and one that is >= the total,
    // which leaves a wide band of nonsense it accepts: $90 of tax on a $100
    // receipt is a decimal-point or column misread, and it satisfies every
    // check the pipeline had. Booked as `taxAtSource`, it goes on a state
    // excise return as a $90 deduction nobody ever looked at.
    //
    // The bound is the SAME one the bookkeeper's PATCH enforces
    // (isPlausibleReceiptTax) — the two writers of this column must not be able
    // to disagree about what a believable figure is. The remedies differ
    // because the situations do: PATCH refuses the request, while booking
    // cannot refuse anything (the Purchase is already in QuickBooks). So the
    // figure is stored as NULL, the row is flagged `needsTaxReview`, and the
    // provenance still says "ocr" — a machine looked, and got an answer a
    // person now has to replace. The raw read stays on `ReceiptIntake.taxCents`
    // for audit, exactly as a rejected read does.
    //
    // Measured against `taxApplied`, which on the alreadyExists path is
    // QuickBooks' own posted tax rather than the OCR read — the plausibility
    // question is about the figure that will be STORED.
    const taxIsPlausible = isPlausibleReceiptTax(taxApplied / 100, amountCents / 100);
    const taxToStore = taxApplied > 0 && taxIsPlausible ? taxApplied / 100 : null;
    const taxNeedsReview = taxApplied > 0 && !taxIsPlausible;
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
        // Phase 3 provenance, derived from WHICH source survived the
        // re-validation above — not from which one was merely present. A
        // captured code that the final project does not carry is dropped by
        // resolvePhase, and calling the survivor "capture" would then be a
        // claim about a decision that did not stick.
        // A MACHINE'S CAPTURE IS NOT A HUMAN'S.
        //
        // Everything that arrived as `row.costCodeId` used to book as
        // "capture", which `HUMAN_COST_CODE_SOURCES` makes untouchable — so a
        // Drive folder name or a mail rule could pin a phase that no later pass
        // was allowed to correct, with exactly the authority of a person who
        // picked it. The intake row records which it was; booking carries that
        // through.
        const capturedByHuman = row.costCodeSource === "user";
        const costCodeSource = costCodeId
            ? (costCodeId === row.costCodeId ? (capturedByHuman ? "capture" : "machine") : "ai")
            : null;
        const costCodeConfidence = costCodeSource === "ai" ? row.suggestedConfidence : null;
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

        // ONE OBJECT, THREE WRITES.
        //
        // The Expense, the intake row's BOOKED update and the audit event all
        // have to say the same thing about the same money. They were three
        // separate expressions reaching for three different variables, and
        // they drifted exactly where it mattered: the audit reported
        // `row.vendor` (the OCR spelling) while the Expense carried QBO's, and
        // the intake row kept the OCR tax while both of the others recorded
        // what actually posted. Building it once makes agreement structural
        // rather than something three call sites have to remember.
        const booked = {
            vendor: expenseVendor || "Unknown",
            // The same instant `dateOnly` would produce for this calendar day —
            // written from `expenseDate` rather than importing that helper,
            // because it lives in worker.ts and worker.ts imports this file.
            // `ReceiptIntake.txnDate` is `@db.Date`, so the day is what lands.
            txnDate: expenseDate,
            date: expenseDate,
            totalCents: amountCents,
            taxCents: taxApplied,
        };
        const docRef = isCheck
            ? `Check #${(row.refNumber ?? "").replace(/^Check/, "") || "?"}${row.memo ? ` — "${row.memo}"` : ""}`
            : (row.refNumber && row.refNumber !== "NoInv" ? `Invoice ${row.refNumber}` : "Receipt");

        // The attribution the Expense ACTUALLY ends up carrying. Decided inside
        // the transaction (only the reconcile knows whether the row already had
        // a phase) and carried out here, because the audit event has to report
        // what was persisted rather than what this pass proposed.
        let effective: EffectiveAttribution = costCodeId
            ? { costCodeId, costCodeOrigin: "receipt", preserved: false }
            : { costCodeId: null, costCodeOrigin: "none", preserved: false };
        const expenseId = await deps.db.$transaction(async tx => {
            const raw = tx as unknown as { $queryRawUnsafe(q: string, ...v: unknown[]): Promise<unknown> };
            // ONE LOCK ORDER, STATED ONCE. Everything this transaction takes,
            // in the order it takes it:
            //
            //   0. `lockReceiptEvidence` — THE OUTERMOST LOCK, before anything
            //      is read or written here. This transaction moves a row to
            //      BOOKED and attaches its Expense, which is exactly what the
            //      missing-receipt sweep reads as "the receipt exists"
            //      (round-42 gate, finding 1). receipt-evidence-lock.ts states
            //      the rule for every writer: it is taken FIRST, before the
            //      component lock, the bank-line identity lock, or any
            //      `SELECT ... FOR UPDATE` — so it goes ahead of the three
            //      below rather than between them, or the receipt pipeline's
            //      writers would take the same two keys in two orders.
            //   1. `lockQboExpense`, keyed on `result.qbPurchaseId` — the
            //      identity. THE SAME LOCK THE QBO IMPORTER TAKES:
            //      `qbo-expense-sync` serializes every writer of one Purchase
            //      id on this key before it reads or writes the Expense. This
            //      path writes an Expense under the same key and was not
            //      taking it, so the importer could create the row in the gap
            //      between the lookup below and the link — and the two ended
            //      up disagreeing about the same money. Shared as a function,
            //      not a copied string.
            //   2. `lockAttributionParents` — Project -> Estimate ->
            //      EstimateItem -> CostCode, ascending id within each table
            //      (round 37, item 3). ONE call, whatever this row turns out to
            //      carry: `assertPhaseOfProjectTx` takes most of the set but
            //      takes NOTHING when the booking has no cost code, and the
            //      fills below still share-lock the Estimate through
            //      `lockEstimateAttribution` — which would leave an uncoded
            //      booking holding an Estimate lock with no Project lock, a
            //      different acquisition order from a coded one.
            //   3. `lockExpense`, on the id found below — the Expense itself,
            //      ALWAYS LAST (round 40, item 1). It is the child; every
            //      table the decision is derived from is held before it, and a
            //      transaction that reverses that is a cycle against this path.
            //      tests/attribution-lock-order.test.ts fails on any
            //      `$transaction` in `src/` that breaks 2-before-3 — it finds
            //      the acquisitions by SUBSTRING, which is why the names above
            //      are written without their call parentheses: a mention in
            //      this comment would otherwise read as an acquisition here.
            //
            // (1) is a `pg_advisory_xact_lock` on the Purchase id — not a row
            // lock on any of the ordered tables — so it sits OUTSIDE the
            // Project..Expense chain and taking it first cannot invert
            // anything inside it. It is first because it is the identity of
            // the document this whole transaction is about.
            await lockReceiptEvidence(tx);
            // AND MOVE THE EVIDENCE EPOCH (round-43 gate, finding 4). This
            // transaction owns the lock directly rather than going through
            // `withReceiptEvidenceLock`, so the bump the wrapper would have
            // done has to be done here — a sweep certifying a cycle needs to
            // see that evidence moved under it.
            await bumpReceiptEvidenceEpoch(tx);
            await lockQboExpense(tx, result.qbPurchaseId);
            await lockAttributionParents(raw, {
                projectId: project.id,
                estimateId,
                costCodeId,
            });
            // THE PHASE IS RE-ASKED HERE, THROUGH THIS TRANSACTION
            // (round 16 item 2; round 17 item 5).
            //
            // The two checks before this one both went through the global
            // datasource, outside any transaction: one before the QBO create,
            // one after it. Neither holds anything still, so an estimate
            // archived, reassigned, or a cost code deactivated while this
            // transaction runs would still be written into job cost.
            //
            // `assertPhaseOfProjectTx` locks the four tables the answer depends
            // on and then answers on THIS transaction's snapshot, so from here
            // the answer cannot change before the write. A code that is no
            // longer a phase PARKS the row: booking it would post money to a
            // line the job does not have, and booking it UNCODED would silently
            // discard a phase a person captured. Neither is ours to decide, and
            // the Purchase already exists, so a human is asked instead.
            const phaseStillValid = await assertPhaseOfProjectTx(raw, project.id, costCodeId);
            if (!phaseStillValid.ok) throw new PhaseRemovedError(phaseStillValid.reason);
            // A retry after a crash between the Purchase and this commit finds
            // its own Expense here (qbPurchaseId is @unique) — create it twice
            // and the insert would fail on that constraint anyway. It is ALSO
            // where the importer's row turns up: QBO expense sync imports the
            // Purchase on its own schedule, so a worker retry after a crash
            // routinely finds an Expense that this receipt never wrote.
            //
            // LOCK FIRST, THEN READ (round 13, item 4). The id is all that is
            // needed to take the lock, and taking it before the read every
            // decision below is made from is the difference between "the row
            // cannot move while I decide" and "the row could have moved
            // between my read and my lock". The second read happens inside the
            // lock, so it sees the winner of any race against the tax PATCH or
            // the QBO sync rather than a value from before it.
            const found = await tx.expense.findUnique({
                where: { qbPurchaseId: result.qbPurchaseId },
                select: { id: true },
            });
            if (found) await lockExpense(raw, found.id);
            const existing: ExistingExpense | null = found
                ? await tx.expense.findUnique({
                    where: { id: found.id },
                    select: {
                        id: true, estimateId: true, amount: true, vendor: true,
                        date: true, costCodeId: true, receiptUrl: true,
                        // The Phase 3 columns the fill reads before deciding.
                        // `projectId` and its estimate fallback are the other
                        // half of the attribution pair: a fill that writes one
                        // without the other leaves the row on two jobs at once.
                        projectId: true, costCodeSource: true,
                        taxAmount: true, taxAtSource: true, taxSource: true,
                        taxDeductibleBase: true, installedAtCustomer: true,
                        estimate: { select: { projectId: true } },
                    },
                })
                : null;
            // The reconcile's verdict is taken here and its FILL is HELD: the
            // writes wait until the void fence below has proved the row is
            // still ours to book.
            let fill: ReturnType<typeof reconcileExistingExpense>["fill"] = {};
            if (existing) {
                // NEVER a blind link. See reconcileExistingExpense.
                // From the SAME `booked` object the writes use: the reconcile
                // has to compare against the values that will actually be
                // persisted, or it is judging a row against numbers nobody
                // ever stores.
                const verdict = reconcileExistingExpense(existing, {
                    estimateId,
                    amountCents: booked.totalCents,
                    vendor: booked.vendor,
                    date: booked.date,
                    calendarDay: expenseCalendarDay,
                    timeZone,
                    costCodeId,
                    costCodeSource,
                    costCodeConfidence,
                    receiptUrl,
                    projectId: row.projectId,
                    taxAmount: taxToStore,
                    taxApplied,
                    taxNeedsReview,
                    installedAtCustomer: row.installedAtCustomer,
                });
                if (verdict.conflicts.length > 0) {
                    throw new ExpenseConflictError(verdict.conflicts);
                }
                effective = verdict.attribution;
                fill = verdict.fill;
            }
            // THE VOID FENCE, BEFORE ANY WRITE THIS TRANSACTION MAKES.
            //
            // It used to run after the Expense was created, which meant a void
            // landing during the QBO round trip still committed an Expense —
            // polluting job costs with a purchase somebody had explicitly
            // cancelled. The Expense, the reconcile's guarded fills and the
            // create all happen ONLY if this CAS succeeded, in the same
            // transaction. Losing it writes nothing.
            //
            // It sits AFTER the reconcile READ and its VERDICT above and
            // before any write: a conflicting imported Expense must park the
            // row for a human, and marking it BOOKED on the way to that
            // verdict would be the very thing the conflict check exists to
            // prevent. The Phase 3 fills therefore wait here too — a row
            // somebody voided mid-flight must not be left carrying a phase, a
            // tax answer or a receipt link this pass wrote.
            const claimed = await tx.receiptIntake.updateMany({
                where: { id: row.id, state: "BOOKING" },
                data: {
                    state: "BOOKED",
                    // Every OTHER value this column carries at BOOKING (a
                    // defer reason like "push-paused", a retry note) is
                    // transient and must not survive into BOOKED — but a
                    // dropped-tax-reading warning is a fact about the
                    // DOCUMENT, not about why booking was delayed, and must.
                    // This CAS *is* the BOOKED write (the void fence), so the
                    // preservation belongs here, not on the claim-confirm
                    // update below.
                    stateReason: preservedTaxWarning(row),
                    qbPurchaseId: result.qbPurchaseId,
                    bookedAt: now,
                    lastError: null,
                    nextRetryAt: null,
                    // THE BOOKED VALUES, PERSISTED — the same object the
                    // Expense and the audit event are built from, on the same
                    // write that says BOOKED.
                    //
                    // "QuickBooks is authoritative for an existing Purchase"
                    // was only half true: booking DERIVED the total, vendor,
                    // date and tax from QBO and wrote them to the Expense, but
                    // left this row carrying the OCR read. So `taxCents` — the
                    // column Phase 3's sales-tax reporting is specified to
                    // read — kept a figure no Purchase ever posted, and the
                    // row and its own Expense disagreed under a qbPurchaseId
                    // asserting they are one document.
                    //
                    // BOOKED OVERWRITES THE EXTRACTED VALUES, deliberately.
                    // There is no `extracted*` column pair on this model, and
                    // none is needed: `readJson` holds the raw model response
                    // verbatim and is never rewritten, so the OCR original
                    // remains auditable after the row records what posted.
                    vendor: booked.vendor,
                    txnDate: booked.txnDate,
                    totalCents: booked.totalCents,
                    taxCents: booked.taxCents,
                },
            });
            if (claimed.count === 0) {
                // The money EXISTS in QuickBooks and nothing here can take it
                // back (QBO is read-only from this pipeline). Record the
                // Purchase id where a human will see it — deliberately NOT
                // `qbPurchaseId`, which means "this row is booked", and this
                // row is not. The queue surfaces "booked-after-void" so
                // somebody voids it in QBO by hand. No Expense is written.
                //
                // FENCED ON THE CLAIM as well: a superseded worker writes
                // NOTHING to a row it no longer owns (Phase 1's rule). The
                // orphaned Purchase still reaches a human either way — the
                // "booked-after-void" audit event below is written regardless.
                await tx.receiptIntake.updateMany({
                    where: { id: row.id, claimToken: row.claimToken },
                    data: {
                        postVoidQbPurchaseId: result.qbPurchaseId,
                        stateReason: "booked-after-void",
                        nextRetryAt: null,
                    },
                });
                return null;
            }
            if (existing) {
                // EACH FIELD GETS ITS OWN GUARDED WRITE.
                //
                // The read above happened inside this transaction and inside
                // the per-expense lock, but a writer that does NOT take that
                // lock — a bookkeeper's PATCH, a migration, a path somebody
                // forgets to wire — can still commit between the read and
                // these writes, and that PATCH is exactly the authority this
                // fill must not overrun. Deciding from the read and then
                // writing unconditionally is the read-then-write shape the QBO
                // sync was already made to give up: the guarantee belongs in
                // the predicate, so a row that gained an answer in the gap
                // simply matches zero rows. The lock orders the writers that
                // take it; the predicate protects against one that does not.
                //
                // Split per field because the conditions differ and a single
                // predicate would make one field's contention veto another's
                // legitimate fill.
                //
                // `expectedProjectId` is the attribution EVERY decision was
                // made under — the conflict check above passed against it.
                // Pinning it in each predicate means a re-attribution landing
                // in the gap makes the fill match zero rows rather than
                // writing a phase and a tax answer onto a job they were never
                // about.
                const expectedProjectId = existing.projectId ?? null;

                // THE ATTRIBUTION IS FILLED AS A PAIR, OR NOT AT ALL
                // (round 20, item 3).
                //
                // This wrote `projectId` alone onto a row whose `estimateId`
                // belongs to whatever estimate v1 (or a crash) left there. If
                // that estimate is on another job, the result is an expense
                // claiming two jobs at once — `resolveExpenseProjectId` prefers
                // the column, every join through the estimate says otherwise,
                // and no report can be right about it.
                //
                // So the estimate this booking resolved is locked, its project
                // re-read, and BOTH columns move together. A disagreement that
                // cannot be resolved is not something to guess at: the row
                // parks and a person decides.
                if ("projectId" in fill) {
                    const pair = await lockEstimateAttribution(raw, estimateId);
                    if (!pair || pair.projectId !== row.projectId) {
                        throw new ExpenseConflictError(["attribution"]);
                    }
                    // The existing row may hang off NO estimate at all; both
                    // columns are written from the one locked read so the pair
                    // is consistent whichever it was.
                    await tx.expense.updateMany({
                        where: { id: existing.id, projectId: null },
                        data: { projectId: pair.projectId, estimateId: pair.estimateId },
                    });
                }
                if ("costCodeId" in fill) {
                    await tx.expense.updateMany({
                        where: {
                            id: existing.id,
                            projectId: expectedProjectId ?? row.projectId,
                            costCodeId: null,
                            // A human's phase outranks anything booking knows —
                            // through the ONE shared definition of "a human
                            // chose this", never a list restated here.
                            //
                            // THIS LIST USED TO BE HAND-ROLLED AS ["capture",
                            // "manual"] (round 37, item 1). "manual-none" — a
                            // bookkeeper who looked at the receipt and cleared
                            // the phase — was therefore NOT excluded, so the
                            // next intake retry of the same document matched
                            // the row (its code IS null) and restored the
                            // machine's code on top of the person's decision.
                            // The clear looked like it had never happened.
                            //
                            // `notHumanCodedExpenseWhere()` reads
                            // HUMAN_COST_CODE_SOURCES, and its explicit NULL
                            // branch is what keeps legacy rows eligible: SQL
                            // `NOT IN` drops NULLs, and an unset source is the
                            // common case.
                            ...notHumanCodedExpenseWhere(),
                        },
                        // NEVER `costCodeId` ALONE. The phase and its
                        // provenance are one fact: a code with no source reads
                        // as a legacy row that any later pass may overwrite,
                        // and the confidence belongs to the same decision.
                        data: {
                            costCodeId: fill.costCodeId,
                            costCodeSource: fill.costCodeSource,
                            costCodeConfidence: fill.costCodeConfidence,
                        },
                    });
                }
                // Tax is filled only where there is none recorded at all — a
                // stored figure came either from an earlier booking of this
                // same document or from a bookkeeper, and both outrank a
                // re-read.
                if ("taxAmount" in fill) {
                    // A MANUAL BASE CAN OUTLIVE A NULL taxAmount.
                    //
                    // The tax PATCH lets a bookkeeper set `taxDeductibleBase`
                    // while leaving `taxAmount` unanswered, and a base-only
                    // edit does not stamp `taxSource` either (it stamps
                    // `taxDeductibleBaseSource` instead) — so a row like that
                    // matches the guard below exactly like a legacy row with
                    // no tax opinion at all. It is not one: writing this OCR
                    // figure on top could push the human's base above the new
                    // ceiling (`amount - taxAmount`), which the DB CHECK
                    // (Expense_taxDeductibleBase_check,
                    // scripts/apply-expense-attribution.mjs) then refuses —
                    // and since the Purchase already exists in QBO, every
                    // retry of this row would hit the same violation again.
                    //
                    // Mirrors that CHECK verbatim: NULL and 0 always fit
                    // (nothing to violate); otherwise the base must point the
                    // same way as the amount and fit inside
                    // `amount - COALESCE(taxAmount, 0)`.
                    const existingBase =
                        existing.taxDeductibleBase == null ? null : Number(existing.taxDeductibleBase);
                    const amount = Number(existing.amount);
                    const nextTaxAmount = taxToStore ?? 0;
                    const ceilingMagnitude = Math.abs(Math.round((amount - nextTaxAmount) * 100) / 100);
                    const baseFitsNewTax =
                        existingBase === null ||
                        existingBase === 0 ||
                        (Math.sign(existingBase) === Math.sign(amount) &&
                            Math.abs(existingBase) <= ceilingMagnitude);
                    if (!baseFitsNewTax) {
                        // The manual base outranks a machine read: leave
                        // `taxAmount` and `taxSource` untouched and flag the
                        // row instead of writing a figure the CHECK would
                        // refuse. Recorded here, once, so a bookkeeper resolves
                        // the conflict rather than this write retrying against
                        // the same numbers on every future pass.
                        console.warn(
                            "[receipt-intake] tax-conflict: OCR tax would violate the deduction-base CHECK; flagging for review",
                            JSON.stringify({ rowId: row.id, expenseId: existing.id, existingBase, amount, ocrTax: taxToStore }),
                        );
                    }
                    await tx.expense.updateMany({
                        where: {
                            id: existing.id,
                            projectId: expectedProjectId ?? row.projectId,
                            taxAmount: null,
                            // A NULL taxAmount is NOT proof that nobody has
                            // decided. A bookkeeper who looked at the receipt
                            // and concluded there is no tax on it leaves
                            // exactly that shape, and an OCR re-read would then
                            // overwrite their answer with a number they had
                            // already rejected. `taxSource` is what tells the
                            // two apart. The explicit NULL branch is required:
                            // SQL `<> 'manual'` is NULL for a NULL column, so a
                            // bare not-equals would drop every legacy row.
                            ...taxNotHumanDecidedWhere(),
                        },
                        data: baseFitsNewTax
                            ? {
                                // Same bound as the create path below: an
                                // implausible read fills NOTHING and asks for a
                                // person instead. Writing it here would be
                                // worse than on a new row — this row may
                                // already be in a filing period somebody has
                                // reconciled.
                                taxAmount: fill.taxAmount,
                                taxAtSource: fill.taxAtSource,
                                // Provenance for `taxAmount` ONLY, and now the
                                // column means only that (round 33, item 4).
                                // A manually-set `taxDeductibleBase` from an
                                // earlier PATCH is not touched by this write
                                // and keeps its own `taxDeductibleBaseSource`
                                // — which is the point of the split. While one
                                // column governed both figures, this line made
                                // the row claim OCR had decided a base a
                                // person typed, and the value was the human's
                                // while the provenance said machine.
                                //
                                // `taxDeductibleBaseSource` is deliberately
                                // ABSENT from this data: booking supplies no
                                // base, so it has nothing to say about one.
                                taxSource: fill.taxSource,
                                ...(fill.needsTaxReview === true ? { needsTaxReview: true } : {}),
                            }
                            : { needsTaxReview: true },
                    });
                }
                if ("installedAtCustomer" in fill) {
                    await tx.expense.updateMany({
                        where: {
                            id: existing.id,
                            projectId: expectedProjectId ?? row.projectId,
                            // ITS OWN VALUE IS THE EVIDENCE.
                            //
                            // `installedAtCustomer` is a tri-state: non-null
                            // MEANS a person answered, so `null` is both the
                            // "unanswered" state and the entire guard. It is
                            // deliberately not gated on `taxSource`, which
                            // governs the two tax FIGURES: a receipt whose tax
                            // a bookkeeper has not touched must still be able
                            // to receive the capturer's installed-at-customer
                            // answer, and a receipt whose tax they HAVE set
                            // must not thereby block one.
                            installedAtCustomer: null,
                        },
                        data: { installedAtCustomer: fill.installedAtCustomer },
                    });
                }
                // What the importer could not know, and what a legacy row
                // never had. `vendor` and `date` are filled only when the
                // column is empty (a populated disagreement already parked
                // above); `receiptUrl` is not in QboExpenseWrite at all, so a
                // non-null value there can only have been put in by a person
                // or an earlier receipt — fill-when-null, never overwrite.
                const remainder = pick(fill, ["vendor", "date", "receiptUrl"]);
                if (Object.keys(remainder).length > 0) {
                    await tx.expense.updateMany({
                        where: {
                            id: existing.id,
                            projectId: expectedProjectId ?? row.projectId,
                            ...("vendor" in remainder ? { vendor: null } : {}),
                            ...("date" in remainder ? { date: null } : {}),
                            ...("receiptUrl" in remainder ? { receiptUrl: null } : {}),
                        },
                        data: remainder,
                    });
                }

                // VERIFY THE ATTRIBUTION THAT WAS ACTUALLY WRITTEN.
                //
                // Every predicate above is guarded, so any one of them can
                // legitimately match zero rows (a human answered first). What
                // must NOT happen is marking this intake row BOOKED against an
                // Expense that ended up on a DIFFERENT job than the row claims:
                // that is the same money-moved-between-jobs failure the
                // pre-fill conflict check exists to prevent, reached instead
                // through a re-attribution that commits while this runs.
                //
                // So the final state is re-read and compared with the intent. A
                // mismatch throws, which rolls the fills back with it, and the
                // row is parked for a person.
            }
            // ...AND IT RUNS WHETHER OR NOT THERE WAS ANYTHING TO FILL.
            //
            // An empty `fill` means every column this pass had an opinion about
            // was already answered — it does NOT mean nothing moved. The
            // re-attribution this catches is committed by a writer that does
            // not take the per-expense lock, so it can land between the
            // reconcile's read and this commit on a row this pass never wrote
            // to. Linking the intake row to an Expense that is now on somebody
            // else's job is the same failure either way.
            if (existing && row.projectId) {
                const after = await tx.expense.findUnique({
                    where: { id: existing.id },
                    select: { projectId: true, estimate: { select: { projectId: true } } },
                });
                const finalProjectId = after?.projectId ?? after?.estimate?.projectId ?? null;
                if (finalProjectId !== row.projectId) throw new ExpenseConflictError(["attribution"]);
            }
            // THE PAIR, RE-READ UNDER LOCK (round 21, item 1).
            //
            // `estimateId` was the project's newest estimate as of a query
            // taken before the QBO Purchase round trip. The fill path above
            // already re-reads it; the CREATE path wrote `row.projectId`
            // alongside an estimate nobody had looked at since, so an estimate
            // moved to another job in that window produced a brand new expense
            // on two jobs at once — the exact shape the fill path refuses.
            //
            // A disagreement is not something to guess at: the Purchase exists,
            // so the row parks as an attribution conflict and a person decides.
            let expense: { id: string };
            if (existing) {
                expense = existing;
            } else {
                const createdPair = await lockEstimateAttribution(raw, estimateId);
                if (!createdPair || createdPair.projectId !== row.projectId) {
                    throw new ExpenseConflictError(["attribution"]);
                }
                expense = await tx.expense.create({
                data: {
                    // ONE PAIR, from one locked read: the job the capturer (or
                    // the Drive folder) named, and the estimate that still
                    // belongs to it.
                    estimateId: createdPair.estimateId,
                    projectId: createdPair.projectId,
                    costCodeId,
                    costCodeSource,
                    costCodeConfidence,
                    // ONLY TAX `buildGroups` ACCEPTED (round 4).
                    //
                    // An earlier version stored `row.taxCents` — the raw read —
                    // on the reasoning that the WA deduction is about tax paid
                    // at the register, not about what QuickBooks split. That is
                    // true in principle and wrong in practice: `buildGroups`
                    // REJECTS a tax read on a check, and rejects a nonsense one
                    // (tax >= total), and those rejected values were still
                    // landing on the Expense with `taxAtSource` true. The tax
                    // report reads exactly those two columns, so an OCR misread
                    // no human ever saw could be claimed on an excise return —
                    // and `amount - taxAmount` could even go negative.
                    //
                    // `taxApplied` is the validated figure — QuickBooks' own
                    // posted tax when the Purchase already existed, otherwise
                    // read back off the groups that actually posted. A rejected
                    // read is stored NOWHERE the report can reach:
                    // `ReceiptIntake.taxCents` keeps the raw value for audit,
                    // and a bookkeeper supplies the real figure through
                    // `PATCH /api/expenses/[id]`, which accepts `taxAmount` and
                    // `taxAtSource` (bounded at 12% of the receipt) behind the
                    // `financialReports` permission. NOT the PUT on that route
                    // — PUT is guarded by assertExpenseMutableOutsideQbo and
                    // every row booked here carries a qbPurchaseId.
                    taxAmount: taxToStore,
                    taxAtSource: taxToStore !== null,
                    // An implausible read is a question, not an answer: the row
                    // waits for a person and the report skips it meanwhile.
                    needsTaxReview: taxNeedsReview,
                    // Provenance for `taxAmount`. "ocr" is a re-readable
                    // guess; "manual" (written by the tax PATCH) is a person's
                    // answer, and this pipeline never writes over one. Null
                    // only when there was no tax read at all, which leaves a
                    // later bookkeeper free to answer without arguing with a
                    // machine — an implausible read still counts as "a machine
                    // looked", which is why it keeps "ocr".
                    //
                    // `taxDeductibleBaseSource` is left unset, because this
                    // create writes no `taxDeductibleBase`: booking never
                    // splits a receipt into a resold portion, so the base and
                    // its provenance both start empty and wait for a person.
                    taxSource: taxApplied > 0 ? "ocr" : null,
                    installedAtCustomer: row.installedAtCustomer,
                    amount: booked.totalCents / 100,
                    vendor: booked.vendor,
                    // RE-ANCHORED at write time. `txnDate` is a @db.Date column
                    // and round-trips as UTC midnight, so writing it straight
                    // into Expense.date (a full timestamp) records 5pm the
                    // PREVIOUS day in Pacific — and every job-cost and variance
                    // report that bounds by local midnight then counts the
                    // expense in the wrong period. The intake row keeps the
                    // calendar day; this makes the instant match it.
                    date: booked.date,
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
                        (taxToStore !== null ? ` · incl. $${taxToStore.toFixed(2)} sales tax` : "") +
                        (taxNeedsReview ? " · tax read looks wrong, needs review" : "") +
                        derivedNote +
                        ` · booked to QuickBooks`,
                },
                select: { id: true },
                });
            }
            // CLAIM CAS, inside the same commit, now that the Expense exists.
            //
            // The void fence above proved the row was still BOOKING (a void
            // loses there, and is parked as booked-after-void); this proves WE
            // still own it. If the row was re-claimed the whole transaction
            // rolls back — the BOOKED write above, the guarded fills and the
            // Expense with it — and the successor retries: QBO's DocNumber
            // idempotency returns the SAME Purchase, so it books once, under
            // one owner.
            //
            // It does NOT re-assert `state: "BOOKING"`: the fence above already
            // moved this row to BOOKED inside this transaction, so requiring
            // BOOKING here would fail on our own uncommitted write, every time.
            const confirmed = await tx.receiptIntake.updateMany({
                where: { id: row.id, claimToken: row.claimToken },
                data: {
                    expenseId: expense.id,
                    // Ownership is released by the write that completes the
                    // transition — a booked row is nobody's to hold.
                    claimToken: null,
                    claimedAt: null,
                },
            });
            if (confirmed.count === 0) throw new StaleClaimError();
            return expense.id;
        });

        if (expenseId === null) {
            await deps.logEvent({
                kind: "receipt-push",
                status: "booked-after-void",
                source: "intake-worker",
                vendor: row.vendor ?? undefined,
                projectName: project.name,
                docNumber: result.docNumber,
                fileName: row.fileName ?? undefined,
                amountCents,
                taxCents: taxApplied,
                detail: { fileId, qbPurchaseId: result.qbPurchaseId, intakeId: row.id, sourceRef: row.sourceRef },
            }).catch(() => { /* audit only */ });
            return { outcome: "booked-after-void", qbPurchaseId: result.qbPurchaseId };
        }

        // Audit row so the /automation register keeps seeing v2 bookings
        // alongside the bot's. Fire-and-forget by contract — never fails a
        // booking that already happened.
        await deps.logEvent({
            kind: "receipt-push",
            status: result.alreadyExists ? "already-exists" : "created",
            source: "intake-worker",
            // WHAT THE EXPENSE GOT, not what the read said. The audit used
            // to report the OCR spelling while the Expense carried QBO's.
            vendor: booked.vendor,
            projectName: project.name,
            docNumber: result.docNumber,
            fileName: row.fileName ?? undefined,
            amountCents: booked.totalCents,
            // What POSTED, not what was requested — buildGroups rejects a tax
            // read on a check or when tax >= total, and the filing report has
            // to reconcile against the Purchase.
            taxCents: booked.taxCents,
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
                // WHERE the persisted phase came from, NOT the DB column
                // `Expense.costCodeSource` (capture | ai | manual |
                // manual-none | backfill). Two different vocabularies for two
                // different questions, so they carry two different names.
                costCodeOrigin: effective.costCodeOrigin,
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
        // The phase went away underneath the write. A send WAS attempted, so
        // the strong key stays claimed and the Purchase is not re-sent; a
        // person re-phases the row and it books on the next pass.
        if (error instanceof PhaseRemovedError) {
            return {
                outcome: "needs-review",
                reason: `phase-changed:${error.reason}`,
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
    if (isQBTimeoutError(error)) return "QBTimeoutError";
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
 *   A NULL one (vendor, date, and now `estimateId`) is missing attribution and
 *   is filled from the receipt.
 *
 *   THE JOB (projectId, resolved through the estimate when the column is
 *   null) — a populated disagreement is the worst of the lot: filling would be
 *   guessing which job is right and overwriting would silently move real money
 *   between jobs. It parks as `attribution`, its own reason.
 *
 *   ATTRIBUTION (costCodeId, tax, installedAtCustomer, receiptUrl) — filled
 *   when the row has no answer, never overwritten. The importer cannot write
 *   any of them, so a value there came from a person or from an earlier
 *   receipt. On THIS schema a null is not automatically an absence either: a
 *   provenance column records it. `notHumanCodedExpenseWhere()` (the phase)
 *   and `taxNotHumanDecidedWhere()` (the two tax figures) are the shared
 *   definitions of "a human decided", and both are consulted here and pinned
 *   again in the caller's predicates — the DOC COMMENT THIS REPLACED said
 *   there was no provenance column and no such helper, which was true of the
 *   Phase 1 schema and is not true of this one.
 *
 * Pure, so the whole truth table is a unit test rather than a race. Deciding
 * here and WRITING under a guarded predicate in the caller is deliberate: this
 * function says what should be filled, and the `where` clause is what makes it
 * safe against a writer that commits in between.
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
    /**
     * THE PHASE 3 INPUTS, all optional for the same reason the Phase 3 columns
     * on `ExistingExpense` are: a caller that does not supply one is not
     * asking this function to decide anything about it, and gets exactly the
     * Phase 1 answers.
     */
    /** Provenance to write ALONGSIDE `costCodeId` — never the id alone. */
    costCodeSource?: string | null;
    costCodeConfidence?: number | null;
    /** The job the intake row claims. */
    projectId?: string | null;
    /** The tax figure to STORE, already bounded — null when implausible. */
    taxAmount?: number | null;
    /** The tax that POSTED, in cents. `0` means the read produced none. */
    taxApplied?: number;
    /** The stored figure is a question, not an answer. */
    taxNeedsReview?: boolean;
    installedAtCustomer?: boolean | null;
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
    /**
     * WHERE the persisted value came from — an audit vocabulary, deliberately
     * NOT the DB column `Expense.costCodeSource` (capture | ai | manual |
     * manual-none | backfill), which answers "who chose it". This field was
     * called `costCodeSource` too until the two schemas met in one file and
     * one of them had to be renamed; the values and the meaning are unchanged.
     */
    costCodeOrigin: "receipt" | "existing" | "none";
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

    // THE JOB, FIRST, because every fill below is pinned to it.
    //
    // `projectId` is the primary attribution on this schema and the estimate
    // is the fallback (resolveExpenseProjectId). A row already sitting on
    // ANOTHER job is not something to fill or overwrite: filling would be
    // guessing which one is right, and overwriting would silently move real
    // money between jobs. Nobody is booked and a person is asked.
    const existingProjectId = existing.projectId ?? existing.estimate?.projectId ?? null;
    if (existingProjectId && receipt.projectId && existingProjectId !== receipt.projectId) {
        conflicts.push("attribution");
    }

    // NULLABLE since round 42 item 4b (`onDelete: SetNull`), so an absent
    // estimate is missing attribution and is filled as half of the pair below;
    // a PRESENT one that disagrees is still a real contradiction.
    if (existing.estimateId && existing.estimateId !== receipt.estimateId) conflicts.push("estimate");
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
    //
    // `costCodeId: null` is NOT on its own proof that nobody has decided: a
    // bookkeeper who cleared the phase leaves exactly that shape with
    // `costCodeSource: "manual-none"`, which HUMAN_COST_CODE_SOURCES calls a
    // decision. The caller pins the same predicate in SQL; this is what stops
    // the audit event claiming a fill that will match zero rows.
    if (!existing.costCodeId && !humanCoded(existing) && receipt.costCodeId) {
        fill.costCodeId = receipt.costCodeId;
        // NEVER the id alone. `costCodeSource` says who chose it (and so
        // whether a later pass may correct it) and the confidence belongs to
        // the same decision; a code with neither reads as a legacy row.
        fill.costCodeSource = receipt.costCodeSource ?? null;
        fill.costCodeConfidence = receipt.costCodeConfidence ?? null;
    }

    // THE ATTRIBUTION PAIR. Filled only when the row carries no job at all —
    // and as a PAIR, because writing `projectId` beside an `estimateId` that
    // belongs elsewhere is an expense claiming two jobs at once. The caller
    // re-reads both halves from the locked estimate before writing them.
    if (!existing.projectId && receipt.projectId) {
        fill.projectId = receipt.projectId;
        fill.estimateId = receipt.estimateId;
    }

    // THE TAX FIGURES. A stored amount came from an earlier booking of this
    // same document or from a bookkeeper, and both outrank a re-read; a NULL
    // one is only an absence when `taxSource` says no human has answered.
    // `taxApplied > 0` rather than `taxAmount !== null` so an IMPLAUSIBLE read
    // still reaches the caller: it writes no figure, but it does flag the row.
    if ((receipt.taxApplied ?? 0) > 0 && existing.taxAmount == null && !taxHumanDecided(existing)) {
        fill.taxAmount = receipt.taxAmount ?? null;
        fill.taxAtSource = (receipt.taxAmount ?? null) !== null;
        fill.taxSource = "ocr";
        if (receipt.taxNeedsReview) fill.needsTaxReview = true;
    }

    // ITS OWN VALUE IS THE EVIDENCE: `installedAtCustomer` is a tri-state, so
    // non-null MEANS a person answered and `null` is the entire guard. Not
    // gated on `taxSource`, which governs the two tax FIGURES — a bookkeeper
    // correcting a tax figure must not silently stop every later capture from
    // answering a question they never touched.
    if (receipt.installedAtCustomer !== undefined && receipt.installedAtCustomer !== null
        && existing.installedAtCustomer == null) {
        fill.installedAtCustomer = receipt.installedAtCustomer;
    }

    if (!existing.receiptUrl) fill.receiptUrl = receipt.receiptUrl;

    return { conflicts, fill, attribution: effectiveAttribution(existing, receipt) };
}

/** "A person chose this row's phase" — the ONE shared definition. */
function humanCoded(existing: ExistingExpense): boolean {
    return (HUMAN_COST_CODE_SOURCES as readonly string[]).includes(existing.costCodeSource ?? "");
}

/** "A person answered this row's tax question" — the ONE shared definition. */
function taxHumanDecided(existing: ExistingExpense): boolean {
    return (HUMAN_TAX_SOURCES as readonly string[]).includes(existing.taxSource ?? "");
}

/**
 * The subset of `fill` a single guarded write is allowed to carry. Written out
 * rather than deleted-from, so a new fill key cannot leak into a predicate
 * that was never written for it.
 */
function pick(fill: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (key in fill) out[key] = fill[key];
    return out;
}

function effectiveAttribution(
    existing: ExistingExpense,
    receipt: ReceiptExpenseValues,
): EffectiveAttribution {
    // A HUMAN'S NULL IS STILL A HUMAN'S ANSWER. `costCodeSource:
    // "manual-none"` is a bookkeeper who looked at the receipt and cleared the
    // phase; the guarded fill matches zero rows against it, so reporting the
    // receipt's pick here would assert a cost code that was never applied to
    // anything — the exact failure this whole return value exists to prevent.
    if (existing.costCodeId || humanCoded(existing)) {
        return {
            costCodeId: existing.costCodeId ?? null,
            costCodeOrigin: "existing",
            // Only a CONTEST counts as preserved: a receipt with no phase to
            // offer, or one offering the same phase, displaced nothing.
            preserved: !!receipt.costCodeId && receipt.costCodeId !== existing.costCodeId,
        };
    }
    return receipt.costCodeId
        ? { costCodeId: receipt.costCodeId, costCodeOrigin: "receipt", preserved: false }
        : { costCodeId: null, costCodeOrigin: "none", preserved: false };
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
 *
 * `expense-conflict:attribution` is the JOB disagreement — the Expense under
 * this Purchase id is on another job than the intake row claims, or moved onto
 * one while the fills ran. It used to be its own error class and its own park
 * reason (`attribution-conflict`); folding it in keeps ONE thrown class and
 * ONE park prefix for "our own job-cost row and the read disagree", so a
 * reviewer's queue filter cannot miss half of them.
 */
export const EXPENSE_CONFLICT_PREFIX = "expense-conflict:";

class ExpenseConflictError extends Error {
    constructor(readonly fields: string[]) {
        super(`existing expense disagrees on ${fields.join(",")}`);
        this.name = "ExpenseConflictError";
    }
}

/**
 * Thrown inside the commit transaction when the cost code stopped being a
 * phase of this job while the booking ran. Throwing rather than returning is
 * deliberate: it rolls the guarded fills back with it, so the row is never
 * left half-filled against a phase the job no longer has.
 *
 * Its OWN class, not an `ExpenseConflictError`: nothing about the existing
 * Expense is wrong, and the fix is a person re-phasing the row rather than
 * choosing between two views of one document.
 */
class PhaseRemovedError extends Error {
    /** Carries WHY, so the parked row names the thing a person has to fix. */
    readonly reason: string;
    constructor(reason: string) {
        super(`the cost code stopped being a phase of this job while booking (${reason})`);
        this.name = "PhaseRemovedError";
        this.reason = reason;
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
