// "Tax paid at source" — the WA excise deduction (Phase 3 spec §7).
//
// GTR holds a reseller's permit, but in practice it pays sales tax at the
// register on most material. When that material is resold as part of customer
// work, the tax already paid is deductible on the excise return, on the line
// "taxable amount for tax paid at source". Before Phase 3 that number was
// assembled by hand into a spreadsheet
// (I:\My Drive\Expenses\Processed Receipts\Tax Paid at Source\); this report
// is the same figure, computed from the receipts the pipeline already books.
//
// THREE CONDITIONS, ALL POSITIVE. A row counts only when it carries evidence,
// never when it merely lacks a contradiction:
//   * `taxAtSource` — the read actually found tax on the receipt,
//   * `installedAtCustomer === true` — a NULL is "nobody said", and a NULL
//     must never be spent as a deduction, and
//   * `taxAmount > 0` — a zero is an answer (no tax), not an absence.
//
// TWO THINGS THIS FILE IS FUSSY ABOUT, both because it feeds a tax filing:
//
//  1. INTEGER CENTS. Every sum is in whole cents, converted from the Decimal's
//     STRING form so no float is ever involved. Summing dollars as floats
//     drifts — 0.1 + 0.2 is the canonical example, and a quarter's worth of
//     receipts drifts by more than a cent — and a total that disagrees with the
//     sum of its own rows is exactly the thing a bookkeeper will find and stop
//     trusting the report over.
//
//  2. THE COMPANY TIME ZONE. Period boundaries and month buckets are computed
//     in the company's configured zone, never in the server's or the browser's.
//     A receipt bought on 30 September at 6pm Pacific is stored as 1 October
//     UTC; bucketed in UTC it lands in the wrong QUARTER, and moves a deduction
//     onto the wrong excise return.
//
// The aggregation is pure and unit-tested; only `queryTaxAtSourceRows` and
// `resolveTaxAtSourceFilters` touch Prisma.
import { prisma } from "@/lib/prisma";
import { resolveCompanyTimeZone } from "./company-timezone";
import {
    DEFAULT_COMPANY_TIME_ZONE,
    addDaysToKey,
    dayKeyInTimeZone,
    startOfDateInTimeZone,
    validTimeZone,
} from "./tz-date";
import { resolveExpenseProjectId } from "./expense-attribution";
import { csvCell, csvDocument, csvNumber } from "./csv-safe";

export interface TaxAtSourceFilters {
    /** First day of the period, company calendar, "YYYY-MM-DD" — INCLUSIVE. */
    fromKey: string;
    /** Last day of the period, company calendar — INCLUSIVE, as a human reads it. */
    toKey: string;
    /** Instant bounds for the query: [from, to), both company-midnight. */
    from: Date;
    to: Date;
    timeZone: string;
}

export interface TaxAtSourceRow {
    id: string;
    date: Date;
    /** Company-calendar day the receipt falls on, "YYYY-MM-DD". */
    dayKey: string;
    vendor: string;
    projectId: string | null;
    projectName: string;
    /** Invoice / check reference, when the description carries one. */
    reference: string;
    /** Gross paid, in whole cents. */
    receiptTotalCents: number;
    /** receiptTotal - tax, in whole cents. The excise line's base. */
    deductionBaseCents: number;
    taxCents: number;
}

export const TAX_REPORT_AMOUNT_NOTE =
    "Receipt Total is the gross amount paid; the deduction base is that total less the sales tax on the receipt.";

export const TAX_REPORT_FOOTNOTE =
    "Sales tax already paid on materials resold as part of customer work is deductible on the WA excise return line " +
    "\"taxable amount for tax paid at source\". Only receipts flagged installed-at-customer count; Shop and consumable " +
    "purchases are excluded.";

/** Whole cents from a value for display only. */
export function centsToDollars(cents: number): number {
    return cents / 100;
}

