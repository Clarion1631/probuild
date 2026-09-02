/**
 * The intake worker — one pass over the claimed rows
 * (docs/plans/PHASE-1-INTAKE-CORE-SPEC.md §5).
 *
 * Dry-run is the safety property this whole file exists to protect: with
 * `RECEIPT_INTAKE_DRYRUN` unset or "true" (the default), a row is read,
 * deduped and routed, and then STOPS. No QuickBooks call, no Expense row. The
 * proof is a test, not a comment: tests/receipt-intake-worker.test.ts drives a
 * full pass with injected fakes and asserts createPurchase was called zero
 * times and no Expense was created.
 *
 * Everything external is injected so that test needs no database, no network,
 * and no module mocking (CI is Node 20, where `mock.module` corrupts the
 * require chain).
 */
import { Prisma } from "@prisma/client";
import { canonicalVendor, dedupKeys } from "./keys";
import { dayKeyInTimeZone, startOfDateInTimeZone } from "@/lib/tz-date";
import { backoffMs, MAX_BOOK_ATTEMPTS, routeState, type DedupHits, type ReceiptIntakeState } from "./route-state";
import {
    appliedTaxCents,
    buildGroups,
    resolveSuggestedCostCodeId,
    type BookableRow,
    type BookResult,
} from "./book";
import { QBTimeoutError } from "@/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
} from "@/lib/qbo-receipt-push";
import type { ProjectPhase, ReadOutcome } from "./read";
import type { DocBytesResult } from "@/lib/secure-storage";

/**
 * ONE global constant, deliberately not derived from anything per-row or
 * per-deployment: `pg_try_advisory_xact_lock(hashtextextended(CLAIM_LOCK_KEY,0))`
 * is what guarantees a single worker BATCH runs at a time across every
 * concurrent invocation of the cron. A key that varied by row, region, or
 * process would let two batches run together, and the weak-dedup net (a plain
 * SELECT, not a claim) would then miss a pair that arrived in the same tick.
 */
export const CLAIM_LOCK_KEY = "receipt-intake-worker";
export const BATCH_SIZE = 10;
/** How long a claimed row is hidden from the next run. */
export const CLAIM_LEASE_MINUTES = 10;
/**
 * Stop taking on NEW rows once this much of the 60s function budget is gone.
 * One 25s read plus a QBO round trip can straddle the ceiling, and a row cut
 * off mid-book is the one case where the lease is doing real work rather than
 * being a formality.
 */
export const RUN_SOFT_DEADLINE_MS = 40_000;
/**
 * The invocation's real ceiling (`maxDuration = 60`), minus a small margin so a
 * booking that starts near the edge still gets to write its result. Bookings
 * measure their runway against THIS, not the soft deadline.
 */
export const RUN_HARD_BUDGET_MS = 55_000;
/**
 * How long a row may sit in STAGING before it is presumed to have lost its
 * upload. Generous on purpose: the intake route uploads inline, so a row that
 * is still STAGING after this either crashed mid-request or hit a storage
 * outage, and neither resolves itself.
 */
export const STAGING_SWEEP_MINUTES = 15;
/** Storage round trips per sweep. Small: the sweep runs before any real work. */
export const STAGING_SWEEP_BATCH = 10;
/**
 * Consecutive AI-unavailable passes before a row is parked for a human. Ported
 * from v3.4: an outage that never ends still has to end somewhere, and 20
 * passes at 5 minutes each is over an hour of "we tried".
 */
export const MAX_BUSY_PASSES = 20;

/** The columns a pass needs. A superset of BookableRow. */
export interface WorkerRow extends BookableRow {
    state: string;
    fileSize: number;
    readAt: Date | null;
    dedupWeakKey: string | null;
    busyPasses: number;
    /**
     * The fallback transaction date when the document's own date is
     * unreadable. v1 used the Drive UPLOAD date (:1509); the intake row is
     * created when the file arrives, so this is the same semantic — and,
     * unlike "now", it does not drift when a read is delayed by an outage.
     */
    createdAt: Date;
}

