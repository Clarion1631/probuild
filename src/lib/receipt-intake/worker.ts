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
import { backoffMs, MAX_BOOK_ATTEMPTS, routeState, type DedupHits, type ReceiptIntakeState } from "./route-state";
import { resolveSuggestedCostCodeId, type BookableRow, type BookResult } from "./book";
import { QBTimeoutError } from "@/lib/quickbooks";
import {
    QboAccountConfigError,
    QboPurchaseFaultError,
    QboVendorDuplicateError,
} from "@/lib/qbo-receipt-push";
import type { ProjectPhase, ReadOutcome } from "./read";

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
    /** Claims up to BATCH_SIZE rows and bumps their nextRetryAt. Returns null when another run holds the lock. */
    claim: () => Promise<WorkerRow[] | null>;
    /** RECEIPT_INTAKE_DRYRUN is not "false". Injected so the requeue is testable. */
    isDryRunEnabled: () => boolean;
    /**
     * One-shot at the start of the first LIVE pass: un-park every row the
     * shadow week left sitting at READ/BOOKING with dryRun=true. Returns the
     * number requeued. Naturally idempotent — after one live pass there is
     * nothing left to match.
     */
    requeueDryRunParked: () => Promise<number>;
    loadPhases: (projectId: string | null) => Promise<{ id: string; code: string; name: string }[]>;
    downloadBytes: (secureRef: string) => Promise<Buffer | null>;
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
    book: (row: BookableRow) => Promise<BookResult>;
    applyBookResult: (rowId: string, result: BookResult) => Promise<void>;
    /** AI unavailable: park for a later pass WITHOUT spending an attempt. */
    deferRead: (rowId: string, busyPasses: number, reason: string) => Promise<void>;
    /** A transient fault anywhere else: spend an attempt and back off. */
    retryRow: (rowId: string, attempts: number, nextRetryAt: Date, reason: string) => Promise<void>;
    now: () => Date;
    /** Elapsed-time source for the soft deadline. */
    monotonicMs: () => number;
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
}

export interface WorkerRunSummary {
    processed: number;
    byState: Record<string, number>;
    skipped?: "already-running";
    /** Rows left unprocessed because the soft deadline hit. They keep their lease. */
    deferredToNextRun?: number;
    /** Rows un-parked by the first live pass after the shadow week. */
    requeued?: number;
}

function centsOf(amount: string): number | null {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

/** "YYYY-MM-DD" at UTC midnight — the shape a @db.Date column round-trips. */
export function dateOnly(value: string): Date | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function toDateStr(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** One pass. Never throws for a single bad row — one poison document must not stall the queue. */
export async function runIntakeWorker(deps: WorkerDependencies): Promise<WorkerRunSummary> {
    // Cutover: the FIRST live pass hands the shadow week's parked backlog back
    // to the queue. Rows parked under dryRun are excluded from the claim (see
    // the cron route's claim predicate) precisely so they cannot starve the
    // batch — which also means nothing else would ever wake them.
    let requeued = 0;
    if (!deps.isDryRunEnabled()) {
        requeued = await deps.requeueDryRunParked();
    }

    const rows = await deps.claim();
    if (rows === null) {
        return { processed: 0, byState: {}, skipped: "already-running", ...(requeued ? { requeued } : {}) };
    }

    const startedAt = deps.monotonicMs();
    const byState: Record<string, number> = {};
    const bump = (state: string) => { byState[state] = (byState[state] ?? 0) + 1; };

    let processed = 0;
    let deferredToNextRun = 0;

    for (const row of rows) {
        // A row started at 41s can still be reading at 66s, past the function
        // ceiling — the invocation dies mid-book and the row's state is
        // whatever it happened to be. Stop TAKING rows instead; the claim
        // lease already keeps them ours, and the next run picks them up.
        if (deps.monotonicMs() - startedAt >= RUN_SOFT_DEADLINE_MS) {
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
                const result = await deps.book({ ...row, dryRun: false });
                await deps.applyBookResult(row.id, result);
                bump(stateForBookResult(result));
            } else if (row.state === "BOOKING") {
                if (row.dryRun) { bump("BOOKING"); continue; }
                const result = await deps.book(row);
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
        ...(requeued ? { requeued } : {}),
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
    const bytes = await deps.downloadBytes(row.storagePath);
    if (!bytes) {
        // The object is gone from the bucket — nothing to read, ever.
        await deps.applyState(row.id, "NEEDS_REVIEW", "file-missing");
        return "NEEDS_REVIEW";
    }

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
    const keys = dedupKeys({
        docType: read.docType,
        vendor: read.vendor,
        date: read.date,
        invoice: read.invoice,
        checkNumber: read.checkNumber,
        totalAmount: read.totalAmount,
        fallbackDateStr: toDateStr(row.createdAt),
    });

    const totalCents = centsOf(keys.amount);
    const taxCentsRaw = centsOf(read.taxAmount || "0.00");
    const taxCents = taxCentsRaw && taxCentsRaw > 0 ? taxCentsRaw : null;

    // Weak hits are a plain query and never a claim (:1591-1596). Strong hits
    // come from the partial unique index rejecting the write below.
    const weak = await deps.findWeakHit(row.id, keys.weak);
    const hits: DedupHits = { strong: null, weak };

    const base = {
        vendor: read.vendor || null,
        txnDate: dateOnly(keys.dateStr),
        totalCents,
        taxCents,
        docType: read.docType || null,
        refNumber: keys.ref,
        memo: read.memo || null,
        readJson: read.raw,
        readAt: deps.now(),
        dedupWeakKey: keys.weak,
        suggestedCostCodeId: resolveSuggestedCostCodeId(read.suggestedPhaseCode, costCodes),
    };

    const routeInput = {
        docType: read.docType,
        amount: keys.amount,
        totalCents,
        canonicalVendor: canonicalVendor(read.vendor),
    };
    const decision = routeState(routeInput, hits, !!row.projectId);

    // A document that never reaches READ must not hold the strong key: a
    // multi-doc, a non-receipt, or a $0 misread would otherwise quarantine the
    // real receipt that arrives next (:531 and the v3.6 rationale).
    const claimsStrongKey = decision.state === "READ" && keys.strong !== null;

    const applied = await deps.applyRead(row.id, {
        ...base,
        state: decision.state,
        stateReason: decision.stateReason,
        dedupStrongKey: claimsStrongKey ? keys.strong : null,
        duplicateOfId: decision.duplicateOfId,
    });

    if (applied.strongOwner) {
        // The claim lost: another live row already owns this date|ref. Re-route
        // with the owner in hand and write the losing outcome (no key).
        const second = routeState(routeInput, { strong: applied.strongOwner, weak }, !!row.projectId);
        await deps.applyState(row.id, second.state, second.stateReason, {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: second.duplicateOfId,
        });
        return second.state;
    }

    return decision.state;
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