/**
 * Exact cents from a Prisma Decimal (or anything that stringifies to a decimal
 * literal), WITHOUT going through a float.
 *
 * `Number("16.55") * 100` is 1655.0000000000002 — fine once, wrong after enough
 * additions. Prisma's Decimal stringifies exactly, so the digits are parsed
 * directly and the third decimal place decides a half-up round.
 */
export function toCents(value: unknown): number {
    if (value === null || value === undefined) return 0;
    const text = String(value).trim();
    const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
    if (!match) {
        // Scientific notation or junk — not a shape money arrives in, but a
        // silent 0 would understate a deduction. Fall back rather than drop.
        const asNumber = Number(text);
        return Number.isFinite(asNumber) ? Math.round(asNumber * 100) : 0;
    }
    const sign = match[1] === "-" ? -1 : 1;
    const fraction = (match[3] ?? "").padEnd(3, "0");
    const cents = Number(match[2]) * 100 + Number(fraction.slice(0, 2));
    const roundUp = Number(fraction[2]) >= 5;
    return sign * (cents + (roundUp ? 1 : 0));
}

/** Calendar quarter containing `now`, expressed in the COMPANY's zone. */
export function currentQuarterKeys(now: Date, timeZone: string): { fromKey: string; toKey: string } {
    const today = dayKeyInTimeZone(now, timeZone);
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    const fromKey = `${year}-${String(quarterStartMonth).padStart(2, "0")}-01`;
    // First day of the month AFTER the quarter, then step back one day to get
    // the inclusive last day — no month-length table, and correct in February.
    const endExclusiveMonth = quarterStartMonth + 3;
    const endYear = endExclusiveMonth > 12 ? year + 1 : year;
    const endMonth = endExclusiveMonth > 12 ? endExclusiveMonth - 12 : endExclusiveMonth;
    const toKey = addDaysToKey(`${endYear}-${String(endMonth).padStart(2, "0")}-01`, -1);
    return { fromKey, toKey };
}

/**
 * A REAL calendar day, not merely a well-shaped string.
 *
 * `/^\d{4}-\d{2}-\d{2}$/` accepts "2026-02-31" and "2026-13-01", and
 * `startOfDateInTimeZone` THROWS on both — which turns a typo in a URL into a
 * 500 on a finance page. Construct the date and compare the fields back.
 */
function isDayKey(value: string | undefined): value is string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const probe = new Date(Date.UTC(year, month - 1, day));
    return (
        probe.getUTCFullYear() === year &&
        probe.getUTCMonth() === month - 1 &&
        probe.getUTCDate() === day
    );
}

/**
 * Build the filters from URL params, in the company's zone.
 *
 * An inverted or unparseable range falls back to the current quarter rather
 * than returning an empty period: an empty table reads as "no tax was paid this
 * quarter", which is a very different claim from "your dates are backwards".
 */
