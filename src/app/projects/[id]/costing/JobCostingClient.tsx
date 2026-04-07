"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { formatCurrency } from "@/lib/utils";

interface JobCostingClientProps {
    project: { id: string; name: string };
    estimates: any[];
    timeEntries: any[];
    expenses: any[];
    purchaseOrders?: any[];
}

type CostCodeSummary = {
    code: string;
    name: string;
    budgetLabor: number;
    budgetMaterial: number;
    actualLabor: number;
    actualMaterial: number;
    committedMaterial: number;
};

type SortKey = "code" | "budget" | "actual" | "variance" | "pct";
type SortDir = "asc" | "desc";

const ChartBarIcon = () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
);

export default function JobCostingClient({
    project,
    estimates,
    timeEntries,
    expenses,
    purchaseOrders = []
}: JobCostingClientProps) {
    const [sortKey, setSortKey] = useState<SortKey>("code");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [isForecast, setIsForecast] = useState(false);
    const [showForecast, setShowForecast] = useState(false);
    const [forecastAnalysis, setForecastAnalysis] = useState<string | null>(null);

    async function handleCostForecast() {
        setIsForecast(true);
        try {
            const res = await fetch("/api/ai/cost-forecast", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId: project.id }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Forecast failed");
            setForecastAnalysis(data.analysis);
            setShowForecast(true);
        } catch (e: any) {
            toast.error(e.message || "Cost forecast failed");
        } finally {
            setIsForecast(false);
        }
    }

    const handleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
        else { setSortKey(key); setSortDir("asc"); }
    };

    const summaries = useMemo(() => {
        const map = new Map<string, CostCodeSummary>();
        const getGroup = (ccId: string | null, ccName: string, ccCode: string) => {
            const key = ccId || "unassigned";
            if (!map.has(key)) {
                map.set(key, { code: ccCode || "N/A", name: ccName || "Unassigned", budgetLabor: 0, budgetMaterial: 0, actualLabor: 0, actualMaterial: 0, committedMaterial: 0 });
            }
            return map.get(key)!;
        };
        estimates.forEach(est => {
            est.items.forEach((item: any) => {
                const group = getGroup(item.costCodeId, item.costCode?.name, item.costCode?.code);
                const total = (item.quantity * item.unitCost);
                const itemCategory = (item.costType?.name || item.type || "").toLowerCase();
                if (itemCategory.includes("labor")) group.budgetLabor += total;
                else group.budgetMaterial += total;
            });
        });
        timeEntries.forEach(te => {
            const group = getGroup(te.costCodeId, te.costCode?.name, te.costCode?.code);
            group.actualLabor += (te.laborCost || 0);
        });
        expenses.forEach(ex => {
            const group = getGroup(ex.costCodeId, ex.costCode?.name, ex.costCode?.code);
            group.actualMaterial += (ex.amount || 0);
            if (ex.purchaseOrderId) {
                group.committedMaterial -= (ex.amount || 0);
            }
        });
        purchaseOrders.forEach(po => {
            // Only count approved POs maybe? Or all POs. Usually committed means Approved. Wait, if status exists, let's check it. 
            // In ProBuild, we want to see it but let's assume all POs fetched here are committed.
            if (po.status !== "Draft") {
                po.items?.forEach((item: any) => {
                    const group = getGroup(item.costCodeId, item.costCode?.name, item.costCode?.code);
                    group.committedMaterial += (item.total || 0);
                });
            }
        });
        
        // Prevent negative committed material on over-billed POs
        return Array.from(map.values()).map(v => ({
            ...v,
            committedMaterial: Math.max(0, v.committedMaterial)
        }));
    }, [estimates, timeEntries, expenses, purchaseOrders]);

    const sortedSummaries = useMemo(() => {
        return [...summaries].sort((a, b) => {
            const totalBudgetA = a.budgetLabor + a.budgetMaterial;
            const totalBudgetB = b.budgetLabor + b.budgetMaterial;
            const totalActualA = a.actualLabor + a.actualMaterial + a.committedMaterial;
            const totalActualB = b.actualLabor + b.actualMaterial + b.committedMaterial;
            let cmp = 0;
            switch (sortKey) {
                case "code": cmp = a.code.localeCompare(b.code); break;
                case "budget": cmp = totalBudgetA - totalBudgetB; break;
                case "actual": cmp = totalActualA - totalActualB; break;
                case "variance": cmp = (totalBudgetA - totalActualA) - (totalBudgetB - totalActualB); break;
                case "pct":
                    const pA = totalBudgetA > 0 ? totalActualA / totalBudgetA : 0;
                    const pB = totalBudgetB > 0 ? totalActualB / totalBudgetB : 0;
                    cmp = pA - pB; break;
            }
            return sortDir === "asc" ? cmp : -cmp;
        });
    }, [summaries, sortKey, sortDir]);

    const totals = useMemo(() => {
        return summaries.reduce((acc, curr) => ({
            budget: acc.budget + curr.budgetLabor + curr.budgetMaterial,
            actual: acc.actual + curr.actualLabor + curr.actualMaterial,
            committed: acc.committed + curr.committedMaterial,
            variance: acc.variance + ((curr.budgetLabor + curr.budgetMaterial) - (curr.actualLabor + curr.actualMaterial + curr.committedMaterial))
        }), { budget: 0, actual: 0, committed: 0, variance: 0 });
    }, [summaries]);

    const totalCost = totals.actual + totals.committed;
    const budgetUsedPct = totals.budget > 0 ? (totalCost / totals.budget) * 100 : 0;

    const ThSortable = ({ label, sortK, className = "" }: { label: string; sortK: SortKey; className?: string }) => (
        <th className={`px-5 py-3.5 font-semibold cursor-pointer select-none hover:text-hui-primary transition group ${className}`} onClick={() => handleSort(sortK)}>
            <span className="inline-flex items-center gap-1">
                {label}
                <span className={`transition ${sortKey === sortK ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`}>
                    {sortKey === sortK && sortDir === "asc" ? "↑" : "↓"}
                </span>
            </span>
        </th>
    );

    return (
        <div className="w-full max-w-6xl mx-auto pb-20">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
                        <ChartBarIcon />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-hui-textMain">Job Costing</h1>
                        <p className="text-sm text-hui-textLight">Budget vs actuals for {project.name}</p>
                    </div>
                </div>
                <button
                    onClick={handleCostForecast}
                    disabled={isForecast}
                    className="hui-btn bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200 text-amber-700 hover:from-amber-100 hover:to-orange-100 text-sm flex items-center gap-2 disabled:opacity-50"
                >
                    🔮 {isForecast ? "Forecasting…" : "AI Cost Forecast"}
                </button>
            </div>

            {/* AI Cost Forecast Panel */}
            {showForecast && forecastAnalysis && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center">
                    <div className="fixed inset-0 bg-black/40" onClick={() => setShowForecast(false)} />
                    <div className="relative bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col">
                        <div className="flex items-center justify-between p-5 border-b border-hui-border">
                            <div className="flex items-center gap-2">
                                <span className="text-xl">🔮</span>
                                <h2 className="font-bold text-hui-textMain text-lg">AI Cost Forecast</h2>
                            </div>
                            <button onClick={() => setShowForecast(false)} className="text-hui-textMuted hover:text-hui-textMain">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-5 overflow-y-auto flex-1">
                            <pre className="whitespace-pre-wrap text-sm text-hui-textMain font-sans leading-relaxed">{forecastAnalysis}</pre>
                        </div>
                        <div className="p-4 border-t border-hui-border">
                            <button onClick={() => setShowForecast(false)} className="hui-btn hui-btn-secondary text-sm">Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <div className="bg-white p-5 rounded-xl shadow-sm border border-hui-border">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
                            <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>
                        </div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Budget</p>
                    </div>
                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(totals.budget)}</p>
                </div>

                <div className="bg-white p-5 rounded-xl shadow-sm border border-hui-border">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-9 h-9 rounded-lg bg-orange-50 flex items-center justify-center text-orange-600">
                            <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        </div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Actual Costs</p>
                    </div>
                    <p className="text-2xl font-bold text-hui-textMain">{formatCurrency(totals.actual)}</p>
                </div>

                <div className="bg-white p-5 rounded-xl shadow-sm border border-hui-border">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-9 h-9 rounded-lg bg-orange-50 flex items-center justify-center text-orange-600">
                            <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 8.25H9m6 3H9m3 6l-3-3h1.5a3 3 0 100-6M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        </div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Committed POs</p>
                    </div>
                    <p className="text-2xl font-bold text-amber-500">{formatCurrency(totals.committed)}</p>
                </div>

                <div className="bg-white p-5 rounded-xl shadow-sm border border-hui-border">
                    <div className="flex items-center gap-3 mb-3">
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${totals.variance >= 0 ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-600"}`}>
                            <svg className="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d={totals.variance >= 0 ? "M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" : "M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181"} /></svg>
                        </div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Variance</p>
                    </div>
                    <p className={`text-2xl font-bold ${totals.variance >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {totals.variance >= 0 ? "+" : ""}{formatCurrency(totals.variance)}
                    </p>
                </div>

                <div className="bg-white p-5 rounded-xl shadow-sm border border-hui-border">
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-9 h-9 rounded-lg bg-purple-50 flex items-center justify-center text-purple-600">
                            <ChartBarIcon />
                        </div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Budget Used</p>
                    </div>
                    <p className={`text-2xl font-bold ${budgetUsedPct > 100 ? "text-red-500" : "text-hui-textMain"}`}>{budgetUsedPct.toFixed(1)}%</p>
                    <div className="w-full h-2 bg-slate-100 rounded-full mt-2 overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${budgetUsedPct > 100 ? 'bg-red-500' : budgetUsedPct > 80 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${Math.min(budgetUsedPct, 100)}%` }} />
                    </div>
                </div>
            </div>

            {/* Budget vs Actual Chart */}
            {sortedSummaries.length > 0 && (
                <div className="bg-white rounded-xl shadow-sm border border-hui-border p-5 mb-6">
                    <div className="flex items-center gap-2 mb-4">
                        <ChartBarIcon />
                        <h2 className="text-sm font-bold text-hui-textMain">Budget vs Actual by Phase</h2>
                    </div>
                    <ResponsiveContainer width="100%" height={280}>
                        <BarChart
                            data={sortedSummaries.map(s => ({
                                name: s.code !== "N/A" ? s.code : s.name,
                                fullName: s.name,
                                Budget: parseFloat((s.budgetLabor + s.budgetMaterial).toFixed(2)),
                                Actual: parseFloat((s.actualLabor + s.actualMaterial).toFixed(2)),
                                Committed: parseFloat(s.committedMaterial.toFixed(2)),
                            }))}
                            margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
                            barCategoryGap="30%"
                            barGap={2}
                        >
                            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                            <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                            <YAxis
                                tick={{ fontSize: 11, fill: "#94a3b8" }}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={v => `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`}
                            />
                            <Tooltip
                                formatter={(value: number, name: string) => [formatCurrency(value), name]}
                                labelFormatter={(label, payload) => payload?.[0]?.payload?.fullName ?? label}
                                contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }}
                            />
                            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                            <Bar dataKey="Budget" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="Actual" fill="#f97316" radius={[3, 3, 0, 0]} />
                            <Bar dataKey="Committed" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}

            {/* Cost Breakdown Table */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <div className="px-5 py-4 border-b border-hui-border flex items-center gap-2">
                    <svg className="w-4.5 h-4.5 text-hui-textMuted" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" /></svg>
                    <h2 className="text-sm font-bold text-hui-textMain">Cost Breakdown by Phase</h2>
                </div>
                <table className="w-full text-left text-sm text-hui-textMain">
                    <thead className="bg-slate-50 border-b border-hui-border text-[11px] uppercase text-hui-textMuted tracking-wider">
                        <tr>
                            <ThSortable label="Phase / Cost Code" sortK="code" />
                            <ThSortable label="Budget" sortK="budget" className="text-right" />
                            <ThSortable label="Actual" sortK="actual" className="text-right" />
                            <ThSortable label="Committed" sortK="actual" className="text-right" />
                            <ThSortable label="Variance" sortK="variance" className="text-right" />
                            <ThSortable label="% Used" sortK="pct" className="text-right" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {sortedSummaries.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-12 text-center">
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                                            <ChartBarIcon />
                                        </div>
                                        <p className="text-hui-textLight font-medium">No costing data available</p>
                                        <p className="text-xs text-slate-400">Add estimates or time entries to see metrics</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            sortedSummaries.map((s, i) => {
                                const totalBudget = s.budgetLabor + s.budgetMaterial;
                                const totalActual = s.actualLabor + s.actualMaterial;
                                const committed = s.committedMaterial;
                                const totalCost = totalActual + committed;
                                const variance = totalBudget - totalCost;
                                const pctUsed = totalBudget > 0 ? (totalCost / totalBudget) * 100 : 0;
                                return (
                                    <tr key={i} className="hover:bg-slate-50/80 transition group">
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-2.5">
                                                <div className={`w-2 h-2 rounded-full ${pctUsed > 100 ? "bg-red-500" : pctUsed > 80 ? "bg-amber-400" : "bg-emerald-500"}`} />
                                                <div>
                                                    <p className="font-semibold text-hui-textMain">{s.code !== "N/A" ? `${s.code}` : ""} {s.name}</p>
                                                    <p className="text-[11px] text-slate-400">
                                                        Labor: ${s.budgetLabor.toFixed(0)} budgeted · Material: ${s.budgetMaterial.toFixed(0)} budgeted
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-5 py-4 text-right font-medium tabular-nums">{formatCurrency(totalBudget)}</td>
                                        <td className="px-5 py-4 text-right font-semibold tabular-nums text-slate-500">{formatCurrency(totalActual)}</td>
                                        <td className="px-5 py-4 text-right font-semibold tabular-nums text-amber-500">{formatCurrency(committed)}</td>
                                        <td className={`px-5 py-4 text-right font-semibold tabular-nums ${variance >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                            {variance >= 0 ? "+" : ""}{formatCurrency(variance)}
                                        </td>
                                        <td className="px-5 py-4">
                                            <div className="flex items-center justify-end gap-3">
                                                <span className={`text-xs font-semibold min-w-[3.5ch] text-right ${pctUsed > 100 ? "text-red-500" : "text-hui-textMuted"}`}>{pctUsed.toFixed(0)}%</span>
                                                <div className="w-20 h-2 bg-slate-100 rounded-full overflow-hidden">
                                                    <div className={`h-full rounded-full transition-all ${pctUsed > 100 ? 'bg-red-500' : pctUsed > 80 ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${Math.min(pctUsed, 100)}%` }} />
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                    {sortedSummaries.length > 0 && (
                        <tfoot className="bg-slate-50 border-t border-hui-border">
                            <tr className="text-sm font-bold text-hui-textMain">
                                <td className="px-5 py-3.5">Totals</td>
                                <td className="px-5 py-3.5 text-right tabular-nums">{formatCurrency(totals.budget)}</td>
                                <td className="px-5 py-3.5 text-right tabular-nums text-slate-500">{formatCurrency(totals.actual)}</td>
                                <td className="px-5 py-3.5 text-right tabular-nums text-amber-500">{formatCurrency(totals.committed)}</td>
                                <td className={`px-5 py-3.5 text-right tabular-nums ${totals.variance >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                    {totals.variance >= 0 ? "+" : ""}{formatCurrency(totals.variance)}
                                </td>
                                <td className="px-5 py-3.5 text-right tabular-nums">{budgetUsedPct.toFixed(1)}%</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </div>
    );
}
