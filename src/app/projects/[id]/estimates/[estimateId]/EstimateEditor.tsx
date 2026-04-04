"use client";

import { useState, useEffect, useRef } from "react";
import { saveEstimate, createInvoiceFromEstimate, deleteEstimate, duplicateEstimate, saveEstimateAsTemplate, archiveEstimate, logEstimatePayment } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import ExpensesTab from "./ExpensesTab";
import SendEstimateModal from "@/components/SendEstimateModal";
import SelectVendorModal from "./SelectVendorModal";
import { toast } from "sonner";
import { getStatusColor } from "@/components/EstimateStatusDropdown";

// ─── Types ──────────────────────────────────────────────────────
interface EstimateItem {
    id: string;
    name: string;
    description: string;
    isSection: boolean;
    type: string;
    quantity: number;
    baseCost: number;
    markupPercent: number;
    unitCost: number;
    total: number;
    parentId: string | null;
    costCodeId: string | null;
    costTypeId: string | null;
}

interface PaymentSchedule {
    id: string;
    name: string;
    percentage: string;
    amount: number;
    dueDate: string;
    status: string;
    paidAt: string | null;
    paidAmount: number | null;
}

interface EditorContext {
    type: "project" | "lead";
    id: string;
    name: string;
    clientName: string;
    clientEmail?: string;
    location?: string;
}

const ITEM_TYPES = ["Material", "Labor", "Material & Labor", "Service"];

const DOCUMENT_SECTIONS = [
    { id: "items", label: "Items", icon: "list" },
    { id: "payments", label: "Payments", icon: "dollar" },
    { id: "files", label: "Files", icon: "paperclip" },
    { id: "terms", label: "Terms & Conditions", icon: "document" },
    { id: "memo", label: "Memo", icon: "pencil" },
    { id: "activity", label: "Activity", icon: "clock" },
];