export interface WorkerDependencies {
    /**
     * ONE transaction under the global advisory lock: optionally requeue the
     * shadow-week backlog, then claim up to BATCH_SIZE due rows and bump their
     * nextRetryAt. Returns null when another run holds the lock.
     *
     * The requeue lives INSIDE this transaction rather than beside it: run
     * outside the lock, two overlapping invocations could both see the parked
     * backlog and both un-park it, and the second one's UPDATE would race the
     * first one's claim.
     */
    claim: (opts: CutoverRequest) => Promise<ClaimResult | null>;
    /** RECEIPT_INTAKE_DRYRUN is not "false". Injected so the cutover is testable. */
    isDryRunEnabled: () => boolean;
    /** The instant v1 stopped booking. null = not recorded; the cutover then refuses. */
    cutoverBoundary: () => Promise<Date | null>;
    /**
     * Move STAGING rows older than STAGING_SWEEP_MINUTES to NEEDS_REVIEW
     * `file-missing`, or PUBLISH them when the object is actually there.
     * `shouldStop` bounds the pass: the sweep downloads objects, so it must not
     * be able to eat the invocation before any real work starts.
     */
    sweepStaleStaging: (shouldStop: () => boolean) => Promise<number>;
    loadPhases: (projectId: string | null) => Promise<{ id: string; code: string; name: string }[]>;
    /** Tagged: a confirmed 404 and a transient storage fault are NOT the same answer. */
    downloadBytes: (storagePath: string) => Promise<DocBytesResult>;
    read: (bytes: Buffer, mime: string, phases: ProjectPhase[]) => Promise<ReadOutcome>;
    /**
     * Persist the read + routing. Returns the strong-key owner when the partial
     * unique index rejected our claim — that rejection IS the dedup hit.
     */
    applyRead: (rowId: string, patch: ReadPatch) => Promise<{ strongOwner: StrongOwner | null }>;
    findWeakHit: (rowId: string, weakKey: string) => Promise<{ id: string } | null>;
    /** Marks a row NEEDS_REVIEW / NON_RECEIPT / whatever routing decided, with no keys claimed. */
    applyState: (rowId: string, state: ReceiptIntakeState, stateReason: string | null, patch?: Partial<ReadPatch>) => Promise<void>;
    /**
     * READ + dryRun=false -> BOOKING, and the LAST weak-dedup check, taken
     * inside the same transaction as the transition. Returns the conflicting
     * row when another document with this weak key is already BOOKING/BOOKED.
     */
    promoteToBooking: (rowId: string, weakKey: string | null) => Promise<{ promoted: boolean; conflictId?: string }>;
    /** `remainingMs` is what is left of the invocation when the booking starts. */
    book: (row: BookableRow, remainingMs: number) => Promise<BookResult>;
    applyBookResult: (rowId: string, result: BookResult) => Promise<void>;
    /** AI unavailable: park for a later pass WITHOUT spending an attempt. */
    deferRead: (rowId: string, busyPasses: number, reason: string) => Promise<void>;
    /** A transient fault anywhere else: spend an attempt and back off. */
    retryRow: (rowId: string, attempts: number, nextRetryAt: Date, reason: string) => Promise<void>;
    /**
     * RECEIVED -> READ, and the release of the claim lease. Called ONCE, after
     * every dedup net has answered — never before, or an overlapping run could
     * reclaim a half-routed row and book it.
     */
    finishRouting: (rowId: string, stateReason: string | null) => Promise<void>;
    now: () => Date;
    /** Elapsed-time source for the soft deadline. */
    monotonicMs: () => number;
    /** The company's configured time zone — business dates are anchored to it, never UTC. */
    companyTimeZone: () => Promise<string>;
}

export interface StrongOwner {
    id: string;
    totalCents: number | null;
    canonicalVendor: string | null;
}

export interface ReadPatch {
    state: ReceiptIntakeState;
    stateReason: string | null;
    vendor: string | null;
    txnDate: Date | null;
    totalCents: number | null;
    taxCents: number | null;
    docType: string | null;
    refNumber: string | null;
    memo: string | null;
    readJson: string | null;
    readAt: Date;
    dedupStrongKey: string | null;
    dedupWeakKey: string;
    duplicateOfId: string | null;
    suggestedCostCodeId: string | null;
    suggestedConfidence: number | null;
}

