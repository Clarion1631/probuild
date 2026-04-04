"use client";

import { useState, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createExpense, updateExpense, deleteExpense, approveExpense } from "./actions";

type UserBasic = { id: string; name: string | null; email: string };
type CostCodeBasic = { id: string; name: string; code: string };

type ExpenseDetailed = {
    id: string;
    projectId: string | null;
    amount: number;
    vendor: string | null;
    date: string | null;
    description: string | null;
    receiptUrl: string | null;
    quantity: number;
    paymentMethod: string | null;
    isBillable: boolean;
    isTaxable: boolean;
    referenceNumber: string | null;
    service: string | null;
    syncToQB: boolean;
    status: string;
    costCodeId: string | null;
    costCode: CostCodeBasic | null;
    reportedById: string | null;
    reportedBy: { id: string; name: string | null; email: string } | null;
    createdAt: string;
};

interface ExpensesTabClientProps {
    projectId: string;
    initialExpenses: ExpenseDetailed[];
    costCodes: CostCodeBasic[];
    teamMembers: UserBasic[];
    currentUser: { id: string; role: string; name: string };
}

// Icons
const ReceiptIcon = () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 14.25l6-6m4.5-3.493V21.75l-3.75-1.5-3.75 1.5-3.75-1.5-3.75 1.5V4.757c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0c1.1.128 1.907 1.077 1.907 2.185zM9.75 9h.008v.008H9.75V9zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 4.5h.008v.008h-.008V13.5zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
);
const PlusIcon = () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
);
const UploadIcon = () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
    </svg>
);
const SparkleIcon = () => (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
    </svg>
);

const PAYMENT_METHODS = ["Cash", "Credit Card", "Debit Card", "Check", "Company Card", "Bank Transfer", "Other"];

type SortKey = "date" | "vendor" | "amount" | "status" | "ref";
type SortDir = "asc" | "desc";

