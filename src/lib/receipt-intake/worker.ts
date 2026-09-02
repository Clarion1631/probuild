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
import { dedupKeys } from "./keys";
import { routeState, type DedupHits, type ReceiptIntakeState } from "./route-state";
import { resolveSuggestedCostCodeId, type BookableRow, type BookResult } from "./book";
import type { ProjectPhase, ReadOutcome } from "./read";

export const CLAIM_LOCK_KEY = "receipt-intake-worker";
export const BATCH_SIZE = 10;
/** How long a claimed row is hidden from the next run. */
export const CLAIM_LEASE_MINUTES = 10;

/** The columns a pass needs. A superset of BookableRow. */
export interface WorkerRow extends BookableRow {
    state: string;
    fileSize: number;
    readAt: Date | null;
}

export interface WorkerDependencies {
    /** Claims up to BATCH_SIZE rows and bumps their nextRetryAt. Returns [] when another run holds the lock. */
    claim: () => Promise<WorkerRow[] | null>;
    loadPhases: (projectId: string | null) => Promise<{ id: string; code: string; name: string }[]>;
    downloadBytes: (secureRef: string) => Promise<Buffer | null>;
    read: (bytes: Buffer, mime: string, phases: ProjectPhase[]) => Promise<ReadOutcome>;
    /**
     * Persist the read + routing. Returns the strong-key owner when the partial
     * unique index rejected our claim — that rejection IS the dedup hit.
     */
    applyRead: (rowId: string, patch: ReadPatch) => Promise<{ strongOwner: { id: string; totalCents: number | null } | null }>;
    findWeakHit: (rowId: string, weakKey: string) => Promise<{ id: string } | null>;
    /** Marks a row NEEDS_REVIEW / NON_RECEIPT / whatever routing decided, with no keys claimed. */
    applyState: (rowId: string, state: ReceiptIntakeState, stateReason: string | null, patch?: Partial<ReadPatch>) => Promise<void>;
    /** READ + dryRun=false -> BOOKING. */
    promoteToBooking: (rowId: string) => Promise<void>;
    book: (row: BookableRow) => Promise<BookResult>;
    applyBookResult: (rowId: string, result: BookResult) => Promise<void>;
    /** Read failed without touching the document: park it for a later pass. */
    deferRead: (rowId: string, decisive: boolean, reason: string) => Promise<void>;
    now: () => Date;
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
    const rows = await deps.claim();
    if (rows === null) return { processed: 0, byState: {}, skipped: "already-running" };

    const byState: Record<string, number> = {};
    const bump = (state: string) => { byState[state] = (byState[state] ?? 0) + 1; };

    for (const row of rows) {
        try {
            if (row.state === "RECEIVED") {
                bump(await processReceived(row, deps));
            } else if (row.state === "READ") {
                // Dry-run rows PARK at READ. This is the shadow-week gate: the
                // only thing that moves a row to BOOKING is dryRun === false.
                if (row.dryRun) { bump("READ"); continue; }
                await deps.promoteToBooking(row.id);
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
            // A row that blows up is parked for a human rather than retried
            // forever: an unexpected throw here is a code fault, not a
            // transient one.
            const message = error instanceof Error ? `${error.name}: ${error.message}` : "UnknownError";
            await deps.applyState(row.id, "NEEDS_REVIEW", `worker-error:${message}`.slice(0, 400)).catch(() => {});
            bump("NEEDS_REVIEW");
        }
    }

    return { processed: rows.length, byState };
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
        // not decisive: the SERVICE was unavailable -> try again, costs nothing.
        if (outcome.decisive) {
            await deps.applyState(row.id, "NEEDS_REVIEW", "unreadable");
            return "NEEDS_REVIEW";
        }
        await deps.deferRead(row.id, false, "ai-unavailable");
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
        fallbackDateStr: toDateStr(row.readAt ?? deps.now()),
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

    const decision = routeState(
        { docType: read.docType, amount: keys.amount, totalCents },
        hits,
        !!row.projectId,
    );

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
        const second = routeState(
            { docType: read.docType, amount: keys.amount, totalCents },
            { strong: applied.strongOwner, weak },
            !!row.projectId,
        );
        await deps.applyState(row.id, second.state, second.stateReason, {
            ...base,
            dedupStrongKey: null,
            duplicateOfId: second.duplicateOfId,
        });
        return second.state;
    }

    return decision.state;
}

/** True when a write failed because the strong-key partial unique index rejected it. */
export function isStrongKeyConflict(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        JSON.stringify(error.meta ?? {}).includes("dedupStrongKey")
    );
}
