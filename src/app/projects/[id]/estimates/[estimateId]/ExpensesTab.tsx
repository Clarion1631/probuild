"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";

export default function ExpensesTab({
  estimateId,
  projectId,
  items,
}: {
  estimateId: string;
  projectId: string;
  items: any[];
}) {
  const [expenses, setExpenses] = useState<any[]>(items.flatMap((item) => item.expenses || []));
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
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
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
            description,
          }),
        });

        if (!res.ok) throw new Error("Failed to update expense");
        const updatedExpense = await res.json();

        setExpenses(
          expenses.map((e) => (e.id === editingExpenseId ? { ...e, ...updatedExpense } : e))
        );
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
            receiptUrl,
          }),
        });

        if (!res.ok) throw new Error("Failed to save expense");
        const newExpense = await res.json();
        setExpenses([...expenses, newExpense]);
      }

      setShowModal(false);
      resetForm();
      toast.success("Expense saved successfully");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Save failed");
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
    setDate(expense.date ? new Date(expense.date).toISOString().split("T")[0] : "");
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
      setExpenses(expenses.filter((e) => e.id !== id));
    } catch {
      toast.error("Could not delete expense");
    }
  }

  // Calculate Variance By Item
  const varianceByItem = items.reduce((acc, item) => {
    const itemExpenses = expenses.filter((e) => e.itemId === item.id);
    const actualCost = itemExpenses.reduce((sum, e) => sum + e.amount, 0);
    const budgetedCost = (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0);
    acc.push({ ...item, actualCost, budgetedCost, variance: budgetedCost - actualCost });
    return acc;
  }, []);

  const totalActual = varianceByItem.reduce((sum: number, item: any) => sum + item.actualCost, 0);
  const totalBudget = varianceByItem.reduce((sum: number, item: any) => sum + item.budgetedCost, 0);
  const totalVariance = totalBudget - totalActual;

  // Graph Data
  const budgetUtilization =
    totalBudget > 0 ? (totalActual / totalBudget) * 100 : totalActual > 0 ? 100 : 0;
  const utilizationColor =
    budgetUtilization > 100
      ? "bg-red-500"
      : budgetUtilization > 85
        ? "bg-amber-400"
        : "bg-green-500";

  return (
    <div className="animate-in fade-in space-y-10 p-10 pb-12 duration-300">
      {/* Header Setup */}
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-extrabold tracking-tight text-slate-800">
          Job Costing & Expenses
        </h2>
        <div className="flex items-center gap-3">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept="image/*"
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="hui-btn hui-btn-primary flex items-center gap-2"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Upload AI Receipt
          </button>
          <button onClick={() => setShowModal(true)} className="hui-btn hui-btn-secondary">
            Add Manual
          </button>
        </div>
      </div>

      {/* Variance Overview */}
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-6">
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-6">
            <p className="mb-1 text-[11px] font-bold tracking-widest text-slate-400 uppercase">
              Total Budget
            </p>
            <p className="text-3xl font-extrabold text-slate-800">
              ${totalBudget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div className="rounded-xl border border-slate-100 bg-slate-50 p-6">
            <p className="mb-1 text-[11px] font-bold tracking-widest text-slate-400 uppercase">
              Actual Cost
            </p>
            <p className="text-3xl font-extrabold text-slate-800">
              ${totalActual.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div
            className={`rounded-xl border p-6 ${totalVariance >= 0 ? "border-emerald-100 bg-emerald-50" : "border-red-100 bg-red-50"}`}
          >
            <p
              className={`mb-1 text-[11px] font-bold tracking-widest uppercase ${totalVariance >= 0 ? "text-emerald-600" : "text-red-600"}`}
            >
              Variance
            </p>
            <p
              className={`text-3xl font-extrabold ${totalVariance >= 0 ? "text-emerald-700" : "text-red-700"}`}
            >
              {totalVariance >= 0 ? "+" : "-"}$
              {Math.abs(totalVariance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Visual Snapshot Graph */}
        <div className="mt-6 rounded-xl border border-slate-100 bg-slate-50 p-6">
          <div className="mb-3 flex items-end justify-between">
            <h3 className="text-hui-textMain font-semibold">Budget Utilization Snapshot</h3>
            <span className="text-hui-textMuted text-sm font-medium">
              {budgetUtilization.toFixed(1)}% Used
            </span>
          </div>
          <div className="relative h-4 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200 ring-inset">
            <div
              className={`h-4 rounded-full transition-all duration-1000 ease-out ${utilizationColor}`}
              style={{ width: `${Math.min(budgetUtilization, 100)}%` }}
            ></div>
            {budgetUtilization > 100 && (
              <div className="absolute top-0 right-0 bottom-0 w-1 bg-red-600 opacity-50"></div>
            )}
          </div>
          <div className="mt-2 flex justify-between text-xs font-medium text-slate-400">
            <span>$0</span>
            <span>
              ${totalBudget.toLocaleString(undefined, { maximumFractionDigits: 0 })} Budget Limit
            </span>
          </div>
        </div>
      </div>

      {/* Breakdowns */}
      <div className="mt-10 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 bg-slate-50/50 px-8 py-5">
          <h3 className="font-bold tracking-tight text-slate-800">Cost Breakdown by Phase</h3>
        </div>
        <div className="divide-y divide-slate-50">
          {varianceByItem.map((item: any) => (
            <div
              key={item.id}
              className="flex items-center justify-between p-4 px-6 hover:bg-slate-50"
            >
              <div className="w-1/3">
                <p className="font-medium text-slate-800">{item.name}</p>
                <p className="text-xs text-slate-500">{item.type}</p>
              </div>
              <div className="w-1/6 text-right">
                <p className="mb-1 text-xs text-slate-500">Budget</p>
                <p className="text-sm font-medium">
                  ${item.budgetedCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="w-1/6 text-right">
                <p className="mb-1 text-xs text-slate-500">Actual</p>
                <p className="text-sm font-medium">
                  ${item.actualCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="w-1/6 text-right">
                <p className="mb-1 text-xs text-slate-500">Variance</p>
                <p
                  className={`text-sm font-bold ${item.variance >= 0 ? "text-green-600" : "text-red-600"}`}
                >
                  ${item.variance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* List of Recent Expenses */}
      <div className="mt-10 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 bg-slate-50/50 px-8 py-5">
          <h3 className="font-bold tracking-tight text-slate-800">Expense Log</h3>
        </div>
        {expenses.length === 0 ? (
          <div className="text-hui-textMuted p-8 text-center">No expenses recorded yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {expenses.map((expense, idx) => {
              const relatedItem = items.find((i) => i.id === expense.itemId);
              return (
                <div key={idx} className="flex items-center p-4 px-6 hover:bg-slate-50">
                  <div className="w-1/4">
                    <p className="font-medium text-slate-800">
                      {expense.vendor || "Unknown Vendor"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(expense.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="w-1/4">
                    <p className="text-sm text-slate-700">{expense.description || "—"}</p>
                  </div>
                  <div className="w-1/4">
                    <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {relatedItem?.name || "Uncategorized"}
                    </span>
                  </div>
                  <div className="flex w-1/4 items-center justify-end gap-4 text-right">
                    <span className="font-bold text-slate-900">
                      ${expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                    {expense.receiptUrl && (
                      <a
                        href={expense.receiptUrl}
                        target="_blank"
                        className="flex items-center gap-1 text-xs text-blue-500 hover:underline"
                        title="View Receipt"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
                        </svg>
                      </a>
                    )}
                    <button
                      onClick={() => handleEditExpense(expense)}
                      className="text-slate-400 transition hover:text-blue-600"
                      title="Edit"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleDeleteExpense(expense.id)}
                      className="text-slate-400 transition hover:text-red-600"
                      title="Delete"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Receipt Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
          <div className="border-hui-border flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-6 py-4">
              <h3 className="text-hui-textMain text-lg font-bold">
                {editingExpenseId ? "Edit Expense" : "Add Expense"}
              </h3>
              <button
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
                className="text-hui-textMuted hover:text-hui-textMain"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto p-6">
              {isUploading && (
                <div className="flex flex-col items-center justify-center space-y-3 rounded-lg border-2 border-dashed border-slate-200 bg-slate-50 p-8">
                  <svg
                    className="animate-spin text-blue-500"
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <p className="text-sm font-medium text-slate-600">
                    AI is reading your receipt...
                  </p>
                </div>
              )}

              {!isUploading && receiptUrl && (
                <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
                  <div className="rounded bg-white p-1 shadow-sm">
                    <img
                      src={receiptUrl}
                      alt="Receipt preview"
                      className="pointer-events-none h-16 w-16 rounded object-cover"
                    />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-blue-900">
                      Receipt Scanned successfully!
                    </p>
                    <p className="mt-0.5 text-xs text-blue-700">Please review the details below.</p>
                  </div>
                </div>
              )}

              {uploadError && (
                <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {uploadError}
                </div>
              )}

              {!isUploading && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-slate-700">Amount *</label>
                      <input
                        type="number"
                        step="0.01"
                        required
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full rounded border border-slate-300 px-3 py-2 text-sm ring-blue-500 focus:ring-2 focus:outline-none"
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium text-slate-700">Vendor</label>
                      <input
                        type="text"
                        value={vendor}
                        onChange={(e) => setVendor(e.target.value)}
                        className="w-full rounded border border-slate-300 px-3 py-2 text-sm ring-blue-500 focus:ring-2 focus:outline-none"
                        placeholder="Home Depot"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">
                      Phase / Cost Code *
                    </label>
                    <select
                      required
                      value={selectedItemId}
                      onChange={(e) => setSelectedItemId(e.target.value)}
                      className="w-full rounded border border-slate-300 px-3 py-2 text-sm ring-blue-500 focus:ring-2 focus:outline-none"
                    >
                      <option value="">Select an estimate item...</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} {item.type ? `(${item.type})` : ""} - Budget: $
                          {(item.quantity * item.unitCost).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">Description</label>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full rounded border border-slate-300 px-3 py-2 text-sm ring-blue-500 focus:ring-2 focus:outline-none"
                      placeholder="Materials for framing"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-slate-700">Date</label>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="w-full rounded border border-slate-300 px-3 py-2 text-sm ring-blue-500 focus:ring-2 focus:outline-none"
                    />
                  </div>
                </>
              )}
            </div>
            <div className="mt-auto flex justify-end gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
              <button
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
                className="hui-btn hui-btn-secondary"
              >
                Cancel
              </button>
              <button
                disabled={isUploading}
                onClick={handleSaveExpense}
                className="hui-btn hui-btn-primary disabled:opacity-50"
              >
                Save Expense
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
