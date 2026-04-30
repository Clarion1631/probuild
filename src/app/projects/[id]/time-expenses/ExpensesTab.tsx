"use client";

import { useMemo, useState, useCallback } from "react";
import { toast } from "sonner";
import { deleteExpense, deleteExpenses, getExpenses } from "@/lib/time-expense-actions";

interface Expense {
    id: string;
    amount: any;
    vendor: string | null;
    description: string | null;
    date: string | Date | null;
    status: string;
    receiptUrl: string | null;
    costCode: { id: string; name: string; code: string } | null;
    costType: { id: string; name: string } | null;
    item: { id: string; name: string } | null;
}

interface Props {
    projectId: string;
    expenses: Expense[];
    onAddNew: () => void;
    currentUser: { id: string; role: string; name: string };
}

function num(v: unknown): number {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "object" && "toNumber" in (v as Record<string, unknown>)
        ? (v as { toNumber: () => number }).toNumber()
        : Number(v);
    return isNaN(n) ? 0 : n;
}

function fmtMoney(v: number): string {
    return "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ExpensesTab({ projectId, expenses: initialExpenses, onAddNew, currentUser }: Props) {
    const [expenses, setExpenses] = useState<Expense[]>(initialExpenses);
    const [filter, setFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "Pending" | "Reviewed">("all");
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const refreshExpenses = useCallback(async () => {
        try {
            const fresh = await getExpenses(projectId);
            setExpenses(fresh as Expense[]);
        } catch { /* server revalidation will handle it */ }
    }, [projectId]);

    const summary = useMemo(() => {
        let total = 0;
        let pending = 0;
        let reviewed = 0;
        for (const e of expenses) {
            const amt = num(e.amount);
            total += amt;
            if (e.status === "Pending") pending += amt;
            else reviewed += amt;
        }
        return { total, pending, reviewed, count: expenses.length };
    }, [expenses]);

    const filtered = useMemo(() => {
        let list = expenses;
        if (statusFilter !== "all") {
            list = list.filter(e => e.status === statusFilter);
        }
        if (filter) {
            const q = filter.toLowerCase();
            list = list.filter(e =>
                (e.vendor || "").toLowerCase().includes(q) ||
                (e.description || "").toLowerCase().includes(q) ||
                e.costCode?.name.toLowerCase().includes(q) ||
                e.item?.name.toLowerCase().includes(q)
            );
        }
        return list;
    }, [expenses, filter, statusFilter]);

    function toggleSelect(id: string) {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function toggleAll() {
        if (selectedIds.size === filtered.length) setSelectedIds(new Set());
        else setSelectedIds(new Set(filtered.map(e => e.id)));
    }

    async function handleBulkDelete() {
        if (selectedIds.size === 0) return;
        const n = selectedIds.size;
        if (!confirm(`Delete ${n} expense${n === 1 ? "" : "s"}?`)) return;
        try {
            const res = await deleteExpenses(Array.from(selectedIds));
            toast.success(`Deleted ${res.deleted} expense${res.deleted === 1 ? "" : "s"}`);
            setSelectedIds(new Set());
            await refreshExpenses();
        } catch (err: any) {
            toast.error(err.message || "Failed to delete expenses");
        }
    }

    async function handleDelete(id: string) {
        if (!confirm("Delete this expense?")) return;
        try {
            await deleteExpense(id, projectId);
            toast.success("Expense deleted");
            await refreshExpenses();
        } catch (err: any) {
            toast.error(err.message || "Failed to delete");
        }
    }

    function handleExport() {
        const headers = ["Date", "Vendor", "Description", "Amount", "Cost Code", "Status"];
        const rows = [headers.join(",")];
        for (const e of filtered) {
            rows.push([
                e.date ? new Date(e.date).toLocaleDateString() : "",
                `"${e.vendor || ""}"`,
                `"${e.description || ""}"`,
                num(e.amount).toFixed(2),
                `"${e.costCode ? `${e.costCode.code} — ${e.costCode.name}` : ""}"`,
                e.status,
            ].join(","));
        }
        const blob = new Blob([rows.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "expenses.csv";
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Expenses exported");
    }

    return (
        <div>
            {/* Summary Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-gradient-to-br from-blue-50 to-blue-100/50 border border-blue-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Total Expenses</div>
                    <div className="text-xl font-bold text-blue-700">{fmtMoney(summary.total)}</div>
                    <div className="text-xs text-slate-500">{summary.count} records</div>
                </div>
                <div className="bg-gradient-to-br from-amber-50 to-amber-100/50 border border-amber-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Pending Review</div>
                    <div className="text-xl font-bold text-amber-700">{fmtMoney(summary.pending)}</div>
                </div>
                <div className="bg-gradient-to-br from-emerald-50 to-emerald-100/50 border border-emerald-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Reviewed</div>
                    <div className="text-xl font-bold text-emerald-700">{fmtMoney(summary.reviewed)}</div>
                </div>
                <div className="bg-gradient-to-br from-purple-50 to-purple-100/50 border border-purple-200 rounded-xl p-4">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">QB Synced</div>
                    <div className="text-xl font-bold text-purple-700">$0.00</div>
                    <div className="text-xs text-slate-500">QuickBooks sync</div>
                </div>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        placeholder="Filter by vendor, description..."
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        className="hui-input text-sm py-1.5 px-3 w-64"
                    />
                    <select
                        value={statusFilter}
                        onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
                        className="hui-input text-sm py-1.5 px-3"
                    >
                        <option value="all">All Statuses</option>
                        <option value="Pending">Pending</option>
                        <option value="Reviewed">Reviewed</option>
                    </select>
                    {selectedIds.size > 0 && (currentUser.role === "ADMIN" || currentUser.role === "MANAGER") && (
                        <button
                            onClick={handleBulkDelete}
                            className="hui-btn bg-white border border-red-300 text-red-600 hover:bg-red-50 text-sm px-3 py-1.5 flex items-center gap-1.5"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                            Delete ({selectedIds.size})
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={handleExport} className="hui-btn bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm px-3 py-1.5">
                        Export
                    </button>
                    <button onClick={onAddNew} className="hui-btn hui-btn-green text-sm px-3 py-1.5 flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        New Expense
                    </button>
                </div>
            </div>

            {/* Table */}
            {filtered.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
                    <svg className="w-12 h-12 mx-auto text-slate-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
                    </svg>
                    <h3 className="text-lg font-semibold text-slate-600 mb-1">No expenses yet</h3>
                    <p className="text-sm text-slate-400">Click "New Expense" to log a project expense.</p>
                </div>
            ) : (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-slate-50 border-b border-slate-200">
                                    <th className="px-4 py-3 text-left w-10">
                                        <input type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0} onChange={toggleAll} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary" />
                                    </th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Date</th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Vendor</th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Description</th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Cost Code</th>
                                    <th className="px-4 py-3 text-left font-semibold text-slate-600 uppercase text-xs tracking-wider">Line Item</th>
                                    <th className="px-4 py-3 text-right font-semibold text-slate-600 uppercase text-xs tracking-wider">Amount</th>
                                    <th className="px-4 py-3 text-center font-semibold text-slate-600 uppercase text-xs tracking-wider">Status</th>
                                    <th className="px-4 py-3 text-center font-semibold text-slate-600 uppercase text-xs tracking-wider">QB</th>
                                    <th className="px-4 py-3 text-right font-semibold text-slate-600 uppercase text-xs tracking-wider w-20"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filtered.map(expense => (
                                    <tr key={expense.id} className="hover:bg-slate-50 transition">
                                        <td className="px-4 py-3">
                                            <input type="checkbox" checked={selectedIds.has(expense.id)} onChange={() => toggleSelect(expense.id)} className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary" />
                                        </td>
                                        <td className="px-4 py-3 text-slate-600 tabular-nums">{expense.date ? new Date(expense.date).toLocaleDateString() : "—"}</td>
                                        <td className="px-4 py-3 font-medium text-hui-textMain">{expense.vendor || "—"}</td>
                                        <td className="px-4 py-3 text-slate-600 max-w-[200px] truncate">{expense.description || "—"}</td>
                                        <td className="px-4 py-3 text-slate-600">{expense.costCode ? `${expense.costCode.code}` : "—"}</td>
                                        <td className="px-4 py-3 text-slate-600">{expense.item?.name || "—"}</td>
                                        <td className="px-4 py-3 text-right tabular-nums font-medium text-hui-textMain">{fmtMoney(num(expense.amount))}</td>
                                        <td className="px-4 py-3 text-center">
                                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                                                expense.status === "Reviewed"
                                                    ? "bg-green-100 text-green-700"
                                                    : "bg-amber-100 text-amber-700"
                                            }`}>
                                                {expense.status}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <input
                                                type="checkbox"
                                                disabled
                                                title="QuickBooks sync — coming soon"
                                                className="rounded border-slate-300 text-hui-primary focus:ring-hui-primary"
                                            />
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            {(currentUser.role === "ADMIN" || currentUser.role === "MANAGER") && (
                                                <button onClick={() => handleDelete(expense.id)} className="text-slate-400 hover:text-red-500 transition" title="Delete">
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                                    </svg>
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
