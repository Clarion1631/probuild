import type { QBTokens } from "./quickbooks";

export type PurchaseQuery = <T = any>(tokens: QBTokens, query: string) => Promise<T[]>;
export type DuplicateMatch = "within-7-days" | "same-month-day-other-year";
export interface DuplicatePurchaseCandidate {
    id: string;
    date: string;
    amount: number;
    vendor: string | null;
    match: DuplicateMatch;
}
export interface DuplicatePurchasePair {
    ids: [string, string];
    amount: number;
    dates: [string, string];
    vendors: [string | null, string | null];
    match: DuplicateMatch;
}
interface Purchase {
    Id: string;
    TxnDate: string;
    TotalAmt: number;
    PrivateNote?: string;
    EntityRef?: { name?: string };
}
const DAY = 86_400_000;
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
export const DUPLICATE_LOOKBACK_DAYS = 45;

function day(value: string): Date {
    const result = new Date(value + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
        throw new Error("Invalid duplicate-check date");
    }
    return result;
}
function iso(value: Date): string { return value.toISOString().slice(0, 10); }
function shift(value: string, days: number): string { return iso(new Date(day(value).getTime() + days * DAY)); }
function validYearDate(date: string, year: number): string | null {
    const candidate = String(year) + date.slice(4);
    try { day(candidate); return candidate; } catch { return null; }
}
function cents(amount: number): number {
    if (!Number.isFinite(amount) || !Number.isSafeInteger(Math.round(amount * 100))) throw new Error("Invalid duplicate-check amount");
    return Math.round(amount * 100);
}
export function matchDates(left: string, right: string, now: Date): DuplicateMatch | null {
    if (Math.abs(day(left).getTime() - day(right).getTime()) <= 7 * DAY) return "within-7-days";
    const year = now.getUTCFullYear();
    const otherYear = Number(right.slice(0, 4));
    if (left.slice(5) === right.slice(5) && left.slice(0,4) !== right.slice(0,4) &&
        otherYear >= year - 2 && otherYear <= year) return "same-month-day-other-year";
    return null;
}

/**
 * Purchase.TotalAmt is not a documented QBO-filterable field (the SDK lists QBW).
 * Query bounded, supported TxnDate ranges, then compare exact integer cents here.
 * No vendor filter and no unsupported OR clause. Every page must succeed.
 */
async function readWindow(tokens: QBTokens, query: PurchaseQuery, from: string, to: string): Promise<Purchase[]> {
    const rows: Purchase[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await query<Purchase>(tokens,
            `SELECT * FROM Purchase WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ORDERBY TxnDate STARTPOSITION ${page * PAGE_SIZE + 1} MAXRESULTS ${PAGE_SIZE}`);
        if (!Array.isArray(batch)) throw new Error("Incomplete QBO duplicate query");
        for (const row of batch) {
            if (!row || typeof row.Id !== "string" || !row.Id.trim() || typeof row.TxnDate !== "string" || typeof row.TotalAmt !== "number") throw new Error("Unreadable QBO duplicate candidate");
            day(row.TxnDate);
            cents(row.TotalAmt);
            if (row.TxnDate < from || row.TxnDate > to) throw new Error("QBO duplicate query returned an out-of-window row");
            const id = String(row.Id);
            if (seen.has(id)) throw new Error("QBO duplicate pagination repeated a purchase");
            seen.add(id);
            rows.push({ ...row, Id: id,
                EntityRef: { name: typeof row.EntityRef?.name === "string" ? row.EntityRef.name : undefined },
                PrivateNote: typeof row.PrivateNote === "string" ? row.PrivateNote : undefined });
        }
        if (batch.length < PAGE_SIZE) return rows;
    }
    throw new Error("QBO duplicate query exceeded page limit; review required");
}

