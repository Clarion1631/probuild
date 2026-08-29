// Resolves the effective start/end range for GET /api/mobile/schedule/today.
//
// With no `start`/`end` query params, reproduces the original "today ± 1 day
// slop" window byte-for-byte (server-local day boundaries around `now`).
//
// With both `start` and `end` given as YYYY-MM-DD, they're treated as UTC
// calendar dates — ScheduleTask.startDate/endDate are date-only values stored
// at UTC midnight (the route's serializer does `toISOString().split("T")[0]`),
// so the range boundaries must be computed in UTC, not server-local time.

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ScheduleRangeResult =
    | { ok: true; start: Date; end: Date; startKey: string; endKey: string }
    | { ok: false; error: string };

function toUtcDateKey(d: Date): string {
    return d.toISOString().split("T")[0];
}

function isValidDateKey(key: string): boolean {
    if (!DATE_KEY_RE.test(key)) return false;
    const d = new Date(`${key}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return false;
    // Reject e.g. 2026-02-30, which Date() rolls over into March.
    return toUtcDateKey(d) === key;
}

export function resolveScheduleRange(searchParams: URLSearchParams, now: Date): ScheduleRangeResult {
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");

    if (startParam === null && endParam === null) {
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - 1);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        end.setDate(end.getDate() + 1);
        return { ok: true, start, end, startKey: toUtcDateKey(start), endKey: toUtcDateKey(end) };
    }

    if (startParam === null || endParam === null || !isValidDateKey(startParam) || !isValidDateKey(endParam)) {
        return { ok: false, error: "start and end must both be YYYY-MM-DD" };
    }

    const start = new Date(`${startParam}T00:00:00.000Z`);
    const end = new Date(`${endParam}T23:59:59.999Z`);

    if (end.getTime() < start.getTime()) {
        return { ok: false, error: "end must not be before start" };
    }

    const spanDays = Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
        return { ok: false, error: `range must not exceed ${MAX_RANGE_DAYS} days` };
    }

    return { ok: true, start, end, startKey: startParam, endKey: endParam };
}