// ─── Main Component ─────────────────────────────────────────────
export default function EstimateEditor({ context, initialEstimate }: { context: EditorContext, initialEstimate: any }) {
    const router = useRouter();
    const [title, setTitle] = useState(initialEstimate.title);
    const [code, setCode] = useState(initialEstimate.code);
    const [status, setStatus] = useState(initialEstimate.status);
    const [items, setItems] = useState<EstimateItem[]>(() =>
        (initialEstimate.items || []).map((i: any) => ({ ...i, isSection: !!i.isSection }))
    );
    const [paymentSchedules, setPaymentSchedules] = useState<PaymentSchedule[]>(initialEstimate.paymentSchedules || []);
    const [isSaving, setIsSaving] = useState(false);
    const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [showSendModal, setShowSendModal] = useState(false);
    const [costCodes, setCostCodes] = useState<any[]>([]);
    const [costTypes, setCostTypes] = useState<any[]>([]);
    const [showAiModal, setShowAiModal] = useState(false);
    const [aiPrompt, setAiPrompt] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [showMoreMenu, setShowMoreMenu] = useState(false);
    const [viewMode, setViewMode] = useState<"internal" | "client">("client");
    const [showTemplateModal, setShowTemplateModal] = useState(false);
    const [templateName, setTemplateName] = useState("");
    const [isSavingTemplate, setIsSavingTemplate] = useState(false);
    const [isDuplicating, setIsDuplicating] = useState(false);
    const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
    const [isCreatingCO, setIsCreatingCO] = useState(false);
    const [showVendorSelectModal, setShowVendorSelectModal] = useState(false);
    const [isCreatingPO, setIsCreatingPO] = useState(false);
    const [isSyncingQB, setIsSyncingQB] = useState(false);

    // New A1 state
    const [expirationDate, setExpirationDate] = useState(initialEstimate.expirationDate ? new Date(initialEstimate.expirationDate).toISOString().split('T')[0] : "");
    const [memo, setMemo] = useState(initialEstimate.memo || "");
    const [processingFeePercent, setProcessingFeePercent] = useState(initialEstimate.processingFeePercent?.toString() || "");
    const [showProcessingFee, setShowProcessingFee] = useState(initialEstimate.showProcessingFee || false);
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
    const [activeDocSection, setActiveDocSection] = useState("items");
    const [sidebarTab, setSidebarTab] = useState<"overview" | "activity">("overview");
    const [showLogPaymentModal, setShowLogPaymentModal] = useState<string | null>(null);
    const [logPaymentAmount, setLogPaymentAmount] = useState("");
    const [logPaymentDate, setLogPaymentDate] = useState(new Date().toISOString().split('T')[0]);
    const [termsText, setTermsText] = useState(initialEstimate.termsAndConditions || "");

    const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

    useEffect(() => {
        fetch('/api/cost-codes?active=true')
            .then(res => res.json())
            .then(data => { if (Array.isArray(data)) setCostCodes(data); })
            .catch(() => {});
        fetch('/api/cost-types?active=true')
            .then(res => res.json())
            .then(data => { if (Array.isArray(data)) setCostTypes(data); })
            .catch(() => {});
    }, []);

    // ─── Calculations ────────────────────────────────────────────
    const lineItems = items.filter(i => !i.isSection);
    const subtotal = lineItems.reduce((acc, item) => acc + ((parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.unitCost)) || 0)), 0);
    const markupTotal = subtotal - lineItems.reduce((acc, item) => acc + ((parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.baseCost)) || 0)), 0);
    const processingFee = showProcessingFee && processingFeePercent ? subtotal * (parseFloat(processingFeePercent) / 100) : 0;
    const taxableAmount = subtotal + processingFee;
    const tax = taxableAmount * 0.087;
    const total = taxableAmount + tax;

    // Internal margin
    const totalBaseCost = lineItems.reduce((acc, item) => acc + ((parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.baseCost)) || 0)), 0);
    const profitMargin = subtotal > 0 ? ((markupTotal / subtotal) * 100) : 0;

    // Payment totals
    const totalPaid = paymentSchedules
        .filter(s => s.status === "Paid")
        .reduce((acc, s) => acc + (parseFloat(String(s.paidAmount || s.amount)) || 0), 0);
    const totalScheduled = paymentSchedules.reduce((acc, s) => acc + (parseFloat(String(s.amount)) || 0), 0);

    // ─── Handlers ────────────────────────────────────────────────
    async function handleSave() {
        setIsSaving(true);
        const mappedItems = items.map((item, index) => ({
            ...item,
            order: index,
            total: item.isSection ? 0 : (parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.unitCost)) || 0)
        }));
        const mappedSchedules = paymentSchedules.map((schedule, index) => ({
            ...schedule,
            order: index
        }));

        await saveEstimate(initialEstimate.id, context.id, context.type, {
            title, code, status, totalAmount: total,
            paymentSchedules: mappedSchedules,
            expirationDate: expirationDate || null,
            memo: memo || null,
            termsAndConditions: termsText || null,
            processingFeePercent: processingFeePercent || null,
            showProcessingFee,
        }, mappedItems);
        setIsSaving(false);
        toast.success("Estimate saved");
        router.refresh();
    }

    async function handleCreateInvoice() {
        setIsCreatingInvoice(true);
        try {
            await handleSave();
            const res = await createInvoiceFromEstimate(initialEstimate.id);
            if (res.id) {
                toast.success("Invoice drafted from estimate");
                router.push(`/projects/${context.id}/invoices/${res.id}`);
            }
        } catch (e: any) {
            toast.error(e.message || "Failed to create invoice");
        } finally {
            setIsCreatingInvoice(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Delete this estimate? This cannot be undone.")) return;
        setIsDeleting(true);
        try {
            await deleteEstimate(initialEstimate.id);
            toast.success("Estimate deleted");
            router.push(context.type === "project" ? `/projects/${context.id}/estimates` : `/leads/${context.id}`);
        } catch {
            toast.error("Failed to delete");
        } finally {
            setIsDeleting(false);
        }
    }

    async function handleDuplicate() {
        setIsDuplicating(true);
        try {
            await handleSave();
            const res = await duplicateEstimate(initialEstimate.id);
            toast.success("Estimate duplicated");
            if (res.projectId) router.push(`/projects/${res.projectId}/estimates/${res.id}`);
        } catch (e: any) {
            toast.error(e.message || "Failed to duplicate");
        } finally {
            setIsDuplicating(false);
        }
    }

    async function handleSaveAsTemplate() {
        if (!templateName.trim()) { toast.error("Enter a template name"); return; }
        setIsSavingTemplate(true);
        try {
            await handleSave();
            await saveEstimateAsTemplate(initialEstimate.id, templateName.trim());
            toast.success("Template saved");
            setShowTemplateModal(false);
            setTemplateName("");
        } catch (e: any) {
            toast.error(e.message || "Failed to save template");
        } finally {
            setIsSavingTemplate(false);
        }
    }

    async function handleArchive() {
        try {
            const res = await archiveEstimate(initialEstimate.id);
            toast.success(res.isArchived ? "Estimate archived" : "Estimate restored");
            setShowMoreMenu(false);
            router.refresh();
        } catch {
            toast.error("Failed to archive");
        }
    }

    async function handleCreateChangeOrder() {
        if (selectedItemIds.length === 0) return;
        setIsCreatingCO(true);
        try {
            await handleSave();
            const { createChangeOrder } = await import("@/lib/actions");
            const res = await createChangeOrder(context.id, initialEstimate.id, selectedItemIds);
            toast.success("Change Order drafted!");
            router.push(`/projects/${context.id}/change-orders/${res.id}`);
        } catch (e: any) {
            toast.error(e.message || "Failed to create Change Order");
        } finally {
            setIsCreatingCO(false);
        }
    }

    async function handleCreatePurchaseOrder(vendorId: string) {
        if (selectedItemIds.length === 0) return;
        setIsCreatingPO(true);
        setShowVendorSelectModal(false);
        try {
            await handleSave();
            const { createPurchaseOrderFromEstimate } = await import("@/lib/actions");
            const res = await createPurchaseOrderFromEstimate(context.id, initialEstimate.id, selectedItemIds, vendorId);
            toast.success("Purchase Order drafted!");
            router.push(`/projects/${context.id}/purchase-orders/${res.id}`);
        } catch (e: any) {
            toast.error(e.message || "Failed to create Purchase Order");
        } finally {
            setIsCreatingPO(false);
        }
    }

    async function handleSyncQB() {
        setIsSyncingQB(true);
        setShowMoreMenu(false);
        try {
            const res = await fetch("/api/quickbooks/sync", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "estimate", id: initialEstimate.id }),
            });
            const data = await res.json();
            if (data.notConnected) { toast.error("QuickBooks not connected — go to Settings → Integrations."); return; }
            if (!res.ok) throw new Error(data.error || "Sync failed");
            toast.success("Synced to QuickBooks!", {
                action: data.qbUrl ? { label: "View in QB", onClick: () => window.open(data.qbUrl, "_blank") } : undefined,
            });
        } catch (e: any) {
            toast.error(e.message || "Failed to sync");
        } finally {
            setIsSyncingQB(false);
        }
    }

    async function handleLogPayment(scheduleId: string) {
        const amount = parseFloat(logPaymentAmount);
        if (!amount || amount <= 0) { toast.error("Enter a valid amount"); return; }
        try {
            await logEstimatePayment(scheduleId, amount, logPaymentDate);
            toast.success("Payment logged");
            setShowLogPaymentModal(null);
            setLogPaymentAmount("");
            // Update local state
            setPaymentSchedules(prev => prev.map(s =>
                s.id === scheduleId ? { ...s, status: "Paid", paidAmount: amount, paidAt: logPaymentDate } : s
            ));
            router.refresh();
        } catch {
            toast.error("Failed to log payment");
        }
    }

    async function handleAiGenerate() {
        setIsGenerating(true);
        try {
            const res = await fetch('/api/ai-estimate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectName: context.name,
                    projectType: title || context.name,
                    description: aiPrompt,
                    location: context.location || 'Vancouver, WA',
                    costCodes,
                    costTypes,
                }),
            });
            if (!res.ok) { const data = await res.json(); toast.error(data.error || 'AI generation failed'); return; }
            const data = await res.json();
            if (data.items && data.items.length > 0) {
                const newItems = [...items, ...data.items];
                const newSchedules = data.paymentMilestones?.length > 0 ? [...paymentSchedules, ...data.paymentMilestones] : paymentSchedules;
                setItems(newItems);
                if (data.paymentMilestones?.length > 0) setPaymentSchedules(newSchedules);
                toast.success(`AI generated ${data.count} items (est. $${data.totalEstimate?.toLocaleString()})`);
                setShowAiModal(false);
                setAiPrompt("");

                // Auto-save
                const mappedItems = newItems.map((item, index) => ({ ...item, order: index, total: (parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.unitCost)) || 0) }));
                const mappedSchedules = newSchedules.map((schedule, index) => ({ ...schedule, order: index }));
                const newSubtotal = newItems.reduce((acc, item) => acc + ((parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.unitCost)) || 0)), 0);
                const newTotal = newSubtotal + newSubtotal * 0.087;
                await saveEstimate(initialEstimate.id, context.id, context.type, {
                    title, code, status, totalAmount: newTotal, paymentSchedules: mappedSchedules,
                    expirationDate: expirationDate || null, memo: memo || null,
                    termsAndConditions: termsText || null,
                    processingFeePercent: processingFeePercent || null, showProcessingFee,
                }, mappedItems);
                router.refresh();
            } else {
                toast.error('AI returned no items');
            }
        } catch (err: any) {
            toast.error(err?.message || 'Failed to generate estimate');
        } finally {
            setIsGenerating(false);
        }
    }

    // ─── Item CRUD ───────────────────────────────────────────────
    function generateId() { return Math.random().toString(36).substr(2, 9); }

    function addItem(parentId: string | null = null) {
        setItems([...items, {
            id: generateId(), name: "", description: "", isSection: false,
            type: "Material", quantity: 1, baseCost: 0, markupPercent: 25,
            unitCost: 0, total: 0, parentId, costCodeId: null, costTypeId: null
        }]);
    }

    function addSection() {
        setItems([...items, {
            id: generateId(), name: "", description: "", isSection: true,
            type: "Material", quantity: 0, baseCost: 0, markupPercent: 0,
            unitCost: 0, total: 0, parentId: null, costCodeId: null, costTypeId: null
        }]);
    }

    function updateItem(index: number, field: string, value: any) {
        const newItems = [...items];
        newItems[index] = { ...newItems[index], [field]: value };
        setItems(newItems);
    }

    function removeItem(index: number) {
        const itemToRemove = items[index];
        setItems(items.filter((item, i) => i !== index && item.parentId !== itemToRemove.id));
    }

    function toggleSectionCollapse(sectionId: string) {
        setCollapsedSections(prev => {
            const next = new Set(prev);
            if (next.has(sectionId)) next.delete(sectionId); else next.add(sectionId);
            return next;
        });
    }

    // ─── Payment CRUD ────────────────────────────────────────────
    function addPaymentSchedule() {
        setPaymentSchedules([...paymentSchedules, {
            id: generateId(), name: "Progress Payment", percentage: "",
            amount: 0, dueDate: "", status: "Pending", paidAt: null, paidAmount: null
        }]);
    }

    function updatePaymentSchedule(index: number, field: string, value: any) {
        const newSchedules = [...paymentSchedules];
        if (field === "percentage") {
            const pct = parseFloat(value) || 0;
            newSchedules[index] = { ...newSchedules[index], percentage: value, amount: parseFloat((total * (pct / 100)).toFixed(2)) };
        } else {
            newSchedules[index] = { ...newSchedules[index], [field]: value };
        }
        setPaymentSchedules(newSchedules);
    }

    function removePaymentSchedule(index: number) {
        setPaymentSchedules(paymentSchedules.filter((_, i) => i !== index));
    }

    function onDragEnd(result: any) {
        if (!result.destination) return;
        const newItems = Array.from(items);
        const [reorderedItem] = newItems.splice(result.source.index, 1);
        newItems.splice(result.destination.index, 0, reorderedItem);
        setItems(newItems);
    }

    function scrollToSection(sectionId: string) {
        setActiveDocSection(sectionId);
        sectionRefs.current[sectionId]?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // ─── Render ──────────────────────────────────────────────────
    return (
        <div className="flex flex-col h-full bg-slate-50">
            {/* ═══ Top Action Bar ═══ */}
            <div className="bg-white border-b border-hui-border px-6 py-3 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-3">
                    <button onClick={() => router.push(context.type === "project" ? `/projects/${context.id}/estimates` : `/leads/${context.id}`)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                        {context.type === "project" ? "Estimates" : "Lead"}
                    </button>
                    <div className="h-4 w-px bg-hui-border" />
                    <span className="text-sm font-semibold text-hui-textMain">{code}</span>
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wider uppercase border ${getStatusColor(status)}`}>{status}</span>
                </div>

                <div className="flex items-center gap-2">
                    {/* View Toggle */}
                    <div className="flex items-center gap-0.5 bg-slate-100 p-0.5 rounded-md">
                        <button onClick={() => setViewMode("client")} className={`px-3 py-1 text-xs font-medium rounded transition ${viewMode === "client" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Client</button>
                        <button onClick={() => setViewMode("internal")} className={`px-3 py-1 text-xs font-medium rounded transition ${viewMode === "internal" ? "bg-amber-50 text-amber-800 shadow-sm border border-amber-200" : "text-slate-500 hover:text-slate-700"}`}>Internal</button>
                    </div>
                    <div className="h-4 w-px bg-hui-border" />

                    {/* More Menu */}
                    <div className="relative">
                        <button onClick={() => setShowMoreMenu(!showMoreMenu)} className="hui-btn hui-btn-secondary px-2.5" title="More actions">
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                        </button>
                        {showMoreMenu && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
                                <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg shadow-xl border border-hui-border z-50 py-1 text-sm">
                                    <MenuButton icon={<EyeIcon />} onClick={() => { window.open(`/portal/estimates/${initialEstimate.id}`, '_blank'); setShowMoreMenu(false); }}>Customer Portal</MenuButton>
                                    <MenuLink icon={<DocIcon />} href={`/api/pdf/${initialEstimate.id}?inline=true`} onClick={() => setShowMoreMenu(false)}>Preview PDF</MenuLink>
                                    <MenuLink icon={<DownloadIcon />} href={`/api/pdf/${initialEstimate.id}`} onClick={() => setShowMoreMenu(false)}>Download PDF</MenuLink>
                                    <div className="border-t border-hui-border my-1" />
                                    <MenuButton icon={<CopyIcon />} onClick={() => { handleDuplicate(); setShowMoreMenu(false); }} disabled={isDuplicating}>{isDuplicating ? "Duplicating..." : "Duplicate"}</MenuButton>
                                    <MenuButton icon={<BookmarkIcon />} onClick={() => { setShowTemplateModal(true); setShowMoreMenu(false); }}>Save as Template</MenuButton>
                                    {context.type === "project" && (
                                        <MenuButton icon={<InvoiceIcon />} onClick={() => { handleCreateInvoice(); setShowMoreMenu(false); }} disabled={isCreatingInvoice}>{isCreatingInvoice ? "Creating..." : "Create Invoice"}</MenuButton>
                                    )}
                                    {context.type === "project" && selectedItemIds.length > 0 && (
                                        <>
                                            <div className="border-t border-hui-border my-1" />
                                            <MenuButton icon={<ClipboardIcon />} onClick={() => { handleCreateChangeOrder(); setShowMoreMenu(false); }} disabled={isCreatingCO} className="text-amber-700 hover:bg-amber-50">
                                                {isCreatingCO ? "Creating..." : `Change Order (${selectedItemIds.length})`}
                                            </MenuButton>
                                            <MenuButton icon={<CartIcon />} onClick={() => { setShowVendorSelectModal(true); setShowMoreMenu(false); }} disabled={isCreatingPO} className="text-emerald-700 hover:bg-emerald-50">
                                                {isCreatingPO ? "Creating PO..." : `Purchase Order (${selectedItemIds.length})`}
                                            </MenuButton>
                                        </>
                                    )}
                                    <div className="border-t border-hui-border my-1" />
                                    <MenuButton icon={<span className="w-4 h-4 text-[11px] font-bold flex items-center justify-center">QB</span>} onClick={handleSyncQB} disabled={isSyncingQB} className="text-green-700 hover:bg-green-50">
                                        {isSyncingQB ? "Syncing..." : "Sync to QuickBooks"}
                                    </MenuButton>
                                    <div className="border-t border-hui-border my-1" />
                                    <MenuButton icon={<ArchiveIcon />} onClick={handleArchive} className="text-slate-600 hover:bg-slate-50">Archive</MenuButton>
                                    <MenuButton icon={<TrashIcon />} onClick={() => { handleDelete(); setShowMoreMenu(false); }} disabled={isDeleting} className="text-red-600 hover:bg-red-50">
                                        {isDeleting ? "Deleting..." : "Delete"}
                                    </MenuButton>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Primary Actions */}
                    <button onClick={() => setShowAiModal(true)} className="hui-btn hui-btn-secondary bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 flex items-center gap-2">
                        <SparkleIcon /> AI Generate
                    </button>
                    <button onClick={() => setShowSendModal(true)} className="hui-btn hui-btn-green flex items-center gap-2">
                        <SendIcon /> Send
                    </button>
                    <button onClick={handleSave} disabled={isSaving} className="hui-btn hui-btn-primary disabled:opacity-50">
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                </div>
            </div>

            {/* ═══ Main Content + Sidebar ═══ */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left: Document Content */}
                <div className="flex-1 overflow-y-auto p-8 pb-32">
                    <div className="max-w-4xl mx-auto space-y-6">
                        {/* ─── General Info Section ─── */}
                        <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            <div className="h-1.5 w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500" />
                            <div className="p-8 space-y-6">
                                <input
                                    type="text" value={title} onChange={e => setTitle(e.target.value)}
                                    className="text-3xl font-extrabold tracking-tight text-slate-800 w-full focus:outline-none focus:bg-slate-50 hover:bg-slate-50 transition-colors rounded-lg px-3 py-2 -ml-3 placeholder:text-slate-300 bg-transparent"
                                    placeholder="Estimate Title"
                                />
                                <div className="flex justify-between items-start gap-8 text-sm">
                                    <div className="space-y-1">
                                        <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Estimate To</p>
                                        <p className="font-semibold text-base text-slate-800">{context.clientName}</p>
                                        {context.clientEmail && <p className="text-slate-500">{context.clientEmail}</p>}
                                        {context.location && <p className="text-slate-500 pt-1">{context.location}</p>}
                                    </div>
                                    <div className="bg-slate-50 p-4 rounded-lg border border-slate-100 min-w-[280px]">
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                                            <label className="text-slate-500 font-medium">Estimate No.</label>
                                            <input type="text" value={code} onChange={e => setCode(e.target.value)} className="font-semibold text-slate-800 focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-0.5 text-right bg-transparent transition" />
                                            <label className="text-slate-500 font-medium">Date Issued</label>
                                            <span className="text-right font-medium text-slate-800 px-2 py-0.5">{new Date(initialEstimate.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                                            <label className="text-slate-500 font-medium">Expiration</label>
                                            <input type="date" value={expirationDate} onChange={e => setExpirationDate(e.target.value)} className="font-medium text-slate-800 focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-0.5 text-right bg-transparent transition" />
                                            {context.type === "project" && (
                                                <>
                                                    <label className="text-slate-500 font-medium">Project</label>
                                                    <span className="text-right font-medium text-slate-800 px-2 py-0.5 truncate">{context.name}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ─── Document Section Navigation ─── */}
                        <div className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 p-1 shadow-sm">
                            {DOCUMENT_SECTIONS.map(section => (
                                <button
                                    key={section.id}
                                    onClick={() => scrollToSection(section.id)}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${activeDocSection === section.id ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}`}
                                >
                                    {section.label}
                                </button>
                            ))}
                        </div>

                        {/* ─── Items Section ─── */}
                        <div ref={el => { sectionRefs.current["items"] = el; }} className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            {/* Column Headers */}
                            <div className="flex text-[11px] font-bold text-slate-400 bg-slate-50/80 border-b border-slate-100 px-6 py-3 uppercase tracking-wider">
                                <div className="w-8" />
                                <div className="w-8 pt-0.5">
                                    <input type="checkbox" checked={lineItems.length > 0 && selectedItemIds.length === lineItems.length} onChange={(e) => setSelectedItemIds(e.target.checked ? lineItems.map(i => i.id) : [])} className="rounded border-slate-300 text-amber-600 focus:ring-amber-500" />
                                </div>
                                <div className="flex-1">Item Description</div>
                                <div className="w-28">Type</div>
                                <div className="w-20 text-right">Qty</div>
                                {viewMode === "internal" && <div className="w-24 text-right text-amber-500">Base Cost</div>}
                                {viewMode === "internal" && <div className="w-16 text-right text-amber-500">Markup</div>}
                                <div className="w-28 text-right">{viewMode === "internal" ? "Sell Price" : "Unit Cost"}</div>
                                <div className="w-28 text-right">Total</div>
                                <div className="w-8" />
                            </div>

                            <DragDropContext onDragEnd={onDragEnd}>
                                <Droppable droppableId="items-list">
                                    {(provided) => (
                                        <div {...provided.droppableProps} ref={provided.innerRef} className="divide-y divide-slate-100">
                                            {items.map((item, index) => {
                                                // If item belongs to a collapsed section, hide it
                                                if (item.parentId && collapsedSections.has(item.parentId)) return null;

                                                if (item.isSection) {
                                                    const isCollapsed = collapsedSections.has(item.id);
                                                    const sectionItems = items.filter(i => i.parentId === item.id && !i.isSection);
                                                    const sectionTotal = sectionItems.reduce((acc, i) => acc + ((parseFloat(String(i.quantity)) || 0) * (parseFloat(String(i.unitCost)) || 0)), 0);

                                                    return (
                                                        <Draggable key={item.id} draggableId={item.id} index={index}>
                                                            {(provided, snapshot) => (
                                                                <div ref={provided.innerRef} {...provided.draggableProps}
                                                                    className={`flex items-center px-6 py-3 bg-slate-50 group border-l-4 border-indigo-400 ${snapshot.isDragging ? "shadow-lg z-50 ring-1 ring-indigo-300" : ""}`}>
                                                                    <div {...provided.dragHandleProps} className="w-8 flex items-center justify-center text-slate-300 hover:text-slate-500 cursor-grab opacity-0 group-hover:opacity-100">
                                                                        <DragIcon />
                                                                    </div>
                                                                    <button onClick={() => toggleSectionCollapse(item.id)} className="w-8 flex items-center justify-center text-slate-400 hover:text-slate-600">
                                                                        <svg className={`w-4 h-4 transition-transform ${isCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                                                                    </button>
                                                                    <div className="flex-1">
                                                                        <input
                                                                            type="text" value={item.name} onChange={e => updateItem(index, "name", e.target.value)}
                                                                            placeholder="Section name (e.g. Demolition, Framing, Electrical)"
                                                                            className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 -ml-2 transition text-sm font-bold text-slate-800 uppercase tracking-wide"
                                                                        />
                                                                    </div>
                                                                    <div className="w-28 text-right text-sm font-semibold text-slate-600 pr-2">
                                                                        ${fmt(sectionTotal)}
                                                                    </div>
                                                                    <div className="w-8 flex justify-end">
                                                                        <button onClick={() => removeItem(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1 transition opacity-0 group-hover:opacity-100">
                                                                            <XIcon />
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </Draggable>
                                                    );
                                                }

                                                // Regular item
                                                const itemTotal = (parseFloat(String(item.quantity)) || 0) * (parseFloat(String(item.unitCost)) || 0);
                                                const isSubItem = !!item.parentId;
                                                return (
                                                    <Draggable key={item.id} draggableId={item.id} index={index}>
                                                        {(provided, snapshot) => (
                                                            <div ref={provided.innerRef} {...provided.draggableProps}
                                                                className={`flex items-center px-6 py-2.5 bg-white group hover:bg-slate-50 transition border-l-2 ${snapshot.isDragging ? "shadow-lg border-hui-primary z-50 ring-1 ring-hui-primary/20" : isSubItem ? "border-transparent ml-6 bg-slate-50/30" : "border-transparent"}`}>
                                                                <div {...provided.dragHandleProps} className="w-8 flex items-center justify-center text-slate-300 hover:text-slate-500 cursor-grab opacity-0 group-hover:opacity-100">
                                                                    <DragIcon />
                                                                </div>
                                                                <div className="w-8">
                                                                    <input type="checkbox" checked={selectedItemIds.includes(item.id)}
                                                                        onChange={(e) => setSelectedItemIds(e.target.checked ? [...selectedItemIds, item.id] : selectedItemIds.filter(id => id !== item.id))}
                                                                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500" />
                                                                </div>
                                                                <div className="flex-1 flex flex-col">
                                                                    <input type="text" value={item.name} onChange={e => updateItem(index, "name", e.target.value)}
                                                                        placeholder="Item name"
                                                                        className={`w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 -ml-2 transition text-sm ${isSubItem ? 'text-hui-textMuted' : 'font-medium text-hui-textMain'}`} />
                                                                    <input type="text" value={item.description || ""} onChange={e => updateItem(index, "description", e.target.value)}
                                                                        placeholder="Description (optional)"
                                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-0.5 -ml-2 transition text-xs text-slate-400 mt-0.5" />
                                                                    {!isSubItem && (
                                                                        <button onClick={() => addItem(item.id)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium text-left w-fit mt-0.5 opacity-0 group-hover:opacity-100 transition">
                                                                            + Sub-item
                                                                        </button>
                                                                    )}
                                                                </div>
                                                                <div className="w-28 px-1">
                                                                    <select value={item.type} onChange={e => updateItem(index, "type", e.target.value)}
                                                                        className="bg-transparent focus:outline-none text-hui-textMuted w-full text-xs rounded px-1 py-0.5">
                                                                        {ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                                                    </select>
                                                                </div>
                                                                <div className="w-20 text-right">
                                                                    <input type="number" value={item.quantity} onChange={e => updateItem(index, "quantity", e.target.value)}
                                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-0.5 text-right text-sm font-medium text-slate-700" />
                                                                </div>
                                                                {viewMode === "internal" && (
                                                                    <div className="w-24 text-right relative">
                                                                        <span className="absolute left-1 top-0.5 text-amber-400 text-xs">$</span>
                                                                        <input type="number" value={item.baseCost ?? 0}
                                                                            onChange={e => {
                                                                                const bc = parseFloat(e.target.value) || 0;
                                                                                const mp = parseFloat(String(item.markupPercent)) || 0;
                                                                                updateItem(index, "baseCost", e.target.value);
                                                                                updateItem(index, "unitCost", (bc * (1 + mp / 100)).toFixed(2));
                                                                            }}
                                                                            className="w-full bg-amber-50/50 focus:outline-none focus:bg-white focus:ring-1 ring-amber-200 rounded px-2 py-0.5 pl-4 text-right text-sm font-medium text-amber-800" />
                                                                    </div>
                                                                )}
                                                                {viewMode === "internal" && (
                                                                    <div className="w-16 text-right relative">
                                                                        <input type="number" value={item.markupPercent ?? 25}
                                                                            onChange={e => {
                                                                                const mp = parseFloat(e.target.value) || 0;
                                                                                const bc = parseFloat(String(item.baseCost)) || 0;
                                                                                updateItem(index, "markupPercent", e.target.value);
                                                                                updateItem(index, "unitCost", (bc * (1 + mp / 100)).toFixed(2));
                                                                            }}
                                                                            className="w-full bg-amber-50/50 focus:outline-none focus:bg-white focus:ring-1 ring-amber-200 rounded px-1 py-0.5 text-right text-sm font-medium text-amber-800" />
                                                                        <span className="absolute right-1 top-0.5 text-amber-400 text-[10px]">%</span>
                                                                    </div>
                                                                )}
                                                                <div className="w-28 text-right relative">
                                                                    <span className="absolute left-1 top-0.5 text-slate-400 text-xs">$</span>
                                                                    <input type="number" value={item.unitCost} onChange={e => updateItem(index, "unitCost", e.target.value)}
                                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-0.5 pl-4 text-right text-sm font-medium text-slate-700"
                                                                        readOnly={viewMode === "internal"} />
                                                                </div>
                                                                <div className="w-28 text-right font-semibold text-slate-800 text-sm pr-1">
                                                                    ${fmt(itemTotal)}
                                                                </div>
                                                                <div className="w-8 flex justify-end">
                                                                    <button onClick={() => removeItem(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1 transition opacity-0 group-hover:opacity-100">
                                                                        <XIcon />
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                );
                                            })}
                                            {provided.placeholder}
                                        </div>
                                    )}
                                </Droppable>
                            </DragDropContext>

                            {/* Add Item / Section Buttons */}
                            <div className="p-3 px-6 border-t border-slate-100 bg-white flex items-center gap-3">
                                <button onClick={() => addItem(null)} className="text-sm font-semibold text-indigo-500 hover:text-indigo-600 flex items-center gap-1.5 transition">
                                    <span className="bg-indigo-50 text-indigo-500 rounded p-0.5"><PlusIcon /></span>
                                    Add Item
                                </button>
                                <div className="h-4 w-px bg-slate-200" />
                                <button onClick={addSection} className="text-sm font-semibold text-slate-500 hover:text-slate-700 flex items-center gap-1.5 transition">
                                    <span className="bg-slate-100 text-slate-500 rounded p-0.5"><FolderIcon /></span>
                                    Add Section
                                </button>
                            </div>

                            {/* ─── Summary Block ─── */}
                            <div className="bg-slate-50 p-8 border-t border-slate-200">
                                <div className="flex justify-end">
                                    <div className="w-80 space-y-3 text-sm">
                                        <div className="flex justify-between text-slate-500 font-medium">
                                            <span>Subtotal</span>
                                            <span className="text-slate-800">${fmt(subtotal)}</span>
                                        </div>
                                        {viewMode === "internal" && (
                                            <div className="flex justify-between text-amber-600 font-medium">
                                                <span>Markup</span>
                                                <span>${fmt(markupTotal)}</span>
                                            </div>
                                        )}
                                        {/* Processing Fee Toggle */}
                                        <div className="flex justify-between items-center text-slate-500 font-medium">
                                            <div className="flex items-center gap-2">
                                                <span>Processing Fee</span>
                                                <label className="relative inline-flex items-center cursor-pointer">
                                                    <input type="checkbox" checked={showProcessingFee} onChange={e => setShowProcessingFee(e.target.checked)} className="sr-only peer" />
                                                    <div className="w-7 h-4 bg-slate-200 peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-indigo-500" />
                                                </label>
                                                {showProcessingFee && (
                                                    <div className="relative">
                                                        <input type="number" value={processingFeePercent} onChange={e => setProcessingFeePercent(e.target.value)}
                                                            placeholder="3" className="w-14 bg-white border border-slate-200 rounded px-2 py-0.5 text-xs text-right" />
                                                        <span className="absolute right-1 top-0.5 text-slate-400 text-[10px]">%</span>
                                                    </div>
                                                )}
                                            </div>
                                            <span className="text-slate-800">{showProcessingFee ? `$${fmt(processingFee)}` : "—"}</span>
                                        </div>
                                        {showProcessingFee && (
                                            <p className="text-[10px] text-slate-400 italic">Hidden from client view</p>
                                        )}
                                        <div className="flex justify-between text-slate-500 font-medium">
                                            <span>Estimated Tax (8.7%)</span>
                                            <span className="text-slate-800">${fmt(tax)}</span>
                                        </div>
                                        <div className="h-px w-full bg-slate-200 my-2" />
                                        <div className="flex justify-between text-lg font-extrabold text-slate-900">
                                            <span>Total</span>
                                            <span className="text-indigo-600">${fmt(total)}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Internal Margin Summary */}
                            {viewMode === "internal" && (
                                <div className="bg-amber-50/60 border-t border-amber-200 px-8 py-3 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <LockIcon className="w-4 h-4 text-amber-600" />
                                        <span className="text-xs font-semibold text-amber-800 uppercase tracking-wider">Internal Margin</span>
                                    </div>
                                    <div className="flex items-center gap-6 text-sm">
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Base Cost</div>
                                            <div className="font-bold text-amber-900">${fmt(totalBaseCost)}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Markup</div>
                                            <div className="font-bold text-amber-900">${fmt(markupTotal)}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Margin</div>
                                            <div className="font-bold text-amber-900">{profitMargin.toFixed(1)}%</div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ─── Payment Schedule Section ─── */}
                        <div ref={el => { sectionRefs.current["payments"] = el; }} className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            <div className="flex items-center justify-between bg-slate-50/80 border-b border-slate-100 px-6 py-4">
                                <h3 className="font-bold text-slate-800 tracking-tight flex items-center gap-2">
                                    <DollarIcon className="w-4 h-4 text-slate-400" />
                                    Payment Schedule
                                </h3>
                                <button onClick={addPaymentSchedule} className="text-xs font-semibold text-indigo-500 hover:text-indigo-600 flex items-center gap-1 transition">
                                    <PlusIcon /> Add Milestone
                                </button>
                            </div>

                            {paymentSchedules.length === 0 ? (
                                <div className="p-8 text-center">
                                    <DollarIcon className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                                    <p className="text-sm text-slate-500 font-medium">No payment milestones</p>
                                    <p className="text-xs text-slate-400 mt-1">Add milestones to let clients pay in stages</p>
                                </div>
                            ) : (
                                <>
                                    <div className="flex text-[11px] font-bold text-slate-400 bg-white border-b border-slate-100 px-6 py-2.5 uppercase tracking-wider">
                                        <div className="flex-1">Milestone</div>
                                        <div className="w-20">%</div>
                                        <div className="w-28">Amount</div>
                                        <div className="w-32">Due Date</div>
                                        <div className="w-24">Status</div>
                                        <div className="w-20 text-right">Actions</div>
                                    </div>
                                    <div className="divide-y divide-slate-50">
                                        {paymentSchedules.map((schedule, index) => (
                                            <div key={schedule.id || index} className="flex items-center px-6 py-3 bg-white group hover:bg-slate-50/50 transition">
                                                <div className="flex-1">
                                                    <input type="text" value={schedule.name} onChange={e => updatePaymentSchedule(index, "name", e.target.value)}
                                                        placeholder="e.g. Initial Deposit"
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 -ml-2 text-sm font-semibold text-slate-800" />
                                                </div>
                                                <div className="w-20 px-1 relative">
                                                    <input type="number" value={schedule.percentage} onChange={e => updatePaymentSchedule(index, "percentage", e.target.value)}
                                                        placeholder="%" className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 pr-4 text-sm text-slate-600" />
                                                    <span className="absolute right-3 top-1.5 text-slate-400 text-[10px]">%</span>
                                                </div>
                                                <div className="w-28 px-1 relative">
                                                    <span className="absolute left-2 top-1.5 text-slate-400 text-xs">$</span>
                                                    <input type="number" value={schedule.amount} onChange={e => updatePaymentSchedule(index, "amount", e.target.value)}
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 pl-4 text-sm font-medium text-slate-800" />
                                                </div>
                                                <div className="w-32 px-1">
                                                    <input type="date" value={schedule.dueDate ? new Date(schedule.dueDate).toISOString().split('T')[0] : ''} onChange={e => updatePaymentSchedule(index, "dueDate", new Date(e.target.value).toISOString())}
                                                        className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-1 py-1 text-sm text-slate-500" />
                                                </div>
                                                <div className="w-24">
                                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                                                        schedule.status === "Paid" ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
                                                        schedule.status === "Sent" ? "bg-amber-50 text-amber-700 border border-amber-200" :
                                                        "bg-slate-100 text-slate-600 border border-slate-200"
                                                    }`}>{schedule.status}</span>
                                                </div>
                                                <div className="w-20 flex justify-end gap-1">
                                                    {schedule.status !== "Paid" && (
                                                        <button onClick={() => { setShowLogPaymentModal(schedule.id); setLogPaymentAmount(String(schedule.amount)); }}
                                                            className="text-xs text-emerald-600 hover:text-emerald-700 font-medium opacity-0 group-hover:opacity-100 transition"
                                                            title="Log Payment">
                                                            <CheckCircleIcon />
                                                        </button>
                                                    )}
                                                    <button onClick={() => removePaymentSchedule(index)} className="text-slate-300 hover:text-red-500 rounded p-0.5 transition opacity-0 group-hover:opacity-100">
                                                        <XIcon />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    {/* Payment Summary */}
                                    <div className="bg-slate-50 px-6 py-3 border-t border-slate-200 flex justify-between text-sm">
                                        <span className="text-slate-500 font-medium">Total Scheduled: <span className="text-slate-800 font-semibold">${fmt(totalScheduled)}</span></span>
                                        <span className="text-slate-500 font-medium">Total Paid: <span className="text-emerald-700 font-semibold">${fmt(totalPaid)}</span></span>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* ─── Files Section ─── */}
                        <div ref={el => { sectionRefs.current["files"] = el; }} className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            <div className="flex items-center justify-between bg-slate-50/80 border-b border-slate-100 px-6 py-4">
                                <h3 className="font-bold text-slate-800 tracking-tight flex items-center gap-2">
                                    <PaperclipIcon className="w-4 h-4 text-slate-400" />
                                    Files & Attachments
                                </h3>
                            </div>
                            <div className="p-8 text-center border-2 border-dashed border-slate-200 m-4 rounded-lg">
                                <PaperclipIcon className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                                <p className="text-sm text-slate-500 font-medium">Drop files here or click to upload</p>
                                <p className="text-xs text-slate-400 mt-1">Attach plans, specs, or reference documents</p>
                            </div>
                        </div>

                        {/* ─── Terms & Conditions ─── */}
                        <div ref={el => { sectionRefs.current["terms"] = el; }} className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            <div className="flex items-center justify-between bg-slate-50/80 border-b border-slate-100 px-6 py-4">
                                <h3 className="font-bold text-slate-800 tracking-tight flex items-center gap-2">
                                    <DocIcon className="w-4 h-4 text-slate-400" />
                                    Terms & Conditions
                                </h3>
                            </div>
                            <div className="p-4">
                                <textarea
                                    value={termsText}
                                    onChange={e => setTermsText(e.target.value)}
                                    placeholder="Enter your terms and conditions, payment terms, warranty information, etc."
                                    className="w-full min-h-[120px] bg-transparent focus:outline-none focus:bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-700 resize-y border border-slate-100 focus:border-slate-200 transition"
                                />
                            </div>
                        </div>

                        {/* ─── Memo ─── */}
                        <div ref={el => { sectionRefs.current["memo"] = el; }} className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            <div className="flex items-center justify-between bg-slate-50/80 border-b border-slate-100 px-6 py-4">
                                <h3 className="font-bold text-slate-800 tracking-tight flex items-center gap-2">
                                    <PencilIcon className="w-4 h-4 text-slate-400" />
                                    Memo
                                </h3>
                            </div>
                            <div className="p-4">
                                <textarea
                                    value={memo}
                                    onChange={e => setMemo(e.target.value)}
                                    placeholder="Internal notes about this estimate..."
                                    className="w-full min-h-[80px] bg-transparent focus:outline-none focus:bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-700 resize-y border border-slate-100 focus:border-slate-200 transition"
                                />
                            </div>
                        </div>

                        {/* ─── Signature ─── */}
                        {initialEstimate.signatureUrl && (
                            <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                                <div className="flex items-center justify-between bg-green-50/80 border-b border-green-100 px-6 py-4">
                                    <h3 className="font-bold text-green-800 tracking-tight flex items-center gap-2">
                                        <CheckCircleIcon className="w-4 h-4 text-green-600" />
                                        Signed & Approved
                                    </h3>
                                    <span className="text-xs text-green-600">by {initialEstimate.approvedBy} on {initialEstimate.approvedAt ? new Date(initialEstimate.approvedAt).toLocaleDateString() : ''}</span>
                                </div>
                                <div className="p-6 flex justify-center">
                                    <img src={initialEstimate.signatureUrl} alt="Signature" className="max-h-24 border border-slate-200 rounded-lg p-2" />
                                </div>
                            </div>
                        )}

                        {/* ─── Activity Stream ─── */}
                        <div ref={el => { sectionRefs.current["activity"] = el; }} className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden">
                            <div className="flex items-center justify-between bg-slate-50/80 border-b border-slate-100 px-6 py-4">
                                <h3 className="font-bold text-slate-800 tracking-tight flex items-center gap-2">
                                    <ClockIcon className="w-4 h-4 text-slate-400" />
                                    Activity Stream
                                </h3>
                            </div>
                            <div className="p-4 space-y-3">
                                <ActivityEntry icon="create" time={initialEstimate.createdAt} text="Estimate created" />
                                {initialEstimate.sentAt && <ActivityEntry icon="send" time={initialEstimate.sentAt} text="Sent to client" />}
                                {initialEstimate.viewedAt && <ActivityEntry icon="view" time={initialEstimate.viewedAt} text="Viewed by client" />}
                                {initialEstimate.approvedAt && <ActivityEntry icon="approve" time={initialEstimate.approvedAt} text={`Approved by ${initialEstimate.approvedBy || 'client'}`} />}
                                {paymentSchedules.filter(s => s.status === "Paid").map(s => (
                                    <ActivityEntry key={s.id} icon="payment" time={s.paidAt || ''} text={`Payment received: $${fmt(parseFloat(String(s.paidAmount || s.amount)) || 0)} — ${s.name}`} />
                                ))}
                            </div>
                        </div>
                    </div>
                </div>

                {/* ═══ Right Sidebar ═══ */}
                <div className="w-80 border-l border-slate-200 bg-white overflow-y-auto flex-shrink-0">
                    {/* Sidebar Tabs */}
                    <div className="flex border-b border-slate-200 sticky top-0 bg-white z-10">
                        <button onClick={() => setSidebarTab("overview")}
                            className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wider transition ${sidebarTab === "overview" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-400 hover:text-slate-600"}`}>
                            Overview
                        </button>
                        <button onClick={() => setSidebarTab("activity")}
                            className={`flex-1 px-4 py-3 text-xs font-semibold uppercase tracking-wider transition ${sidebarTab === "activity" ? "text-indigo-600 border-b-2 border-indigo-600" : "text-slate-400 hover:text-slate-600"}`}>
                            Activity
                        </button>
                    </div>

                    {sidebarTab === "overview" && (
                        <div className="p-4 space-y-5">
                            {/* Status */}
                            <div>
                                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Status</label>
                                <select value={status} onChange={e => setStatus(e.target.value)}
                                    className={`mt-1 w-full appearance-none cursor-pointer px-3 py-2 text-sm font-semibold border rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition ${getStatusColor(status)}`}>
                                    {["Draft", "Sent", "Viewed", "Approved", "Invoiced", "Paid"].map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                            </div>

                            {/* Key Amounts */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Financials</label>
                                <div className="bg-slate-50 rounded-lg p-3 space-y-2 text-sm">
                                    <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-semibold text-slate-800">${fmt(subtotal)}</span></div>
                                    {showProcessingFee && <div className="flex justify-between"><span className="text-slate-500">Processing Fee</span><span className="font-semibold text-slate-800">${fmt(processingFee)}</span></div>}
                                    <div className="flex justify-between"><span className="text-slate-500">Tax</span><span className="font-semibold text-slate-800">${fmt(tax)}</span></div>
                                    <div className="h-px bg-slate-200" />
                                    <div className="flex justify-between"><span className="font-bold text-slate-700">Total</span><span className="font-bold text-indigo-600">${fmt(total)}</span></div>
                                </div>
                            </div>

                            {/* Payment Status */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Payments</label>
                                <div className="bg-slate-50 rounded-lg p-3 space-y-2 text-sm">
                                    <div className="flex justify-between"><span className="text-slate-500">Scheduled</span><span className="font-semibold text-slate-800">${fmt(totalScheduled)}</span></div>
                                    <div className="flex justify-between"><span className="text-slate-500">Received</span><span className="font-semibold text-emerald-600">${fmt(totalPaid)}</span></div>
                                    <div className="flex justify-between"><span className="text-slate-500">Balance Due</span><span className="font-semibold text-amber-600">${fmt(Math.max(0, total - totalPaid))}</span></div>
                                </div>
                            </div>

                            {/* Key Dates */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Dates</label>
                                <div className="bg-slate-50 rounded-lg p-3 space-y-2 text-xs">
                                    <div className="flex justify-between"><span className="text-slate-500">Created</span><span className="text-slate-700">{new Date(initialEstimate.createdAt).toLocaleDateString()}</span></div>
                                    {initialEstimate.sentAt && <div className="flex justify-between"><span className="text-slate-500">Sent</span><span className="text-slate-700">{new Date(initialEstimate.sentAt).toLocaleDateString()}</span></div>}
                                    {initialEstimate.viewedAt && <div className="flex justify-between"><span className="text-slate-500">Viewed</span><span className="text-slate-700">{new Date(initialEstimate.viewedAt).toLocaleDateString()}</span></div>}
                                    {initialEstimate.approvedAt && <div className="flex justify-between"><span className="text-slate-500">Approved</span><span className="text-slate-700">{new Date(initialEstimate.approvedAt).toLocaleDateString()}</span></div>}
                                    {expirationDate && <div className="flex justify-between"><span className="text-slate-500">Expires</span><span className="text-amber-600 font-medium">{new Date(expirationDate).toLocaleDateString()}</span></div>}
                                </div>
                            </div>

                            {/* Items Summary */}
                            <div className="space-y-2">
                                <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">Items</label>
                                <div className="bg-slate-50 rounded-lg p-3 text-xs space-y-1">
                                    <div className="flex justify-between"><span className="text-slate-500">Line Items</span><span className="text-slate-700 font-medium">{lineItems.length}</span></div>
                                    <div className="flex justify-between"><span className="text-slate-500">Sections</span><span className="text-slate-700 font-medium">{items.filter(i => i.isSection).length}</span></div>
                                    {selectedItemIds.length > 0 && <div className="flex justify-between"><span className="text-amber-600">Selected</span><span className="text-amber-700 font-medium">{selectedItemIds.length}</span></div>}
                                </div>
                            </div>
                        </div>
                    )}

                    {sidebarTab === "activity" && (
                        <div className="p-4 space-y-3">
                            <ActivityEntry icon="create" time={initialEstimate.createdAt} text="Estimate created" />
                            {initialEstimate.sentAt && <ActivityEntry icon="send" time={initialEstimate.sentAt} text="Sent to client" />}
                            {initialEstimate.viewedAt && <ActivityEntry icon="view" time={initialEstimate.viewedAt} text="Viewed by client" />}
                            {initialEstimate.approvedAt && <ActivityEntry icon="approve" time={initialEstimate.approvedAt} text={`Approved by ${initialEstimate.approvedBy || 'client'}`} />}
                            {paymentSchedules.filter(s => s.status === "Paid").map(s => (
                                <ActivityEntry key={s.id} icon="payment" time={s.paidAt || ''} text={`Payment: $${fmt(parseFloat(String(s.paidAmount || s.amount)) || 0)}`} />
                            ))}
                            {!initialEstimate.sentAt && !initialEstimate.approvedAt && (
                                <p className="text-xs text-slate-400 text-center pt-4">No activity yet</p>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* ═══ Modals ═══ */}
            {showSendModal && (
                <SendEstimateModal
                    estimateId={initialEstimate.id}
                    clientEmail={context.clientEmail}
                    onClose={() => setShowSendModal(false)}
                />
            )}

            {/* AI Modal */}
            {showAiModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-purple-200">
                        <div className="px-6 py-4 border-b border-purple-100 bg-gradient-to-r from-purple-50 to-indigo-50 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center"><SparkleIcon /></div>
                                <div>
                                    <h2 className="text-lg font-bold text-hui-textMain">AI Estimate Generator</h2>
                                    <p className="text-xs text-purple-600">Powered by AI — local market pricing</p>
                                </div>
                            </div>
                            <button onClick={() => setShowAiModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition"><XIcon size={20} /></button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-2">Describe the scope of work</label>
                                <textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
                                    placeholder="e.g. Full kitchen remodel — gut existing kitchen, new cabinets, quartz countertops, tile backsplash, new appliances, LVP flooring, recessed lighting."
                                    className="hui-input w-full h-32 resize-none" disabled={isGenerating} />
                            </div>
                            <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 space-y-1">
                                <div className="font-semibold text-slate-700">AI will generate:</div>
                                <div>• Line items grouped by phase with sections</div>
                                <div>• Separate Labor, Material, and Service costs</div>
                                <div>• Allowances for customer selections</div>
                                <div>• Local market pricing</div>
                            </div>
                            {items.length > 0 && (
                                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                                    <strong>Note:</strong> AI items will be appended to your existing {items.length} item(s).
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button onClick={() => setShowAiModal(false)} disabled={isGenerating} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button onClick={handleAiGenerate} disabled={isGenerating || !aiPrompt.trim()}
                                className="hui-btn bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 flex items-center gap-2">
                                {isGenerating ? (<><Spinner /> Generating...</>) : (<><SparkleIcon /> Generate Estimate</>)}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Template Modal */}
            {showTemplateModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">Save as Template</h2>
                            <button onClick={() => setShowTemplateModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition"><XIcon size={20} /></button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Template Name</label>
                                <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="e.g. Kitchen Remodel Template" className="hui-input w-full" autoFocus />
                            </div>
                            <p className="text-xs text-hui-textMuted">Saves the current line items as a reusable template.</p>
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button onClick={() => setShowTemplateModal(false)} className="hui-btn hui-btn-secondary" disabled={isSavingTemplate}>Cancel</button>
                            <button onClick={handleSaveAsTemplate} disabled={isSavingTemplate || !templateName.trim()} className="hui-btn hui-btn-primary disabled:opacity-50">
                                {isSavingTemplate ? "Saving..." : "Save Template"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Log Payment Modal */}
            {showLogPaymentModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-sm w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">Log Payment</h2>
                            <button onClick={() => setShowLogPaymentModal(null)} className="text-hui-textMuted hover:text-hui-textMain transition"><XIcon size={20} /></button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Amount Received</label>
                                <div className="relative">
                                    <span className="absolute left-3 top-2.5 text-slate-400">$</span>
                                    <input type="number" value={logPaymentAmount} onChange={e => setLogPaymentAmount(e.target.value)}
                                        className="hui-input w-full pl-7" placeholder="0.00" autoFocus />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Date Received</label>
                                <input type="date" value={logPaymentDate} onChange={e => setLogPaymentDate(e.target.value)} className="hui-input w-full" />
                            </div>
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button onClick={() => setShowLogPaymentModal(null)} className="hui-btn hui-btn-secondary">Cancel</button>
                            <button onClick={() => handleLogPayment(showLogPaymentModal)} className="hui-btn hui-btn-primary">Log Payment</button>
                        </div>
                    </div>
                </div>
            )}

            {showVendorSelectModal && (
                <SelectVendorModal onSelect={handleCreatePurchaseOrder} onClose={() => setShowVendorSelectModal(false)} />
            )}
        </div>
    );
}

// ─── Sub-Components ──────────────────────────────────────────────

function ActivityEntry({ icon, time, text }: { icon: string, time: string, text: string }) {
    if (!time) return null;
    const date = new Date(time);
    const iconColor = icon === "approve" ? "bg-green-100 text-green-600" :
        icon === "payment" ? "bg-emerald-100 text-emerald-600" :
        icon === "send" ? "bg-amber-100 text-amber-600" :
        icon === "view" ? "bg-blue-100 text-blue-600" :
        "bg-slate-100 text-slate-500";

    return (
        <div className="flex items-start gap-3">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${iconColor}`}>
                {icon === "create" && <PlusIcon size={12} />}
                {icon === "send" && <SendIcon size={12} />}
                {icon === "view" && <EyeIcon size={12} />}
                {icon === "approve" && <CheckCircleIcon size={12} />}
                {icon === "payment" && <DollarIcon size={12} />}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-700 font-medium">{text}</p>
                <p className="text-[10px] text-slate-400">{date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            </div>
        </div>
    );
}

function MenuButton({ icon, onClick, disabled, className, children }: { icon: React.ReactNode, onClick: () => void, disabled?: boolean, className?: string, children: React.ReactNode }) {
    return (
        <button onClick={onClick} disabled={disabled}
            className={`w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 disabled:opacity-50 ${className || "text-hui-textMain"}`}>
            <span className="w-4 h-4 flex items-center justify-center text-slate-400">{icon}</span>
            {children}
        </button>
    );
}

function MenuLink({ icon, href, onClick, children }: { icon: React.ReactNode, href: string, onClick: () => void, children: React.ReactNode }) {
    return (
        <a href={href} target="_blank" onClick={onClick}
            className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain">
            <span className="w-4 h-4 flex items-center justify-center text-slate-400">{icon}</span>
            {children}
        </a>
    );
}

// ─── Icon Components ─────────────────────────────────────────────

function DragIcon() {
    return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></svg>;
}

function XIcon({ size = 14 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}

function PlusIcon({ size = 14 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>;
}

function FolderIcon() {
    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;
}

function SparkleIcon() {
    return <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>;
}

function SendIcon({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>;
}

function EyeIcon({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>;
}

function DocIcon({ size = 16, className }: { size?: number, className?: string }) {
    return <svg width={size} height={size} className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>;
}

function DownloadIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>;
}

function CopyIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>;
}

function BookmarkIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>;
}

function InvoiceIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>;
}

function ClipboardIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>;
}

function CartIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>;
}

function ArchiveIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>;
}

function TrashIcon() {
    return <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>;
}

function LockIcon({ className }: { className?: string }) {
    return <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>;
}

function DollarIcon({ className, size = 16 }: { className?: string, size?: number }) {
    return <svg width={size} height={size} className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
}

function PaperclipIcon({ className }: { className?: string }) {
    return <svg width="16" height="16" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>;
}

function PencilIcon({ className }: { className?: string }) {
    return <svg width="16" height="16" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>;
}

function ClockIcon({ className }: { className?: string }) {
    return <svg width="16" height="16" className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
}

function CheckCircleIcon({ className, size = 16 }: { className?: string, size?: number }) {
    return <svg width={size} height={size} className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
}

function Spinner() {
    return <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" /></svg>;
}