export interface WorkerRunSummary {
    processed: number;
    byState: Record<string, number>;
    skipped?: "already-running";
    /** Rows left unprocessed because the soft deadline hit. They keep their lease. */
    deferredToNextRun?: number;
    /** Rows v1 already booked, retired as SHADOW_DONE by the first live pass. */
    shadowRetired?: number;
    /** Rows received AFTER v1 stopped: nobody booked these, so they are handed to v2. */
    requeued?: number;
    /** The cutover could not run because no boundary is recorded. */
    cutoverBlocked?: "cutover-boundary-missing";
    /** STAGING rows whose upload never landed, parked for a human. */
    staleStagingSwept?: number;
}

function centsOf(amount: string): number | null {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

/**
 * The calendar day the receipt was written, anchored in the COMPANY's time
 * zone — not UTC.
 *
 * A receipt read as 2026-08-03 was stored as 2026-08-03T00:00:00Z, which in
 * America/Los_Angeles is 5pm on August 2nd. Every date-range report that
 * bounds by local midnight (job cost by month, the WA tax period, variance by
 * week) therefore put roughly a third of receipts in the wrong bucket, and the
 * error is invisible unless you already suspect it. Everything else in the app
 * anchors business dates with startOfDateInTimeZone; this now does too.
 */
export function dateOnly(value: string, timeZone: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    try {
        const at = startOfDateInTimeZone(value, timeZone);
        return Number.isFinite(at.getTime()) ? at : null;
    } catch {
        return null;
    }
}

/**
 * The most sales tax a receipt can plausibly carry, as a fraction of the total.
 *
 * Washington's highest combined rate is about 10.6%; 12% leaves headroom for a
 * local surcharge without accepting nonsense. The model reads the TAX line off
 * a photo, and a misread decimal point ("$2.92" as "$292") or a grabbed
 * subtotal posts real money to the reimbursable-sales-tax account and inflates
 * a state filing. This is a SANITY bound, not a tax calculation — the tax that
 * survives it is still whatever the document said.
 */
export const MAX_PLAUSIBLE_TAX_RATE = 0.12;

/**
 * Accept the OCR'd tax only when it is between zero and MAX_PLAUSIBLE_TAX_RATE
 * of the total, rounded UP to the cent so a legitimate rounding artefact at the
 * boundary is not rejected.
 *
 * An implausible value is DROPPED, not parked: the receipt itself is fine and
 * its total is what the bank charge will match, so booking it is right. The row
 * simply books as a single un-split line and carries a note, which is exactly
 * what happens for a receipt with no readable tax line at all.
 */
export function validateTaxCents(
    taxCents: number | null,
    totalCents: number | null,
    docType: string | null,
): { taxCents: number | null; implausible: boolean } {
    // No tax line is the NORMAL case here, not a problem.
    if (taxCents === null || taxCents <= 0) return { taxCents: null, implausible: false };

    // A handwritten check to a subcontractor has no sales tax, full stop. If the
    // model produced one it read the wrong number off the cheque — the amount
    // box, a memo figure — and booking it would move real money into the
    // reimbursable-sales-tax account for a payment that was never taxed.
    // sendToQBOviaAPI.js:148 refuses to split tax on a check for the same
    // reason; this makes the row SAY so instead of dropping it silently.
    if (String(docType ?? "receipt").toLowerCase() === "check") {
        return { taxCents: null, implausible: true };
    }

    if (totalCents === null || totalCents <= 0) return { taxCents: null, implausible: true };
    // Tax can never BE the total, let alone exceed it — that is a grabbed
    // subtotal or a misread line, not a tax figure.
    if (taxCents >= totalCents) return { taxCents: null, implausible: true };
    const ceiling = Math.ceil(totalCents * MAX_PLAUSIBLE_TAX_RATE);
    if (taxCents > ceiling) return { taxCents: null, implausible: true };
    return { taxCents, implausible: false };
}

export function toDateStr(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** One pass. Never throws for a single bad row — one poison document must not stall the queue. */
export interface CutoverRequest {
    /** Run the cutover this pass (i.e. dry-run is off). */
    run: boolean;
    /**
     * The instant v1 stopped booking. Rows received BEFORE it were booked by
     * v1 and are retired; rows received AFTER it were booked by nobody and are
     * handed to v2. null refuses to touch either side.
     */
    boundary: Date | null;
}

export interface ClaimResult {
    rows: WorkerRow[];
    shadowRetired: number;
    requeued: number;
    boundaryMissing: boolean;
}

export async function runIntakeWorker(deps: WorkerDependencies): Promise<WorkerRunSummary> {
    // THE DEADLINE STARTS HERE, at invocation entry — not after the claim and
    // the sweep. The sweep downloads objects, so timing it out of the budget
    // meant it could consume the whole platform timeout and the worker would
    // STILL go on to start a 25s Gemini read and a QBO round trip.
    const startedAt = deps.monotonicMs();
    const outOfTime = () => deps.monotonicMs() - startedAt >= RUN_SOFT_DEADLINE_MS;
    // What is left of the PLATFORM budget, not the soft deadline: a booking may
    // legitimately run past the point where we stop taking new rows, it just
    // must not start without room to finish.
    const remainingMs = () => RUN_HARD_BUDGET_MS - (deps.monotonicMs() - startedAt);

    // CUTOVER. Rows received while dry-run was on were booked by v1, so v2 must
    // never book them: they are RETIRED as SHADOW_DONE, not requeued.
    //
    // Requeuing them was a double-booking hazard. v2's QBO identity for an
    // email/chat/mobile/web row is the intake UUID, which v1 never saw, so
    // QuickBooks' DocNumber idempotency could not recognise a Purchase v1 had
    // already created for the same document — and the whole shadow backlog
    // would have been booked a second time, on real books, in one pass.
    // The shadow backlog splits on ONE timestamp: when v1 stopped booking.
    // Everything before it was booked by v1 and is retired to SHADOW_DONE;
    // everything after it was booked by NOBODY and must be handed to v2, or
    // those receipts are silently dropped. Nothing in the database can infer
    // that instant, so with no boundary recorded the pass refuses to touch
    // either side and says so.
    const runCutover = !deps.isDryRunEnabled();
    const boundary = runCutover ? await deps.cutoverBoundary() : null;
    const claimed = await deps.claim({ run: runCutover, boundary });
    if (claimed === null) {
        return { processed: 0, byState: {}, skipped: "already-running" };
    }
    const { rows, shadowRetired, requeued, boundaryMissing } = claimed;
    if (boundaryMissing) {
        console.error("[cron/receipt-intake-worker] cutover-boundary-missing: refusing to retire or requeue");
    }

    // Rows whose upload never landed are invisible to the claim by design, so
    // this is the only thing that will ever notice them.
    const staged = await deps.sweepStaleStaging(outOfTime).catch(() => 0);

    const byState: Record<string, number> = {};
    const bump = (state: string) => { byState[state] = (byState[state] ?? 0) + 1; };

    let processed = 0;
    let deferredToNextRun = 0;

    for (const row of rows) {
        // A row started at 41s can still be reading at 66s, past the function
        // ceiling — the invocation dies mid-book and the row's state is
        // whatever it happened to be. Stop TAKING rows instead; the claim
        // lease already keeps them ours, and the next run picks them up.
        if (outOfTime()) {
            deferredToNextRun = rows.length - processed;
            break;
        }
        processed++;
        try {
            if (row.state === "RECEIVED") {
                bump(await processReceived(row, deps));
            } else if (row.state === "READ") {
                // Dry-run rows PARK at READ. This is the shadow-week gate: the
                // only thing that moves a row to BOOKING is dryRun === false.
                if (row.dryRun) { bump("READ"); continue; }
                const promotion = await deps.promoteToBooking(row.id, row.dedupWeakKey);
                if (!promotion.promoted) {
                    // Another document with the same canonical vendor, date and
                    // amount reached BOOKING/BOOKED first. Two same-day, same-
                    // amount purchases from one vendor are real, so this asks a
                    // human rather than quarantining — but it must ask BEFORE
                    // the money moves, which is why the check lives inside the
                    // transition rather than beside it.
                    bump("NEEDS_REVIEW");
                    continue;
                }
                const result = await deps.book({ ...row, dryRun: false }, remainingMs());
                await deps.applyBookResult(row.id, result);
                bump(stateForBookResult(result));
            } else if (row.state === "BOOKING") {
                if (row.dryRun) { bump("BOOKING"); continue; }
                const result = await deps.book(row, remainingMs());
                await deps.applyBookResult(row.id, result);
                bump(stateForBookResult(result));
            }
        } catch (error) {
            bump(await handleRowError(row, deps, error));
        }
    }

    return {
        processed,
        byState,
        ...(deferredToNextRun ? { deferredToNextRun } : {}),
        ...(shadowRetired ? { shadowRetired } : {}),
        ...(requeued ? { requeued } : {}),
        ...(boundaryMissing ? { cutoverBlocked: "cutover-boundary-missing" as const } : {}),
        ...(staged ? { staleStagingSwept: staged } : {}),
    };
}

/**
 * A throw out of a row's processing is almost never the document's fault:
 * Supabase hiccuped, Prisma lost its connection, the settings read failed, a
 * socket reset. Parking all of those for a human turns one bad minute into a
 * queue full of manual work, and (worse) leaves rows holding their strong keys.
 *
 * Only the CLASSIFIED QuickBooks business faults are terminal here. Everything
 * else spends an attempt and comes back on the normal backoff, with the same
 * 20-attempt ceiling as booking so a genuinely broken row still ends up in
 * front of a person.
 */
export async function handleRowError(
    row: WorkerRow,
    deps: WorkerDependencies,
    error: unknown,
): Promise<string> {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";

    if (isTerminalQboFault(error)) {
        await deps.applyState(row.id, "NEEDS_REVIEW", `qbo-fault:${message}`.slice(0, 400)).catch(() => {});
        return "NEEDS_REVIEW";
    }

    const attempts = row.attempts + 1;
    if (attempts >= MAX_BOOK_ATTEMPTS) {
        await deps.applyState(row.id, "NEEDS_REVIEW", "max-retries").catch(() => {});
        return "NEEDS_REVIEW";
    }
    await deps.retryRow(
        row.id,
        attempts,
        new Date(deps.now().getTime() + backoffMs(attempts)),
        `worker-error:${message}`.slice(0, 400),
    ).catch(() => {});
    return "RETRY";
}

/** QBTimeoutError is deliberately NOT here — a timeout is transport, not a verdict. */
export function isTerminalQboFault(error: unknown): boolean {
    if (error instanceof QBTimeoutError) return false;
    return (
        error instanceof QboPurchaseFaultError ||
        error instanceof QboAccountConfigError ||
        error instanceof QboVendorDuplicateError
    );
}

function stateForBookResult(result: BookResult): string {
    switch (result.outcome) {
        case "booked": return "BOOKED";
        case "needs-review": return "NEEDS_REVIEW";
        case "deferred": return "BOOKING";
        case "retry": return "BOOKING";
    }
}

async function processReceived(row: WorkerRow, deps: WorkerDependencies): Promise<string> {
    const download = await deps.downloadBytes(row.storagePath);
    if (!download.ok) {
        // "The object is gone" and "storage was briefly unreachable" demand
        // opposite answers, and collapsing them to null meant a Supabase blip
        // parked good receipts as file-missing, permanently, for a human to
        // untangle. Only an AFFIRMATIVE not-found is terminal.
        if (download.kind === "not-found") {
            await deps.applyState(row.id, "NEEDS_REVIEW", "file-missing");
            return "NEEDS_REVIEW";
        }
        return retryTransient(row, deps, `storage:${download.message}`);
    }
    const bytes = download.bytes;

    const costCodes = await deps.loadPhases(row.projectId);
    const phases: ProjectPhase[] = costCodes.map(c => ({ code: c.code, name: c.name }));

    const outcome = await deps.read(bytes, row.mimeType, phases);
    if (!outcome.ok) {
        // decisive: the model answered and still could not read it -> a human.
        if (outcome.decisive) {
            await deps.applyState(row.id, "NEEDS_REVIEW", "unreadable");
            return "NEEDS_REVIEW";
        }
        // The SERVICE was unavailable. That is never the document's fault, so
        // it costs no `attempts` — but it cannot be free forever either, or an
        // outage that outlasts the incident leaves rows cycling silently. v3.4
        // counts the busy passes separately and gives up after 20.
        const busyPasses = row.busyPasses + 1;
        if (busyPasses >= MAX_BUSY_PASSES) {
            await deps.applyState(row.id, "NEEDS_REVIEW", "ai-unavailable");
            return "NEEDS_REVIEW";
        }
        await deps.deferRead(row.id, busyPasses, "ai-unavailable");
        return "RECEIVED";
    }

    const read = outcome.read;
    // Resolved BEFORE the keys: the fallback date is part of the dedup key, so
    // it has to be the company's calendar day from the start.
    const timeZone = await deps.companyTimeZone();
    const keys = dedupKeys({
        docType: read.docType,
        vendor: read.vendor,
        date: read.date,
        invoice: read.invoice,
        checkNumber: read.checkNumber,
        totalAmount: read.totalAmount,
        // The company's calendar day, not UTC's. `toISOString().slice(0,10)`
        // rolls over at 16:00/17:00 local, so a receipt uploaded on a Pacific
        // evening got TOMORROW's date as its fallback — changing its dedup key
        // and its reporting period.
        fallbackDateStr: dayKeyInTimeZone(row.createdAt, timeZone),
    });

    const totalCents = centsOf(keys.amount);
    const taxCentsRaw = centsOf(read.taxAmount || "0.00");
    const tax = validateTaxCents(
        taxCentsRaw && taxCentsRaw > 0 ? taxCentsRaw : null,
        totalCents,
        read.docType,
    );

    // PERSIST ONLY WHAT BOOKING WILL ACTUALLY USE.
    //
    // The row's taxCents feeds the sales-tax reports, and those must never show
    // a figure that no Purchase ever carried. So the stored value is not the
    // validated one — it is the value read back out of the SAME buildGroups the
    // booking step calls. If the two ever disagree (a rule added on one side
    // only), the row records the BOOKING's answer and is flagged, rather than
    // quietly reporting a tax that was rejected downstream.
    const accepted = totalCents !== null && totalCents > 0
        ? appliedTaxCents(buildGroups(read.docType, totalCents, tax.taxCents, keys.ref))
        : 0;
    const taxCents = accepted > 0 ? accepted : null;
    const taxImplausible = tax.implausible || (tax.taxCents !== null && taxCents === null);

    const base = {
        vendor: read.vendor || null,
        txnDate: dateOnly(keys.dateStr, timeZone),
        totalCents,
        taxCents,
        docType: read.docType || null,
        refNumber: keys.ref,
        memo: read.memo || null,
        readJson: read.raw,
        readAt: deps.now(),
        dedupWeakKey: keys.weak,
        suggestedCostCodeId: resolveSuggestedCostCodeId(read.suggestedPhaseCode, costCodes),
        // Stored beside the suggestion so the queue can sort by it and the
        // booking can record how sure the phase pick was.
        suggestedConfidence: read.suggestedConfidence,
    };

    const routeInput = {
        docType: read.docType,
        amount: keys.amount,
        totalCents,
        canonicalVendor: canonicalVendor(read.vendor),
    };

    // ORDER MATTERS, and it used to be wrong.
    //
    // The weak lookup ran FIRST, so an exact duplicate — same date, same ref,
    // same vendor, same amount, which therefore matches BOTH nets — routed on
    // the weak hit to NEEDS_REVIEW and never attempted the strong claim at all.
    // The one case the strong key exists to resolve automatically was the one
    // case it never got to see, and every re-sent receipt landed in a human's
    // queue.
    //
    // So: the document-level gates first (multi, non-receipt, refund/zero, no
    // job) because those outrank dedup entirely; then the STRONG claim, which
    // is the only net that can answer DUPLICATE on its own; and only if the
    // strong net is silent do we fall back to the weak one, which by design
    // never decides anything itself.
    // A dropped tax reading is recorded, never parked: the receipt is fine and
    // its TOTAL is what the bank charge matches, so it must still book. The note
    // rides along with whatever state routing picks so the row shows it in the
    // queue. `note()` is applied to every write below rather than to one branch,
    // because a document can be both a duplicate and a bad tax read.
    const note = (reason: string | null): string | null => {
        if (!taxImplausible) return reason;
        return reason ? `${reason};tax-implausible` : "tax-implausible";
    };

    const gate = routeState(routeInput, { strong: null, weak: null }, !!row.projectId);
    if (gate.state !== "READ") {
        // A multi-doc, a non-receipt, or a $0/negative misread must never hold
        // a dedup key — it would quarantine the real receipt that arrives next
        // (:531 and the v3.6 rationale).
        await deps.applyRead(row.id, {
            ...base,
            state: gate.state,
            stateReason: note(gate.stateReason),
            dedupStrongKey: null,
            duplicateOfId: gate.duplicateOfId,
        });
        return gate.state;
    }

    // The strong claim IS the partial unique index: a rejection is the hit.
    //
    // The row deliberately stays RECEIVED here, and keeps its claim lease.
    // Publishing READ at this point was wrong twice over:
    //   - the lease was cleared before the weak lookup ran, so an overlapping
    //     invocation could reclaim the row and BOOK it while this one was still
    //     routing — and this one would then regress it to NEEDS_REVIEW.
    //   - if the weak lookup then threw, the row was left in READ having never
    //     been weak-checked. In shadow mode READ is a terminal parking state,
    //     so it would sit there forever while the daily comparison counted it
    //     as fully deduped. A silent false negative in the one report the
    //     cutover decision rests on.
    // READ is now reached only by finishRouting(), after every net has spoken.
    const applied = await deps.applyRead(row.id, {
        ...base,
        state: "RECEIVED",
        stateReason: note(null),
        dedupStrongKey: keys.strong,
        duplicateOfId: null,
    });

    if (applied.strongOwner) {
        const second = routeState(routeInput, { strong: applied.strongOwner, weak: null }, !!row.projectId);
        await deps.applyState(row.id, second.state, note(second.stateReason), {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: second.duplicateOfId,
        });
        return second.state;
    }

    // No strong hit (or no strong key at all — a placeholder ref). The weak net
    // is a plain query and never a claim (:1591-1596); a hit only ever asks a
    // human, because two genuine same-day purchases from one vendor for the
    // same amount do happen.
    //
    // A THROW here leaves the row RECEIVED with its keys already written, which
    // is exactly right: the next pass re-runs the identical claim (updating a
    // row to the strong key it already holds is a no-op, not a conflict) and
    // re-checks the weak net.
    const weak = await deps.findWeakHit(row.id, keys.weak);
    if (weak) {
        const third = routeState(routeInput, { strong: null, weak }, !!row.projectId);
        // RELEASE the strong key. Nothing was sent to QuickBooks, so this row
        // is parked pre-send and the documented rule applies to it like any
        // other. Holding the key made a CORRECTED resend of the same receipt
        // collide with a row that was never booked — the review queue then had
        // two rows and neither could proceed. The weak pair is still visible to
        // a human through duplicateOfId and the reason.
        await deps.applyState(row.id, third.state, note(third.stateReason), {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: third.duplicateOfId,
        });
        return third.state;
    }

    // Routing is complete. This is the ONLY path to READ, and the only place
    // the claim lease is released.
    await deps.finishRouting(row.id, note(null));
    return "READ";
}

/** A transport-class fault during a row's processing: spend an attempt, back off. */
async function retryTransient(row: WorkerRow, deps: WorkerDependencies, reason: string): Promise<string> {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_BOOK_ATTEMPTS) {
        await deps.applyState(row.id, "NEEDS_REVIEW", "max-retries");
        return "NEEDS_REVIEW";
    }
    await deps.retryRow(row.id, attempts, new Date(deps.now().getTime() + backoffMs(attempts)), reason);
    return "RETRY";
}

/**
 * A unique-constraint violation. NOT specific to the strong key on purpose.
 *
 * The previous version string-matched "dedupStrongKey" inside `error.meta`,
 * which is a Prisma-version-dependent shape AND is empty for a PARTIAL index on
 * some engine builds — the exact index this whole mechanism relies on. The
 * caller resolves which constraint fired by looking the owner up by
 * dedupStrongKey, which is a fact about the DATA rather than about how Prisma
 * happened to render the error.
 */
export function isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
