import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { parseLocalDateString, formatLocalDateString } from "./report-utils";
export { parseLocalDateString, formatLocalDateString } from "./report-utils";

export type SalesTaxBasis = "cash" | "accrual";

export type SalesTaxFilters = {
    basis: SalesTaxBasis;
    from: Date;
    to: Date;
    methods?: string[];       // cash basis only; filters PaymentSchedule.paymentMethod
    clientId?: string | null;
    projectId?: string | null;
    // Reserved for future: jurisdictions/taxRate filtering once multi-jurisdiction is built.
    rates?: number[];
};

export type SalesTaxRow = {
    /** Record key */
    id: string;
    /** "cash" rows come from a PaymentSchedule/EstimatePaymentSchedule; "accrual" rows come from an Invoice */
    source: "invoice-payment" | "estimate-payment" | "invoice";
    /** Date to group by (paymentDate for cash, issueDate for accrual) */
    date: Date;
    /** Display label for the parent invoice/estimate */
    documentCode: string;
    documentKind: "invoice" | "estimate";
    clientName: string;
    clientId: string | null;
    projectName: string | null;
    projectId: string | null;
    /** Payment method (cash basis only) */
    method: string | null;
    referenceNumber: string | null;
    /** Gross money for this row (schedule amount for cash, totalAmount for accrual) */
    gross: number;
    /** Pre-tax portion */
    taxableSubtotal: number;
    /** Sales tax portion */
    tax: number;
    /** Rate used (percent) */
    taxRate: number;
    /** True when the parent invoice was flagged no-tax / $0 tax */
    isExempt: boolean;
    /** Deep link path for the row (to jump to the source doc) */
    href: string;
};

/** Parse URL searchParams into strongly-typed filters. Defaults basis=cash and current month. */
export function parseSalesTaxFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): SalesTaxFilters {
    const get = (k: string): string | undefined => {
        if (params instanceof URLSearchParams) return params.get(k) ?? undefined;
        const v = (params as Record<string, string | string[] | undefined>)[k];
        if (Array.isArray(v)) return v[0];
        return v ?? undefined;
    };
    const getAll = (k: string): string[] => {
        if (params instanceof URLSearchParams) return params.getAll(k);
        const v = (params as Record<string, string | string[] | undefined>)[k];
        if (Array.isArray(v)) return v;
        return v ? [v] : [];
    };

    const rawBasis = (get("basis") || "cash").toLowerCase();
    const basis: SalesTaxBasis = rawBasis === "accrual" ? "accrual" : "cash";

    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const parseDate = (s: string | undefined, fallback: Date) => {
        if (!s) return fallback;
        // Parse YYYY-MM-DD as LOCAL midnight — not UTC — so ranges match the user's calendar.
        return parseLocalDateString(s) ?? fallback;
    };

    const fromRaw = parseDate(get("from"), defaultFrom);
    const toRaw = parseDate(get("to"), defaultTo);
    // Normalize to inclusive local start-of-day / end-of-day so date filters are calendar-correct.
    const from = new Date(fromRaw.getFullYear(), fromRaw.getMonth(), fromRaw.getDate(), 0, 0, 0, 0);
    const to = new Date(toRaw.getFullYear(), toRaw.getMonth(), toRaw.getDate(), 23, 59, 59, 999);

    const methodsParam = getAll("method");
    const methods = methodsParam.length ? methodsParam : undefined;
    const clientId = get("clientId") || null;
    const projectId = get("projectId") || null;

    return { basis, from, to, methods, clientId, projectId };
}

/** Serializer to rebuild URL searchParams from filters (used by CSV export link + preset buttons). */
export function stringifySalesTaxFilters(f: Partial<SalesTaxFilters>): string {
    const sp = new URLSearchParams();
    if (f.basis) sp.set("basis", f.basis);
    // Format dates using LOCAL calendar fields — not UTC — so round-tripped URLs match the user's intent.
    if (f.from) sp.set("from", formatLocalDateString(f.from));
    if (f.to) sp.set("to", formatLocalDateString(f.to));
    if (f.methods) for (const m of f.methods) sp.append("method", m);
    if (f.clientId) sp.set("clientId", f.clientId);
    if (f.projectId) sp.set("projectId", f.projectId);
    return sp.toString();
}

