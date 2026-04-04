"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

// ─── Types ──────────────────────────────────────────────────────
interface BudgetData {
    estimates: EstimateWithItems[];
    changeOrders: ChangeOrderWithItems[];
    expenses: ExpenseRow[];
    timeEntries: TimeEntryRow[];
    purchaseOrders: PurchaseOrderWithItems[];
    invoices: InvoiceWithPayments[];
}

interface EstimateWithItems {
    id: string;
    title: string;
    status: string;
    totalAmount: number;
    items: EstimateItemRow[];
}

interface EstimateItemRow {
    id: string;
    name: string;
    isSection: boolean;
    type: string;
    quantity: number;
    baseCost: number | null;
    markupPercent: number;
    unitCost: number;
    total: number;
    parentId: string | null;
    costCode: { id: string; code: string; name: string } | null;
    costType: { id: string; name: string } | null;
}

interface ChangeOrderWithItems {
    id: string;
    title: string;
    status: string;
    totalAmount: number;
    items: ChangeOrderItemRow[];
}

interface ChangeOrderItemRow {
    id: string;
    name: string;
    type: string;
    quantity: number;
    baseCost: number | null;
    markupPercent: number;
    unitCost: number;
    total: number;
    costCode: { id: string; code: string; name: string } | null;
    costType: { id: string; name: string } | null;
}

interface ExpenseRow {
    id: string;
    amount: number;
    vendor: string | null;
    description: string | null;
    date: string | null;
    itemId: string | null;
    costCode: { id: string; code: string; name: string } | null;
    costType: { id: string; name: string } | null;
}

interface TimeEntryRow {
    id: string;
    durationHours: number | null;
    laborCost: number | null;
    burdenCost: number | null;
    estimateItemId: string | null;
    costCode: { id: string; code: string; name: string } | null;
    costType: { id: string; name: string } | null;
    user: { name: string | null } | null;
}

interface PurchaseOrderWithItems {
    id: string;
    status: string;
    totalAmount: number;
    vendor: { name: string } | null;
    items: {
        id: string;
        total: number;
        costCode: { id: string; code: string; name: string } | null;
        costType: { id: string; name: string } | null;
    }[];
}

interface InvoiceWithPayments {
    id: string;
    status: string;
    totalAmount: number;
    balanceDue: number;
    payments: { id: string; amount: number; status: string; paidAt: string | null }[];
}

interface BudgetLineItem {
    key: string;
    name: string;
    category: string;
    originalEst: number;
    revisedEst: number;
    actual: number;
    varianceDollar: number;
    variancePct: number;
    invoiced: number;
    invoicedPct: number;
}

type SortKey = "name" | "originalEst" | "revisedEst" | "actual" | "varianceDollar" | "variancePct" | "invoiced";
type SortDir = "asc" | "desc";
type ViewBy = "all" | "costCode" | "costType" | "itemType";

// ─── Helpers ────────────────────────────────────────────────────
function num(v: unknown): number {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "object" && "toNumber" in (v as Record<string, unknown>)
        ? (v as { toNumber: () => number }).toNumber()
        : Number(v);
    return isNaN(n) ? 0 : n;
}

function fmtMoney(v: number): string {
    const abs = Math.abs(v);
    const s = abs >= 1000
        ? "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "$" + abs.toFixed(2);
    return v < 0 ? `(${s})` : s;
}

