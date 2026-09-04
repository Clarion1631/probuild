/**
 * The v1 -> v2 cutover boundary.
 *
 * The problem this exists to solve: at cutover, the shadow-week backlog cannot
 * all be treated the same way. Rows received while the Apps Script was still
 * BOOKING were booked by v1, so v2 must never book them again — v2's QuickBooks
 * identity for an email/chat/mobile/web row is the intake UUID, which v1 never
 * saw, so DocNumber idempotency cannot recognise the Purchase v1 already made.
 * But rows received AFTER v1 stopped booking were never booked by anyone, and
 * retiring those would silently drop real expenses on the floor.
 *
 * One timestamp separates the two: the instant the Apps Script was flipped to
 * forwarder mode and stopped writing to QuickBooks. It is recorded when that
 * flip happens, NOT derived — nothing in the database can infer it, and a guess
 * here either double-books or loses receipts.
 *
 * With no boundary recorded the worker refuses to retire anything at all. That
 * is the only safe default: retiring on a guess destroys evidence, and the
 * failure mode of refusing is a visible, logged no-op.
 */
import { prisma } from "@/lib/prisma";

export const CUTOVER_SETTING_KEY = "cutoverV1StoppedAt";

/**
 * When v1 stopped booking. Read from the AutomationSetting row first (that is
 * what an operator writes at the flip), falling back to the env var so a
 * deployment can carry it too. Returns null when unset OR unparseable — a
 * malformed value must not be silently treated as "epoch", which would retire
 * the entire backlog.
 */
export async function resolveCutoverBoundary(): Promise<Date | null> {
    let raw: string | null | undefined;
    try {
        raw = (await prisma.automationSetting.findUnique({ where: { key: CUTOVER_SETTING_KEY } }))?.value;
    } catch (error) {
        // A settings read failure is NOT "no boundary" — that would let a DB
        // blip authorise a retire. Surface it as unset, which refuses.
        console.error("[cutover] settings read failed", error instanceof Error ? error.name : "UnknownError");
        return null;
    }
    return parseCutoverBoundary(raw ?? process.env.CUTOVER_V1_STOPPED_AT);
}

// Full RFC3339 date-time with a REQUIRED offset (`Z` or `±HH:MM`). `new
// Date()`/`Date.parse()` also accept date-only strings ("2026-09-01", read as
// UTC midnight) and naive local-time strings ("2026-09-01T10:00:00", read in
// the SERVER's local zone) and even ambiguous formats ("9/1/2026") — every one
// of those silently shifts the boundary by hours depending on where the
// process runs, which either retires rows v1 never booked or lets a
// v1-booked row slip through to be double-booked by v2. An explicit offset is
// the only representation that names one unambiguous instant.
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/** Pure, so the parsing rules are testable without a database. */
export function parseCutoverBoundary(value: string | null | undefined): Date | null {
    if (!value || !value.trim()) return null;
    const trimmed = value.trim();
    if (!RFC3339_WITH_OFFSET.test(trimmed)) {
        console.error(
            "[cutover] boundary must be a full RFC3339 timestamp with an explicit Z or ±HH:MM offset " +
            `(e.g. "2026-08-25T17:30:00Z") — rejecting ambiguous value: ${JSON.stringify(trimmed)}`,
        );
        return null;
    }
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
}

/** One parked shadow row, as the cutover sees it. */
export interface CutoverCandidate {
    id: string;
    source: string;
    sourceRef: string;
    archivedByV1: boolean;
    createdAt: Date;
}

export interface CutoverTriage {
    /** v1 booked it. Retire — SHADOW_DONE, never booked here. */
    evidenced: string[];
    /** Nobody booked it (or we can collapse a double). Hand to v2. */
    unevidenced: string[];
    /** Cannot be settled from data. A human checks QuickBooks. */
    quarantined: string[];
}

/** The Drive file id a row books under, or null when it has no shared identity. */
export function driveFileIdOf(row: { source: string; sourceRef: string }): string | null {
    return row.source === "drive" && row.sourceRef.startsWith("drive:")
        ? row.sourceRef.slice("drive:".length)
        : null;
}

/**
 * Split the shadow backlog three ways.
 *
 * EVIDENCE OUTRANKS THE TIMESTAMP. The old rule looked only at rows older than
 * the boundary, so a file v1 had already booked but the forwarder handed over
 * AFTER the flip (a queued send, a retry, a slow archive step) never reached
 * the evidence check at all: it went straight into the requeue and v2 booked a
 * second Purchase. For an email or chat row that is unrecoverable by
 * idempotency — v2 books under the intake UUID, which v1 never saw — so it is
 * a real duplicate in the real books.
 *
 * The boundary only decides what to do with rows carrying NO evidence:
 *   - after it   -> v1 was not booking; v2 takes it.
 *   - before it, Drive row -> v2 takes it. Safe because it books under the
 *     Drive file id, so a v1/v2 overlap collapses into one Purchase.
 *   - before it, anything else -> quarantine. Booking risks double-paying and
 *     retiring risks losing a real expense, so a human decides.
 */
