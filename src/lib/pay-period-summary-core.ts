import { NextResponse } from "next/server";
import { toNum } from "@/lib/prisma-helpers";
import {
    bucketWorkweeks,
    priceEntryBurden,
    priceEntrySplits,
    sumEntryPay,
    workweekStartKey,
    type EntryOvertimeSplit,
    type EntryPay,
    type OvertimeTimeEntry,
} from "@/lib/overtime";
import { addDaysToKey, dayKeyInTimeZone, daysBetweenDayKeys, startOfDateInTimeZone } from "@/lib/tz-date";

// Pure DI core for GET /api/mobile/pay-period-summary — no static import of
// mobile-auth.ts (which throws at MODULE LOAD if NEXTAUTH_SECRET is unset)
// or prisma, so this module (and therefore createPayPeriodSummaryHandlers)
// is safe to import from tests without either. The route file wires real
// dependencies (prisma, authenticateMobileOrSession) on top of this and
// keeps a STATIC import of mobile-auth.ts, so a real deployment still fails
// fast at startup if NEXTAUTH_SECRET is missing — that fail-fast behavior
// must not get pushed out to first-request only.
//
// Pay-period pay summary: regular vs overtime hours and pay for an arbitrary
// [start, end) range, priced per Washington's weekly (Mon-Sun) overtime rule.
// Intended for the mobile app's pay/history screen — no existing endpoint
// surfaced OT-aware pay before this.
//
// The pay period does not need to align to a Monday. WA overtime is a
// property of the WORKWEEK, not the pay period, so a workweek that straddles
// the edge of the requested range still needs its FULL Mon-Sun hours to know
// whether the days inside this period were regular or overtime (e.g. a
// biweekly period that opens mid-week can already be past 40 hours for that
// workweek because of hours earned before the period started). To get that
// right without guessing at a fixed padding window (which is DST-sensitive
// and can still miss hours — a fixed N-day offset from an arbitrary instant
// doesn't reliably reach the Monday on the other side of a short month or a
// transition), the DB query spans the EXACT full workweeks that overlap
// [start, end): the Monday 00:00 (company-local) of the workweek containing
// `start`, through the Monday 00:00 following the workweek containing the
// last instant actually inside the range. Only the per-entry regular/OT
// split for entries whose startTime falls inside [start, end) then counts
// toward this period's totals — the rest of each workweek was fetched only
// to get the 40h threshold right.
//
// PRICING POLICY (a later rate change must not rewrite a past summary):
// each entry is priced at its OWN historical effective rate, derived from
// its stored laborCost/burdenCost (set at clock-out time from the owner's
// rates as of THEN — see createTimeEntryCore / the time-entries PUT/PATCH
// routes) divided by its durationHours. The OT premium (0.5x extra) is
// applied to that same historical rate on the entry's OT hours. Burden is
// priced the same way but never OT-multiplied. If an entry has durationHours
// but no stored laborCost/burdenCost (a data gap — every entry-creation path
// in this codebase sets them together, but legacy/imported rows might not),
// pricing falls back to the target user's CURRENT rate for just that entry,
// and `ratesUsingCurrentRateFallback` reports how many entries that
// happened for — see its own comment on the response for exactly what it
// counts — so a caller can flag it rather than silently trust the total.

type AuthedUser = { id: string; role: string };
type AuthResult = { ok: true; user: AuthedUser } | { ok: false; status: number; error: string };

/** Longest [start, end) range a single request may cover — bounds the workweek query fan-out (see file header) and guards against an unbounded scan. */
export const MAX_PAY_PERIOD_RANGE_DAYS = 62;

type PriceableEntry = OvertimeTimeEntry & {
    laborCost: number | null;
    burdenCost: number | null;
};

