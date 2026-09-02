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
    if (!value) return { phase: "done", chaserCompletedAt: null };
    if (isSweepPhase(value)) return { phase: value, chaserCompletedAt: null };
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { phase: "done", chaserCompletedAt: null };
        }
        const record = parsed as { phase?: unknown; chaserCompletedAt?: unknown };
        return {
            phase: isSweepPhase(record.phase) ? record.phase : "done",
            chaserCompletedAt: typeof record.chaserCompletedAt === "string" ? record.chaserCompletedAt : null,
        };
    } catch {
        // An unparseable marker is not a licence to assume anything. "done"
        // with no completion is the reading that BLOCKS the cards cron, which
        // is the safe direction.
        return { phase: "done", chaserCompletedAt: null };
    }
}

export function formatSweepMarker(marker: SweepMarker): string {
    return JSON.stringify({ phase: marker.phase, chaserCompletedAt: marker.chaserCompletedAt });
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
): boolean {
    if (!marker.chaserCompletedAt) return false;
    const at = new Date(marker.chaserCompletedAt);
    if (Number.isNaN(at.getTime())) return false;
    return at.toLocaleDateString("en-CA", { timeZone }) === pacificDate;
}
