/**
 * Deposit sweep — the PURE half of the daily bank-credit auto-apply
 * (docs/plans/DEPOSIT-SWEEP-PLAN.md).
 *
 * The sweep itself lives in the bank branch of
 * src/app/api/payments/deposit-ingest/route.ts, which owns every database read
 * and every money write. Everything here is a decision or a string: batch
 * validation, the control-total gate, in-batch collision detection, the wait
 * rule, the image-evidence cardinality rule, and the human-facing messages.
 * No Prisma, no network — so the rules can be tested without a database.
 *
 * WHY A BANK SOURCE AT ALL: the QuickBooks API exposes only BOOKED
 * transactions, never the "For Review" bank feed, so an unbooked customer
 * check is invisible to it until a human books it. The Washington Trust daily
 * CSV is the one daily, human-free source that sees the deposit on the day it
 * lands (docs/BANK-DATA-SOURCES.md).
 */

import { COMPANY_TIME_ZONE } from "./company-day";
import { dayKeyInTimeZone, endOfDateInTimeZone } from "./tz-date";

/**
 * LIVE AUTO-APPLY OF PAYER-LESS CREDITS IS A PRODUCT DECISION, AND IT IS OFF.
 *
 * A branch-deposited check never names its payer (docs/WTB-CHECK-IMAGES.md), so
 * for most credits the strongest evidence the sweep will ever have is "exactly
 * one requested milestone is owed exactly this amount" — attributeDeposit's
 * `amount_only`. Every guard in this module narrows that risk; none removes it.
 * Whether to book real money on it is Justin's call (DEPOSIT-SWEEP-PLAN.md,
 * Decision 2), not a default.
 *
 * So the switch is explicit, environment-level, and fails CLOSED: anything but
 * the exact string "true" leaves the sweep in suggest-only mode, where a
 * perfect match is recorded as `proposed` for a human to confirm. A credit that
 * DOES carry payer corroboration (`verified` / `recorded`) is not gated by
 * this — that is evidence, not an amount coincidence.
 */
export const LIVE_APPLY_ENV_VAR = "DEPOSIT_SWEEP_LIVE_APPLY";

export function liveApplyEnabled(env: Record<string, string | undefined> = process.env): boolean {
    return env[LIVE_APPLY_ENV_VAR] === "true";
}

/** Attribution confidences that carry actual payer corroboration. */
export function hasPayerCorroboration(confidence: string): boolean {
    return confidence === "verified" || confidence === "recorded";
}

/**
 * THE CORROBORATION LADDER (Justin, 2026-09-02: "it should align with the
 * daily logs from the chat spaces").
 *
 * The deposit-class allowlist proves a customer DEPOSIT arrived; it says
 * nothing about WHICH customer. Three rungs, strongest first:
 *
 *   1. payer evidence  — a check image (or QBO payment) naming the customer:
 *                        `verified` / `recorded`;
 *   2. job progress    — the FIELD says the work this milestone bills for is
 *                        actually done, and says it about THIS phase: a passed
 *                        inspection of the phase, or a daily log naming it
 *                        (`progress`, see progressCorroboration);
 *   3. the switch      — DEPOSIT_SWEEP_LIVE_APPLY, for credits with neither.
 *
 * Rungs 1 and 2 book on their own. Rung 3 is the operator taking
 * responsibility for an amount-only match, and stays OFF by default.
 */
export const PROGRESS_CONFIDENCE = "progress";

export function booksWithoutOverride(confidence: string): boolean {
    return hasPayerCorroboration(confidence) || confidence === PROGRESS_CONFIDENCE;
}

/** DepositIngest.source for a swept bank credit (null means the photo path). */
export const BANK_DEPOSIT_SOURCE = "bank";

/**
 * A bank credit is only eligible for LIVE auto-apply once it is this many days
 * old. The photo path carries a project name, so it gets first dibs on a fresh
 * check; younger credits are held as `proposed` and re-evaluated by the next
 * daily POST. Dry runs ignore the wait.
 */
export const BANK_APPLY_MIN_AGE_DAYS = 2;

/** Window for "settled recently by ANY source" in the uniqueness union. */
export const PAID_UNION_WINDOW_DAYS = 14;

/** Window for the cross-source claim check and the applied-twin lookup. */
export const CROSS_SOURCE_CLAIM_WINDOW_DAYS = 14;

/**
 * One POST carries ONE day, and every credit in it is processed sequentially
 * inside a single serverless invocation — so the cap is a DEADLINE budget, not
 * just a sanity check. A real Washington Trust day is a handful of credits; a
 * batch of dozens means a merged or mis-ranged export, and pushing it through
 * a 60-second function would leave a half-processed day behind.
 */
export const MAX_BANK_CREDITS_PER_BATCH = 50;

/**
 * The states in which a DepositIngest row can still HOLD a milestone
 * reservation — byte-for-byte the predicate of the partial unique index in
 * scripts/apply-deposit-ingest-schema.mjs:
 *
 *   WHERE status IN ('processing','qbo_unknown','qbo_created','applied',
 *                    'reconcile','failed') AND "paymentScheduleId" IS NOT NULL
 *
 * The claim lists below are DERIVED from this rather than enumerated by hand,
 * which is how `reconcile` and `failed` went missing: both sit past a money
 * boundary and keep their reservation on purpose (a reconcile row so the human
 * can see which milestone is at stake, a boundary-marked failed row so no
 * second file slips in before the retry resumes). Leaving them out let a photo
 * and a bank credit reserve two DIFFERENT milestones for the same deposit —
 * the exact hole the claim check exists to close.
 */
