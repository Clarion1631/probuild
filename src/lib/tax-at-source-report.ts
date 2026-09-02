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
// The aggregation is pure and unit-tested; only `queryTaxAtSourceRows` touches
// Prisma.
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { formatMoneyMonth, formatMoneyMonthKey, formatMoneyDateISO } from "./payment-date";
import { parseLocalDateString, formatLocalDateString } from "./report-utils";
import { resolveExpenseProjectId } from "./expense-attribution";

export { parseLocalDateString, formatLocalDateString } from "./report-utils";

export interface TaxAtSourceFilters {
    from: Date;
    /** Exclusive upper bound. */
    to: Date;
}

export interface TaxAtSourceRow {
    id: string;
    date: Date;
    vendor: string;
    projectId: string | null;
    projectName: string;
    /** Invoice / check reference, when the description carries one. */
    reference: string;
    /**
     * What was paid in total. See the caveat in `TAX_REPORT_AMOUNT_NOTE`:
     * intake-born rows are gross-with-tax, and legacy QBO rows carry no
     * taxAmount at all so they never reach this report.
     */
    receiptTotal: number;
    /** receiptTotal - tax. The figure the excise line is computed from. */
    deductionBase: number;
    tax: number;
}

export const TAX_REPORT_AMOUNT_NOTE =
    "Receipt Total is the gross amount paid; the deduction base is that total less the sales tax on the receipt.";

export const TAX_REPORT_FOOTNOTE =
    "Sales tax already paid on materials resold as part of customer work is deductible on the WA excise return line " +
    "\"taxable amount for tax paid at source\". Only receipts flagged installed-at-customer count; Shop and consumable " +
    "purchases are excluded.";

/** Calendar quarter containing `now`, as [from, to) local dates. */
export function currentQuarterRange(now: Date = new Date()): TaxAtSourceFilters {
    const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return {
        from: new Date(now.getFullYear(), quarterStartMonth, 1, 0, 0, 0, 0),
        to: new Date(now.getFullYear(), quarterStartMonth + 3, 1, 0, 0, 0, 0),
    };
}

export function parseTaxAtSourceFilters(
    params: URLSearchParams | Record<string, string | string[] | undefined>,
    now: Date = new Date(),
): TaxAtSourceFilters {
    const get = (key: string): string | undefined => {
        if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
        const value = (params as Record<string, string | string[] | undefined>)[key];
        return Array.isArray(value) ? value[0] : value ?? undefined;
    };
    const fallback = currentQuarterRange(now);
    const from = (get("from") && parseLocalDateString(get("from")!)) || fallback.from;
    const parsedTo = get("to") ? parseLocalDateString(get("to")!) : null;
    // The picker's "to" is INCLUSIVE to a human; the query bound is exclusive.
    const to = parsedTo
        ? new Date(parsedTo.getFullYear(), parsedTo.getMonth(), parsedTo.getDate() + 1, 0, 0, 0, 0)
        : fallback.to;
    // An inverted range is a typo, not a query. Returning the fallback rather
    // than an empty table stops the page reading as "no tax paid this quarter".
    if (to.getTime() <= from.getTime()) return fallback;
    return { from, to };
}

export function stringifyTaxAtSourceFilters(filters: TaxAtSourceFilters): string {
    // `to` goes back out as the INCLUSIVE day the user typed.
    const inclusiveTo = new Date(filters.to.getTime());
    inclusiveTo.setDate(inclusiveTo.getDate() - 1);
    return new URLSearchParams({
        from: formatLocalDateString(filters.from),
        to: formatLocalDateString(inclusiveTo),
    }).toString();
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
    deductionBase: number;
    receiptTotal: number;
    tax: number;
}

export interface TaxAtSourceMonthGroup {
    key: string;
    label: string;
    jobs: TaxAtSourceJobGroup[];
    count: number;
    deductionBase: number;
    receiptTotal: number;
    tax: number;
}

export interface TaxAtSourceSummary {
    count: number;
    deductionBase: number;
    receiptTotal: number;
    tax: number;
}

/** Month × job rollup. Pure — this is the function the unit tests drive. */
export function groupTaxAtSource(rows: TaxAtSourceRow[]): {
    months: TaxAtSourceMonthGroup[];
    summary: TaxAtSourceSummary;
} {
    const months = new Map<string, TaxAtSourceMonthGroup>();
    const summary: TaxAtSourceSummary = { count: 0, deductionBase: 0, receiptTotal: 0, tax: 0 };

    for (const row of rows) {
        const key = formatMoneyMonthKey(row.date);
        let month = months.get(key);
        if (!month) {
            month = {
                key,
                label: formatMoneyMonth(row.date),
                jobs: [],
                count: 0,
                deductionBase: 0,
                receiptTotal: 0,
                tax: 0,
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
                deductionBase: 0,
                receiptTotal: 0,
                tax: 0,
            };
            month.jobs.push(job);
        }

        job.count += 1;
        job.deductionBase += row.deductionBase;
        job.receiptTotal += row.receiptTotal;
        job.tax += row.tax;

        month.count += 1;
        month.deductionBase += row.deductionBase;
        month.receiptTotal += row.receiptTotal;
        month.tax += row.tax;

        summary.count += 1;
        summary.deductionBase += row.deductionBase;
        summary.receiptTotal += row.receiptTotal;
        summary.tax += row.tax;
    }

    const ordered = [...months.values()].sort((a, b) => a.key.localeCompare(b.key));
    for (const month of ordered) {
        month.jobs.sort((a, b) => b.tax - a.tax);
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
        const tax = toNum(row.taxAmount);
        const receiptTotal = toNum(row.amount);
        return {
            id: row.id,
            // The `date: { gte }` filter above already excluded null dates.
            date: row.date!,
            vendor: row.vendor ?? "",
            projectId: resolveExpenseProjectId(row),
            projectName: row.project?.name ?? row.estimate?.project?.name ?? "(unassigned)",
            reference: extractReference(row.description),
            receiptTotal,
            deductionBase: receiptTotal - tax,
            tax,
        };
    });
}

function escapeCsv(value: string): string {
    return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/**
 * Mirrors the columns of the workbook Vanessa already receives
 * (Date, Vendor, Job, Invoice, Receipt Total, deduction base, Tax), so the
 * handoff file shape survives the move into ProBuild.
 */
export function rowsToCsv(rows: TaxAtSourceRow[]): string {
    const lines = [
        ["Date", "Vendor", "Job", "Invoice", "Receipt Total", "Material Amount (deduction base)", "Tax Paid at Source"].join(","),
    ];
    for (const row of rows) {
        lines.push([
            formatMoneyDateISO(row.date),
            escapeCsv(row.vendor),
            escapeCsv(row.projectName),
            escapeCsv(row.reference),
            row.receiptTotal.toFixed(2),
            row.deductionBase.toFixed(2),
            row.tax.toFixed(2),
        ].join(","));
    }
    return lines.join("\r\n") + "\r\n";
}