export interface PayPeriodSummaryDependencies {
    authenticate(req: Request): Promise<AuthResult>;
    getUser(userId: string): Promise<{ id: string; name: string | null; email: string; hourlyRate: number; burdenRate: number } | null>;
    getTimeEntries(userId: string, rangeStart: Date, rangeEnd: Date): Promise<PriceableEntry[]>;
    resolveTimeZone(): Promise<string>;
}

/** Whether an entry has a genuine stored historical cost to derive a rate from — the ONE place this condition is defined, so pricing and fallback-counting can never disagree about it. */
function hasStoredCost(cost: number | null, durationHours: number): boolean {
    return cost != null && durationHours > 0;
}

function rateForEntry(entry: PriceableEntry, currentRate: number): { hourlyRate: number; rateSource: "entry" | "fallback" } {
    if (hasStoredCost(entry.laborCost, entry.durationHours)) {
        return { hourlyRate: entry.laborCost! / entry.durationHours, rateSource: "entry" };
    }
    return { hourlyRate: currentRate, rateSource: "fallback" };
}

function burdenRateForEntry(entry: PriceableEntry, currentRate: number): number {
    if (hasStoredCost(entry.burdenCost, entry.durationHours)) {
        return entry.burdenCost! / entry.durationHours;
    }
    return currentRate;
}

/** True if EITHER the labor rate or the burden rate had to fall back to the current rate for this entry — see `ratesUsingCurrentRateFallback` on the response for what the count means. */
function entryUsedAnyFallbackRate(entry: PriceableEntry): boolean {
    return !hasStoredCost(entry.laborCost, entry.durationHours) || !hasStoredCost(entry.burdenCost, entry.durationHours);
}

