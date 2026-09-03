/**
 * The missing-receipt sweep's own marker row, and the one fact the CARDS cron
 * needs from it: did tonight's chase actually finish?
 *
 * WHY THE CARDS CRON CARES. The morning card is built from open ReviewIssues,
 * and those issues are whatever the nightly sweep last left behind. If the
 * sweep was still mid-cycle — budget-truncated, or stopped on an error — the
 * open set is a snapshot of a half-reconciled world: items already answered
 * have not been closed yet, and items that should have opened have not opened.
 * A card built from that asks people for receipts they already sent, and misses
 * the ones they did not, on the same morning. That is the fastest way to teach
 * a crew the list is noise.
 *
 * And it costs the day to find out: selection CLAIMS the owner's
 * (owner, pacificDate) slot, so a bad card is not merely wrong, it is the only
 * card that owner gets. So the cron refuses to select at all until the sweep
 * says it finished, and says so out loud.
 *
 * ONE ROW, not a new table. The phase marker already exists; it now carries a
 * JSON body instead of a bare phase string, and a bare string still parses (as
 * "no completion recorded"), so a row written by an older build is read
 * correctly rather than throwing.
 */

/** AutomationSetting key. Shared by the sweep (writer) and the cards cron (reader). */
export const SWEEP_MARKER_KEY = "receiptRequestsPhase";

export type SweepPhase = "open-issues" | "lines" | "done";

export interface SweepMarker {
    phase: SweepPhase;
    /** ISO instant of the last CLEAN, COMPLETE cycle, or null. */
    chaserCompletedAt: string | null;
    /**
     * Why the most recent run deliberately did NOT stamp a completion, or null
     * when nothing is holding it back. Today the only value is
     * "bank-pull-stale".
     *
     * It rides the marker rather than a key of its own because refusing to
     * finish and having finished are the SAME fact about the same cycle, and
     * splitting them across two rows is how they come to disagree. The health
     * check already reads this row, so it costs no extra probe.
     *
     * OPTIONAL on the way IN so a caller that has nothing to say need not say
     * "null"; `parseSweepMarker` always returns it, so a reader never has to
     * distinguish absent from null.
     */
    blockedReason?: string | null;
    /**
     * WHICH CYCLE THE COMPLETION IS ABOUT (Codex PR #443 gate round 46,
     * finding 4).
     *
     * `chaserCompletedAt` alone is a DATE, and the cards cron only asked
     * whether that date was today. A completion stamped by this morning's cycle
     * is carried forward by every later `writePhase` — that is deliberate, it
     * is a true statement about a cycle that really happened — so a NEW cycle
     * that started at 13:00 and is still mid-flight, or blocked, still looked
     * "completed today". The cards then went out on a partially reconciled set.
     *
     * So completion is a tuple, and the cards cron asks about the CURRENT
     * cycle: this id must match the cycle record, the phase must be "done" and
     * nothing may be blocking it. A cycle that starts clears the stamp, because
     * from that moment the previous completion is no longer a statement about
     * the work in progress.
     */
    completedCycleId?: string | null;
}

export function isSweepPhase(value: unknown): value is SweepPhase {
    return value === "open-issues" || value === "lines" || value === "done";
}

/**
 * Parse the stored value. Accepts both shapes on purpose:
 *   `"lines"`                                   — written by an older build
 *   `{"phase":"done","chaserCompletedAt":"…"}`  — written by this one
 */
export function parseSweepMarker(value: string | null | undefined): SweepMarker {
    if (!value) return { phase: "done", chaserCompletedAt: null, blockedReason: null, completedCycleId: null };
    if (isSweepPhase(value)) return { phase: value, chaserCompletedAt: null, blockedReason: null, completedCycleId: null };
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { phase: "done", chaserCompletedAt: null, blockedReason: null, completedCycleId: null };
        }
        const record = parsed as { phase?: unknown; chaserCompletedAt?: unknown; blockedReason?: unknown; completedCycleId?: unknown };
        return {
            phase: isSweepPhase(record.phase) ? record.phase : "done",
            chaserCompletedAt: typeof record.chaserCompletedAt === "string" ? record.chaserCompletedAt : null,
            // A row from an older build has no such field, and that must read
            // as "nothing is blocking", not as an unknown that alarms.
            blockedReason: typeof record.blockedReason === "string" && record.blockedReason ? record.blockedReason : null,
            // A marker from a build before round 46 carries no cycle id. It
            // reads as null, which fails the identity check and therefore
            // BLOCKS the cards — the safe direction on the deploy that
            // introduces this, and self-correcting on the next clean cycle.
            completedCycleId: typeof record.completedCycleId === "string" && record.completedCycleId
                ? record.completedCycleId
                : null,
        };
    } catch {
        // An unparseable marker is not a licence to assume anything. "done"
        // with no completion is the reading that BLOCKS the cards cron, which
        // is the safe direction.
        return { phase: "done", chaserCompletedAt: null, blockedReason: null, completedCycleId: null };
    }
}

