import type { SerializedJourney } from "../journey-list";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** True once a booked-api receipt has gone longer than the 4h sync cadence
 * (plus a buffer) without landing in ProBuild — worth a human look. */
export function isStaleBookedApi(journey: SerializedJourney): boolean {
    if (journey.finalState !== "booked-api" || journey.synced) return false;
    return Date.now() - new Date(journey.lastSeen).getTime() >= FIVE_HOURS_MS;
}
