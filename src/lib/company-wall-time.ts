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
 * Every instant whose company wall time equals "YYYY-MM-DDTHH:MM", earliest first.
 *  - []            → unparseable, or the wall time does not exist (spring-forward gap)
 *  - [one]         → the normal case
 *  - [pdt, pst]    → the fall-back hour happens twice; the CALLER must disambiguate
 *                    (payroll UIs show an explicit first/second choice — never guess).
 */
export function companyWallToInstants(value: string): Date[] {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!m) return [];
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return [];
    const wanted = Date.UTC(y, mo - 1, d, h, mi, 0);
    // Pacific is UTC-7 or UTC-8. Both candidate offsets are checked EXACTLY, rather than
    // trusting a fixed-point search that can oscillate inside the spring-forward gap.
    const candidates: number[] = [];
    for (const offsetHours of [7, 8]) {
        const guess = wanted + offsetHours * 3_600_000;
        if (wallOf(guess).asUtc === wanted) candidates.push(guess);
    }
    return candidates.sort((a, b) => a - b).map((ms) => new Date(ms));
}

/**
 * "YYYY-MM-DDTHH:MM" company wall time -> UTC instant.
 * null when unparseable OR the wall time does not exist (DST spring-forward gap).
 * Ambiguous (fall-back) wall times resolve to the EARLIER instant — callers that must
 * not guess use companyWallToInstants and ask.
 */
export function companyWallToInstant(value: string): Date | null {
    return companyWallToInstants(value)[0] ?? null;
}

export type DstPick = "" | "first" | "second";

/**
 * Resolve a wall time with an explicit occurrence choice for the fall-back hour.
 *  - unambiguous wall time → its instant (pick is ignored);
 *  - ambiguous + pick "first"/"second" → that occurrence;
 *  - ambiguous with no pick, the DST gap, or junk → null (the caller must ask).
 */
export function pickInstant(wall: string, pick: DstPick): Date | null {
    const instants = companyWallToInstants(wall);
    if (instants.length === 1) return instants[0];
    if (instants.length === 2) {
        if (pick === "first") return instants[0];
        if (pick === "second") return instants[1];
    }
    return null;
}

/** Which occurrence of an ambiguous wall time `instant` is ("" when unambiguous or no match). */
export function occurrenceOf(wall: string, instant: Date): DstPick {
    const instants = companyWallToInstants(wall);
    if (instants.length !== 2) return "";
    if (instants[0].getTime() === instant.getTime()) return "first";
    if (instants[1].getTime() === instant.getTime()) return "second";
    return "";
}

/**
 * Prisma range for date-only filter inputs ("YYYY-MM-DD"), as COMPANY-local calendar
 * days: [00:00 of `dateFrom`, 00:00 of the day after `dateTo`). Built from wall times,
 * so an evening Pacific entry stays inside its displayed date even though its UTC
 * timestamp is on the next day (Codex gate, PR #437). Midnight never falls in the DST
 * gap, so these always resolve. Invalid inputs are ignored.
 */
export function companyDayRange(dateFrom?: string | null, dateTo?: string | null): { gte?: Date; lt?: Date } {
    const range: { gte?: Date; lt?: Date } = {};
    if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        const start = companyWallToInstant(`${dateFrom}T00:00`);
        if (start) range.gte = start;
    }
    if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        const [y, mo, d] = dateTo.split("-").map(Number);
        const next = new Date(Date.UTC(y, mo - 1, d + 1));
        const end = companyWallToInstant(`${next.toISOString().slice(0, 10)}T00:00`);
        if (end) range.lt = end;
    }
    return range;
}