export async function findPurchaseDuplicateCandidates(
    tokens: QBTokens,
    input: { totalAmount: number; date: string },
    query: PurchaseQuery,
    now = new Date(),
): Promise<DuplicatePurchaseCandidate[]> {
    day(input.date);
    const amountCents = cents(input.totalAmount);
    if (amountCents <= 0) throw new Error("Invalid duplicate-check amount");
    const windows: [string, string][] = [[shift(input.date, -7), shift(input.date, 7)]];
    for (let year = now.getUTCFullYear() - 2; year <= now.getUTCFullYear(); year++) {
        const projected = validYearDate(input.date, year);
        if (projected && (projected < windows[0][0] || projected > windows[0][1])) windows.push([projected, projected]);
    }
    const found = new Map<string, DuplicatePurchaseCandidate>();
    for (const [from, to] of windows) {
        for (const purchase of await readWindow(tokens, query, from, to)) {
            const match = matchDates(input.date, purchase.TxnDate, now);
            if (cents(purchase.TotalAmt) === amountCents && match) {
                found.set(purchase.Id, { id: purchase.Id, date: purchase.TxnDate, amount: amountCents / 100,
                    vendor: purchase.EntityRef?.name ?? null, match });
            }
        }
    }
    return [...found.values()].sort((a,b) => a.id.localeCompare(b.id));
}

/** Read-only health scan: a recent seed plus nearby or calendar-year partners. */
export async function findRecentQboPurchaseDuplicates(
    tokens: QBTokens, query: PurchaseQuery, now: Date,
): Promise<DuplicatePurchasePair[]> {
    const today = iso(now);
    const from = shift(today, -DUPLICATE_LOOKBACK_DAYS);
    const rows = new Map<string, Purchase>();
    const addWindow = async (start: string, end: string) => {
        for (const row of await readWindow(tokens, query, start, end)) rows.set(row.Id, row);
    };
    await addWindow(shift(from, -7), today);
    // At most 46 exact calendar days per historical year, coalesced into ranges.
    // Project each day explicitly so Feb 29 never rolls into March 1.
    for (let year = now.getUTCFullYear() - 2; year < now.getUTCFullYear(); year++) {
        const dates = new Set<string>();
        for (let date = from; date <= today; date = shift(date, 1)) {
            const projected = validYearDate(date, year);
            if (projected && projected < from) dates.add(projected);
        }
        const sorted = [...dates].sort();
        let start = sorted[0], end = start;
        for (let i = 1; i <= sorted.length; i++) {
            if (i < sorted.length && sorted[i] === shift(end, 1)) { end = sorted[i]; continue; }
            if (start) await addWindow(start, end);
            start = sorted[i]; end = start;
        }
    }
    const byAmount = new Map<number, Purchase[]>();
    for (const purchase of rows.values()) {
        const amount = cents(purchase.TotalAmt);
        if (amount <= 0) continue; // Voided/credit entries cannot duplicate a positive receipt.
        const bucket = byAmount.get(amount) ?? [];
        bucket.push(purchase);
        byAmount.set(amount, bucket);
    }
    const result = new Map<string, DuplicatePurchasePair>();
    const hasMarker = (p: Purchase) => /\[gtr-file:[^\]\s]+\]/.test(p.PrivateNote ?? "");
    for (const seed of rows.values()) {
        if (seed.TxnDate < from || seed.TxnDate > today || cents(seed.TotalAmt) <= 0) continue;
        for (const partner of byAmount.get(cents(seed.TotalAmt)) ?? []) {
            if (seed.Id === partner.Id || (!hasMarker(seed) && !hasMarker(partner))) continue;
            const match = matchDates(seed.TxnDate, partner.TxnDate, now);
            if (!match) continue;
            const [a, b] = [seed, partner].sort((l,r) => l.Id.localeCompare(r.Id));
            result.set(JSON.stringify([a.Id,b.Id]), { ids: [a.Id,b.Id], amount: cents(a.TotalAmt) / 100,
                dates: [a.TxnDate,b.TxnDate], vendors: [a.EntityRef?.name ?? null,b.EntityRef?.name ?? null], match });
        }
    }
    return [...result.values()].sort((a,b) => a.ids.join(":").localeCompare(b.ids.join(":")));
}
