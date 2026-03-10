"use client";

import { useMemo } from "react";

interface JobCostingClientProps {
    project: { id: string; name: string };
    estimates: any[];
    timeEntries: any[];
    expenses: any[];
}

type CostCodeSummary = {
    code: string;
    name: string;
    budgetLabor: number;
    budgetMaterial: number;
    actualLabor: number;
    actualMaterial: number;
};

export default function JobCostingClient({
    project,
    estimates,
    timeEntries,
    expenses
}: JobCostingClientProps) {

    const summaries = useMemo(() => {
        const map = new Map<string, CostCodeSummary>();

        const getGroup = (ccId: string | null, ccName: string, ccCode: string) => {
            const key = ccId || "unassigned";
            if (!map.has(key)) {
                map.set(key, {
                    code: ccCode || "N/A",
                    name: ccName || "Unassigned",
                    budgetLabor: 0,
                    budgetMaterial: 0,
                    actualLabor: 0,
                    actualMaterial: 0
                });
            }
            return map.get(key)!;
        };

        // 1. Process Budget (Estimates)
        // We might just sum up all items on Approved estimates, or all of them. Let's sum all items for now.
        estimates.forEach(est => {
            est.items.forEach((item: any) => {
                const group = getGroup(item.costCodeId, item.costCode?.name, item.costCode?.code);
                // Simple heuristic: If type is labor, add to budgetLabor, else budgetMaterial
                const total = (item.quantity * item.unitCost);
                if (item.type?.toLowerCase().includes("labor")) {
                    group.budgetLabor += total;
                } else {
                    group.budgetMaterial += total;
                }
            });
        });

        // 2. Process Actuals - Time Entries (Labor)
        timeEntries.forEach(te => {
            const group = getGroup(te.costCodeId, te.costCode?.name, te.costCode?.code);
            group.actualLabor += (te.laborCost || 0);
        });

        // 3. Process Actuals - Expenses (Material/Other)
        expenses.forEach(ex => {
            const group = getGroup(ex.costCodeId, ex.costCode?.name, ex.costCode?.code);
            group.actualMaterial += (ex.amount || 0);
        });

        return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
    }, [estimates, timeEntries, expenses]);

    const totals = useMemo(() => {
        return summaries.reduce((acc, curr) => ({
            budget: acc.budget + curr.budgetLabor + curr.budgetMaterial,
            actual: acc.actual + curr.actualLabor + curr.actualMaterial,
            variance: acc.variance + ((curr.budgetLabor + curr.budgetMaterial) - (curr.actualLabor + curr.actualMaterial))
        }), { budget: 0, actual: 0, variance: 0 });
    }, [summaries]);

    return (
        <div className="w-full max-w-5xl mx-auto pb-20">
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-hui-textMain">Job Costing</h1>
                <p className="text-sm text-hui-textLight">Track budget vs actuals for {project.name}</p>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-white p-6 rounded-xl shadow-sm border border-hui-border flex flex-col justify-center">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2">Total Budget</p>
                    <p className="text-3xl font-bold text-hui-textMain">${totals.budget.toFixed(2)}</p>
                </div>
                <div className="bg-white p-6 rounded-xl shadow-sm border border-hui-border flex flex-col justify-center">
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2">Actual Cost</p>
                    <p className="text-3xl font-bold text-hui-textMain">${totals.actual.toFixed(2)}</p>
                </div>
                <div className={`bg-white p-6 rounded-xl shadow-sm border border-hui-border flex flex-col justify-center`}>
                    <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider mb-2">Variance</p>
                    <p className={`text-3xl font-bold ${totals.variance >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {totals.variance >= 0 ? "+" : ""}${totals.variance.toFixed(2)}
                    </p>
                </div>
            </div>

            {/* Detailed Table */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <table className="w-full text-left text-sm text-hui-textMain">
                    <thead className="bg-hui-background border-b border-hui-border text-xs uppercase text-hui-textMuted tracking-wider">
                        <tr>
                            <th className="px-6 py-4 font-semibold">Phase / Cost Code</th>
                            <th className="px-6 py-4 font-semibold text-right">Budget</th>
                            <th className="px-6 py-4 font-semibold text-right">Actual</th>
                            <th className="px-6 py-4 font-semibold text-right">Variance</th>
                            <th className="px-6 py-4 font-semibold text-right">% Used</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-hui-border">
                        {summaries.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-6 py-8 text-center text-hui-textLight">
                                    No costing data available. Add estimates or time entries to see metrics.
                                </td>
                            </tr>
                        ) : (
                            summaries.map((s, i) => {
                                const totalBudget = s.budgetLabor + s.budgetMaterial;
                                const totalActual = s.actualLabor + s.actualMaterial;
                                const variance = totalBudget - totalActual;
                                const pctUsed = totalBudget > 0 ? (totalActual / totalBudget) * 100 : 0;
                                
                                return (
                                    <tr key={i} className="hover:bg-slate-50 transition">
                                        <td className="px-6 py-4">
                                            <p className="font-semibold text-hui-textMain">{s.code !== "N/A" ? `${s.code} - ` : ""}{s.name}</p>
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            ${totalBudget.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            <span className="font-medium">${totalActual.toFixed(2)}</span>
                                        </td>
                                        <td className={`px-6 py-4 text-right font-medium ${variance >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                                            {variance >= 0 ? "+" : ""}${variance.toFixed(2)}
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="flex items-center justify-end gap-3">
                                                <span className="text-xs text-hui-textMuted min-w-[3ch]">{pctUsed.toFixed(0)}%</span>
                                                <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                                    <div 
                                                        className={`h-full rounded-full transition-all ${pctUsed > 100 ? 'bg-red-500' : 'bg-hui-primary'}`} 
                                                        style={{ width: `${Math.min(pctUsed, 100)}%`}} 
                                                    />
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                )
                            })
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