/** Execute the sales-tax query and return one flat row list + summary totals. */
export async function querySalesTaxData(filters: SalesTaxFilters): Promise<{ rows: SalesTaxRow[]; summary: { gross: number; subtotal: number; tax: number; count: number } }> {
    const rows: SalesTaxRow[] = [];

    if (filters.basis === "cash") {
        // Invoice milestone payments
        const invoicePayments = await prisma.paymentSchedule.findMany({
            where: {
                status: "Paid",
                paymentDate: { gte: filters.from, lt: filters.to },
                ...(filters.methods ? { paymentMethod: { in: filters.methods } } : {}),
                invoice: {
                    ...(filters.clientId ? { clientId: filters.clientId } : {}),
                    ...(filters.projectId ? { projectId: filters.projectId } : {}),
                },
            },
            include: {
                invoice: {
                    include: {
                        client: { select: { id: true, name: true } },
                        project: { select: { id: true, name: true } },
                    },
                },
            },
            orderBy: { paymentDate: "asc" },
        });

        // Group payments by invoice so we can allocate the rounding residual (cents that
        // would otherwise drift under proportional per-payment rounding) to the last paid
        // schedule in each invoice. Within the current filter window, each invoice's tax
        // rows will sum exactly to the proportional target (rounded to the nearest cent).
        //
        // Known limitation: the residual is allocated intra-window only. If the same invoice
        // is reported across different filter windows (e.g. Jan-only vs full-quarter), the
        // penny may land on a different schedule in each, so stacking two separate period
        // exports can diverge by ≤1¢ per invoice. True cross-period reconciliation would
        // require persisting per-payment tax allocations at payment time rather than
        // recomputing on read — deferred until the bookkeeper asks for it.
        const paymentsByInvoice = new Map<string, typeof invoicePayments>();
        for (const p of invoicePayments) {
            const arr = paymentsByInvoice.get(p.invoiceId) ?? [];
            arr.push(p);
            paymentsByInvoice.set(p.invoiceId, arr);
        }

        for (const [, group] of paymentsByInvoice) {
            group.sort((a, b) => {
                const at = (a.paymentDate ?? a.paidAt ?? a.createdAt).getTime();
                const bt = (b.paymentDate ?? b.paidAt ?? b.createdAt).getTime();
                return at - bt;
            });
            const inv = group[0].invoice;
            const invoiceTotal = toNum(inv.totalAmount);
            const invoiceTax = toNum(inv.taxAmount);
            const invoiceRate = toNum(inv.taxRate);
            const isExempt = invoiceTax <= 0;

            const rawTaxes = group.map(p => {
                const gross = toNum(p.amount);
                return invoiceTotal > 0 ? invoiceTax * (gross / invoiceTotal) : 0;
            });
            const targetTotalCents = Math.round(rawTaxes.reduce((s, t) => s + t, 0) * 100);
            const roundedCents = rawTaxes.map(t => Math.round(t * 100));
            const driftCents = targetTotalCents - roundedCents.reduce((s, c) => s + c, 0);
            if (roundedCents.length > 0) roundedCents[roundedCents.length - 1] += driftCents;

            group.forEach((p, i) => {
                const gross = toNum(p.amount);
                const tax = roundedCents[i] / 100;
                const taxableSubtotal = Math.round((gross - tax) * 100) / 100;
                rows.push({
                    id: `inv-${p.id}`,
                    source: "invoice-payment",
                    date: p.paymentDate ?? p.paidAt ?? p.createdAt,
                    documentCode: inv.code,
                    documentKind: "invoice",
                    clientName: inv.client?.name || "",
                    clientId: inv.client?.id || null,
                    projectName: inv.project?.name || null,
                    projectId: inv.project?.id || null,
                    method: p.paymentMethod || null,
                    referenceNumber: p.referenceNumber || null,
                    gross,
                    taxableSubtotal,
                    tax,
                    taxRate: invoiceRate,
                    isExempt,
                    href: `/projects/${inv.project?.id}/invoices/${inv.id}`,
                });
            });
        }

        // Estimate deposit payments
        const estimatePayments = await prisma.estimatePaymentSchedule.findMany({
            where: {
                status: "Paid",
                paymentDate: { gte: filters.from, lt: filters.to },
                ...(filters.methods ? { paymentMethod: { in: filters.methods } } : {}),
                estimate: {
                    ...(filters.projectId ? { projectId: filters.projectId } : {}),
                    ...(filters.clientId ? { project: { clientId: filters.clientId } } : {}),
                },
            },
            include: {
                estimate: {
                    include: {
                        project: {
                            select: {
                                id: true, name: true,
                                client: { select: { id: true, name: true } },
                            },
                        },
                        lead: { select: { id: true, name: true } },
                    },
                },
            },
            orderBy: { paymentDate: "asc" },
        });

        for (const p of estimatePayments) {
            const est = p.estimate;
            const gross = toNum(p.amount);
            // Estimate deposits are treated as non-taxable in the sales-tax report (deposits typically
            // apply against a later invoice where tax is calculated). Both tax and taxable subtotal
            // are $0 — the full received amount shows in Gross only so the bookkeeper doesn't
            // double-count these dollars as taxable sales.
            const tax = 0;
            const taxableSubtotal = 0;
            rows.push({
                id: `est-${p.id}`,
                source: "estimate-payment",
                date: p.paymentDate ?? p.paidAt ?? p.createdAt,
                documentCode: est.code,
                documentKind: "estimate",
                clientName: est.project?.client?.name || est.lead?.name || "",
                clientId: est.project?.client?.id || est.lead?.id || null,
                projectName: est.project?.name || null,
                projectId: est.project?.id || null,
                method: p.paymentMethod || null,
                referenceNumber: p.referenceNumber || null,
                gross,
                taxableSubtotal,
                tax,
                taxRate: 0,
                isExempt: true,
                href: est.project?.id
                    ? `/projects/${est.project.id}/estimates/${est.id}`
                    : est.lead?.id ? `/leads/${est.lead.id}/estimates/${est.id}` : `/estimates`,
            });
        }
    } else {
        // Accrual basis — issued invoices
        const invoices = await prisma.invoice.findMany({
            where: {
                status: { not: "Draft" },
                issueDate: { gte: filters.from, lt: filters.to },
                ...(filters.clientId ? { clientId: filters.clientId } : {}),
                ...(filters.projectId ? { projectId: filters.projectId } : {}),
            },
            include: {
                client: { select: { id: true, name: true } },
                project: { select: { id: true, name: true } },
            },
            orderBy: { issueDate: "asc" },
        });

        for (const inv of invoices) {
            const gross = toNum(inv.totalAmount);
            const tax = toNum(inv.taxAmount);
            // Use the stored subtotal when present (including legitimate 0 on fully-exempt invoices).
            // Only fall back to derived math when the field is null/undefined (e.g. legacy rows not backfilled).
            const subtotal = inv.subtotal != null ? toNum(inv.subtotal) : Math.max(0, gross - tax);
            rows.push({
                id: `inv-acc-${inv.id}`,
                source: "invoice",
                date: inv.issueDate ?? inv.createdAt,
                documentCode: inv.code,
                documentKind: "invoice",
                clientName: inv.client?.name || "",
                clientId: inv.client?.id || null,
                projectName: inv.project?.name || null,
                projectId: inv.project?.id || null,
                method: null,
                referenceNumber: null,
                gross,
                taxableSubtotal: subtotal,
                tax,
                taxRate: toNum(inv.taxRate),
                isExempt: tax <= 0,
                href: `/projects/${inv.project?.id}/invoices/${inv.id}`,
            });
        }
    }

    // Sort by date ascending
    rows.sort((a, b) => a.date.getTime() - b.date.getTime());

    const summary = rows.reduce(
        (acc, r) => {
            acc.gross += r.gross;
            acc.subtotal += r.taxableSubtotal;
            acc.tax += r.tax;
            acc.count += 1;
            return acc;
        },
        { gross: 0, subtotal: 0, tax: 0, count: 0 },
    );
    summary.gross = Math.round(summary.gross * 100) / 100;
    summary.subtotal = Math.round(summary.subtotal * 100) / 100;
    summary.tax = Math.round(summary.tax * 100) / 100;

    return { rows, summary };
}

