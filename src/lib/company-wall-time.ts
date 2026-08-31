// Company-local (America/Los_Angeles) wall time ↔ UTC instant, browser-safe.
// Built for datetime-local inputs on payroll surfaces: the manager types Pacific wall
// time no matter where their device thinks it is (Codex gate, PR #437).
//
// DST rules (tested in tests/company-wall-time.test.ts):
//  - a NONEXISTENT wall time (the spring-forward gap, e.g. 2026-03-08T02:30) → null,
//    never a silently shifted instant;
//  - an AMBIGUOUS wall time (the fall-back hour, e.g. 2026-11-01T01:30) resolves to the
//    EARLIER instant (the first time the clock shows it), deterministically.
import { COMPANY_TIME_ZONE } from "@/lib/company-day";

const WALL_PARTS = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
});

function wallOf(instantMs: number): { asUtc: number; y: number; mo: number; d: number; h: number; mi: number } {
    const parts = WALL_PARTS.formatToParts(new Date(instantMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const y = get("year"), mo = get("month"), d = get("day"), h = get("hour"), mi = get("minute"), s = get("second");
    return { asUtc: Date.UTC(y, mo - 1, d, h, mi, s), y, mo, d, h, mi };
}

/** Instant (ISO or Date) -> "YYYY-MM-DDTHH:MM" company wall time (datetime-local value). */
export function instantToCompanyWall(instant: string | Date): string {
    const w = wallOf(new Date(instant).getTime());
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/**
 * "YYYY-MM-DDTHH:MM" company wall time -> UTC instant.
 * null when unparseable OR the wall time does not exist (DST spring-forward gap).
 * Ambiguous (fall-back) wall times resolve to the EARLIER instant.
 */
export function companyWallToInstant(value: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    const wanted = Date.UTC(y, mo - 1, d, h, mi, 0);
    // Pacific is UTC-7 or UTC-8. Both candidate offsets are checked EXACTLY, rather than
    // trusting a fixed-point search that can oscillate inside the spring-forward gap.
    const candidates: number[] = [];
    for (const offsetHours of [7, 8]) {
        const guess = wanted + offsetHours * 3_600_000;
        if (wallOf(guess).asUtc === wanted) candidates.push(guess);
    }
    if (candidates.length === 0) return null; // nonexistent wall time (DST gap)
    return new Date(Math.min(...candidates)); // ambiguous → earlier instant
}