export default function ExpensesTabClient({
    projectId,
    initialExpenses,
    costCodes,
    teamMembers,
    currentUser,
}: ExpensesTabClientProps) {
    const router = useRouter();
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Sort & filter
    const [sortKey, setSortKey] = useState<SortKey>("date");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [filterUser, setFilterUser] = useState("");
    const [filterStatus, setFilterStatus] = useState("");

    // Modal
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isParsingReceipt, setIsParsingReceipt] = useState(false);

    // Form fields
    const [amount, setAmount] = useState("");
    const [vendor, setVendor] = useState("");
    const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
    const [description, setDescription] = useState("");
    const [receiptUrl, setReceiptUrl] = useState("");
    const [quantity, setQuantity] = useState("1");
    const [paymentMethod, setPaymentMethod] = useState("");
    const [isBillable, setIsBillable] = useState(true);
    const [isTaxable, setIsTaxable] = useState(true);
    const [service, setService] = useState("");
    const [syncToQB, setSyncToQB] = useState(false);
    const [reportedById, setReportedById] = useState(currentUser.id);
    const [costCodeId, setCostCodeId] = useState("");

    const isAdminOrManager = currentUser.role === "ADMIN" || currentUser.role === "MANAGER";

    const handleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
        else { setSortKey(key); setSortDir("asc"); }
    };

    const sortedExpenses = useMemo(() => {
        let filtered = [...initialExpenses];
        if (filterUser) filtered = filtered.filter(e => e.reportedById === filterUser);
        if (filterStatus) filtered = filtered.filter(e => e.status === filterStatus);

        return filtered.sort((a, b) => {
            let cmp = 0;
            switch (sortKey) {
                case "date":
                    cmp = new Date(a.date || a.createdAt).getTime() - new Date(b.date || b.createdAt).getTime();
                    break;
                case "vendor":
                    cmp = (a.vendor || "").localeCompare(b.vendor || "");
                    break;
                case "amount":
                    cmp = a.amount - b.amount;
                    break;
                case "status":
                    cmp = a.status.localeCompare(b.status);
                    break;
                case "ref":
                    cmp = (a.referenceNumber || "").localeCompare(b.referenceNumber || "");
                    break;
            }
            return sortDir === "asc" ? cmp : -cmp;
        });
    }, [initialExpenses, sortKey, sortDir, filterUser, filterStatus]);

    // Totals
    const totalAmount = useMemo(() => sortedExpenses.reduce((s, e) => s + e.amount, 0), [sortedExpenses]);
    const totalBillable = useMemo(() => sortedExpenses.filter(e => e.isBillable).reduce((s, e) => s + e.amount, 0), [sortedExpenses]);
    const totalNonBillable = useMemo(() => sortedExpenses.filter(e => !e.isBillable).reduce((s, e) => s + e.amount, 0), [sortedExpenses]);
    const totalInvoiced = useMemo(() => sortedExpenses.filter(e => e.status === "Approved").reduce((s, e) => s + e.amount, 0), [sortedExpenses]);

    const resetForm = () => {
        setEditId(null);
        setAmount("");
        setVendor("");
        setDate(new Date().toISOString().split("T")[0]);
        setDescription("");
        setReceiptUrl("");
        setQuantity("1");
        setPaymentMethod("");
        setIsBillable(true);
        setIsTaxable(true);
        setService("");
        setSyncToQB(false);
        setReportedById(currentUser.id);
        setCostCodeId("");
    };

    const openModal = (expense?: ExpenseDetailed) => {
        if (expense) {
            setEditId(expense.id);
            setAmount(expense.amount.toString());
            setVendor(expense.vendor || "");
            setDate(expense.date ? new Date(expense.date).toISOString().split("T")[0] : "");
            setDescription(expense.description || "");
            setReceiptUrl(expense.receiptUrl || "");
            setQuantity(expense.quantity.toString());
            setPaymentMethod(expense.paymentMethod || "");
            setIsBillable(expense.isBillable);
            setIsTaxable(expense.isTaxable);
            setService(expense.service || "");
            setSyncToQB(expense.syncToQB);
            setReportedById(expense.reportedById || currentUser.id);
            setCostCodeId(expense.costCodeId || "");
        } else {
            resetForm();
        }
        setIsModalOpen(true);
    };

    const closeModal = () => { setIsModalOpen(false); resetForm(); };

    // Receipt upload + AI OCR
    const handleReceiptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsParsingReceipt(true);
        setIsModalOpen(true);

        const formData = new FormData();
        formData.append("receipt", file);

        try {
            const res = await fetch("/api/expenses/parse", { method: "POST", body: formData });
            if (!res.ok) throw new Error("Failed to parse receipt");

            const data = await res.json();
            if (data.receiptUrl) setReceiptUrl(data.receiptUrl);

            if (data.parsedData) {
                if (data.parsedData.amount) setAmount(data.parsedData.amount.toString());
                if (data.parsedData.vendor) setVendor(data.parsedData.vendor);
                if (data.parsedData.date) setDate(data.parsedData.date);
                if (data.parsedData.description) setDescription(data.parsedData.description);
                toast.success("AI extracted receipt details — review and save");
            }
        } catch (err: any) {
            toast.error(err.message || "Failed to parse receipt");
        } finally {
            setIsParsingReceipt(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const handleSubmit = async (e: React.FormEvent, logAnother = false) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const payload = {
                projectId,
                amount: parseFloat(amount) || 0,
                vendor: vendor.trim() || undefined,
                date: date || undefined,
                description: description.trim() || undefined,
                receiptUrl: receiptUrl || undefined,
                quantity: parseInt(quantity) || 1,
                paymentMethod: paymentMethod || undefined,
                isBillable,
                isTaxable,
                service: service.trim() || undefined,
                syncToQB,
                reportedById,
                costCodeId: costCodeId || undefined,
            };

            if (editId) {
                await updateExpense(editId, payload);
                toast.success("Expense updated");
            } else {
                await createExpense(payload);
                toast.success("Expense added");
            }

            router.refresh();
            if (logAnother) {
                resetForm();
                toast.success("Saved — log another expense");
            } else {
                closeModal();
            }
        } catch (err: any) {
            toast.error(err.message || "Something went wrong");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm("Delete this expense?")) return;
        try {
            await deleteExpense(id);
            toast.success("Expense deleted");
            router.refresh();
        } catch (err: any) {
            toast.error(err.message || "Failed to delete");
        }
    };

    const handleApprove = async (id: string) => {
        try {
            await approveExpense(id);
            toast.success("Expense approved");
            router.refresh();
        } catch (err: any) {
            toast.error(err.message || "Failed to approve");
        }
    };

    const ThSortable = ({ label, sortK, className = "" }: { label: string; sortK: SortKey; className?: string }) => (
        <th
            className={`px-5 py-3.5 font-semibold cursor-pointer select-none hover:text-hui-primary transition group ${className}`}
            onClick={() => handleSort(sortK)}
        >
            <span className="inline-flex items-center gap-1">
                {label}
                <span className={`transition ${sortKey === sortK ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`}>
                    {sortKey === sortK && sortDir === "asc" ? "↑" : "↓"}
                </span>
            </span>
        </th>
    );

    const ToggleSwitch = ({ value, onChange, activeColor }: { value: boolean; onChange: () => void; activeColor: string }) => (
        <button
            type="button"
            onClick={onChange}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? activeColor : "bg-slate-300"}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${value ? "translate-x-6" : "translate-x-1"}`} />
        </button>
    );

    return (
        <div>
            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Billable</p>
                        <p className="text-xl font-bold text-emerald-600">${totalBillable.toFixed(2)}</p>
                    </div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600">
                        <ReceiptIcon />
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Invoiced</p>
                        <p className="text-xl font-bold text-blue-600">${totalInvoiced.toFixed(2)}</p>
                    </div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center text-amber-600">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Total Cost</p>
                        <p className="text-xl font-bold text-hui-textMain">${totalAmount.toFixed(2)}</p>
                    </div>
                </div>
                <div className="bg-white rounded-xl p-4 border border-hui-border shadow-sm flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" /></svg>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-hui-textMuted uppercase tracking-wider">Non-Billable</p>
                        <p className="text-xl font-bold text-slate-500">${totalNonBillable.toFixed(2)}</p>
                    </div>
                </div>
            </div>

            {/* Actions Row */}
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <select className="hui-input text-sm py-1.5 px-3 rounded-lg min-w-[160px]" value={filterUser} onChange={e => setFilterUser(e.target.value)}>
                    <option value="">All Team Members</option>
                    {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                </select>
                <select className="hui-input text-sm py-1.5 px-3 rounded-lg min-w-[140px]" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                    <option value="">All Statuses</option>
                    <option value="Pending">Pending</option>
                    <option value="Reviewed">Reviewed</option>
                    <option value="Approved">Approved</option>
                </select>
                <div className="flex-1" />
                {/* Upload receipt with AI */}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,.pdf"
                    className="hidden"
                    onChange={handleReceiptUpload}
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-purple-200 text-purple-700 bg-purple-50 hover:bg-purple-100 transition"
                >
                    <SparkleIcon />
                    Upload Receipt (AI)
                </button>
                <button
                    onClick={() => openModal()}
                    className="hui-btn-primary px-5 py-2.5 flex items-center gap-2 rounded-lg shadow-md hover:shadow-lg transition-all"
                >
                    <PlusIcon />
                    Add Expense
                </button>
            </div>

            {/* Table */}
            <div className="bg-white rounded-xl shadow-sm border border-hui-border overflow-hidden">
                <table className="w-full text-left text-sm text-hui-textMain">
                    <thead className="bg-slate-50 border-b border-hui-border text-[11px] uppercase text-hui-textMuted tracking-wider">
                        <tr>
                            <ThSortable label="Ref #" sortK="ref" />
                            <ThSortable label="Date" sortK="date" />
                            <ThSortable label="Vendor" sortK="vendor" />
                            <th className="px-5 py-3.5 font-semibold">Description</th>
                            <th className="px-5 py-3.5 font-semibold text-center">Qty</th>
                            <ThSortable label="Amount" sortK="amount" className="text-right" />
                            <th className="px-5 py-3.5 font-semibold text-center">Billable</th>
                            <ThSortable label="Status" sortK="status" className="text-center" />
                            <th className="px-5 py-3.5 font-semibold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {sortedExpenses.length === 0 ? (
                            <tr>
                                <td colSpan={9} className="px-6 py-12 text-center">
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300">
                                            <ReceiptIcon />
                                        </div>
                                        <p className="text-hui-textLight font-medium">No expenses found</p>
                                        <p className="text-xs text-slate-400">Upload a receipt or click &ldquo;Add Expense&rdquo; to get started</p>
                                    </div>
                                </td>
                            </tr>
                        ) : (
                            sortedExpenses.map((exp) => (
                                <tr key={exp.id} className="hover:bg-slate-50/80 transition group">
                                    <td className="px-5 py-3.5 whitespace-nowrap">
                                        <span className="text-xs font-mono text-slate-500">{exp.referenceNumber || "—"}</span>
                                    </td>
                                    <td className="px-5 py-3.5 whitespace-nowrap font-medium">
                                        {exp.date ? new Date(exp.date).toLocaleDateString() : "—"}
                                    </td>
                                    <td className="px-5 py-3.5">
                                        <div className="flex items-center gap-2">
                                            {exp.receiptUrl && (
                                                <span className="w-6 h-6 rounded bg-purple-50 flex items-center justify-center text-purple-500" title="Has receipt">
                                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
                                                </span>
                                            )}
                                            <span className="font-medium">{exp.vendor || "Unknown vendor"}</span>
                                        </div>
                                    </td>
                                    <td className="px-5 py-3.5 text-slate-600 max-w-[200px] truncate">{exp.description || "—"}</td>
                                    <td className="px-5 py-3.5 text-center tabular-nums">{exp.quantity}</td>
                                    <td className="px-5 py-3.5 text-right font-semibold tabular-nums">${exp.amount.toFixed(2)}</td>
                                    <td className="px-5 py-3.5 text-center">
                                        <div className="flex flex-wrap items-center justify-center gap-1">
                                            {exp.isBillable ? (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-100">Billable</span>
                                            ) : (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">Non-billable</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-5 py-3.5 text-center">
                                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                                            exp.status === "Approved"
                                                ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                                : exp.status === "Reviewed"
                                                ? "bg-blue-50 text-blue-700 border-blue-100"
                                                : "bg-amber-50 text-amber-700 border-amber-100"
                                        }`}>
                                            {exp.status}
                                        </span>
                                    </td>
                                    <td className="px-5 py-3.5 text-right">
                                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition">
                                            {isAdminOrManager && exp.status === "Pending" && (
                                                <button
                                                    onClick={() => handleApprove(exp.id)}
                                                    className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 transition"
                                                    title="Approve"
                                                >
                                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                                                </button>
                                            )}
                                            <button
                                                onClick={() => openModal(exp)}
                                                className="p-1.5 rounded-lg text-slate-400 hover:text-hui-primary hover:bg-blue-50 transition"
                                                title="Edit"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>
                                            </button>
                                            <button
                                                onClick={() => handleDelete(exp.id)}
                                                className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition"
                                                title="Delete"
                                            >
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                    {sortedExpenses.length > 0 && (
                        <tfoot className="bg-slate-50 border-t border-hui-border">
                            <tr className="text-sm font-bold text-hui-textMain">
                                <td className="px-5 py-3" colSpan={5}>Totals</td>
                                <td className="px-5 py-3 text-right tabular-nums">${totalAmount.toFixed(2)}</td>
                                <td></td>
                                <td></td>
                                <td></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            {/* New/Edit Expense Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
                        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3 shrink-0">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white">
                                <ReceiptIcon />
                            </div>
                            <div className="flex-1">
                                <h3 className="text-base font-bold text-hui-textMain">
                                    {editId ? "Edit Expense" : "New Expense"}
                                </h3>
                                {isParsingReceipt && (
                                    <p className="text-xs text-purple-600 flex items-center gap-1">
                                        <SparkleIcon /> AI is reading your receipt...
                                    </p>
                                )}
                            </div>
                            <button onClick={closeModal} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto flex-1">
                            {/* Receipt upload area */}
                            {!editId && !receiptUrl && (
                                <div
                                    onClick={() => fileInputRef.current?.click()}
                                    className="border-2 border-dashed border-purple-200 rounded-xl p-6 text-center cursor-pointer hover:border-purple-400 hover:bg-purple-50/50 transition group"
                                >
                                    <div className="flex flex-col items-center gap-2">
                                        <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center text-purple-500 group-hover:scale-110 transition">
                                            <UploadIcon />
                                        </div>
                                        <p className="text-sm font-medium text-purple-700">Upload Receipt</p>
                                        <p className="text-xs text-slate-400">
                                            <span className="inline-flex items-center gap-1"><SparkleIcon /> AI AutoMate will fill in the details</span>
                                        </p>
                                    </div>
                                </div>
                            )}

                            {receiptUrl && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-50 border border-purple-100 text-sm">
                                    <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
                                    <span className="text-purple-700 flex-1 truncate">Receipt attached</span>
                                    <button type="button" onClick={() => setReceiptUrl("")} className="text-purple-400 hover:text-purple-600">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                            )}

                            {/* Reported By */}
                            {isAdminOrManager && (
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Reported By</label>
                                    <select className="hui-input w-full" value={reportedById} onChange={e => setReportedById(e.target.value)}>
                                        {teamMembers.map(m => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
                                    </select>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Vendor</label>
                                    <input type="text" className="hui-input w-full" value={vendor} onChange={e => setVendor(e.target.value)} placeholder="e.g. Home Depot" />
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Date</label>
                                    <input type="date" className="hui-input w-full" value={date} onChange={e => setDate(e.target.value)} />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Service / Category</label>
                                <input type="text" className="hui-input w-full" value={service} onChange={e => setService(e.target.value)} placeholder="e.g. Materials, Equipment Rental" />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Cost ($)</label>
                                    <input type="number" step="0.01" min="0" className="hui-input w-full" value={amount} onChange={e => setAmount(e.target.value)} required placeholder="0.00" />
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Quantity</label>
                                    <input type="number" min="1" className="hui-input w-full" value={quantity} onChange={e => setQuantity(e.target.value)} />
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Payment Method</label>
                                    <select className="hui-input w-full" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                                        <option value="">— Select —</option>
                                        {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Cost Code</label>
                                    <select className="hui-input w-full" value={costCodeId} onChange={e => setCostCodeId(e.target.value)}>
                                        <option value="">— Unassigned —</option>
                                        {costCodes.map(cc => <option key={cc.id} value={cc.id}>{cc.code} - {cc.name}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-semibold text-hui-textMain mb-1.5">Description</label>
                                <textarea className="hui-input w-full" rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="What was purchased..." />
                            </div>

                            {/* Toggles */}
                            <div className="space-y-3 pt-1">
                                <div className="flex items-center justify-between py-1">
                                    <div>
                                        <label className="text-sm font-semibold text-hui-textMain">Billable</label>
                                        <p className="text-xs text-slate-400">Include in client invoicing</p>
                                    </div>
                                    <ToggleSwitch value={isBillable} onChange={() => setIsBillable(!isBillable)} activeColor="bg-emerald-500" />
                                </div>
                                <div className="flex items-center justify-between py-1">
                                    <div>
                                        <label className="text-sm font-semibold text-hui-textMain">Taxable</label>
                                        <p className="text-xs text-slate-400">Subject to sales tax</p>
                                    </div>
                                    <ToggleSwitch value={isTaxable} onChange={() => setIsTaxable(!isTaxable)} activeColor="bg-blue-500" />
                                </div>
                                <div className="flex items-center justify-between py-1">
                                    <div>
                                        <label className="text-sm font-semibold text-hui-textMain">Sync to QuickBooks</label>
                                        <p className="text-xs text-slate-400">Push this expense to QB</p>
                                    </div>
                                    <ToggleSwitch value={syncToQB} onChange={() => setSyncToQB(!syncToQB)} activeColor="bg-indigo-500" />
                                </div>
                            </div>

                            <div className="pt-4 flex gap-3 justify-end">
                                <button type="button" onClick={closeModal} className="hui-btn-secondary px-4 py-2 rounded-lg" disabled={isSubmitting}>Cancel</button>
                                {!editId && (
                                    <button
                                        type="button"
                                        onClick={(e) => handleSubmit(e as any, true)}
                                        className="px-4 py-2 rounded-lg text-sm font-medium border border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition"
                                        disabled={isSubmitting || isParsingReceipt}
                                    >
                                        {isSubmitting ? "Saving..." : "Save & Log Another"}
                                    </button>
                                )}
                                <button type="submit" className="hui-btn-primary px-5 py-2 rounded-lg" disabled={isSubmitting || isParsingReceipt}>
                                    {isSubmitting ? "Saving..." : isParsingReceipt ? "Parsing..." : "Save Expense"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