export function parseTaxAtSourceFilters(
    params: URLSearchParams | Record<string, string | string[] | undefined>,
    timeZone: string,
    now: Date = new Date(),
): TaxAtSourceFilters {
    const get = (key: string): string | undefined => {
        if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
        const value = (params as Record<string, string | string[] | undefined>)[key];
        return Array.isArray(value) ? value[0] : value ?? undefined;
    };

    const fallback = currentQuarterKeys(now, timeZone);
    const rawFrom = get("from");
    const rawTo = get("to");

    // EITHER endpoint being unusable discards BOTH. Keeping the good half and
    // defaulting the other silently invents a range the user never asked for —
    // a quarter that starts where they said and ends three months later reads
    // as a real answer, and its total would be reported to the state.
    let fromKey = fallback.fromKey;
    let toKey = fallback.toKey;
    if (isDayKey(rawFrom) && isDayKey(rawTo) && rawTo >= rawFrom) {
        fromKey = rawFrom;
        toKey = rawTo;
    } else if (rawFrom === undefined && rawTo === undefined) {
        // No params at all is the normal first visit, not a bad request.
    }

    try {
        return {
            fromKey,
            toKey,
            from: startOfDateInTimeZone(fromKey, timeZone),
            // `toKey` is the last day a human means to include, so the
            // exclusive bound is the start of the NEXT company day. Taken
            // literally, an exclusive bound would silently drop everything
            // bought on the last day of the quarter.
            to: startOfDateInTimeZone(addDaysToKey(toKey, 1), timeZone),
            timeZone,
        };
    } catch {
        // Belt and braces. `isDayKey` has already ruled out every input
        // `startOfDateInTimeZone` rejects, so reaching here means an invalid
        // TIME ZONE — and a finance page must degrade to the default quarter
        // rather than 500.
        const zone = validTimeZone(timeZone) ? timeZone : DEFAULT_COMPANY_TIME_ZONE;
        const safe = currentQuarterKeys(now, zone);
        return {
            fromKey: safe.fromKey,
            toKey: safe.toKey,
            from: startOfDateInTimeZone(safe.fromKey, zone),
            to: startOfDateInTimeZone(addDaysToKey(safe.toKey, 1), zone),
            timeZone: zone,
        };
    }
}

/** Resolve the company zone, then parse. The one Prisma-touching entry point. */
export async function resolveTaxAtSourceFilters(
    params: URLSearchParams | Record<string, string | string[] | undefined>,
): Promise<TaxAtSourceFilters> {
    return parseTaxAtSourceFilters(params, await resolveCompanyTimeZone());
}

export function stringifyTaxAtSourceFilters(filters: TaxAtSourceFilters): string {
    return new URLSearchParams({ from: filters.fromKey, to: filters.toKey }).toString();
}

/**
 * Pull the invoice or check reference back out of the description the intake
 * and Drive-import writers compose ("... Invoice 82766 · ...", "Check #1041").
 * Best-effort by construction — an expense has no reference column — so a miss
 * is an empty string, never a guess.
 */
