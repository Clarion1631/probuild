import type { SerializedJourney } from "../journey-list";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** True once a booked-api receipt has gone longer than the 4h sync cadence
 * (plus a buffer) without landing in ProBuild — worth a human look.
 *
 * `nowMs` must come from the caller, not `Date.now()` here: this runs inside
 * components that render on the server (initial SSR pass) and again on the
 * client (hydration) — calling `Date.now()` in each pass reads two different
 * clock values and, right at the 5-hour boundary, can flip the boolean
 * between passes, producing a hydration mismatch. Callers thread a single
 * timestamp captured once, server-side (see `page.tsx`), through both
 * render paths. */
export function isStaleBookedApi(journey: SerializedJourney, nowMs: number): boolean {
    if (journey.finalState !== "booked-api" || journey.synced) return false;
    return nowMs - new Date(journey.lastSeen).getTime() >= FIVE_HOURS_MS;
}
