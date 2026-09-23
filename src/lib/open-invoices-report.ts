import { prisma } from "@/lib/prisma";
import { type SearchParamMap, getParam, getAllParams } from "./report-utils";
import {
    RECEIVABLE_INVOICE_WHERE, RECEIVABLE_INVOICE_SELECT,
    computeInvoiceReceivable, toReceivableInput,
    type BilledItem,
} from "./receivables";

export type OpenInvoicesFilters = {
    clientId: string | null;
    projectId: string | null;
    statuses: string[];
};

export function parseOpenInvoicesFilters(params: SearchParamMap): OpenInvoicesFilters {
    return {
        clientId: getParam(params, "clientId") || null,
        projectId: getParam(params, "projectId") || null,
        statuses: getAllParams(params, "status"),
    };
}

export function stringifyOpenInvoicesFilters(f: Partial<OpenInvoicesFilters>): string {
    const sp = new URLSearchParams();
    if (f.clientId) sp.set("clientId", f.clientId);
    if (f.projectId) sp.set("projectId", f.projectId);
    if (f.statuses) for (const s of f.statuses) sp.append("status", s);
    return sp.toString();
}

// With no status filter the universe is the digest's — every non-Canceled
// invoice RECEIVABLE_INVOICE_WHERE finds — not a fixed status list. Composed
// under AND (never a second spread object that could carry its own OR key,
// which would silently clobber RECEIVABLE_INVOICE_WHERE's).
export function queryOpenInvoicesData(filters: OpenInvoicesFilters) {
    return prisma.invoice.findMany({
        where: {
            AND: [
                RECEIVABLE_INVOICE_WHERE,
                ...(filters.statuses.length ? [{ status: { in: filters.statuses } }] : []),
                ...(filters.clientId ? [{ clientId: filters.clientId }] : []),
                ...(filters.projectId ? [{ projectId: filters.projectId }] : []),
            ],
        },
        select: {
            id: true, code: true,
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
            ...RECEIVABLE_INVOICE_SELECT,
        },
        orderBy: { issueDate: "asc" },
    });
}

export type OpenInvoiceRow = Awaited<ReturnType<typeof queryOpenInvoicesData>>[number];

export interface OpenInvoiceItemRow {
    invoiceId: string;
    code: string;
    invoiceStatus: string;
    project: { id: string; name: string } | null;
    client: { id: string; name: string } | null;
    item: BilledItem;
}

const OPEN_INVOICE_BUCKETS = ["0–30", "31–60", "61–90", "90+"] as const;
export type OpenInvoiceBucketLabel = (typeof OPEN_INVOICE_BUCKETS)[number];

export interface OpenInvoicesSummary {
    totalOutstandingCents: number;
    overdueCents: number;
    unbilledCents: number;
    invoiceCount: number;
    overdueInvoiceCount: number;
    buckets: Array<{ label: OpenInvoiceBucketLabel; cents: number; rows: OpenInvoiceItemRow[] }>;
}

function bucketForAge(ageDays: number): OpenInvoiceBucketLabel {
    if (ageDays <= 30) return "0–30"; // negative ages (billed "in the future") land here too
    if (ageDays <= 60) return "31–60";
    if (ageDays <= 90) return "61–90";
    return "90+";
}

/**
 * One row per BILLED item, bucketed by that item's own age (not the
 * invoice's) — an invoice whose items were billed at different times can
 * appear in more than one bucket, each with only that item's cents. Mirrors
 * the AR digest's own math (src/lib/receivables.ts) exactly: same universe,
 * same billed predicate, same integer-cent amounts.
 */
export function summarizeOpenInvoices(invoices: OpenInvoiceRow[], now: number): OpenInvoicesSummary {
    const byBucket = new Map<OpenInvoiceBucketLabel, { cents: number; rows: OpenInvoiceItemRow[] }>(
        OPEN_INVOICE_BUCKETS.map(label => [label, { cents: 0, rows: [] }]),
    );

    let totalOutstandingCents = 0;
    let overdueCents = 0;
    let unbilledCents = 0;
    let invoiceCount = 0;
    let overdueInvoiceCount = 0;

    for (const inv of invoices) {
        const receivable = computeInvoiceReceivable(toReceivableInput(inv), now);
        totalOutstandingCents += receivable.receivableCents;
        overdueCents += receivable.overdueCents;
        // Backlog is summed over EVERY fetched invoice, not just the ones with
        // a billed item — a 100%-unbilled invoice still belongs in it (same
        // rule as the digest's unbilledBacklog).
        unbilledCents += receivable.unbilledCents;
        if (receivable.receivableCents > 0) invoiceCount++;
        if (receivable.overdue) overdueInvoiceCount++;

        const project = inv.project ? { id: inv.project.id, name: inv.project.name } : null;
        const client = inv.client ? { id: inv.client.id, name: inv.client.name } : null;

        for (const item of receivable.items) {
            const bucket = byBucket.get(bucketForAge(item.ageDays))!;
            bucket.cents += item.cents;
            bucket.rows.push({ invoiceId: inv.id, code: inv.code, invoiceStatus: inv.status, project, client, item });
        }
    }

    for (const bucket of byBucket.values()) {
        // Oldest first; ties by invoice code, then item label.
        bucket.rows.sort((a, b) => {
            if (b.item.ageDays !== a.item.ageDays) return b.item.ageDays - a.item.ageDays;
            if (a.code !== b.code) return a.code < b.code ? -1 : 1;
            return a.item.label < b.item.label ? -1 : a.item.label > b.item.label ? 1 : 0;
        });
    }

    return {
        totalOutstandingCents,
        overdueCents,
        unbilledCents,
        invoiceCount,
        overdueInvoiceCount,
        buckets: OPEN_INVOICE_BUCKETS.map(label => ({ label, ...byBucket.get(label)! })),
    };
}