export const RESERVATION_RETAINING_STATUSES = [
    "processing", "qbo_unknown", "qbo_created", "applied", "reconcile", "failed",
] as const;

/**
 * The cross-source claim check is DIRECTIONAL, so it has two status lists, and
 * both start from "can that row still be holding a milestone?".
 *
 * CLAIMING_STATUSES — what the BANK side treats as a claim by the photo path:
 * every reservation-retaining state, plus `proposed` for completeness (a photo
 * row can never be proposed; the sweep's own rows can, and this list is the
 * conservative one). Any live photo row is closer to the money than a bank
 * credit is — it carries a project name; the sweep has only an amount.
 *
 * MONEY_BOUNDARY_CLAIM_STATUSES — what the PHOTO side treats as a claim by the
 * sweep: the reservation-retaining states, and NOT `proposed`. A proposed row
 * is a bank credit that matched but was held back — by a dry run, or by the
 * 2-day wait whose entire purpose is to give the evidence-rich photo first
 * dibs. Counting it as a claim would invert that: the photo would stand down
 * during exactly the window reserved for it. When the proposed row is
 * re-evaluated after the photo settles, the 14-day Paid union and the
 * applied-row lookup route it to a human with the right explanation.
 */
export const CLAIMING_STATUSES = [...RESERVATION_RETAINING_STATUSES, "proposed"] as const;
export const MONEY_BOUNDARY_CLAIM_STATUSES = [...RESERVATION_RETAINING_STATUSES] as const;

/**
 * Statuses that mean a bank deposit has ALREADY REACHED QuickBooks for this
 * milestone, used to decide receipt suppression when some other caller
 * finishes the settle. Three deliberate boundaries:
 *
 *   - `qbo_unknown` / `qbo_created` are here: a QuickBooks payment exists (or
 *     may exist), so a settle landing now is almost certainly the sweep's.
 *   - `reconcile` IS here. A sweep payment parked for manual reconciliation is
 *     still the sweep's money; the client must not be emailed a receipt for it.
 *   - `processing` is NOT here, and this is the subtle one. A bank row is
 *     `processing` from the moment it is claimed — before any match, before any
 *     QuickBooks request. Treating that as ownership meant an UNRELATED payment
 *     settling the same milestone (a client paying the Intuit link while the
 *     sweep was still deciding) silently lost its receipt. A merely-processing
 *     row has not touched the money yet, so it gets no say.
 *   - `applied` is NOT here either. A finished deposit is history, and history
 *     must not suppress a LATER, unrelated settlement of the same milestone —
 *     an undo-and-repay would otherwise swallow the client's receipt forever.
 *     An applied row only suppresses when its own qbPaymentId matches the
 *     payment being settled (see settleMilestoneFromQBPayment).
 */
export const MONEY_IN_FLIGHT_STATUSES = ["qbo_unknown", "qbo_created", "reconcile"] as const;

/**
 * REVIEW-TASK MUTUAL EXCLUSION, shared by the sweep and the human task actions.
 *
 * The sweep claims a deposit's OfficeTask before re-evaluating its row (see
 * claimReviewTask in the deposit-ingest route) by writing this marker into
 * `OfficeTask.status`. OfficeTask has no ownership column and `assigneeId` is a
 * foreign key to User, so claiming with it would mean seeding a synthetic bot
 * user that then surfaces in the team list, the dispatch board and every
 * assignee picker. `status` is the least-abusive column that exists:
 * schema.prisma calls it LEGACY ("kept in sync with column.name on create/move
 * ... reads should use columnId") and nothing in src/ branches on it or renders
 * it.
 *
 * EXCLUSION IS MUTUAL, which is the point: while the claim is FRESH, the human
 * mutations in src/lib/actions.ts (assign, move, archive, delete) refuse with
 * SWEEP_CLAIM_BUSY_MESSAGE, and the sweep's own re-assert before each money
 * boundary treats a claim it cannot see as lost. Both sides express the rule as
 * a CAS against the same row, so whichever statement lands first wins and the
 * other is told it lost.
 *
 * FRESHNESS is `OfficeTask.updatedAt` (Prisma `@updatedAt`, written by every
 * update including the sweep's own re-assert, so a long-running sweep keeps its
 * claim alive). A claim older than the TTL belongs to a sweep that crashed: the
 * human may then override it (their write clears the marker) and the sweep must
 * treat it as lost. A deposit batch is capped at 60s of function time, so 15
 * minutes is far longer than any honest claim needs.
 */
export const SWEEP_TASK_CLAIM = "Deposit sweep working";

export const SWEEP_CLAIM_TTL_MS = 15 * 60_000;

export const SWEEP_CLAIM_BUSY_MESSAGE =
    "The deposit sweep is booking this deposit right now; try again in a few minutes.";

/** The oldest `updatedAt` a claim can carry and still be considered live. */
export function sweepClaimFreshSince(now: Date = new Date()): Date {
    return new Date(now.getTime() - SWEEP_CLAIM_TTL_MS);
}

/**
 * The Prisma `where` fragment every human task mutation carries: "this row is
 * not under a LIVE sweep claim". Shared rather than retyped, so the sweep's
 * notion of a live claim and the humans' can never drift apart.
 */
export function notSweepClaimedWhere(now: Date = new Date()) {
    return { NOT: { status: SWEEP_TASK_CLAIM, updatedAt: { gte: sweepClaimFreshSince(now) } } };
}

/** BankImage.source that scripts/post-bank-images.mjs writes for WTB documents. */
export const BANK_IMAGE_SOURCE = "WTB_ONLINE";

