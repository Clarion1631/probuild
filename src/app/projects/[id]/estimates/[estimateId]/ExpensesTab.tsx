"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";

export default function ExpensesTab({ estimateId, projectId, items }: { estimateId: string, projectId: string, items: any[] }) {
    const [expenses, setExpenses] = useState<any[]>(items.flatMap(item => item.expenses || []));
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState("");
    const [showModal, setShowModal] = useState(false);
    const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);

    // Form state for new/edit expense
    const [amount, setAmount] = useState("");
    const [vendor, setVendor] = useState("");
    const [date, setDate] = useState("");
    const [description, setDescription] = useState("");
    const [receiptUrl, setReceiptUrl] = useState("");
    const [selectedItemId, setSelectedItemId] = useState("");

    const fileInputRef = useRef<HTMLInputElement>(null);

    async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        setUploadError("");
        setShowModal(true); // Open modal immediately to show parsing

        const formData = new FormData();
        formData.append("receipt", file);

        try {
            const res = await fetch("/api/expenses/parse", {
                method: "POST",
                body: formData,
            });

            if (!res.ok) throw new Error("Failed to parse receipt");

            const data = await res.json();

            // Populate form with AI data
            if (data.parsedData) {
                setAmount(data.parsedData.amount?.toString() || "");
                setVendor(data.parsedData.vendor || "");
                setDate(data.parsedData.date || "");
                setDescription(data.parsedData.description || "");
            }
            setReceiptUrl(data.receiptUrl || "");

        } catch (error: any) {
            setUploadError(error.message);
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    async function handleSaveExpense() {
        if (!amount || !selectedItemId) {
            setUploadError("Amount and Cost Code (Estimate Item) are required.");
            return;
        }

        setIsUploading(true);
        try {
            if (editingExpenseId) {
                // Update existing expense
                const res = await fetch(`/api/expenses/${editingExpenseId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        itemId: selectedItemId,
                        amount: parseFloat(amount),
                        vendor,
                        date,
                        description
                    }),
                });

                if (!res.ok) throw new Error("Failed to update expense");
                const updatedExpense = await res.json();

                setExpenses(expenses.map(e => e.id === editingExpenseId ? { ...e, ...updatedExpense } : e));
            } else {
                // Create new expense
                const res = await fetch("/api/expenses", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        estimateId,
                        itemId: selectedItemId,
                        amount: parseFloat(amount),
                        vendor,
                        date,
                        description,
                        receiptUrl
                    }),
                });

                if (!res.ok) throw new Error("Failed to save expense");
                const newExpense = await res.json();
                setExpenses([...expenses, newExpense]);
            }

            setShowModal(false);
            resetForm();
            toast.success("Expense saved successfully");
        } catch (error: any) {
            setUploadError(error.message);
        } finally {
            setIsUploading(false);
        }
    }

    function resetForm() {
        setAmount("");
        setVendor("");
        setDate("");
        setDescription("");
        setReceiptUrl("");
        setSelectedItemId("");
        setUploadError("");
        setEditingExpenseId(null);
    }

    function handleEditExpense(expense: any) {
        setEditingExpenseId(expense.id);
        setAmount(expense.amount?.toString() || "");
        setVendor(expense.vendor || "");
        setDate(expense.date ? new Date(expense.date).toISOString().split('T')[0] : "");
        setDescription(expense.description || "");
        setReceiptUrl(expense.receiptUrl || "");
        setSelectedItemId(expense.itemId || "");
        setUploadError("");
        setShowModal(true);
    }

    async function handleDeleteExpense(id: string) {
        if (!confirm("Are you sure you want to delete this expense?")) return;

        try {
            const res = await fetch(`/api/expenses/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Failed to delete expense");
            setExpenses(expenses.filter(e => e.id !== id));
        } catch (error) {
            console.error(error);
            alert("Could not delete expense");
        }
    }

    // Calculate Variance By Item
    const varianceByItem = items.reduce((acc, item) => {
        const itemExpenses = expenses.filter(e => e.itemId === item.id);
        const actualCost = itemExpenses.reduce((sum, e) => sum + e.amount, 0);
        const budgetedCost = (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0);
        acc.push({ ...item, actualCost, budgetedCost, variance: budgetedCost - actualCost });
        return acc;
    }, []);

    const totalActual = varianceByItem.reduce((sum: number, item: any) => sum + item.actualCost, 0);
    const totalBudget = varianceByItem.reduce((sum: number, item: any) => sum + item.budgetedCost, 0);
    const totalVariance = totalBudget - totalActual;

    // Graph Data
    const budgetUtilization = totalBudget > 0 ? (totalActual / totalBudget) * 100 : (totalActual > 0 ? 100 : 0);
    const utilizationColor = budgetUtilization > 100 ? "bg-red-500" : (budgetUtilization > 85 ? "bg-amber-400" : "bg-green-500");

    return (
        <div className="p-8 space-y-8 animate-in fade-in duration-300">
            {/* Header Setup */}
            <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-slate-800">Job Costing & Expenses</h2>
                <div className="flex items-center gap-3">
                    <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="image/*" className="hidden" />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="px-4 py-2 bg-blue-600 text-white rounded shadow text-sm font-medium hover:bg-blue-700 transition flex items-center gap-2"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                        Upload AI Receipt
                    </button>
                    <button
                        onClick={() => setShowModal(true)}
                        className="px-4 py-2 bg-white text-slate-700 border border-slate-300 rounded shadow-sm text-sm font-medium hover:bg-slate-50 transition"
                    >
                        Add Manual
                    </button>
                </div>
            </div>

            {/* Variance Overview */}
            <div className="space-y-4">
                <div className="grid grid-cols-3 gap-6">
                    <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
                        <p className="text-sm font-medium text-slate-500 mb-1">Total Budget</p>
                        <p className="text-3xl font-bold text-slate-900">${totalBudget.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                    </div>
                    <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
                        <p className="text-sm font-medium text-slate-500 mb-1">Actual Cost</p>
                        <p className="text-3xl font-bold text-slate-900">${totalActual.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                    </div>
                    <div className={`p-6 rounded-lg shadow-sm border ${totalVariance >= 0 ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                        <p className={`text-sm font-medium mb-1 ${totalVariance >= 0 ? "text-green-700" : "text-red-700"}`}>Variance</p>
                        <p className={`text-3xl font-bold ${totalVariance >= 0 ? "text-green-800" : "text-red-800"}`}>
                            {totalVariance >= 0 ? "+" : "-"}${Math.abs(totalVariance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>

                {/* Visual Snapshot Graph */}
                <div className="bg-white p-6 rounded-lg shadow-sm border border-slate-200">
                    <div className="flex justify-between items-end mb-2">
                        <h3 className="font-semibold text-slate-800">Budget Utilization Snapshot</h3>
                        <span className="text-sm font-medium text-slate-500">{budgetUtilization.toFixed(1)}% Used</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-4 relative overflow-hidden ring-1 ring-inset ring-slate-200">
                        <div
                            className={`h-4 transition-all duration-1000 ease-out rounded-full ${utilizationColor}`}
                            style={{ width: `${Math.min(budgetUtilization, 100)}%` }}
                        ></div>
                        {budgetUtilization > 100 && (
                            <div className="absolute top-0 bottom-0 right-0 bg-red-600 w-1 opacity-50"></div>
                        )}
                    </div>
                    <div className="flex justify-between text-xs text-slate-400 mt-2 font-medium">
                        <span>$0</span>
                        <span>${totalBudget.toLocaleString(undefined, { maximumFractionDigits: 0 })} Budget Limit</span>
                    </div>
                </div>
            </div>

            {/* Breakdowns */}
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50">
                    <h3 className="font-semibold text-slate-800">Cost Breakdown by Phase</h3>
                </div>
                <div className="divide-y divide-slate-100">
                    {varianceByItem.map((item: any) => (
                        <div key={item.id} className="p-4 px-6 flex items-center justify-between hover:bg-slate-50">
                            <div className="w-1/3">
                                <p className="font-medium text-slate-800">{item.name}</p>
                                <p className="text-xs text-slate-500">{item.type}</p>
                            </div>
                            <div className="w-1/6 text-right">
                                <p className="text-xs text-slate-500 mb-1">Budget</p>
                                <p className="text-sm font-medium">${item.budgetedCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div className="w-1/6 text-right">
                                <p className="text-xs text-slate-500 mb-1">Actual</p>
                                <p className="text-sm font-medium">${item.actualCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div className="w-1/6 text-right">
                                <p className="text-xs text-slate-500 mb-1">Variance</p>
                                <p className={`text-sm font-bold ${item.variance >= 0 ? "text-green-600" : "text-red-600"}`}>
                                    ${item.variance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* List of Recent Expenses */}
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden mt-8">
                <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50">
                    <h3 className="font-semibold text-slate-800">Expense Log</h3>
                </div>
                {expenses.length === 0 ? (
                    <div className="p-8 text-center text-slate-500">No expenses recorded yet.</div>
                ) : (
                    <div className="divide-y divide-slate-100">
                        {expenses.map((expense, idx) => {
                            const relatedItem = items.find(i => i.id === expense.itemId);
                            return (
                                <div key={idx} className="p-4 px-6 flex items-center hover:bg-slate-50">
                                    <div className="w-1/4">
                                        <p className="font-medium text-slate-800">{expense.vendor || "Unknown Vendor"}</p>
                                        <p className="text-xs text-slate-500">{new Date(expense.createdAt).toLocaleDateString()}</p>
                                    </div>
                                    <div className="w-1/4">
                                        <p className="text-sm text-slate-700">{expense.description || "—"}</p>
                                    </div>
                                    <div className="w-1/4">
                                        <span className="px-2 py-0.5 rounded text-xs bg-slate-100 border border-slate-200 text-slate-600">
                                            {relatedItem?.name || "Uncategorized"}
                                        </span>
                                    </div>
                                    <div className="w-1/4 text-right flex items-center justify-end gap-4">
                                        <span className="font-bold text-slate-900">${expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                        {expense.receiptUrl && (
                                            <a href={expense.receiptUrl} target="_blank" className="text-blue-500 hover:underline text-xs flex items-center gap-1" title="View Receipt">
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" /></svg>
                                            </a>
                                        )}
                                        <button onClick={() => handleEditExpense(expense)} className="text-slate-400 hover:text-blue-600 transition" title="Edit">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
                                        </button>
                                        <button onClick={() => handleDeleteExpense(expense.id)} className="text-slate-400 hover:text-red-600 transition" title="Delete">
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" /></svg>
                                        </button>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {/* Receipt Modal */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
                    <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                            <h3 className="font-bold text-lg text-slate-800">{editingExpenseId ? "Edit Expense" : "Add Expense"}</h3>
                            <button onClick={() => { setShowModal(false); resetForm(); }} className="text-slate-400 hover:text-slate-600">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto space-y-4">
                            {isUploading && (
                                <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-slate-200 rounded-lg bg-slate-50 space-y-3">
                                    <svg className="animate-spin text-blue-500" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                                    <p className="text-sm font-medium text-slate-600">AI is reading your receipt...</p>
                                </div>
                            )}

                            {!isUploading && receiptUrl && (
                                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-3">
                                    <div className="bg-white p-1 rounded shadow-sm">
                                        <img src={receiptUrl} alt="Receipt preview" className="w-16 h-16 object-cover rounded pointer-events-none" />
                                    </div>
                                    <div>
                                        <p className="font-medium text-blue-900 text-sm">Receipt Scanned successfully!</p>
                                        <p className="text-xs text-blue-700 mt-0.5">Please review the details below.</p>
                                    </div>
                                </div>
                            )}

                            {uploadError && (
                                <div className="p-3 bg-red-50 text-red-700 text-sm rounded border border-red-200">
                                    {uploadError}
                                </div>
                            )}

                            {!isUploading && (
                                <>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-slate-700">Amount *</label>
                                            <input type="number" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="0.00" />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className="text-sm font-medium text-slate-700">Vendor</label>
                                            <input type="text" value={vendor} onChange={e => setVendor(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="Home Depot" />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-slate-700">Phase / Cost Code *</label>
                                        <select required value={selectedItemId} onChange={e => setSelectedItemId(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none">
                                            <option value="">Select an estimate item...</option>
                                            {items.map(item => (
                                                <option key={item.id} value={item.id}>
                                                    {item.name} {item.type ? `(${item.type})` : ''} - Budget: ${(item.quantity * item.unitCost).toLocaleString()}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-slate-700">Description</label>
                                        <input type="text" value={description} onChange={e => setDescription(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" placeholder="Materials for framing" />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-sm font-medium text-slate-700">Date</label>
                                        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 ring-blue-500 focus:outline-none" />
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3 bg-slate-50 mt-auto">
                            <button onClick={() => { setShowModal(false); resetForm(); }} className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-200 rounded transition text-sm">Cancel</button>
                            <button disabled={isUploading} onClick={handleSaveExpense} className="px-4 py-2 bg-slate-900 text-white font-medium hover:bg-slate-800 rounded shadow-sm disabled:opacity-50 transition text-sm">
                                Save Expense
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