export function createPayPeriodSummaryHandlers(dependencies: PayPeriodSummaryDependencies) {
    return {
        async GET(req: Request) {
            const auth = await dependencies.authenticate(req);
            if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
            const { user } = auth;

            const { searchParams } = new URL(req.url);
            const startParam = searchParams.get("start");
            const endParam = searchParams.get("end");
            const userIdParam = searchParams.get("userId");

            if (!startParam || !endParam) {
                return NextResponse.json({ error: "start and end are required (ISO timestamps)" }, { status: 400 });
            }

            const start = new Date(startParam);
            const end = new Date(endParam);
            if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
                return NextResponse.json({ error: "Invalid start/end range" }, { status: 400 });
            }

            const timeZone = await dependencies.resolveTimeZone();

            // Company-local CALENDAR days, not fixed 24h math — a range of
            // exactly MAX_PAY_PERIOD_RANGE_DAYS company-local calendar days
            // spanning a DST transition is not exactly N*24h of real time (a
            // fall-back day is 25h, a spring-forward day is 23h), so dividing
            // raw elapsed ms by 86,400,000 can wrongly reject a legitimate
            // range (fall-back) or wrongly accept an over-long one
            // (spring-forward).
            const rangeDays = daysBetweenDayKeys(dayKeyInTimeZone(start, timeZone), dayKeyInTimeZone(end, timeZone));
            if (rangeDays > MAX_PAY_PERIOD_RANGE_DAYS) {
                return NextResponse.json(
                    { error: `start/end range must not exceed ${MAX_PAY_PERIOD_RANGE_DAYS} days` },
                    { status: 400 }
                );
            }

            let targetUserId = user.id;
            if (userIdParam && userIdParam !== user.id) {
                if (user.role !== "MANAGER" && user.role !== "ADMIN") {
                    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
                }
                targetUserId = userIdParam;
            }

            const targetUser = await dependencies.getUser(targetUserId);
            if (!targetUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

            // Exact full workweeks overlapping [start, end) — see file header.
            const rangeStartKey = workweekStartKey(start, timeZone);
            const lastIncludedInstant = new Date(end.getTime() - 1);
            const rangeEndWeekStartKey = workweekStartKey(lastIncludedInstant, timeZone);
            const queryStart = startOfDateInTimeZone(rangeStartKey, timeZone);
            const queryEnd = startOfDateInTimeZone(addDaysToKey(rangeEndWeekStartKey, 7), timeZone);

            const entries = await dependencies.getTimeEntries(targetUserId, queryStart, queryEnd);
            const overtimeEntries = entries.filter(
                (e): e is PriceableEntry => Number.isFinite(e.durationHours) && e.durationHours > 0,
            );

            const weeks = bucketWorkweeks(overtimeEntries, timeZone);

            let regularHours = 0;
            let overtimeHours = 0;
            let fallbackEntryCount = 0;
            const allPriced: EntryPay<PriceableEntry>[] = [];
            const allSplits: EntryOvertimeSplit<PriceableEntry>[] = [];
            const weekBreakdown: Array<{
                weekStartKey: string;
                weekStart: string;
                weekEnd: string;
                regularHours: number;
                overtimeHours: number;
                regularPay: number;
                overtimePay: number;
                totalPay: number;
                burdenCost: number;
            }> = [];

            for (const week of weeks) {
                // Only entries that actually fall inside the requested period count
                // toward this period's totals — the wider query exists only to get
                // the 40h threshold right (see file header).
                const inPeriod = week.entries.filter(
                    (split) => split.entry.startTime >= start && split.entry.startTime < end,
                );
                if (inPeriod.length === 0) continue;

                const priced = priceEntrySplits(inPeriod, (entry) => rateForEntry(entry, toNum(targetUser.hourlyRate)));
                for (const split of inPeriod) {
                    if (entryUsedAnyFallbackRate(split.entry)) fallbackEntryCount += 1;
                }
                allPriced.push(...priced);
                allSplits.push(...inPeriod);

                const weekRegularHours = inPeriod.reduce((sum, split) => sum + split.regularHours, 0);
                const weekOvertimeHours = inPeriod.reduce((sum, split) => sum + split.overtimeHours, 0);
                regularHours += weekRegularHours;
                overtimeHours += weekOvertimeHours;

                const weekPay = sumEntryPay(priced);
                const weekBurden = priceEntryBurden(inPeriod, (entry) => burdenRateForEntry(entry, toNum(targetUser.burdenRate)));

                weekBreakdown.push({
                    weekStartKey: week.weekStartKey,
                    weekStart: week.weekStart.toISOString(),
                    weekEnd: week.weekEnd.toISOString(),
                    regularHours: weekRegularHours,
                    overtimeHours: weekOvertimeHours,
                    regularPay: weekPay.regularPay,
                    overtimePay: weekPay.overtimePay,
                    totalPay: weekPay.totalPay,
                    burdenCost: weekBurden,
                });
            }

            const totals = sumEntryPay(allPriced);
            const burdenCost = priceEntryBurden(allSplits, (entry) => burdenRateForEntry(entry, toNum(targetUser.burdenRate)));

            return NextResponse.json({
                userId: targetUser.id,
                userName: targetUser.name ?? targetUser.email,
                start: start.toISOString(),
                end: end.toISOString(),
                timeZone,
                hourlyRate: toNum(targetUser.hourlyRate),
                burdenRate: toNum(targetUser.burdenRate),
                regularHours,
                overtimeHours,
                totalHours: regularHours + overtimeHours,
                regularPay: totals.regularPay,
                overtimePay: totals.overtimePay,
                totalPay: totals.totalPay,
                burdenCost,
                // Count of priced entries where EITHER the labor rate or the
                // burden rate had no reliable stored historical value (see
                // hasStoredCost) and fell back to the target user's CURRENT
                // rate for that one rate. An entry that fell back on both
                // still counts once — this is "how many entries might be
                // wrong", not "how many rates fell back". A non-zero count
                // means part of regularPay/overtimePay/burdenCost may not
                // match what was actually earned if a rate has since changed.
                ratesUsingCurrentRateFallback: fallbackEntryCount,
                weeks: weekBreakdown,
            });
        },
    };
}