function fmtPct(v: number): string {
    if (!isFinite(v)) return "—";
    return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

// ─── Summary Panel ──────────────────────────────────────────────
function SummaryCard({ label, value, subtitle, color, tooltip }: {
    label: string;
    value: string;
    subtitle?: string;
    color: "blue" | "green" | "red" | "amber";
    tooltip: string;
}) {
    const colors = {
        blue: "from-blue-50 to-blue-100/50 border-blue-200",
        green: "from-emerald-50 to-emerald-100/50 border-emerald-200",
        red: "from-red-50 to-red-100/50 border-red-200",
        amber: "from-amber-50 to-amber-100/50 border-amber-200",
    };
    const textColors = {
        blue: "text-blue-700",
        green: "text-emerald-700",
        red: "text-red-700",
        amber: "text-amber-700",
    };

    return (
        <div className={`relative bg-gradient-to-br ${colors[color]} border rounded-xl p-5 group`}>
            <div className="flex items-center gap-1.5 mb-1">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{label}</span>
                <div className="relative">
                    <svg className="w-3.5 h-3.5 text-slate-400 cursor-help" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-slate-800 text-white text-xs rounded-lg px-3 py-2 opacity-0 group-hover:opacity-100 transition pointer-events-none z-10 shadow-lg">
                        {tooltip}
                    </div>
                </div>
            </div>
            <div className={`text-2xl font-bold ${textColors[color]}`}>{value}</div>
            {subtitle && <div className="text-xs text-slate-500 mt-1">{subtitle}</div>}
        </div>
    );
}

// ─── Main Component ─────────────────────────────────────────────
export default function BudgetClient({ project, data }: { project: { id: string; name: string }; data: BudgetData }) {
    const [viewBy, setViewBy] = useState<ViewBy>("all");
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [showSettings, setShowSettings] = useState(false);
    const [includeStatuses, setIncludeStatuses] = useState({
        estimateSent: true,
        estimateApproved: true,
        coApproved: true,
        coDraft: false,
    });
    const [visibleColumns, setVisibleColumns] = useState({
        originalEst: true,
        revisedEst: true,
        actual: true,
        varianceDollar: true,
        variancePct: true,
        invoiced: true,
        invoicedPct: true,
    });

    // ─── Compute budget line items ──────────────────────────────
    const { lineItems, totals } = useMemo(() => {
        // Filter estimates by status
        const activeStatuses = [
            ...(includeStatuses.estimateSent ? ["Sent"] : []),
            ...(includeStatuses.estimateApproved ? ["Approved", "Invoiced", "Partially Paid"] : []),
        ];
        const activeCOStatuses = [
            ...(includeStatuses.coApproved ? ["Approved"] : []),
            ...(includeStatuses.coDraft ? ["Draft", "Sent"] : []),
        ];

        const estimates = data.estimates.filter(e => activeStatuses.includes(e.status));
        const changeOrders = data.changeOrders.filter(co => activeCOStatuses.includes(co.status));

        // Build line items by grouping
        const groupMap = new Map<string, BudgetLineItem>();

        function getGroupKey(item: { costCode?: { code: string; name: string } | null; costType?: { name: string } | null; type?: string; name?: string }): { key: string; name: string; category: string } {
            if (viewBy === "costCode" && item.costCode) {
                return { key: `cc-${item.costCode.code}`, name: `${item.costCode.code} — ${item.costCode.name}`, category: "Cost Code" };
            }
            if (viewBy === "costType" && item.costType) {
                return { key: `ct-${item.costType.name}`, name: item.costType.name, category: "Cost Type" };
            }
            if (viewBy === "itemType" && item.type) {
                return { key: `type-${item.type}`, name: item.type, category: "Item Type" };
            }
            // "all" mode — one line per estimate item
            return { key: `item-${item.name || "Unknown"}`, name: item.name || "Unknown", category: "Line Item" };
        }

        function getOrCreate(gk: { key: string; name: string; category: string }): BudgetLineItem {
            if (!groupMap.has(gk.key)) {
                groupMap.set(gk.key, {
                    key: gk.key,
                    name: gk.name,
                    category: gk.category,
                    originalEst: 0,
                    revisedEst: 0,
                    actual: 0,
                    varianceDollar: 0,
                    variancePct: 0,
                    invoiced: 0,
                    invoicedPct: 0,
                });
            }
            return groupMap.get(gk.key)!;
        }

        // Original estimates
        for (const est of estimates) {
            for (const item of est.items) {
                if (item.isSection) continue;
                const gk = getGroupKey(item);
                const row = getOrCreate(gk);
                row.originalEst += num(item.total);
            }
        }

        // Change orders add to revised
        for (const co of changeOrders) {
            for (const item of co.items) {
                const gk = getGroupKey(item);
                const row = getOrCreate(gk);
                row.revisedEst += num(item.total);
            }
        }

        // Actuals from expenses
        for (const exp of data.expenses) {
            const gk = getGroupKey(exp);
            const row = getOrCreate(gk);
            row.actual += num(exp.amount);
        }

        // Actuals from time entries (labor cost + burden cost)
        for (const te of data.timeEntries) {
            const gk = getGroupKey(te);
            const row = getOrCreate(gk);
            row.actual += num(te.laborCost) + num(te.burdenCost);
        }

        // Actuals from PO items (committed costs treated as actual for budget tracking)
        for (const po of data.purchaseOrders) {
            for (const item of po.items) {
                const gk = getGroupKey(item);
                const row = getOrCreate(gk);
                row.actual += num(item.total);
            }
        }

        // Compute revised = original + CO additions, variance, etc.
        const rows = Array.from(groupMap.values());
        for (const row of rows) {
            row.revisedEst = row.originalEst + row.revisedEst; // CO additions on top of original
            row.varianceDollar = row.revisedEst - row.actual;
            row.variancePct = row.revisedEst > 0 ? ((row.varianceDollar / row.revisedEst) * 100) : 0;
        }

        // Invoiced totals — we can only attribute at the project level since invoices aren't linked to line items
        const totalInvoiced = data.invoices.reduce((sum, inv) => sum + num(inv.totalAmount), 0);
        const totalPaid = data.invoices.reduce((sum, inv) =>
            sum + inv.payments.filter(p => p.status === "Paid").reduce((s, p) => s + num(p.amount), 0), 0);

        // Totals
        const totalOriginal = rows.reduce((s, r) => s + r.originalEst, 0);
        const totalRevised = rows.reduce((s, r) => s + r.revisedEst, 0);
        const totalActual = rows.reduce((s, r) => s + r.actual, 0);
        const totalVariance = totalRevised - totalActual;
        const totalVariancePct = totalRevised > 0 ? (totalVariance / totalRevised) * 100 : 0;

        // Distribute invoiced proportionally
        if (totalRevised > 0 && totalInvoiced > 0) {
            for (const row of rows) {
                const proportion = row.revisedEst / totalRevised;
                row.invoiced = totalInvoiced * proportion;
                row.invoicedPct = row.revisedEst > 0 ? (row.invoiced / row.revisedEst) * 100 : 0;
            }
        }

        return {
            lineItems: rows,
            totals: {
                originalEst: totalOriginal,
                revisedEst: totalRevised,
                actual: totalActual,
                varianceDollar: totalVariance,
                variancePct: totalVariancePct,
                invoiced: totalInvoiced,
                invoicedPct: totalRevised > 0 ? (totalInvoiced / totalRevised) * 100 : 0,
                paid: totalPaid,
            },
        };
    }, [data, viewBy, includeStatuses]);

    // ─── Sort ───────────────────────────────────────────────────
    const sortedItems = useMemo(() => {
        const sorted = [...lineItems].sort((a, b) => {
            const av = sortKey === "name" ? a.name.toLowerCase() : a[sortKey];
            const bv = sortKey === "name" ? b.name.toLowerCase() : b[sortKey];
            if (av < bv) return sortDir === "asc" ? -1 : 1;
            if (av > bv) return sortDir === "asc" ? 1 : -1;
            return 0;
        });
        return sorted;
    }, [lineItems, sortKey, sortDir]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
        else { setSortKey(key); setSortDir("asc"); }
    };

    const sortIcon = (key: SortKey) => {
        if (sortKey !== key) return "↕";
        return sortDir === "asc" ? "↑" : "↓";
    };

    // ─── CSV Export ─────────────────────────────────────────────
    function handleExportCSV() {
        const headers = ["Name", "Original Est", "Revised Est", "Actual", "Variance ($)", "Variance (%)", "Invoiced ($)", "Invoiced (%)"];
        const csvRows = [headers.join(",")];
        for (const row of sortedItems) {
            csvRows.push([
                `"${row.name}"`,
                row.originalEst.toFixed(2),
                row.revisedEst.toFixed(2),
                row.actual.toFixed(2),
                row.varianceDollar.toFixed(2),
                row.variancePct.toFixed(1),
                row.invoiced.toFixed(2),
                row.invoicedPct.toFixed(1),
            ].join(","));
        }
        csvRows.push([
            '"TOTAL"',
            totals.originalEst.toFixed(2),
            totals.revisedEst.toFixed(2),
            totals.actual.toFixed(2),
            totals.varianceDollar.toFixed(2),
            totals.variancePct.toFixed(1),
            totals.invoiced.toFixed(2),
            totals.invoicedPct.toFixed(1),
        ].join(","));

        const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `budget-${project.name.replace(/\s+/g, "-").toLowerCase()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Budget report exported");
    }

    // ─── Render ─────────────────────────────────────────────────
    const varianceColor = totals.varianceDollar >= 0 ? "green" : "red";

    return (
        <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Budget</h1>
                    <p className="text-sm text-slate-500 mt-0.5">{project.name} — Budget vs. Actual Tracking</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowSettings(true)}
                        className="hui-btn bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm px-3 py-2 rounded-lg flex items-center gap-1.5"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        Budget Settings
                    </button>
                    <button
                        onClick={handleExportCSV}
                        className="hui-btn bg-hui-primary text-white hover:bg-blue-600 text-sm px-4 py-2 rounded-lg flex items-center gap-1.5"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Generate Report
                    </button>
                </div>
            </div>

            {/* 4-Panel Summary */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                <SummaryCard
                    label="Revised Estimated Cost"
                    value={fmtMoney(totals.revisedEst)}
                    subtitle={totals.revisedEst !== totals.originalEst
                        ? `Original: ${fmtMoney(totals.originalEst)} + COs: ${fmtMoney(totals.revisedEst - totals.originalEst)}`
                        : `No change orders`}
                    color="blue"
                    tooltip="Original estimate total plus approved change orders. Markup is included in the total."
                />
                <SummaryCard
                    label="Actual Cost"
                    value={fmtMoney(totals.actual)}
                    subtitle={`${fmtPct(totals.revisedEst > 0 ? (totals.actual / totals.revisedEst) * 100 - 100 : 0)} vs budget`}
                    color={totals.actual <= totals.revisedEst ? "green" : "red"}
                    tooltip="Sum of recorded expenses, labor costs (time entries), and purchase order amounts. Taxes excluded."
                />
                <SummaryCard
                    label="Variance"
                    value={fmtMoney(totals.varianceDollar)}
                    subtitle={fmtPct(totals.variancePct)}
                    color={varianceColor}
                    tooltip="Revised estimate minus actual cost. Green = under budget, Red = over budget."
                />
                <SummaryCard
                    label="Invoiced"
                    value={fmtMoney(totals.invoiced)}
                    subtitle={`${totals.invoicedPct.toFixed(1)}% of revised estimate | ${fmtMoney(totals.paid)} collected`}
                    color="amber"
                    tooltip="Total invoiced to client (taxes excluded). Shows percentage of revised estimate that has been billed."
                />
            </div>

            {/* Controls Row */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <label className="text-sm font-medium text-slate-600">View by:</label>
                    <select
                        value={viewBy}
                        onChange={e => setViewBy(e.target.value as ViewBy)}
                        className="hui-input text-sm py-1.5 px-3 rounded-lg border-slate-300"
                    >
                        <option value="all">Line Items</option>
                        <option value="costCode">Cost Code</option>
                        <option value="costType">Cost Type</option>
                        <option value="itemType">Item Type</option>
                    </select>
                </div>
                <div className="text-sm text-slate-500">
                    {sortedItems.length} {sortedItems.length === 1 ? "row" : "rows"}
                </div>
            </div>

            {/* Budget Table */}
            {sortedItems.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                    <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <h3 className="text-lg font-semibold text-slate-600 mb-1">No budget data yet</h3>
                    <p className="text-sm text-slate-400">Create an estimate with line items to start tracking your budget.</p>
                </div>
            ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-200">
                                    <th className="text-left px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                        <button onClick={() => handleSort("name")} className="flex items-center gap-1 hover:text-hui-primary">
                                            Name <span className="text-slate-400 text-[10px]">{sortIcon("name")}</span>
                                        </button>
                                    </th>
                                    {visibleColumns.originalEst && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                            <button onClick={() => handleSort("originalEst")} className="flex items-center gap-1 justify-end hover:text-hui-primary">
                                                Original Est <span className="text-slate-400 text-[10px]">{sortIcon("originalEst")}</span>
                                            </button>
                                        </th>
                                    )}
                                    {visibleColumns.revisedEst && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                            <button onClick={() => handleSort("revisedEst")} className="flex items-center gap-1 justify-end hover:text-hui-primary">
                                                Revised Est <span className="text-slate-400 text-[10px]">{sortIcon("revisedEst")}</span>
                                            </button>
                                        </th>
                                    )}
                                    {visibleColumns.actual && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                            <button onClick={() => handleSort("actual")} className="flex items-center gap-1 justify-end hover:text-hui-primary">
                                                Actual <span className="text-slate-400 text-[10px]">{sortIcon("actual")}</span>
                                            </button>
                                        </th>
                                    )}
                                    {visibleColumns.varianceDollar && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                            <button onClick={() => handleSort("varianceDollar")} className="flex items-center gap-1 justify-end hover:text-hui-primary">
                                                Variance ($) <span className="text-slate-400 text-[10px]">{sortIcon("varianceDollar")}</span>
                                            </button>
                                        </th>
                                    )}
                                    {visibleColumns.variancePct && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                            <button onClick={() => handleSort("variancePct")} className="flex items-center gap-1 justify-end hover:text-hui-primary">
                                                Variance (%) <span className="text-slate-400 text-[10px]">{sortIcon("variancePct")}</span>
                                            </button>
                                        </th>
                                    )}
                                    {visibleColumns.invoiced && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider">
                                            <button onClick={() => handleSort("invoiced")} className="flex items-center gap-1 justify-end hover:text-hui-primary">
                                                Invoiced ($) <span className="text-slate-400 text-[10px]">{sortIcon("invoiced")}</span>
                                            </button>
                                        </th>
                                    )}
                                    {visibleColumns.invoicedPct && (
                                        <th className="text-right px-4 py-3 font-semibold text-slate-600 uppercase text-xs tracking-wider whitespace-nowrap">
                                            Invoiced (%)
                                        </th>
                                    )}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {sortedItems.map(row => (
                                    <tr key={row.key} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3 font-medium text-hui-textMain">{row.name}</td>
                                        {visibleColumns.originalEst && (
                                            <td className="px-4 py-3 text-right text-slate-600 tabular-nums">{fmtMoney(row.originalEst)}</td>
                                        )}
                                        {visibleColumns.revisedEst && (
                                            <td className="px-4 py-3 text-right text-slate-600 tabular-nums font-medium">{fmtMoney(row.revisedEst)}</td>
                                        )}
                                        {visibleColumns.actual && (
                                            <td className="px-4 py-3 text-right text-slate-600 tabular-nums">{fmtMoney(row.actual)}</td>
                                        )}
                                        {visibleColumns.varianceDollar && (
                                            <td className={`px-4 py-3 text-right tabular-nums font-medium ${row.varianceDollar >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                                {fmtMoney(row.varianceDollar)}
                                            </td>
                                        )}
                                        {visibleColumns.variancePct && (
                                            <td className={`px-4 py-3 text-right tabular-nums ${row.variancePct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                                {fmtPct(row.variancePct)}
                                            </td>
                                        )}
                                        {visibleColumns.invoiced && (
                                            <td className="px-4 py-3 text-right text-slate-600 tabular-nums">{fmtMoney(row.invoiced)}</td>
                                        )}
                                        {visibleColumns.invoicedPct && (
                                            <td className="px-4 py-3 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <div className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-amber-500 rounded-full transition-all"
                                                            style={{ width: `${Math.min(row.invoicedPct, 100)}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-slate-500 tabular-nums text-xs w-10 text-right">{row.invoicedPct.toFixed(0)}%</span>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                            <tfoot>
                                <tr className="bg-slate-50 border-t-2 border-slate-300 font-bold">
                                    <td className="px-4 py-3 text-hui-textMain">TOTAL</td>
                                    {visibleColumns.originalEst && (
                                        <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{fmtMoney(totals.originalEst)}</td>
                                    )}
                                    {visibleColumns.revisedEst && (
                                        <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{fmtMoney(totals.revisedEst)}</td>
                                    )}
                                    {visibleColumns.actual && (
                                        <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{fmtMoney(totals.actual)}</td>
                                    )}
                                    {visibleColumns.varianceDollar && (
                                        <td className={`px-4 py-3 text-right tabular-nums ${totals.varianceDollar >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                            {fmtMoney(totals.varianceDollar)}
                                        </td>
                                    )}
                                    {visibleColumns.variancePct && (
                                        <td className={`px-4 py-3 text-right tabular-nums ${totals.variancePct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                                            {fmtPct(totals.variancePct)}
                                        </td>
                                    )}
                                    {visibleColumns.invoiced && (
                                        <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{fmtMoney(totals.invoiced)}</td>
                                    )}
                                    {visibleColumns.invoicedPct && (
                                        <td className="px-4 py-3 text-right">
                                            <span className="text-amber-600 tabular-nums text-xs font-bold">{totals.invoicedPct.toFixed(0)}%</span>
                                        </td>
                                    )}
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}

            {/* Budget Settings Modal */}
            {showSettings && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto">
                        <div className="flex items-center justify-between mb-5">
                            <h3 className="text-lg font-bold text-hui-textMain">Budget Settings</h3>
                            <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-600 text-xl">&times;</button>
                        </div>

                        {/* Sync Documents */}
                        <div className="mb-6">
                            <h4 className="text-sm font-semibold text-slate-700 mb-3 uppercase tracking-wider">Sync Documents</h4>
                            <p className="text-xs text-slate-500 mb-3">Choose which document statuses count toward the budget.</p>
                            <div className="space-y-2">
                                <label className="flex items-center gap-2.5 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={includeStatuses.estimateSent}
                                        onChange={e => setIncludeStatuses(s => ({ ...s, estimateSent: e.target.checked }))}
                                        className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary"
                                    />
                                    <span className="text-sm text-slate-700">Sent Estimates</span>
                                </label>
                                <label className="flex items-center gap-2.5 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={includeStatuses.estimateApproved}
                                        onChange={e => setIncludeStatuses(s => ({ ...s, estimateApproved: e.target.checked }))}
                                        className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary"
                                    />
                                    <span className="text-sm text-slate-700">Approved / Invoiced Estimates</span>
                                </label>
                                <label className="flex items-center gap-2.5 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={includeStatuses.coApproved}
                                        onChange={e => setIncludeStatuses(s => ({ ...s, coApproved: e.target.checked }))}
                                        className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary"
                                    />
                                    <span className="text-sm text-slate-700">Approved Change Orders</span>
                                </label>
                                <label className="flex items-center gap-2.5 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={includeStatuses.coDraft}
                                        onChange={e => setIncludeStatuses(s => ({ ...s, coDraft: e.target.checked }))}
                                        className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary"
                                    />
                                    <span className="text-sm text-slate-700">Draft/Sent Change Orders</span>
                                </label>
                            </div>
                        </div>

                        {/* Customize Columns */}
                        <div className="mb-6">
                            <h4 className="text-sm font-semibold text-slate-700 mb-3 uppercase tracking-wider">Visible Columns</h4>
                            <div className="space-y-2">
                                {Object.entries({
                                    originalEst: "Original Estimate",
                                    revisedEst: "Revised Estimate",
                                    actual: "Actual Cost",
                                    varianceDollar: "Variance ($)",
                                    variancePct: "Variance (%)",
                                    invoiced: "Invoiced ($)",
                                    invoicedPct: "Invoiced (%)",
                                }).map(([key, label]) => (
                                    <label key={key} className="flex items-center gap-2.5 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={visibleColumns[key as keyof typeof visibleColumns]}
                                            onChange={e => setVisibleColumns(c => ({ ...c, [key]: e.target.checked }))}
                                            className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary"
                                        />
                                        <span className="text-sm text-slate-700">{label}</span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="flex justify-end">
                            <button
                                onClick={() => setShowSettings(false)}
                                className="hui-btn bg-hui-primary text-white hover:bg-blue-600 text-sm px-4 py-2 rounded-lg"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
