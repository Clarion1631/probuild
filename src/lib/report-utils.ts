/** Parse a "YYYY-MM-DD" string as local midnight (NOT UTC). */
export function parseLocalDateString(s: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (isNaN(dt.getTime())) return null;
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
}

/** Format a Date as "YYYY-MM-DD" using local calendar fields (NOT UTC). */
export function formatLocalDateString(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** Current-month from/to as local start-of-day / end-of-day. */
export function defaultMonthRange(): { from: Date; to: Date } {
    const now = new Date();
    return {
        from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    };
}

export function parseDateParam(s: string | undefined, fallback: Date): Date {
    if (!s) return fallback;
    const d = parseLocalDateString(s);
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0) : fallback;
}

export function parseDateParamEod(s: string | undefined, fallback: Date): Date {
    if (!s) return fallback;
    const d = parseLocalDateString(s);
    return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999) : fallback;
}

export type SearchParamMap = Record<string, string | string[] | undefined>;

export function getParam(params: SearchParamMap, key: string): string | undefined {
    const v = params[key];
    if (Array.isArray(v)) return v[0];
    return v ?? undefined;
}

export function getAllParams(params: SearchParamMap, key: string): string[] {
    const v = params[key];
    if (Array.isArray(v)) return v;
    return v ? [v] : [];
}
