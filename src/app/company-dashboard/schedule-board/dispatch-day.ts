// Pure day-key helpers for the Dispatch Day lens (see ScheduleBoard's
// dispatchDayKey / DispatchView's dayKey prop). Kept dependency-free of
// React so they're trivially unit-testable — see tests/dispatch-day.test.ts.

import { addDays, formatDate, parseUTCDate } from "@/app/projects/[id]/schedule/schedule-utils";

/** Shifts a YYYY-MM-DD day key by `delta` days (negative goes back), UTC-safe across month/year boundaries. */
export function shiftDayKey(key: string, delta: number): string {
    return formatDate(addDays(parseUTCDate(key), delta));
}

/** Formats a YYYY-MM-DD day key like "Saturday, Aug 29" (UTC, no year — matches the board's other date labels). */
export function formatDayLabel(key: string): string {
    return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(parseUTCDate(key));
}

/** True when `key` is the same day as `todayKey` (both YYYY-MM-DD). */
export function isTodayKey(key: string, todayKey: string): boolean {
    return key === todayKey;
}