export function triageCutoverRows(
    candidates: CutoverCandidate[],
    boundary: Date,
    bookedByV1: ReadonlySet<string>,
): CutoverTriage {
    const triage: CutoverTriage = { evidenced: [], unevidenced: [], quarantined: [] };
    for (const row of candidates) {
        const driveId = driveFileIdOf(row);
        if (row.archivedByV1 || (driveId && bookedByV1.has(driveId))) {
            triage.evidenced.push(row.id);
            continue;
        }
        if (row.createdAt >= boundary) {
            triage.unevidenced.push(row.id);
            continue;
        }
        if (driveId) triage.unevidenced.push(row.id);
        else triage.quarantined.push(row.id);
    }
    return triage;
}

/**
 * A candidate PLUS the row state the verdict about it was reached against.
 *
 * The triage above only needs the identity fields; these are the ones the write
 * has to prove are still true when it lands.
 */
export interface CutoverRow extends CutoverCandidate {
    state: string;
    stateReason: string | null;
    dryRun: boolean;
    /**
     * Pinned at whatever was OBSERVED, not required to be null.
     *
     * A shadow-parked row is excluded from the claim entirely
     * (eligibleClaimWhere's NOT clause), so no live worker can be holding one
     * on the pass that runs the cutover — any token still on it is a leftover
     * from a pass that died during the shadow week. Demanding null would
     * therefore hide such a row from the cutover FOREVER: nothing can re-claim
     * it to release the token, so it would never be retired, requeued or
     * quarantined, and nobody would be told. Pinning the observed value still
     * catches a claim taken after the select, which is the race that matters.
     */
    claimToken: string | null;
}

export interface CutoverWriteClient {
    updateMany(args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
    }): Promise<{ count: number }>;
}

export interface CutoverMove {
    /** Rows the verdict actually landed on. */
    moved: number;
    /** Rows that changed under us between the select and the write. */
    skippedMoved: number;
}

/**
 * APPLY ONE CUTOVER VERDICT, FENCED ON THE ROW IT WAS DECIDED ABOUT.
 *
 * The three cutover writes used to constrain nothing but `id: { in: [...] }`.
 * The candidates are read in the same transaction, but READ COMMITTED means a
 * concurrent writer that never touches the claim's advisory lock — an admin
 * review, a future queue UI, a late completion — can still move a row in the
 * gap between that SELECT and these UPDATEs. The verdict then landed on a row
 * it was never computed for: a human's review was overwritten with
 * SHADOW_DONE or SHADOW_QUARANTINE, or `dryRun: false` handed a row to v2 that
 * somebody had just parked. Every one of those is terminal and none of them is
 * visible afterwards.
 *
 * So each write re-asserts the WHOLE predicate the row was selected by
 * (`dryRun: true`, one of the parked states) plus the exact evidence the
 * verdict was reached on: that row's own `state`, `stateReason` and
 * `claimToken`. A row that moved matches nothing, is counted as
 * `skippedMoved`, and simply comes back round on the next pass — where it will
 * be triaged against whatever it looks like then.
 *
 * Grouped by the observed (state, stateReason, claimToken) rather than issued
 * per row: the shadow backlog is the whole of a week and this runs inside the claim
 * transaction, so one statement per distinct observed state is the difference
 * between a handful of round trips and hundreds.
 */
export async function applyCutoverVerdict(
    rows: CutoverRow[],
    data: Record<string, unknown>,
    db: CutoverWriteClient,
): Promise<CutoverMove> {
    type Group = { state: string; stateReason: string | null; claimToken: string | null; ids: string[] };
    const groups = new Map<string, Group>();
    for (const row of rows) {
        // JSON, so two different observations can never collapse into one
        // group and be written under each other's fence.
        const key = JSON.stringify([row.state, row.stateReason, row.claimToken]);
        const group = groups.get(key)
            ?? { state: row.state, stateReason: row.stateReason, claimToken: row.claimToken, ids: [] };
        group.ids.push(row.id);
        groups.set(key, group);
    }

    let moved = 0;
    let skippedMoved = 0;
    for (const group of groups.values()) {
        const { count } = await db.updateMany({
            where: {
                id: { in: group.ids },
                // The parked predicate the candidates were SELECTED by...
                dryRun: true,
                // ...and the exact evidence this verdict was reached on.
                state: group.state,
                stateReason: group.stateReason,
                claimToken: group.claimToken,
            },
            data,
        });
        moved += count;
        skippedMoved += group.ids.length - count;
    }
    return { moved, skippedMoved };
}