/**
 * QBO Account Id for the Washington Trust operating account. The sweep's
 * trigger IS the bank line, and Vanessa matches the feed line to the payment,
 * so a swept payment is deposited straight to the bank account rather than
 * QBO's default Undeposited Funds (docs/DEPOSIT-PIPELINE.md M2). All three
 * Hoppe payments used this account. The photo path is unchanged.
 */
export const BANK_DEPOSIT_TO_ACCOUNT_ID = "154";

export interface BankCredit {
    bankReference: string;
    /** Positive dollars, exactly representable in cents. */
    amount: number;
    amountCents: number;
    /** The bank's transaction class code, e.g. "174" for OTHER DEPOSITS. */
    baiCode: string | null;
    /** The bank's Description column, e.g. "OTHER DEPOSITS". */
    description: string | null;
    /** The bank's Transaction Detail column, e.g. "DEPOSIT - DDA/MMKT". */
    transactionDetail: string | null;
    customerReference: string | null;
}

/**
 * ONLY a customer deposit may be booked as a customer payment.
 *
 * A bank credit is any money in: an owner capital contribution, interest, an
 * ACH refund from a supplier, a transfer between accounts. Every one of those
 * can land on the exact cents of a requested milestone, and the sweep matches
 * on amount alone — so without this gate a $13,447.68 transfer would retire a
 * customer's milestone and invoice them for money they never paid.
 *
 * This is an ALLOWLIST, not a denylist: a class nobody anticipated is refused
 * rather than swept. The shape comes from the real Washington Trust export
 * (docs/WTB-CHECK-IMAGES.md): BAI 174 / "OTHER DEPOSITS", whose Transaction
 * Detail distinguishes a branch deposit ("DEPOSIT - DDA/MMKT") from a remote
 * one ("MOBILE D..."). Those two are the only ways a customer check reaches
 * this account.
 */
export const CUSTOMER_DEPOSIT_BAI_CODE = "174";
export const CUSTOMER_DEPOSIT_DESCRIPTION = "OTHER DEPOSITS";
export const CUSTOMER_DEPOSIT_DETAIL_PREFIXES = ["DEPOSIT", "MOBILE D"] as const;

export function isCustomerDepositClass(credit: {
    baiCode?: string | null;
    description?: string | null;
    transactionDetail?: string | null;
}): boolean {
    const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    if (norm(credit.baiCode) !== CUSTOMER_DEPOSIT_BAI_CODE) return false;
    if (norm(credit.description) !== CUSTOMER_DEPOSIT_DESCRIPTION) return false;
    const detail = norm(credit.transactionDetail);
    return CUSTOMER_DEPOSIT_DETAIL_PREFIXES.some(prefix => detail.startsWith(prefix));
}

/** Marker prefix so the row's own reason says why it was never swept — and so
 *  the replay healer can tell a deliberate no-task row from a lost one. */
export const NOT_CUSTOMER_DEPOSIT_PREFIX = "not a customer deposit class";

export function notCustomerDepositNote(credit: {
    description?: string | null;
    transactionDetail?: string | null;
}): string {
    return `${NOT_CUSTOMER_DEPOSIT_PREFIX} (${credit.description ?? "no description"} / ${credit.transactionDetail ?? "no detail"})`;
}

/** True for a row that was filed WITHOUT an OfficeTask on purpose: a bank
 *  credit that is simply not a customer deposit is noise, not a task. */
export function isNotCustomerDepositReason(reason: string | null | undefined): boolean {
    return typeof reason === "string" && reason.startsWith(NOT_CUSTOMER_DEPOSIT_PREFIX);
}

/**
 * A credit the runner deliberately did NOT send for sweeping, declared so the
 * day's control totals still tie.
 *
 * The only reason today is a missing Bank Reference. That reference is the
 * deposit's identity — without it there is no idempotency key, so the credit
 * cannot be swept at all. Refusing the whole day for it (the first cut) meant
 * one such row on 2026-08-28 would have stalled every later day forever, which
 * is a much worse failure than not sweeping one credit: the bank publishes ONE
 * total for the day, so a partial batch cannot simply recompute its own totals
 * and still be checkable. Declaring the excluded rows keeps the arithmetic
 * honest — credits + excluded must account for the bank's own figures exactly —
 * while the sweepable subset gets on with it.
 *
 * Nothing is recorded for these rows. They are evidence in the request, not
 * deposits in the system.
 */
export interface BankExcludedCredit {
    amount: number;
    amountCents: number;
    description: string | null;
    transactionDetail: string | null;
    reason: string;
}

export interface BankBatch {
    /** YYYY-MM-DD — the CSV Post Date the whole batch belongs to. */
    postDate: string;
    credits: BankCredit[];
    /** Declared, never processed — see BankExcludedCredit. */
    excluded: BankExcludedCredit[];
    dryRun: boolean;
}

export type BankBatchParse = { ok: true; batch: BankBatch } | { ok: false; reason: string };

/** Strict YYYY-MM-DD with a real-calendar round trip (same rule the photo path
 *  applies to a check date). */