/** Group rows by calendar month ("March 2026") for the monthly rollup table. */
export function groupRowsByMonth(rows: SalesTaxRow[]) {
    const byMonth = new Map<string, { month: string; key: string; count: number; gross: number; subtotal: number; tax: number }>();
    for (const r of rows) {
        const key = `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}`;
        const label = r.date.toLocaleString("en-US", { month: "long", year: "numeric" });
        const curr = byMonth.get(key) || { month: label, key, count: 0, gross: 0, subtotal: 0, tax: 0 };
        curr.count += 1;
        curr.gross += r.gross;
        curr.subtotal += r.taxableSubtotal;
        curr.tax += r.tax;
        byMonth.set(key, curr);
    }
    return Array.from(byMonth.values())
        .map(m => ({
            ...m,
            gross: Math.round(m.gross * 100) / 100,
            subtotal: Math.round(m.subtotal * 100) / 100,
            tax: Math.round(m.tax * 100) / 100,
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/** Escape a cell for RFC 4180 CSV — quote fields containing comma, quote, or newline. */
export function escapeCsv(v: unknown): string {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

export function rowsToCsv(rows: SalesTaxRow[], basis: SalesTaxBasis): string {
    const headers = basis === "cash"
        ? ["Date Paid", "Document", "Kind", "Client", "Project", "Method", "Reference #", "Gross", "Taxable Subtotal", "Sales Tax", "Tax Rate %"]
        : ["Issue Date", "Document", "Kind", "Client", "Project", "Gross", "Taxable Subtotal", "Sales Tax", "Tax Rate %"];

    const lines = [headers.join(",")];
    for (const r of rows) {
        const dateStr = formatLocalDateString(r.date);
        if (basis === "cash") {
            lines.push([
                dateStr,
                escapeCsv(r.documentCode),
                r.documentKind,
                escapeCsv(r.clientName),
                escapeCsv(r.projectName ?? ""),
                escapeCsv(r.method ?? ""),
                escapeCsv(r.referenceNumber ?? ""),
                r.gross.toFixed(2),
                r.taxableSubtotal.toFixed(2),
                r.tax.toFixed(2),
                r.taxRate.toFixed(3),
            ].join(","));
        } else {
            lines.push([
                dateStr,
                escapeCsv(r.documentCode),
                r.documentKind,
                escapeCsv(r.clientName),
                escapeCsv(r.projectName ?? ""),
                r.gross.toFixed(2),
                r.taxableSubtotal.toFixed(2),
                r.tax.toFixed(2),
                r.taxRate.toFixed(3),
            ].join(","));
        }
    }
    return lines.join("\r\n") + "\r\n";
}
