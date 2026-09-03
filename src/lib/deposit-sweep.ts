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
import { dayKeyInTimeZone } from "./tz-date";

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
 * Statuses that mean a bank deposit is working on this milestone RIGHT NOW,
 * used to decide receipt suppression when some other caller finishes the
 * settle. Deliberately different from the list above in both directions:
 *
 *   - `reconcile` IS here. A sweep payment parked for manual reconciliation is
 *     still the sweep's money; the client must not be emailed a receipt for it.
 *   - `applied` is NOT here. A finished deposit is history, and history must
 *     not suppress a LATER, unrelated settlement of the same milestone — an
 *     undo-and-repay would otherwise silently swallow the client's receipt
 *     forever. An applied row only suppresses when its own qbPaymentId matches
 *     the payment being settled (see settleMilestoneFromQBPayment).
 */
export const MONEY_IN_FLIGHT_STATUSES = ["processing", "qbo_unknown", "qbo_created", "reconcile"] as const;

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

export interface BankBatch {
    /** YYYY-MM-DD — the CSV Post Date the whole batch belongs to. */
    postDate: string;
    credits: BankCredit[];
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
    if (raw.credits.length > MAX_BANK_CREDITS_PER_BATCH) {
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

    // Control totals, from the CSV's own ledger/total rows. Both must tie to
    // the rows actually present.
    // Real numbers, not numeric strings: a control total is evidence, and
    // evidence that needed coercing to compare is not evidence.
    const creditCount = typeof raw.creditCount === "number" ? raw.creditCount : NaN;
    if (!Number.isInteger(creditCount) || creditCount !== credits.length) {
        return { ok: false, reason: `creditCount ${raw.creditCount} does not match the ${credits.length} credit row(s) posted` };
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
    const actualCents = credits.reduce((sum, c) => sum + c.amountCents, 0);
    if (Math.abs(creditSum * 100 - declaredCents) > 1e-6 || declaredCents !== actualCents) {
        return {
            ok: false,
            reason: `creditSum ${creditSum} does not match the posted rows (${(actualCents / 100).toFixed(2)})`,
        };
    }

    return { ok: true, batch: { postDate, credits, dryRun: raw.dryRun === true } };
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
    const bucketSum = counts.applied + counts.proposed + counts.unmatched
        + counts.reconcile + counts.failed + counts.qboUnknown + counts.unresolved;
    if (bucketSum !== counts.credits) return false;
    return counts.reconcile === 0 && counts.failed === 0 && counts.qboUnknown === 0 && counts.unresolved === 0;
}