export function isValidIsoDate(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Midnight UTC for a YYYY-MM-DD — the storage form of a `@db.Date` column. */
export function isoDateToUtc(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
}

/** Whole calendar days from `a` to `b` (negative when b precedes a). */
export function isoDayDiff(a: string, b: string): number {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** `days` calendar days before an ISO date, as an ISO date. */
export function isoDaysBefore(value: string, days: number): string {
    return new Date(Date.parse(`${value}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** `days` calendar days after an ISO date, as an ISO date. */
export function isoDaysAfter(value: string, days: number): string {
    return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The wait rule: a bank credit may only be applied for real once it is at
 * least BANK_APPLY_MIN_AGE_DAYS old, counted in the COMPANY's calendar days.
 *
 * This used to read `now.toISOString()`, i.e. the UTC day — and the sweep runs
 * at 6pm Pacific, by which time UTC is already tomorrow. An August 24 credit
 * therefore looked two days old on the evening of August 25: one local day, not
 * two, silently halving the window that exists to give the photo path first
 * dibs. Post dates are the bank's own local calendar days, so they have to be
 * compared against the company's day, never the server's.
 */
export function bankCreditIsOldEnough(postDate: string, now: Date): boolean {
    const today = dayKeyInTimeZone(now, COMPANY_TIME_ZONE);
    if (!today) return false; // an unreadable clock never unlocks a money write
    return isoDayDiff(postDate, today) >= BANK_APPLY_MIN_AGE_DAYS;
}

/**
 * The instant by which a milestone must ALREADY have been requested to be a
 * candidate for this credit: the end of the credit's post date, in the
 * company's timezone.
 *
 * Money cannot pay a bill that had not been sent when it arrived. Without this
 * bound, invoicing a NEW milestone for the same amount today would retroactively
 * make it a candidate for a deposit that landed a week ago and belonged to
 * something else.
 *
 * NOTE: `qbInvoiceSentAt` is a LAST-send timestamp, not a first-send one, so a
 * re-send after the deposit pushes the milestone outside this bound and it
 * stops being auto-appliable — the credit goes to a human instead. That is the
 * safe direction: the alternative is booking money against a row whose request
 * history we cannot actually reconstruct.
 */
export function requestedByInstant(postDate: string): Date {
    return endOfDateInTimeZone(postDate, COMPANY_TIME_ZONE);
}

/**
 * The normalised identity of a bank credit. `fileId` is "bank:<reference>",
 * which is an idempotency key only while a reference always means the same
 * money — so a replay is checked against this before it is treated as one. A
 * bank that reuses a reference for a different credit gets a human, not a
 * silent overwrite of the original deposit.
 *
 * Whitespace and case are the bank's; they are normalised out so a cosmetic
 * re-render of the same row is still the same credit.
 */
export function bankCreditFingerprint(credit: {
    postDate?: string | null;
    amountCents?: number | null;
    baiCode?: string | null;
    description?: string | null;
    transactionDetail?: string | null;
}): string {
    const norm = (v: string | null | undefined) => (v ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    return [
        norm(credit.postDate),
        String(credit.amountCents ?? ""),
        norm(credit.baiCode),
        norm(credit.description),
        norm(credit.transactionDetail),
    ].join("|");
}

/** `fileId` for a bank credit — fits the existing @unique column and keeps the
 *  requestid namespace disjoint from any Drive file id. */
export function bankFileId(bankReference: string): string {
    return `bank:${bankReference}`;
}

/** Image keys are `${bankReference}:${side}` (scripts/post-bank-images.mjs), so
 *  a bare-reference lookup finds nothing — match the prefix instead. */
export function bankImageKeyPrefix(bankReference: string): string {
    return `${bankReference}:`;
}

/**
 * Validate ONE day's credit batch. Rejects the WHOLE batch (nothing is
 * written) rather than silently ingesting a partial day: the control totals
 * are the only evidence that the browser-automated CSV export saw the whole
 * day, and a half-seen day is exactly the state that makes an amount look
 * unique when it is not.
 */
export function parseBankBatch(raw: Record<string, unknown>): BankBatchParse {
    const postDate = typeof raw.postDate === "string" ? raw.postDate.trim() : "";
    if (!isValidIsoDate(postDate)) return { ok: false, reason: "postDate must be a YYYY-MM-DD calendar date" };

    if (!Array.isArray(raw.credits)) return { ok: false, reason: "credits must be an array" };
    if (raw.credits.length === 0) return { ok: false, reason: "credits must not be empty" };
    if (raw.excluded !== undefined && !Array.isArray(raw.excluded)) {
        return { ok: false, reason: "excluded must be an array when present" };
    }
    const rawExcluded = Array.isArray(raw.excluded) ? raw.excluded : [];
    // The cap is a deadline budget for the rows this request will PROCESS, but a
    // batch whose declared rows are wildly out of range is a merged export
    // either way.
    if (raw.credits.length + rawExcluded.length > MAX_BANK_CREDITS_PER_BATCH) {
        return {
            ok: false,
            reason: `credits exceeds the ${MAX_BANK_CREDITS_PER_BATCH}-row batch cap — post one day at a time ` +
                `(a batch this size means a merged or mis-ranged export, and it cannot be processed inside one request)`,
        };
    }
    // A truthiness test here would read "true", 1 or "yes" as LIVE, which is the
    // wrong way round for a flag whose whole job is to stop money moving.
    if (raw.dryRun !== undefined && typeof raw.dryRun !== "boolean") {
        return { ok: false, reason: "dryRun must be a boolean (omit it for a live run)" };
    }

    const credits: BankCredit[] = [];
    const seen = new Set<string>();
    for (const [i, entry] of raw.credits.entries()) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return { ok: false, reason: `credits[${i}] is not an object` };
        }
        const c = entry as Record<string, unknown>;
        const bankReference = typeof c.bankReference === "string" ? c.bankReference.trim() : "";
        // The bank reference IS this deposit's identity: without it there is no
        // idempotency key, so the credit is rejected rather than guessed at.
        if (!bankReference) return { ok: false, reason: `credits[${i}] is missing bankReference` };
        if (bankReference.length > 150) return { ok: false, reason: `credits[${i}] bankReference is longer than 150 chars` };
        if (seen.has(bankReference)) return { ok: false, reason: `bankReference ${bankReference} appears twice in the batch` };
        seen.add(bankReference);

        const amount = Number(c.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return { ok: false, reason: `credits[${i}] (${bankReference}) amount must be a positive number` };
        }
        const amountCents = Math.round(amount * 100);
        if (Math.abs(amount * 100 - amountCents) > 1e-6 || amountCents <= 0) {
            return { ok: false, reason: `credits[${i}] (${bankReference}) amount must have at most 2 decimal places` };
        }

        credits.push({
            bankReference,
            amount: amountCents / 100,
            amountCents,
            baiCode: boundedString(c.baiCode, 10),
            description: boundedString(c.description, 200),
            transactionDetail: boundedString(c.transactionDetail, 500),
            customerReference: boundedString(c.customerReference, 200),
        });
    }

    const excluded: BankExcludedCredit[] = [];
    for (const [i, entry] of rawExcluded.entries()) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            return { ok: false, reason: `excluded[${i}] is not an object` };
        }
        const e = entry as Record<string, unknown>;
        const amount = Number(e.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return { ok: false, reason: `excluded[${i}] amount must be a positive number` };
        }
        const amountCents = Math.round(amount * 100);
        if (Math.abs(amount * 100 - amountCents) > 1e-6 || amountCents <= 0) {
            return { ok: false, reason: `excluded[${i}] amount must have at most 2 decimal places` };
        }
        const reason = typeof e.reason === "string" ? e.reason.trim() : "";
        // A row is only excusable when the runner says WHY: an undeclared
        // exclusion is indistinguishable from a dropped row.
        if (!reason) return { ok: false, reason: `excluded[${i}] must carry a reason` };
        excluded.push({
            amount: amountCents / 100,
            amountCents,
            description: boundedString(e.description, 200),
            transactionDetail: boundedString(e.transactionDetail, 500),
            reason: reason.slice(0, 200),
        });
    }

    // Control totals, from the CSV's own ledger/total rows. They describe the
    // WHOLE day, so they must tie to the swept rows PLUS the declared ones —
    // that is what stops an excluded row from being a way to hide a deposit.
    // Real numbers, not numeric strings: a control total is evidence, and
    // evidence that needed coercing to compare is not evidence.
    const creditCount = typeof raw.creditCount === "number" ? raw.creditCount : NaN;
    const declaredRows = credits.length + excluded.length;
    if (!Number.isInteger(creditCount) || creditCount !== declaredRows) {
        return {
            ok: false,
            reason: `creditCount ${raw.creditCount} does not match the ${declaredRows} credit row(s) declared ` +
                `(${credits.length} posted + ${excluded.length} excluded)`,
        };
    }
    // Required, with no fallback anywhere in the chain: a creditSum derived from
    // the same rows it is checking proves nothing. It must come from the bank's
    // own per-day TOTAL CREDITS row, and a day that has no such row is not
    // swept at all (see the runner's canSweepDay).
    if (raw.creditSum === undefined || raw.creditSum === null) {
        return { ok: false, reason: "creditSum is required (the bank's own TOTAL CREDITS figure for the day)" };
    }
    const creditSum = typeof raw.creditSum === "number" ? raw.creditSum : NaN;
    if (!Number.isFinite(creditSum)) return { ok: false, reason: "creditSum must be a number" };
    const declaredCents = Math.round(creditSum * 100);
    const actualCents = credits.reduce((sum, c) => sum + c.amountCents, 0)
        + excluded.reduce((sum, e) => sum + e.amountCents, 0);
    if (Math.abs(creditSum * 100 - declaredCents) > 1e-6 || declaredCents !== actualCents) {
        return {
            ok: false,
            reason: `creditSum ${creditSum} does not match the declared rows (${(actualCents / 100).toFixed(2)}: ` +
                `${credits.length} posted + ${excluded.length} excluded)`,
        };
    }

    return { ok: true, batch: { postDate, credits, excluded, dryRun: raw.dryRun === true } };
    // (raw.dryRun is already known to be a boolean or absent by here.)
}

function boundedString(value: unknown, max: number): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
}

/**
 * Collisions: two DIFFERENT bank references on the same day for the same
 * amount. Neither can be told apart by amount, which is all a bank credit
 * carries, so both go to a human.
 *
 * Classified over the WHOLE batch — replays included — plus any same-day row
 * already stored, in ANY status. Excluding replays (the first cut of this
 * feature) made the verdict crash-sensitive: a run that created a colliding row
 * as `processing` and died before filing it would, on the next day's replay, no
 * longer see a collision at all and could auto-apply the money. A credit that
 * ever collided must go on colliding for as long as its twin is visible, which
 * means classification cannot depend on how far a previous run got.
 *
 * `stored` must exclude the batch's own rows (same reference = same credit, not
 * a collision with itself).
 *
 * Returns bankReference → the OTHER references it collides with. Only
 * references present in `credits` get an entry; a stored row is evidence, not
 * something this batch can act on.
 */
export function findCollisions(
    credits: BankCredit[],
    stored: Array<{ bankReference: string | null; amountCents: number | null }> = [],
): Map<string, string[]> {
    const byAmount = new Map<number, Set<string>>();
    const add = (amountCents: number, ref: string) => {
        const refs = byAmount.get(amountCents) ?? new Set<string>();
        refs.add(ref);
        byAmount.set(amountCents, refs);
    };
    for (const c of credits) add(c.amountCents, c.bankReference);
    for (const row of stored) {
        if (row.bankReference && row.amountCents != null) add(row.amountCents, row.bankReference);
    }

    const collisions = new Map<string, string[]>();
    for (const credit of credits) {
        const refs = byAmount.get(credit.amountCents);
        if (!refs || refs.size < 2) continue;
        collisions.set(credit.bankReference, [...refs].filter(r => r !== credit.bankReference).sort());
    }
    return collisions;
}

/** The reason a colliding credit gives its human. */
export function collisionNote(credit: BankCredit, postDate: string, others: string[]): string {
    return `${others.length + 1} different bank credits on ${postDate} are for exactly $${credit.amount.toFixed(2)} ` +
        `(this one is ${credit.bankReference}; the other(s) are ${others.join(", ")}) — a bank line carries ` +
        `nothing but an amount, so a human must say which milestone each one settles`;
}

export interface PayerBearingImage {
    payerName: string | null;
}

export type ImageEvidence<T extends PayerBearingImage> =
    | { kind: "none" }
    | { kind: "one"; image: T }
    | { kind: "conflict"; count: number };

/**
 * Image evidence for ONE bank reference, selected by identity (the reference)
 * rather than by a date/amount window. Zero payer-bearing images is NOT a
 * failure — a branch-deposited check yields only a teller receipt and never
 * names the payer (docs/WTB-CHECK-IMAGES.md), so the sweep proceeds on the
 * union rule. Two or more is a conflict: one deposit cannot have two payers.
 */
export function selectPayerBearingImage<T extends PayerBearingImage>(images: T[]): ImageEvidence<T> {
    const withPayer = images.filter(i => typeof i.payerName === "string" && i.payerName.trim() !== "");
    if (withPayer.length === 0) return { kind: "none" };
    if (withPayer.length > 1) return { kind: "conflict", count: withPayer.length };
    return { kind: "one", image: withPayer[0] };
}

export interface CandidateDescription {
    milestoneName: string;
    projectName: string | null;
    invoiceCode: string;
}

/** Every candidate, named, for the OfficeTask notes a human works from. */
export function describeCandidates(candidates: CandidateDescription[]): string {
    return candidates
        .map(c => `"${c.milestoneName}" (${c.projectName ?? "no project"}, ${c.invoiceCode})`)
        .join(", ");
}

export interface AppliedTwin {
    source: string | null;
    fileId: string;
    bankReference: string | null;
    /** YYYY-MM-DD */
    postDate: string | null;
}

/**
 * The message a zero-match gets when the OTHER path already applied this same
 * money. Without it, the second path to run files a generic, alarming task for
 * a deposit that was in fact booked correctly — the common sequential case,
 * since the first path's settle makes the milestone Paid and invisible to the
 * second path's Pending query.
 */
export function appliedTwinNote(twin: AppliedTwin): string {
    const when = twin.postDate ?? "an unknown date";
    return twin.source === BANK_DEPOSIT_SOURCE
        ? `already applied by the deposit sweep from bank ref ${twin.bankReference ?? "unknown"} on ${when}. Verify, then archive this task.`
        : `likely the same check already applied from a deposit photo (file ${twin.fileId}) on ${when}. Verify, then archive this task.`;
}

export interface ClaimingRow {
    fileId: string;
    source: string | null;
    bankReference: string | null;
    status: string;
    paymentScheduleId: string | null;
    /** YYYY-MM-DD */
    postDate: string | null;
}

/** The reason a deposit stands down because another row already claimed this
 *  money — names the row, its milestone and its date so a human can pair them. */
export function crossSourceClaimNote(other: ClaimingRow): string {
    const who = other.source === BANK_DEPOSIT_SOURCE
        ? `the deposit sweep (bank ref ${other.bankReference ?? "unknown"})`
        : `a deposit photo (file ${other.fileId})`;
    return `${who} is already ${other.status === "applied" ? "applied to" : `working (${other.status})`} ` +
        `this same amount from ${other.postDate ?? "an unknown date"}` +
        (other.paymentScheduleId ? `, milestone ${other.paymentScheduleId}` : "") +
        ` — a human must confirm whether these are two payments or one`;
}

/** The P2002 loser's reason: order-specific, naming the row that won. */
export function reservationLostNote(winner: ClaimingRow | null): string {
    if (!winner) return "milestone already being applied by another deposit";
    return winner.source === BANK_DEPOSIT_SOURCE
        ? `milestone already being applied by the deposit sweep (bank ref ${winner.bankReference ?? "unknown"}, status ${winner.status})`
        : `milestone already being applied by a deposit photo (file ${winner.fileId}, status ${winner.status})`;
}

/**
 * M1: the three QuickBooks guard failures buildQBPaymentRequest can return are
 * DETERMINISTIC — the same request will fail the same way forever, so the
 * generic retry loop only burns attempts and then reconciles with a stack-trace
 * of a reason. Each one is really a message to a human, and the balance case is
 * the most important one in the whole sweep: it means somebody already booked
 * this payment in QuickBooks, which is exactly the state the guard exists to
 * protect and exactly what a bookkeeper needs told plainly.
 */
export function qboGuardNote(
    failure: { reason: string; qbBalance?: number; expected?: number },
    invoiceCode: string,
): string {
    const money = (n: number | undefined) => (typeof n === "number" ? `$${n.toFixed(2)}` : "an unknown amount");
    switch (failure.reason) {
        case "balance-mismatch":
            return `QuickBooks shows ${money(failure.qbBalance)} owed on ${invoiceCode}, not ${money(failure.expected)}; ` +
                `probably already booked. Verify and archive.`;
        case "invoice-not-found":
            return `the QuickBooks invoice linked to ${invoiceCode} no longer exists — it was deleted or the link is stale. ` +
                `Re-push the invoice, then record this payment by hand.`;
        case "missing-customer":
            return `the QuickBooks invoice for ${invoiceCode} has no customer on it, so a payment cannot be applied to it. ` +
                `Fix the invoice in QuickBooks, then record this payment by hand.`;
        default:
            return `QuickBooks refused this payment for ${invoiceCode} (${failure.reason}).`;
    }
}

/** Is this guard failure deterministic (a human's problem) rather than a
 *  transient one worth retrying? */
export function isDeterministicQboGuardFailure(reason: string): boolean {
    return reason === "balance-mismatch" || reason === "invoice-not-found" || reason === "missing-customer";
}

/**
 * The ONLY per-credit outcomes that mean this credit is finished with. A row
 * left in any other state — mid-flight, retryable, or a status nobody thought
 * of — is unresolved money by definition.
 */
export const CLEAN_SWEEP_STATUSES = ["applied", "proposed", "unmatched"] as const;

/** The statuses that get their own named bucket. Everything else is counted by
 *  the `unresolved` catch-all, so no outcome can go unreported. */
export const TALLIED_SWEEP_STATUSES = [
    "applied", "proposed", "unmatched", "reconcile", "failed", "qbo_unknown",
] as const;

/**
 * M2: every outcome a day's credits can land in. Reported in full because the
 * Hermes job is unattended: a batch whose credits all failed with a QuickBooks
 * outage used to answer `ok: true` with counts that mentioned none of it, so
 * the runner logged a healthy day and the watchdog never fired.
 *
 * `unresolved` is the CATCH-ALL, and it is the important one. Naming buckets
 * one at a time is how the first cut of this stayed broken: a settle that threw
 * after the QuickBooks payment existed came back as `qbo_created`, which was
 * not one of the named buckets, so it counted as nothing at all and the batch
 * still answered `ok: true` — over a real payment awaiting recovery. Anything
 * outside CLEAN_SWEEP_STATUSES now lands here, including statuses that do not
 * exist yet.
 */
export interface SweepCounts {
    credits: number;
    applied: number;
    proposed: number;
    unmatched: number;
    reconcile: number;
    failed: number;
    qboUnknown: number;
    /** Catch-all: qbo_created, processing, claim-race, anything unknown. */
    unresolved: number;
    replay: number;
}

/**
 * `ok` answers "did this batch finish cleanly?", NOT "did every credit get
 * booked?". `unmatched` is a clean finish — the sweep did its job and asked a
 * human. Everything else means the run hit something it could not resolve, and
 * a human (or the next run) must look.
 *
 * The bucket sum is checked against `credits` first: the buckets are supposed
 * to PARTITION the results, and if they ever stop doing so the honest answer is
 * "not ok" rather than a success derived from an incomplete tally. That is the
 * failure this whole function exists to make impossible.
 */
export function sweepBatchOk(counts: SweepCounts): boolean {
    // A tally is only a tally if every figure in it is a whole, non-negative
    // number. A negative or fractional bucket can make the partition check
    // below add up perfectly (credits 1 = applied 2 + unmatched -1) while
    // describing something that cannot have happened, so the shape is checked
    // before the arithmetic is trusted.
    const values = [
        counts.credits, counts.applied, counts.proposed, counts.unmatched,
        counts.reconcile, counts.failed, counts.qboUnknown, counts.unresolved, counts.replay,
    ];
    if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return false;

    const bucketSum = counts.applied + counts.proposed + counts.unmatched
        + counts.reconcile + counts.failed + counts.qboUnknown + counts.unresolved;
    if (bucketSum !== counts.credits) return false;
    return counts.reconcile === 0 && counts.failed === 0 && counts.qboUnknown === 0 && counts.unresolved === 0;
}

// ── Job-progress corroboration ──────────────────────────────────────────────

/** How far back the field evidence may be. A milestone is billed when the
 *  phase finishes, and the check clears days later; three weeks covers the lag
 *  without letting last month's work vouch for this month's money. */
export const PROGRESS_WINDOW_DAYS = 21;

/**
 * Words that appear in milestone names but say nothing about WHICH phase — a
 * daily log containing only these corroborates nothing. Tokens shorter than
 * MIN_PROGRESS_TOKEN are dropped for the same reason ("in", "of").
 */
const PROGRESS_STOP_WORDS = new Set([
    "COMPLETE", "COMPLETED", "COMPLETION", "PAYMENT", "PAYMENTS", "DEPOSIT",
    "UPON", "FINAL", "MILESTONE", "DRAW", "PHASE", "PROGRESS", "BILLING",
    "INVOICE", "BALANCE", "DUE", "AMOUNT", "WORK", "JOB", "PROJECT",
]);
const MIN_PROGRESS_TOKEN = 4;

/** The distinctive words of a milestone name — what a daily log has to mention
 *  for that log to be about THIS phase. Empty means the name says nothing
 *  specific ("Final Payment"), and (b) cannot fire at all. */
export function milestoneProgressTokens(milestoneName: string): string[] {
    return [...new Set(
        (milestoneName ?? "")
            .toUpperCase()
            .split(/[^A-Z0-9]+/)
            .filter(token => token.length >= MIN_PROGRESS_TOKEN && !PROGRESS_STOP_WORDS.has(token)),
    )];
}

export interface ProgressEvidence {
    /** YYYY-MM-DD — the credit's post date. */
    postDate: string;
    milestoneName: string;
    /** PASSED/APPROVED inspections on the candidate's project: what was
     *  inspected, and the day it was performed (or scheduled, when that is all
     *  there is). */
    inspections: Array<{ result: string; type: string | null; date: string | null }>;
    /** Daily logs on the candidate's project: the day, and what was done. */
    dailyLogs: Array<{ date: string; workPerformed: string }>;
}

export type ProgressVia = "inspection" | "daily-log";

export interface ProgressResult {
    corroborated: boolean;
    via: ProgressVia | null;
    /** Human-readable, for the row's reason and the OfficeTask notes. */
    detail: string;
}

/**
 * Words that mean the work is NOT done. A log that names the phase inside a
 * sentence like one of these is describing what is LEFT, not what is finished —
 * "cabinets not delivered" is the opposite of evidence that cabinets are in.
 *
 * Deliberately blunt and deliberately over-eager: "rough in complete, no
 * issues" is refused too. A false `proposed` costs a human ten seconds; a false
 * apply moves somebody's money to the wrong job.
 */
const NEGATION_WORDS = new Set([
    "NOT", "NO", "NEVER", "PENDING", "INCOMPLETE", "WAITING", "DELAYED", "HOLD",
    "TOMORROW", "NEED", "NEEDS", "REMAINING", "STILL",
]);
/** Multi-word forms the single-word list cannot see. */
const NEGATION_PHRASES = ["NEXT WEEK"];

/** Sentence-ish fragments: real daily logs are as often line-broken lists as
 *  prose, so line breaks split as hard as full stops do. */
function sentencesOf(text: string): string[] {
    return (text ?? "").split(/[.!?;\n\r]+/).map(part => part.trim()).filter(Boolean);
}

function saysNotDone(sentence: string): boolean {
    const upper = sentence.toUpperCase();
    if (NEGATION_PHRASES.some(phrase => upper.includes(phrase))) return true;
    return upper.split(/[^A-Z0-9]+/).some(word => NEGATION_WORDS.has(word));
}

/** Whole-word, case-insensitive. Substring matching let "textile" corroborate
 *  a Tile milestone and "roughly" a Rough In one — the opposite of evidence. */
function mentionsToken(text: string, token: string): boolean {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text ?? "");
}

/**
 * Does the FIELD say this milestone's work is actually done?
 *
 * The second rung of the corroboration ladder, and the one Justin asked for: a
 * payer-less bank credit may book when the field independently agrees that the
 * phase this milestone bills for finished around when the money arrived. It is
 * corroboration, not identification — it never picks a candidate, it only
 * confirms the one the amount already picked uniquely.
 *
 * BOTH rungs must be about THIS PHASE. A passed plumbing inspection says
 * nothing about a cabinetry milestone, and a log that happens to contain the
 * letters of a token inside another word says nothing at all. Everything is
 * matched on the milestone's distinctive tokens, whole words only, so a
 * milestone whose name has no distinctive words ("Final Payment") cannot be
 * corroborated by anything and stays suggest-only.
 *
 * Pure: the route does the fetching, this decides.
 */
export function progressCorroboration(evidence: ProgressEvidence): ProgressResult {
    const from = isoDaysBefore(evidence.postDate, PROGRESS_WINDOW_DAYS);
    const inWindow = (day: string | null) => !!day && day >= from && day <= evidence.postDate;
    const tokens = milestoneProgressTokens(evidence.milestoneName);

    if (tokens.length === 0) {
        return {
            corroborated: false,
            via: null,
            detail: "the milestone name has no distinctive words, so no inspection or daily log can be tied to this phase",
        };
    }

    // ALL of the phase's distinctive words, in ONE piece of evidence. `some`
    //     was too loose: "Electrical Rough Complete" needs both "electrical" and
    //     "rough", or a passed "Rough-in plumbing" inspection corroborates it.
    const namesWholePhase = (text: string) => tokens.every(token => mentionsToken(text, token));

    // (a) An inspection that PASSED is the strongest field signal there is: a
    //     third party attended and signed the phase off — PROVIDED it is this
    //     phase. An unrelated plumbing sign-off must never unlock cabinetry.
    const passed = evidence.inspections.find(i =>
        /^(PASSED|APPROVED)$/i.test((i.result ?? "").trim())
        && inWindow(i.date)
        && namesWholePhase(i.type ?? ""));
    if (passed) {
        return {
            corroborated: true,
            via: "inspection",
            detail: `a "${passed.type}" inspection passed on ${passed.date} (within ${PROGRESS_WINDOW_DAYS} days of the deposit)`,
        };
    }

    // (b) A daily log that names this phase — AFFIRMATIVELY. The log has to
    //     name the whole phase, and the sentences that name it must not be
    //     saying the work is outstanding.
    for (const log of evidence.dailyLogs) {
        if (!inWindow(log.date)) continue;
        const text = log.workPerformed ?? "";
        if (!namesWholePhase(text)) continue;
        const naming = sentencesOf(text).filter(sentence => tokens.some(token => mentionsToken(sentence, token)));
        if (naming.length === 0 || naming.some(saysNotDone)) continue;
        return {
            corroborated: true,
            via: "daily-log",
            detail: `the daily log for ${log.date} says ${tokens.map(t => `"${t.toLowerCase()}"`).join(" and ")} is done`,
        };
    }

    const wanted = tokens.map(t => `"${t.toLowerCase()}"`).join(" and ");
    return {
        corroborated: false,
        via: null,
        detail: `no daily log saying ${wanted} is done, and no passed inspection of that phase, in the ${PROGRESS_WINDOW_DAYS} days before the deposit`,
    };
}
