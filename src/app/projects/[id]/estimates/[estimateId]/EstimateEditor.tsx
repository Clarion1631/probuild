"use client";

import { useState, useEffect } from "react";
import { saveEstimate, createInvoiceFromEstimate, deleteEstimate, duplicateEstimate, saveEstimateAsTemplate } from "@/lib/actions";
import { useRouter } from "next/navigation";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import ExpensesTab from "./ExpensesTab";
import SendEstimateModal from "@/components/SendEstimateModal";
import { toast } from "sonner";

export default function EstimateEditor({ context, initialEstimate }: { context: { type: "project" | "lead", id: string, name: string, clientName: string, clientEmail?: string, location?: string }, initialEstimate: any }) {
    const router = useRouter();
    const [title, setTitle] = useState(initialEstimate.title);
    const [code, setCode] = useState(initialEstimate.code);
    const [status, setStatus] = useState(initialEstimate.status);
    const [items, setItems] = useState<any[]>(initialEstimate.items || []);
    const [paymentSchedules, setPaymentSchedules] = useState<any[]>(initialEstimate.paymentSchedules || []);
    const [isSaving, setIsSaving] = useState(false);
    const [isCreatingInvoice, setIsCreatingInvoice] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [activeTab, setActiveTab] = useState("builder"); // builder | expenses
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
            setIsCreatingCO(false);
        }
    }

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

    const subtotal = items.reduce((acc, item) => acc + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)), 0);
    const tax = subtotal * 0.087;
    const total = subtotal + tax;

    // Internal margin calculations
    const totalBaseCost = items.reduce((acc, item) => acc + ((parseFloat(item.quantity) || 0) * (parseFloat(item.baseCost) || 0)), 0);
    const totalMarkup = subtotal - totalBaseCost;
    const profitMargin = subtotal > 0 ? ((totalMarkup / subtotal) * 100) : 0;

    async function handleSave() {
        setIsSaving(true);
        const mappedItems = items.map((item, index) => ({
            ...item,
            order: index,
            total: (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)
        }));
        const mappedSchedules = paymentSchedules.map((schedule, index) => ({
            ...schedule,
            order: index
        }));

        await saveEstimate(initialEstimate.id, context.id, context.type, {
            title, code, status, totalAmount: total, paymentSchedules: mappedSchedules
        }, mappedItems);
        setIsSaving(false);
        toast.success("Estimate saved successfully");
        router.refresh();
    }

    async function handleCreateInvoice() {
        setIsCreatingInvoice(true);
        try {
            await handleSave();
            const res = await createInvoiceFromEstimate(initialEstimate.id);
            if (res.id) {
                toast.success("Invoice drafted from this estimate.");
                router.push(`/projects/${context.id}/invoices/${res.id}`);
            }
        } catch (e: any) {
            toast.error(e.message || "Failed to create invoice.");
        } finally {
            setIsCreatingInvoice(false);
        }
    }

    async function handleDelete() {
        if (!confirm("Are you sure you want to delete this estimate? This action cannot be undone.")) return;
        setIsDeleting(true);
        try {
            await deleteEstimate(initialEstimate.id);
            toast.success("Estimate deleted");
            if (context.type === "project") {
                router.push(`/projects/${context.id}/estimates`);
            } else {
                router.push(`/leads/${context.id}`);
            }
        } catch (error) {
            toast.error("Failed to delete estimate");
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
            if (res.projectId) {
                router.push(`/projects/${res.projectId}/estimates/${res.id}`);
            }
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

    function generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    function addItem(parentId: string | null = null) {
        setItems([...items, {
            id: generateId(),
            name: "",
            description: "",
            type: "Material",
            quantity: 1,
            baseCost: 0,
            markupPercent: 25,
            unitCost: 0,
            total: 0,
            parentId,
            costCodeId: null,
            costTypeId: null
        }]);
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

            if (!res.ok) {
                const data = await res.json();
                toast.error(data.error || 'AI generation failed');
                return;
            }

            const data = await res.json();
            if (data.items && data.items.length > 0) {
                const newItems = [...items, ...data.items];
                const newSchedules = data.paymentMilestones && data.paymentMilestones.length > 0
                    ? [...paymentSchedules, ...data.paymentMilestones]
                    : paymentSchedules;
                setItems(newItems);
                if (data.paymentMilestones && data.paymentMilestones.length > 0) {
                    setPaymentSchedules(newSchedules);
                }
                toast.success(`AI generated ${data.count} items (est. $${data.totalEstimate?.toLocaleString()})`);
                setShowAiModal(false);
                setAiPrompt("");

                // Auto-save with the newly merged items
                const mappedItems = newItems.map((item, index) => ({
                    ...item,
                    order: index,
                    total: (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)
                }));
                const mappedSchedules = newSchedules.map((schedule, index) => ({
                    ...schedule,
                    order: index
                }));
                const newSubtotal = newItems.reduce((acc, item) => acc + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0)), 0);
                const newTotal = newSubtotal + newSubtotal * 0.087;
                await saveEstimate(initialEstimate.id, context.id, context.type, {
                    title, code, status, totalAmount: newTotal, paymentSchedules: mappedSchedules
                }, mappedItems);
                toast.success("Estimate auto-saved");
                router.refresh();
            } else {
                toast.error('AI returned no items');
            }
        } catch (err: any) {
            console.error('AI Generate error:', err);
            toast.error(err?.message || 'Failed to generate estimate — check console');
        } finally {
            setIsGenerating(false);
        }
    }

    function updateItem(index: number, field: string, value: any) {
        const newItems = [...items];
        newItems[index][field] = value;
        setItems(newItems);
    }

    function removeItem(index: number) {
        const itemToRemove = items[index];
        // Also remove children if it's a parent
        setItems(items.filter((item, i) => i !== index && item.parentId !== itemToRemove.id));
    }

    function addPaymentSchedule() {
        setPaymentSchedules([...paymentSchedules, {
            id: generateId(),
            name: "Progress Payment",
            percentage: "",
            amount: 0,
            dueDate: ""
        }]);
    }

    function updatePaymentSchedule(index: number, field: string, value: any) {
        const newSchedules = [...paymentSchedules];
        if (field === "percentage") {
            const pct = parseFloat(value) || 0;
            newSchedules[index].percentage = value;
            newSchedules[index].amount = (total * (pct / 100)).toFixed(2);
        } else {
            newSchedules[index][field] = value;
        }
        setPaymentSchedules(newSchedules);
    }

    function removePaymentSchedule(index: number) {
        const newSchedules = [...paymentSchedules];
        newSchedules.splice(index, 1);
        setPaymentSchedules(newSchedules);
    }

    function onDragEnd(result: any) {
        if (!result.destination) return;
        const newItems = Array.from(items);
        const [reorderedItem] = newItems.splice(result.source.index, 1);
        newItems.splice(result.destination.index, 0, reorderedItem);
        setItems(newItems);
    }

    return (
        <div
            className="flex flex-col h-full bg-slate-50"
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node) && !showTemplateModal && !showAiModal && !showSendModal && !showMoreMenu) {
                    handleSave();
                }
            }}
        >
            {/* Top Navigation / Action Bar */}
            <div className="bg-white border-b border-hui-border px-6 py-4 flex items-center justify-between shadow-sm z-10 sticky top-0">
                <div className="flex items-center gap-4">
                    <button onClick={() => {
                        if (context.type === "project") {
                            router.push(`/projects/${context.id}/estimates`);
                        } else {
                            router.push(`/leads/${context.id}`);
                        }
                    }} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-hui-textMain bg-white border border-hui-border rounded-md hover:bg-slate-50 transition shadow-sm">
                        ← Back to {context.type === "project" ? "Estimates" : "Lead"}
                    </button>
                    <div className="h-4 w-px bg-hui-border"></div>
                    <span className="text-sm font-medium text-hui-textMain">{code}</span>
                    <span className="px-2 py-0.5 rounded text-xs bg-slate-100 text-hui-textMuted border border-hui-border">{status}</span>
                </div>

                {/* Tabs Middle */}
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg absolute left-1/2 -translate-x-1/2">
                    <button
                        onClick={() => setActiveTab("builder")}
                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${activeTab === "builder" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >
                        Builder
                    </button>
                    <button
                        onClick={() => setActiveTab("expenses")}
                        className={`px-4 py-1.5 text-sm font-medium rounded-md transition ${activeTab === "expenses" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                    >
                        Costing & Expenses
                    </button>
                </div>

                <div className="flex items-center gap-2">
                    {/* Internal / Client View Toggle */}
                    <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-md">
                        <button
                            onClick={() => setViewMode("client")}
                            className={`px-3 py-1 text-xs font-medium rounded transition ${viewMode === "client" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                        >Client</button>
                        <button
                            onClick={() => setViewMode("internal")}
                            className={`px-3 py-1 text-xs font-medium rounded transition ${viewMode === "internal" ? "bg-amber-50 text-amber-800 shadow-sm border border-amber-200" : "text-slate-500 hover:text-slate-700"}`}
                        >Internal</button>
                    </div>

                    <div className="h-4 w-px bg-hui-border"></div>

                    {/* More dropdown for secondary actions */}
                    <div className="relative">
                        <button
                            onClick={() => setShowMoreMenu(!showMoreMenu)}
                            className="hui-btn hui-btn-secondary px-2.5"
                            title="More actions"
                        >
                            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>
                        </button>
                        {showMoreMenu && (
                            <>
                                <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} />
                                <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg shadow-xl border border-hui-border z-50 py-1 text-sm">
                                    <button
                                        onClick={() => { window.open(`/portal/estimates/${initialEstimate.id}`, '_blank'); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                        Customer Portal
                                    </button>
                                    <a
                                        href={`/api/pdf/${initialEstimate.id}?inline=true`}
                                        target="_blank"
                                        onClick={() => setShowMoreMenu(false)}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                        Preview PDF
                                    </a>
                                    <a
                                        href={`/api/pdf/${initialEstimate.id}`}
                                        target="_blank"
                                        onClick={() => setShowMoreMenu(false)}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                        Download PDF
                                    </a>
                                    <div className="border-t border-hui-border my-1" />
                                    <button
                                        onClick={() => { handleDuplicate(); setShowMoreMenu(false); }}
                                        disabled={isDuplicating}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain disabled:opacity-50"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                        {isDuplicating ? "Duplicating..." : "Duplicate Estimate"}
                                    </button>
                                    <button
                                        onClick={() => { setShowTemplateModal(true); setShowMoreMenu(false); }}
                                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain"
                                    >
                                        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
                                        Save as Template
                                    </button>
                                    {context.type === "project" && (
                                        <button
                                            onClick={() => { handleCreateInvoice(); setShowMoreMenu(false); }}
                                            disabled={isCreatingInvoice}
                                            className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center gap-2.5 text-hui-textMain disabled:opacity-50"
                                        >
                                            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                            {isCreatingInvoice ? "Creating..." : "Create Invoice"}
                                        </button>
                                    )}
                                    <div className="border-t border-hui-border my-1" />
                                    <button
                                        onClick={() => { handleDelete(); setShowMoreMenu(false); }}
                                        disabled={isDeleting}
                                        className="w-full text-left px-4 py-2.5 hover:bg-red-50 flex items-center gap-2.5 text-red-600 disabled:opacity-50"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                        {isDeleting ? "Deleting..." : "Delete Estimate"}
                                    </button>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Primary Actions */}
                    <button
                        onClick={() => setShowAiModal(true)}
                        className="hui-btn hui-btn-secondary bg-gradient-to-r from-purple-50 to-indigo-50 border-purple-200 text-purple-700 hover:from-purple-100 hover:to-indigo-100 flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                        AI Generate
                    </button>
                    <button
                        onClick={() => setShowSendModal(true)}
                        className="hui-btn hui-btn-green flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        Send
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="hui-btn hui-btn-primary disabled:opacity-50"
                    >
                        {isSaving ? "Saving..." : "Save"}
                    </button>
                    {context.type === "project" && selectedItemIds.length > 0 && (
                        <button
                            onClick={handleCreateChangeOrder}
                            disabled={isCreatingCO}
                            className="hui-btn hui-btn-primary bg-amber-600 hover:bg-amber-700 hover:border-amber-700 border-amber-600 text-white disabled:opacity-50"
                        >
                            {isCreatingCO ? "Creating..." : `Create Change Order (${selectedItemIds.length})`}
                        </button>
                    )}
                </div>
            </div>


            <div className="flex-1 p-8 flex justify-center pb-24 overflow-y-auto">
                {activeTab === "builder" && (
                    <div className="w-full max-w-5xl">
                        {/* Premium Document Wrapper */}
                        <div className="bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-hidden relative">
                            {/* Subtle Gradient Accent Top Line */}
                            <div className="h-1.5 w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500"></div>
                            {/* Document Header */}
                            <div className="p-10 pb-12 space-y-10 border-b border-slate-100">
                                <input
                                    type="text"
                                    value={title}
                                    onChange={e => setTitle(e.target.value)}
                                    className="text-4xl font-extrabold tracking-tight text-slate-800 w-full focus:outline-none focus:bg-slate-50 hover:bg-slate-50 transition-colors rounded-lg px-3 py-2 -ml-3 placeholder:text-slate-300 bg-transparent"
                                    placeholder="Estimate Title"
                                />

                                <div className="flex justify-between items-start gap-12 text-sm px-3">
                                    <div className="space-y-1">
                                        <p className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-2">Estimate To</p>
                                        <p className="font-semibold text-base text-slate-800">{context.clientName}</p>
                                        {context.clientEmail && <p className="text-slate-500">{context.clientEmail}</p>}
                                        {context.location && <p className="text-slate-500 pt-1">{context.location}</p>}
                                    </div>
                                    <div className="bg-slate-50 p-5 rounded-lg border border-slate-100 min-w-[280px]">
                                        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                                            <label className="text-slate-500 font-medium">Estimate No.</label>
                                            <input type="text" value={code} onChange={e => setCode(e.target.value)} className="font-semibold text-slate-800 focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 -mr-2 text-right bg-transparent transition" />
                                            
                                            <label className="text-slate-500 font-medium">Date Issued</label>
                                            <span className="text-right font-medium text-slate-800 px-2 py-1">{new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Items Grid with DnD */}
                            <div className="bg-white">
                                <div className="flex text-[11px] font-bold text-slate-400 bg-slate-50/80 border-b border-slate-100 px-8 py-4 uppercase tracking-wider">
                                <div className="w-8"></div>
                                <div className="w-8 pt-0.5">
                                    <input 
                                        type="checkbox" 
                                        checked={items.length > 0 && selectedItemIds.length === items.length}
                                        onChange={(e) => setSelectedItemIds(e.target.checked ? items.map(i => i.id) : [])}
                                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                                    />
                                </div>
                                <div className="flex-1">Item Description</div>
                                <div className="w-32">Phase</div>
                                <div className="w-32">Type</div>
                                <div className="w-24 text-right">Qty</div>
                                {viewMode === "internal" && <div className="w-28 text-right text-amber-500">Base Cost</div>}
                                {viewMode === "internal" && <div className="w-20 text-right text-amber-500">Markup %</div>}
                                <div className="w-32 text-right">{viewMode === "internal" ? "Sell Price" : "Unit Cost"}</div>
                                <div className="w-32 text-right">Total</div>
                                <div className="w-10"></div>
                            </div>

                            <DragDropContext onDragEnd={onDragEnd}>
                                <Droppable droppableId="items-list">
                                    {(provided) => (
                                        <div {...provided.droppableProps} ref={provided.innerRef} className="divide-y divide-slate-100">
                                            {items.map((item, index) => {
                                                const itemTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.unitCost) || 0);
                                                const isSubItem = !!item.parentId;
                                                return (
                                                    <Draggable key={item.id} draggableId={item.id} index={index}>
                                                        {(provided, snapshot) => (
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                                className={`flex items-center px-6 py-3 bg-white group hover:bg-slate-50 transition border-l-2 ${snapshot.isDragging ? "shadow-lg border-hui-primary z-50 ring-1 ring-hui-primary/20" : isSubItem ? "border-transparent ml-8 bg-slate-50/30" : "border-transparent"}`}
                                                            >
                                                                <div {...provided.dragHandleProps} className="w-8 flex items-center justify-center text-slate-300 hover:text-hui-textMuted cursor-grab opacity-0 group-hover:opacity-100">
                                                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm5-6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm0 6a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></svg>
                                                                </div>
                                                                <div className="w-8">
                                                                    <input 
                                                                        type="checkbox" 
                                                                        checked={selectedItemIds.includes(item.id)}
                                                                        onChange={(e) => {
                                                                            if (e.target.checked) setSelectedItemIds([...selectedItemIds, item.id]);
                                                                            else setSelectedItemIds(selectedItemIds.filter(id => id !== item.id));
                                                                        }}
                                                                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                                                                    />
                                                                </div>
                                                                <div className="flex-1 flex flex-col">
                                                                    <input
                                                                        type="text"
                                                                        value={item.name}
                                                                        onChange={e => updateItem(index, "name", e.target.value)}
                                                                        placeholder="Item name / description"
                                                                        className={`w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-hui-border rounded px-2 py-1 -ml-2 transition text-sm ${isSubItem ? 'text-hui-textMuted' : 'font-medium text-hui-textMain'}`}
                                                                    />
                                                                    {!isSubItem && (
                                                                        <button onClick={() => addItem(item.id)} className="text-[10px] text-hui-primary hover:text-hui-primaryHover font-medium text-left w-fit mt-1 opacity-0 group-hover:opacity-100 transition">
                                                                            + Add Sub-item
                                                                        </button>
                                                                    )}
                                                                </div>
                                                                <div className="w-32 px-2">
                                                                    <select
                                                                        value={item.costCodeId || ""}
                                                                        onChange={e => updateItem(index, "costCodeId", e.target.value || null)}
                                                                        className="bg-transparent focus:outline-none text-hui-textMuted w-full text-xs truncate"
                                                                    >
                                                                        <option value="">No Phase</option>
                                                                        {costCodes.map(cc => (
                                                                            <option key={cc.id} value={cc.id}>{cc.code}</option>
                                                                        ))}
                                                                    </select>
                                                                </div>
                                                                <div className="w-32 px-4">
                                                                    <select
                                                                        value={item.costTypeId || ""}
                                                                        onChange={e => {
                                                                            updateItem(index, "costTypeId", e.target.value || null);
                                                                            // Also update legacy type field for backwards compat
                                                                            const ct = costTypes.find(c => c.id === e.target.value);
                                                                            if (ct) updateItem(index, "type", ct.name);
                                                                        }}
                                                                        className={`bg-transparent focus:outline-none w-full text-sm ${
                                                                            costTypes.find(c => c.id === item.costTypeId)?.name === 'Allowance'
                                                                                ? 'text-amber-600 font-semibold'
                                                                                : 'text-hui-textMuted'
                                                                        }`}
                                                                    >
                                                                        <option value="">Cost Type</option>
                                                                        {costTypes.map(ct => (
                                                                            <option key={ct.id} value={ct.id}>{ct.name}</option>
                                                                        ))}
                                                                    </select>
                                                                    </div>
                                                                     <div className="w-24 px-4 pt-1 text-right">
                                                                         <input
                                                                             type="number"
                                                                             value={item.quantity}
                                                                             onChange={e => updateItem(index, "quantity", e.target.value)}
                                                                             className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                                         />
                                                                     </div>
                                                                     {viewMode === "internal" && (
                                                                         <div className="w-28 px-2 pt-1 text-right relative">
                                                                             <span className="absolute left-4 top-1.5 text-amber-400 text-sm">$</span>
                                                                             <input
                                                                                 type="number"
                                                                                 value={item.baseCost ?? 0}
                                                                                 onChange={e => {
                                                                                     const bc = parseFloat(e.target.value) || 0;
                                                                                     const mp = parseFloat(item.markupPercent) || 0;
                                                                                     updateItem(index, "baseCost", e.target.value);
                                                                                     updateItem(index, "unitCost", (bc * (1 + mp / 100)).toFixed(2));
                                                                                 }}
                                                                                 className="w-full bg-amber-50/50 focus:outline-none focus:bg-white focus:ring-1 ring-amber-200 rounded px-2 py-1 pl-5 text-right hover:bg-amber-50 transition text-sm font-medium text-amber-800"
                                                                             />
                                                                         </div>
                                                                     )}
                                                                     {viewMode === "internal" && (
                                                                         <div className="w-20 px-1 pt-1 text-right relative">
                                                                             <input
                                                                                 type="number"
                                                                                 value={item.markupPercent ?? 25}
                                                                                 onChange={e => {
                                                                                     const mp = parseFloat(e.target.value) || 0;
                                                                                     const bc = parseFloat(item.baseCost) || 0;
                                                                                     updateItem(index, "markupPercent", e.target.value);
                                                                                     updateItem(index, "unitCost", (bc * (1 + mp / 100)).toFixed(2));
                                                                                 }}
                                                                                 className="w-full bg-amber-50/50 focus:outline-none focus:bg-white focus:ring-1 ring-amber-200 rounded px-2 py-1 text-right hover:bg-amber-50 transition text-sm font-medium text-amber-800"
                                                                             />
                                                                             <span className="absolute right-3 top-2 text-amber-400 text-xs">%</span>
                                                                         </div>
                                                                     )}
                                                                     <div className="w-32 px-4 pt-1 text-right relative">
                                                                         <span className="absolute left-6 top-1.5 text-slate-400 text-sm">$</span>
                                                                         <input
                                                                             type="number"
                                                                             value={item.unitCost}
                                                                             onChange={e => updateItem(index, "unitCost", e.target.value)}
                                                                             className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1 pl-6 text-right hover:bg-slate-50 transition text-sm font-medium text-slate-700"
                                                                             readOnly={viewMode === "internal"}
                                                                         />
                                                                     </div>
                                                                    <div className="w-32 px-4 pt-2 text-right font-semibold text-slate-800 text-sm">
                                                                        ${itemTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                    </div>
                                                                    <div className="w-10 pt-1.5 flex justify-end">
                                                                    <button onClick={() => removeItem(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 group-hover:opacity-100">
                                                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
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

                            <div className="p-4 px-8 border-t border-slate-100 bg-white hover:bg-slate-50 transition-colors flex items-center gap-4 cursor-pointer group" onClick={() => addItem(null)}>
                                <button className="text-sm font-semibold text-indigo-500 group-hover:text-indigo-600 flex items-center gap-2 transition">
                                    <span className="bg-indigo-50 text-indigo-500 group-hover:bg-indigo-100 rounded p-1">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                                    </span>
                                    Add New Item
                                </button>
                            </div>
                        </div>

                        {/* Progress Payments Section */}
                        {paymentSchedules.length > 0 && (
                            <div className="bg-white border-t border-slate-200 mt-8">
                                <div className="flex items-center justify-between bg-slate-50/50 border-b border-slate-100 px-8 py-5">
                                    <h3 className="font-bold text-slate-800 tracking-tight">Payment Schedule</h3>
                                </div>
                                <div className="flex text-[11px] font-bold text-slate-400 bg-white border-b border-slate-100 px-8 py-3 uppercase tracking-wider">
                                    <div className="flex-1">Payment Name</div>
                                    <div className="w-32">Percentage</div>
                                    <div className="w-32">Amount</div>
                                    <div className="w-40 text-right">Due Date</div>
                                    <div className="w-10"></div>
                                </div>
                                <div className="divide-y divide-slate-50">
                                    {paymentSchedules.map((schedule, index) => (
                                        <div key={schedule.id || index} className="flex items-center px-8 py-4 bg-white group hover:bg-slate-50/50 transition-colors border-l-4 border-transparent">
                                            <div className="flex-1">
                                                <input
                                                    type="text"
                                                    value={schedule.name}
                                                    onChange={e => updatePaymentSchedule(index, "name", e.target.value)}
                                                    placeholder="e.g. Initial Deposit"
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 -ml-3 transition-all text-sm font-semibold text-slate-800"
                                                />
                                            </div>
                                            <div className="w-32 px-4 relative">
                                                <input
                                                    type="number"
                                                    value={schedule.percentage}
                                                    onChange={e => updatePaymentSchedule(index, "percentage", e.target.value)}
                                                    placeholder="%"
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 pr-6 transition-all text-sm font-medium text-slate-600"
                                                />
                                                <span className="absolute right-7 top-2 text-slate-400 text-xs">%</span>
                                            </div>
                                            <div className="w-32 px-4 relative">
                                                <span className="absolute left-6 top-1.5 text-slate-400 text-sm">$</span>
                                                <input
                                                    type="number"
                                                    value={schedule.amount}
                                                    onChange={e => updatePaymentSchedule(index, "amount", e.target.value)}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-3 py-1.5 pl-5 transition-all text-sm font-medium text-slate-800"
                                                />
                                            </div>
                                            <div className="w-40 px-4 text-right">
                                                <input
                                                    type="date"
                                                    value={schedule.dueDate ? new Date(schedule.dueDate).toISOString().split('T')[0] : ''}
                                                    onChange={e => updatePaymentSchedule(index, "dueDate", new Date(e.target.value).toISOString())}
                                                    className="w-full bg-transparent focus:outline-none focus:bg-white focus:ring-1 ring-slate-200 rounded px-2 py-1.5 text-right transition-all text-sm font-medium text-slate-500"
                                                />
                                            </div>
                                            <div className="w-10 pt-0.5 flex justify-end">
                                                <button onClick={() => removePaymentSchedule(index)} className="text-slate-300 hover:text-red-500 hover:bg-red-50 rounded p-1.5 transition opacity-0 group-hover:opacity-100">
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Footer Totals */}
                            <div className="bg-slate-50 p-10 flex justify-end border-t border-slate-200">
                                <div className="w-80 space-y-4 text-sm">
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>Subtotal</span>
                                        <span className="text-slate-800">${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                    <div className="flex justify-between text-slate-500 font-medium">
                                        <span>Estimated Tax (8.7%)</span>
                                        <span className="text-slate-800">${tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                    <div className="h-px w-full bg-slate-200 my-4 shadow-sm"></div>
                                    <div className="flex justify-between text-xl font-extrabold text-slate-900">
                                        <span>Total</span>
                                        <span className="text-indigo-600">${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Internal Margin Summary */}
                            {viewMode === "internal" && (
                                <div className="bg-amber-50/60 border-t border-amber-200 px-10 py-4 flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                                        <span className="text-xs font-semibold text-amber-800 uppercase tracking-wider">Internal Margin Summary</span>
                                    </div>
                                    <div className="flex items-center gap-6 text-sm">
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Base Cost</div>
                                            <div className="font-bold text-amber-900">${totalBaseCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Markup</div>
                                            <div className="font-bold text-amber-900">${totalMarkup.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Margin</div>
                                            <div className="font-bold text-amber-900">{profitMargin.toFixed(1)}%</div>
                                        </div>
                                        <div className="text-center">
                                            <div className="text-[10px] text-amber-600 font-semibold uppercase">Sell Price</div>
                                            <div className="font-bold text-amber-900">${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="mt-8 flex items-start gap-4 mx-2">
                            <div className="bg-indigo-50 p-3 rounded-lg flex-1 border border-indigo-100 flex items-center justify-between">
                                <div>
                                    <h4 className="font-semibold text-indigo-900 text-sm">Payment Schedule</h4>
                                    <p className="text-xs text-indigo-700/70 mt-0.5">Allow your clients to pay in milestones (e.g., Deposit, Completion).</p>
                                </div>
                                <button onClick={addPaymentSchedule} className="hui-btn hui-btn-secondary text-indigo-700 border-indigo-200 hover:bg-indigo-100 bg-white transition shadow-sm text-xs py-1.5 px-3">
                                    + Add milestone
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {activeTab === "expenses" && (
                    <div className="w-full max-w-5xl bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-slate-200 overflow-visible relative">
                        <div className="h-1.5 w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500"></div>
                        <ExpensesTab estimateId={initialEstimate.id} projectId={context.type === "project" ? context.id : ""} items={items} />
                    </div>
                )}
            </div>
            {showSendModal && (
                <SendEstimateModal
                    estimateId={initialEstimate.id}
                    clientEmail={context.clientEmail}
                    onClose={() => setShowSendModal(false)}
                />
            )}

            {/* AI Estimate Modal */}
            {showAiModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden border border-purple-200">
                        <div className="px-6 py-4 border-b border-purple-100 bg-gradient-to-r from-purple-50 to-indigo-50 flex justify-between items-center">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
                                    <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                                </div>
                                <div>
                                    <h2 className="text-lg font-bold text-hui-textMain">AI Estimate Generator</h2>
                                    <p className="text-xs text-purple-600">Powered by Gemini • Vancouver, WA pricing</p>
                                </div>
                            </div>
                            <button onClick={() => setShowAiModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-2">Describe the scope of work</label>
                                <textarea
                                    value={aiPrompt}
                                    onChange={e => setAiPrompt(e.target.value)}
                                    placeholder="e.g. Full kitchen remodel — gut existing kitchen, new cabinets, quartz countertops, tile backsplash, new appliances, LVP flooring, recessed lighting. Approx 120 sq ft kitchen."
                                    className="hui-input w-full h-32 resize-none"
                                    disabled={isGenerating}
                                />
                            </div>
                            <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 space-y-1">
                                <div className="font-semibold text-slate-700">AI will generate:</div>
                                <div>• Line items grouped by phase (Demo, Framing, Electrical, etc.)</div>
                                <div>• Separate Labor, Material, and Subcontractor costs</div>
                                <div>• Allowances for customer selections (fixtures, finishes)</div>
                                <div>• Local Vancouver, WA market pricing</div>
                            </div>
                            {items.length > 0 && (
                                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                                    <strong>Note:</strong> AI items will be appended to your existing {items.length} item(s).
                                </div>
                            )}
                        </div>
                        <div className="px-6 py-4 border-t border-hui-border flex justify-end gap-3 bg-slate-50">
                            <button
                                type="button"
                                onClick={() => setShowAiModal(false)}
                                disabled={isGenerating}
                                className="hui-btn hui-btn-secondary"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleAiGenerate}
                                disabled={isGenerating || !aiPrompt.trim()}
                                className="hui-btn bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 flex items-center gap-2"
                            >
                                {isGenerating ? (
                                    <>
                                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                        Generating...
                                    </>
                                ) : (
                                    <>
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                                        Generate Estimate
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Save as Template Modal */}
            {showTemplateModal && (
                <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-hui-border">
                        <div className="px-6 py-4 border-b border-hui-border flex justify-between items-center">
                            <h2 className="text-lg font-bold text-hui-textMain">Save as Template</h2>
                            <button onClick={() => setShowTemplateModal(false)} className="text-hui-textMuted hover:text-hui-textMain transition">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-hui-textMain mb-1">Template Name</label>
                                <input
                                    type="text"
                                    value={templateName}
                                    onChange={e => setTemplateName(e.target.value)}
                                    placeholder="e.g. Kitchen Remodel Template"
                                    className="hui-input w-full"
                                    autoFocus
                                />
                            </div>
                            <p className="text-xs text-hui-textMuted">This will save the current line item structure as a reusable template. Project-specific data will not be included.</p>
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
        </div>
    );
}