export function extractReference(description: string | null): string {
    if (!description) return "";
    const invoice = description.match(/Invoice\s+([A-Za-z0-9._/-]+)/);
    if (invoice) return invoice[1];
    const check = description.match(/Check\s*#\s*([A-Za-z0-9._/-]+)/);
    if (check) return `Check ${check[1]}`;
    return "";
}

export interface TaxAtSourceJobGroup {
    projectId: string | null;
    projectName: string;
    count: number;
    deductionBaseCents: number;
    receiptTotalCents: number;
    taxCents: number;
}

export interface TaxAtSourceMonthGroup {
    key: string;
    label: string;
    jobs: TaxAtSourceJobGroup[];
    count: number;
    deductionBaseCents: number;
    receiptTotalCents: number;
    taxCents: number;
}

export interface TaxAtSourceSummary {
    count: number;
    deductionBaseCents: number;
    receiptTotalCents: number;
    taxCents: number;
}

const MONTH_LABELS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

/** "2026-06" -> "June 2026", from the company-calendar key. No Date involved. */
export function monthLabelFromKey(monthKey: string): string {
    const year = monthKey.slice(0, 4);
    const month = Number(monthKey.slice(5, 7));
    return `${MONTH_LABELS[month - 1] ?? monthKey} ${year}`;
}

/**
 * Month × job rollup, in whole cents. Pure — this is the function the unit
 * tests drive. Month buckets come from each row's COMPANY-calendar day key, so
 * a late-evening purchase never falls into the next month (or quarter).
 */
export function groupTaxAtSource(rows: TaxAtSourceRow[]): {
    months: TaxAtSourceMonthGroup[];
    summary: TaxAtSourceSummary;
} {
    const months = new Map<string, TaxAtSourceMonthGroup>();
    const summary: TaxAtSourceSummary = {
        count: 0, deductionBaseCents: 0, receiptTotalCents: 0, taxCents: 0,
    };

    for (const row of rows) {
        const key = row.dayKey.slice(0, 7);
        let month = months.get(key);
        if (!month) {
            month = {
                key,
                label: monthLabelFromKey(key),
                jobs: [],
                count: 0,
                deductionBaseCents: 0,
                receiptTotalCents: 0,
                taxCents: 0,
            };
            months.set(key, month);
        }
        // Bucket by project ID, not by name: two jobs can share a name, and
        // merging them would put one client's deduction under another's.
        let job = month.jobs.find(candidate => candidate.projectId === row.projectId);
        if (!job) {
            job = {
                projectId: row.projectId,
                projectName: row.projectName,
                count: 0,
                deductionBaseCents: 0,
                receiptTotalCents: 0,
                taxCents: 0,
            };
            month.jobs.push(job);
        }

        job.count += 1;
        job.deductionBaseCents += row.deductionBaseCents;
        job.receiptTotalCents += row.receiptTotalCents;
        job.taxCents += row.taxCents;

        month.count += 1;
        month.deductionBaseCents += row.deductionBaseCents;
        month.receiptTotalCents += row.receiptTotalCents;
        month.taxCents += row.taxCents;

        summary.count += 1;
        summary.deductionBaseCents += row.deductionBaseCents;
        summary.receiptTotalCents += row.receiptTotalCents;
        summary.taxCents += row.taxCents;
    }

    const ordered = [...months.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (const month of ordered) {
        month.jobs.sort((a, b) => b.taxCents - a.taxCents);
    }
    return { months: ordered, summary };
}

export async function queryTaxAtSourceRows(filters: TaxAtSourceFilters): Promise<TaxAtSourceRow[]> {
    const rows = await prisma.expense.findMany({
        where: {
            taxAtSource: true,
            installedAtCustomer: true,
            taxAmount: { gt: 0 },
            date: { gte: filters.from, lt: filters.to },
        },
        select: {
            id: true,
            date: true,
            vendor: true,
            description: true,
            amount: true,
            taxAmount: true,
            projectId: true,
            project: { select: { name: true } },
            estimate: { select: { projectId: true, project: { select: { name: true } } } },
        },
        orderBy: { date: "asc" },
    });

    return rows.map(row => {
        const taxCents = toCents(row.taxAmount);
        const receiptTotalCents = toCents(row.amount);
        return {
            id: row.id,
            // The `date: { gte }` filter above already excluded null dates.
            date: row.date!,
            dayKey: dayKeyInTimeZone(row.date!, filters.timeZone),
            vendor: row.vendor ?? "",
            projectId: resolveExpenseProjectId(row),
            projectName: row.project?.name ?? row.estimate?.project?.name ?? "(unassigned)",
            reference: extractReference(row.description),
            receiptTotalCents,
            deductionBaseCents: receiptTotalCents - taxCents,
            taxCents,
        };
    });
}

/**
 * Mirrors the columns of the workbook Vanessa already receives
 * (Date, Vendor, Job, Invoice, Receipt Total, deduction base, Tax), so the
 * handoff file shape survives the move into ProBuild.
 *
 * Text cells go through `csvCell`, which neutralizes the leading characters a
 * spreadsheet reads as a formula — vendor names and descriptions are free text
 * lifted off receipts, so that is real input, not a hypothetical.
 */
export function rowsToCsv(rows: TaxAtSourceRow[]): string {
    const document: string[][] = [[
        "Date", "Vendor", "Job", "Invoice",
        "Receipt Total", "Material Amount (deduction base)", "Tax Paid at Source",
    ]];
    for (const row of rows) {
        document.push([
            csvCell(row.dayKey),
            csvCell(row.vendor),
            csvCell(row.projectName),
            csvCell(row.reference),
            csvNumber(centsToDollars(row.receiptTotalCents)),
            csvNumber(centsToDollars(row.deductionBaseCents)),
            csvNumber(centsToDollars(row.taxCents)),
        ]);
    }
    return csvDocument(document);
}