export function formatSweepMarker(marker: SweepMarker): string {
    return JSON.stringify({
        phase: marker.phase,
        chaserCompletedAt: marker.chaserCompletedAt,
        blockedReason: marker.blockedReason,
        completedCycleId: marker.completedCycleId ?? null,
    });
}

/**
 * Did the sweep finish a clean cycle on this Pacific day?
 *
 * The crew's day, not UTC's — the same boundary the card itself is keyed on, so
 * "today's chase finished" and "today's card" can never mean different days.
 */
export function chaserCompletedFor(
    marker: SweepMarker,
    pacificDate: string,
    timeZone = "America/Los_Angeles",
    /**
     * The cycle the sweep is on RIGHT NOW, when the caller knows it. Passing it
     * is what turns "a cycle completed today" into "THIS cycle completed"
     * (round-46 gate, finding 4). Omitted, the date check stands alone — which
     * is the shape that let a stale stamp release cards.
     */
    currentCycleId?: string | null,
): boolean {
    if (!marker.chaserCompletedAt) return false;
    // A completion is only a completion when the cycle it belongs to actually
    // finished, unblocked. Every other phase means work is in flight.
    if (marker.phase !== "done") return false;
    if (marker.blockedReason) return false;
    if (currentCycleId !== undefined) {
        if (!marker.completedCycleId || marker.completedCycleId !== currentCycleId) return false;
    }
    const at = new Date(marker.chaserCompletedAt);
    if (Number.isNaN(at.getTime())) return false;
    return at.toLocaleDateString("en-CA", { timeZone }) === pacificDate;
}

/**
 * THE CYCLE RECORD (Codex PR #443 gate round 45, finding 1).
 *
 * Round 44 put both epochs on the cursors. That is still not enough, because a
 * cursor is CLEARED the moment its pass completes: an invocation that finishes
 * the open-issue pass writes `null` there, and a line pass that exhausts writes
 * `null` too. A continuation then finds no cursor to validate, captures a FRESH
 * pair of epochs, skips the open-issue pass because the phase says "lines", and
 * certifies a cycle whose earlier passes were measured against a world that has
 * since moved. The epochs were attached to the wrong thing: they describe the
 * CYCLE, not a position within it.
 *
 * So they live in a record of their own, written when a cycle starts and
 * untouched until the next one starts. It outlives every cursor.
 *
 * Stored as JSON in one AutomationSetting row: `{ id, epoch, evidenceEpoch }`.
 * A row that is missing, empty, or unparseable reads as "no cycle", which
 * starts one — the safe direction, and what every database looks like the first
 * time this ships.
 */
export const CYCLE_KEY = "receiptRequestsCycle";

export interface SweepCycle {
    /** Identifies the cycle in logs; never compared for correctness. */
    id: string;
    epoch: string;
    evidenceEpoch: string;
}

export function parseSweepCycle(value: string | null): SweepCycle | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as Partial<SweepCycle>;
        if (typeof parsed?.id !== "string" || !parsed.id) return null;
        if (typeof parsed.epoch !== "string" || !parsed.epoch) return null;
        if (typeof parsed.evidenceEpoch !== "string" || !parsed.evidenceEpoch) return null;
        return { id: parsed.id, epoch: parsed.epoch, evidenceEpoch: parsed.evidenceEpoch };
    } catch {
        return null;
    }
}

/**
 * Is the world still the one this cycle started against?
 *
 * A null cycle is NOT usable: it means nothing recorded what this cycle was
 * measured against, and a continuation cannot certify on a guarantee nobody
 * wrote down.
 */
export function cycleStillValid(cycle: SweepCycle | null, epoch: string, evidenceEpoch: string): boolean {
    return cycle !== null && cycle.epoch === epoch && cycle.evidenceEpoch === evidenceEpoch;
}
